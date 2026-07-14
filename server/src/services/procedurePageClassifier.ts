import type { ChartRole, ProcedureNameCandidate, ProcedurePageClassification } from '../types/procedure';
import { normalizeProcedureName, normalizeTransitionId } from './procedureGraph/procedureNames';

// 页面级程序识别：程序名候选按来源优先级提取。
// 优先级：正式标题区 > 表格标题 > 正文说明标题 > 页眉程序标识 > 其他。
// 绝对禁止的来源：图面最大字号航路点、最显眼 waypoint、航迹终点名、Transition 名、任意 FIX 名——
// 这些内容在文本层里表现为"孤立的五字母词"，没有 DEPARTURE/ARRIVAL/代号结构，一律不生成候选。

const PROGRAM_TITLE_LINE = /STANDARD\s+(?:DEPARTURE|ARRIVAL)\s+CHART|INSTRUMENT\s+APPROACH\s+CHART/i;
const TABLE_TITLE_LINE = /TABULAR\s+DESCRIPTION|CODING\s+TABLES?|AERONAUTICAL\s+DATA\s+TABULATION/i;
// 程序名必须带完整代号结构（字词型数字或紧凑型 digit+letter）+ DEPARTURE/ARRIVAL 词缀，
// 或紧凑型代号（BINIL 3C）。孤立的五字母词（VAMOS）不是程序名。
const WORD_FORM_NAME = /\b([A-Z]{2,8}\s+(?:ZERO|ONE|TWO|THREE|FOUR|FIVE|SIX|SEVEN|EIGHT|NINE)(?:\s+[A-Z])?\s+(?:DEPARTURE|ARRIVAL))\b/g;
const COMPACT_FORM_NAME = /\b([A-Z]{2,8}\s?\d[A-Z]?)(?:\s+(?:DEPARTURE|ARRIVAL))?\b/g;
const TRANSITION_LINE = /\b([A-Z]{2,10})\s+TRANSITION\b/g;
const RUNWAY_TOKEN = /RWY?\s*(\d{2}[LRC]?(?:\s*\/\s*(?:\d{2})?[LRC]?)*)/gi;

