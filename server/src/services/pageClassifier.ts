import type { ChartRole, NavigationType, PdfPageAsset, ProcedureCategory } from '../types/procedure';
import { classifyChartNoType, extractLikelyAipPageNo } from './chartIndexParser';
import { assessPdfTextLayer } from './pdfTextDecoder';

export function classifyPage(pageNo: number, text: string): PdfPageAsset {
  const textAssessment = assessPdfTextLayer(text);
  text = textAssessment.text;
  const normalized = text.replace(/\s+/g, ' ').trim();
  const upper = normalized.toUpperCase();
  let chartRole = detectChartRole(upper);
  let procedureCategory = detectProcedureCategory(upper);
  const navigationType = detectNavigationType(upper);
  // 传原始文本保留换行：页脚图号独立成行的判定依赖行边界
  const aipPageNo = extractLikelyAipPageNo(text);

  // 香港等 AIP 的图页往往没有可提取的标题文本，退而用字母段图号语义判定。
  // 图号明确指向 SID/STAR/IAC 图页时，优先于文本嗅探出的表格/最低标准角色：
  // 这类图页图面上常印有 OCA/MINIMA、TABULAR DESCRIPTION 等字样。
  // 带小数子页号的翻页（如 -SID-1.1）是图的描述表页，表格角色不可被图号语义覆盖。
  const chartNoKind = classifyChartNoType(aipPageNo);
  const isSubPageChartNo = /\.\d{1,2}$/.test(aipPageNo ?? '');
  const overridableRoles: ChartRole[] = chartNoKind?.role === 'CHART' && !isSubPageChartNo
    ? ['OTHER', 'UNKNOWN', 'MINIMA_TABLE', 'TABULAR_DESCRIPTION', 'WAYPOINT_COORDINATES']
    : ['OTHER', 'UNKNOWN'];
  if (chartNoKind && overridableRoles.includes(chartRole)) {
    chartRole = chartNoKind.role;
    if (procedureCategory === 'UNKNOWN' && chartNoKind.procedureCategory !== 'UNKNOWN') {
      procedureCategory = chartNoKind.procedureCategory;
    }
  }

  const runwayMatch = firstMatch(normalized, /RWY\s?(\d{2}[LRC]?)/i);
  const procedureNames = uniqueMatches(normalized, /\b[A-Z]{5}\s?\d[A-Z]\b/g).map((name) => name.replace(/\s+/, ' '));
  const chartTitle = detectTitle(text);
  const confidence = calculateConfidence(chartRole, procedureCategory, navigationType, aipPageNo, runwayMatch);

  return {
    pageNo,
    aipPageNo,
    textLayerText: text,
    ocrText: text,
    textLayerQuality: textAssessment.quality,
    textLayerWarnings: textAssessment.warnings,
    chartRole,
    procedureCategory,
    navigationType,
    runway: runwayMatch ? `RWY${runwayMatch.replace(/RWY\s?/i, '')}` : undefined,
    chartTitle,
    procedureNames,
    confidence,
    reviewRequired: confidence < 0.72 || chartRole === 'UNKNOWN' || procedureCategory === 'UNKNOWN' || textAssessment.quality === 'SUSPECT',
  };
}

function detectChartRole(upper: string): ChartRole {
  if (!upper.trim()) return 'BLANK';
  if (/INTENTIONALLY\s+(?:LEFT\s+)?BLANK/.test(upper)) return 'BLANK';
  // 韩国等 AIP 写作 CHARTS RELATED TO THE AERODROME
  if (/CHARTS RELATED TO (?:AN|THE) AERODROME/.test(upper)) return 'CHART_INDEX';
  if (upper.includes('TABULAR DESCRIPTION')) return 'TABULAR_DESCRIPTION';
  if (upper.includes('WAYPOINT COORDINATES') || upper.includes('AERONAUTICAL DATA TABULATION')) return 'WAYPOINT_COORDINATES';
  if (/AD\s*2\.?\s*(12|18|19|20|21|22|23)\b/.test(upper)) return 'SUPPORT';
  if (
    upper.includes('STANDARD ARRIVAL CHART') ||
    upper.includes('STANDARD DEPARTURE CHART') ||
    upper.includes('INSTRUMENT APPROACH CHART')
  ) {
    // 图名标题优先于 MINIMA 嗅探：图页文本层常包含 OCA/MINIMA 字样
    return 'CHART';
  }
  if (upper.includes('MINIMA') || upper.includes('OCA') || upper.includes('OCH')) return 'MINIMA_TABLE';
  return upper.length < 30 ? 'UNKNOWN' : 'OTHER';
}

function detectProcedureCategory(upper: string): ProcedureCategory {
  if (upper.includes('STANDARD ARRIVAL CHART')) return 'ARRIVAL';
  if (upper.includes('STANDARD DEPARTURE CHART')) return 'DEPARTURE';
  if (upper.includes('INSTRUMENT APPROACH CHART')) return 'APPROACH';
  if (upper.includes('AERODROME')) return 'AERODROME';
  return 'UNKNOWN';
}

function detectNavigationType(upper: string): NavigationType {
  if (upper.includes('RNP Z (AR)') || upper.includes('(AR)')) return 'RNP_AR';
  if (upper.includes('DME ARC') || upper.includes('11 DME ARC')) return 'DME_ARC';
  if (upper.includes('RNP')) return 'RNP';
  if (upper.includes('RNAV')) return 'RNAV';
  if (upper.includes('ILS') && upper.includes('LOC')) return 'ILS_LOC';
  if (upper.includes('ILS')) return 'ILS';
  if (upper.includes('LOC')) return 'LOC';
  if (upper.includes('VOR')) return 'VOR';
  if (upper.includes('NDB')) return 'NDB';
  if (upper.includes('RADAR')) return 'RADAR';
  return 'UNKNOWN';
}

function detectTitle(text: string) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const index = lines.findIndex((line) => /STANDARD (ARRIVAL|DEPARTURE) CHART|INSTRUMENT APPROACH CHART/i.test(line));
  if (index < 0) return lines[0]?.slice(0, 140);
  return lines.slice(Math.max(0, index - 1), Math.min(lines.length, index + 3)).join(' ').slice(0, 180);
}

function firstMatch(text: string, regex: RegExp) {
  return text.match(regex)?.[0];
}

function uniqueMatches(text: string, regex: RegExp) {
  return Array.from(new Set(Array.from(text.matchAll(regex), (match) => match[0])));
}

function calculateConfidence(
  chartRole: ChartRole,
  procedureCategory: ProcedureCategory,
  navigationType: NavigationType,
  aipPageNo?: string,
  runway?: string,
) {
  let score = 0.35;
  if (chartRole !== 'UNKNOWN' && chartRole !== 'OTHER') score += 0.2;
  if (procedureCategory !== 'UNKNOWN') score += 0.16;
  if (navigationType !== 'UNKNOWN') score += 0.12;
  if (aipPageNo) score += 0.1;
  if (runway) score += 0.07;
  return Number(Math.min(score, 0.98).toFixed(2));
}