export function classifyProcedurePage(pageNumber: number, text: string, chartRole: ChartRole): ProcedurePageClassification {
  const lines = text.split(/\r?\n/).map((line) => line.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const upperLines = lines.map((line) => line.toUpperCase());
  const titleIndex = upperLines.findIndex((line) => PROGRAM_TITLE_LINE.test(line));
  const tableTitleIndex = upperLines.findIndex((line) => TABLE_TITLE_LINE.test(line));

  const transitionNames = collectTransitionNames(upperLines);
  const candidates: ProcedureNameCandidate[] = [];

  // 1. 正式标题区：图名行 ±6 行窗口
  if (titleIndex >= 0) {
    collectNameCandidates(windowText(upperLines, titleIndex, 6), 'TITLE_BLOCK', 0.9, candidates, transitionNames);
  }
  // 2. 表格标题区
  if (tableTitleIndex >= 0) {
    collectNameCandidates(windowText(upperLines, tableTitleIndex, 4), 'TABLE_TITLE', 0.8, candidates, transitionNames);
  }
  // 3. 正文说明标题：全文中带 DEPARTURE/ARRIVAL 词缀的字词型名称（不含紧凑型，避免图面标签误入）
  collectWordFormCandidates(upperLines.join(' '), 'NARRATIVE_TITLE', 0.6, candidates, transitionNames);

  const confirmed = pickConfirmedName(candidates);
  return {
    pageNumber,
    pageRole: pageRoleOf(chartRole, titleIndex >= 0, tableTitleIndex >= 0),
    procedureNameCandidates: dedupeCandidates(candidates),
    confirmedProcedureName: confirmed?.value,
    procedureIdCandidate: confirmed ? normalizeProcedureName(confirmed.value) : undefined,
    runways: collectRunways(upperLines.join(' ')),
    transitionNames,
  };
}

function pageRoleOf(chartRole: ChartRole, hasProgramTitle: boolean, hasTableTitle: boolean): ProcedurePageClassification['pageRole'] {
  if (chartRole === 'WAYPOINT_COORDINATES') return 'WAYPOINT_COORDINATES';
  if (chartRole === 'TABULAR_DESCRIPTION' || hasTableTitle) return 'LEG_TABLE';
  if (chartRole === 'CHART') return 'PROCEDURE_DIAGRAM';
  if (chartRole === 'MINIMA_TABLE') return 'NOTES';
  if (hasProgramTitle) return 'PROCEDURE_NARRATIVE';
  return 'UNKNOWN';
}

function collectNameCandidates(
  windowedText: string,
  source: ProcedureNameCandidate['source'],
  confidence: number,
  out: ProcedureNameCandidate[],
  transitionNames: string[],
) {
  collectWordFormCandidates(windowedText, source, confidence, out, transitionNames);
  // 紧凑型代号只在标题/表格标题窗口内可信（图面任意位置的代号标签不进入候选）
  for (const match of windowedText.matchAll(COMPACT_FORM_NAME)) {
    const value = match[1].replace(/\s+/g, ' ').trim();
    if (isExcludedCompactToken(value, windowedText, transitionNames)) continue;
    out.push({ value, source, confidence: confidence - 0.05 });
  }
}

function collectWordFormCandidates(
  text: string,
  source: ProcedureNameCandidate['source'],
  confidence: number,
  out: ProcedureNameCandidate[],
  transitionNames: string[],
) {
  for (const match of text.matchAll(WORD_FORM_NAME)) {
    const value = match[1].replace(/\s+/g, ' ').trim();
    // "<X> TRANSITION" 的 X 不是程序名；字词型名称里也排除以过渡名开头的误配
    const head = value.split(/\s+/)[0];
    if (transitionNames.some((transition) => transition === head)) continue;
    out.push({ value, source, confidence });
  }
}

function isExcludedCompactToken(value: string, context: string, transitionNames: string[]) {
  const head = value.split(/\s+/)[0];
  if (transitionNames.includes(head)) return true;
  // RWY 16 之类的跑道 token 会被紧凑正则误抓（如 "16L" 前带字母时不会，纯防御）
  if (/^RWY?\d/.test(value.replace(/\s+/g, ''))) return true;
  // 常见的非程序代号词（RNAV1 / RNP2 / CAT II 等规范标注）
  if (/^(?:RNAV|RNP|GNSS|ICAO|CAT|ILS|LOC|VOR|NDB|DME|GLS|LDA|FL|MSA|AMSL|MAX|MNM|ALT|SPD)\s?\d?[A-Z]?$/.test(value)) return true;
  void context;
  return false;
}

function pickConfirmedName(candidates: ProcedureNameCandidate[]) {
  const sorted = [...candidates].sort((a, b) => b.confidence - a.confidence);
  const best = sorted[0];
  if (!best) return undefined;
  // 只有能标准化出代号的候选才可确认；否则保持未确认（不猜）
  return normalizeProcedureName(best.value) ? best : undefined;
}

function dedupeCandidates(candidates: ProcedureNameCandidate[]) {
  const seen = new Map<string, ProcedureNameCandidate>();
  for (const candidate of candidates) {
    const key = candidate.value;
    const existing = seen.get(key);
    if (!existing || candidate.confidence > existing.confidence) seen.set(key, candidate);
  }
  return [...seen.values()].sort((a, b) => b.confidence - a.confidence);
}

function collectTransitionNames(upperLines: string[]) {
  const names = new Set<string>();
  for (const line of upperLines) {
    for (const match of line.matchAll(TRANSITION_LINE)) {
      const id = normalizeTransitionId(`${match[1]} TRANSITION`);
      if (id) names.add(match[1]);
    }
  }
  return [...names];
}

function collectRunways(text: string) {
  const runways = new Set<string>();
  for (const match of text.matchAll(RUNWAY_TOKEN)) {
    runways.add(`RWY${match[1].replace(/\s+/g, '').toUpperCase()}`);
  }
  return [...runways];
}

function windowText(lines: string[], center: number, radius: number) {
  return lines.slice(Math.max(0, center - radius), Math.min(lines.length, center + radius + 1)).join(' ');
}
