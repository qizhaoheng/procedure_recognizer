import type { ChartIndexItem, NavigationType, PackageType, PdfPageAsset, ProcedureCategory } from '../types/procedure';

// AD 与 2 之间允许连字符：新加坡等 AIP 写作 AD-2-WSSS-…
const CHART_NO_PATTERN = /A\s*D\s*-?\s*2\s*-\s*([A-Z]\s*[A-Z]\s*[A-Z]\s*[A-Z])\s*-\s*(\d{1,2})\s*-\s*(\d{1,2}(?:\s+\d(?!\d))?)/i;
// 香港等 AIP 的字母段图号，如 AD 2-VHHH-SID-BEKOL-A / AD 2-VHHH-IAC-04A / AD 2-VHHH-AC-DEP；
// 新加坡式带小数子页号，如 AD-2-WSSS-SID-1.1（图的翻页描述表）
const LETTERED_CHART_NO_PATTERN = /AD\s*-?\s*2\s*-\s*([A-Z]{4})\s*-\s*([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*(?:\.\d{1,2})?)/;
const LETTERED_CHART_NO_PATTERN_GLOBAL = new RegExp(LETTERED_CHART_NO_PATTERN.source, 'g');
const LETTERED_CHART_NO_LINE_PATTERN = new RegExp(`^${LETTERED_CHART_NO_PATTERN.source}$`);
const PROGRAM_CHART_PATTERN = /STANDARD\s+DEPARTURE\s+CHART|STANDARD\s+ARRIVAL\s+CHART|INSTRUMENT\s+APPROACH\s+CHART/i;

export function normalizeChartNo(raw?: string | null): string | undefined {
  return normalizeNumericChartNo(raw) || normalizeLetteredChartNo(raw);
}

export function normalizeNumericChartNo(raw?: string | null): string | undefined {
  const match = raw?.match(CHART_NO_PATTERN);
  if (!match) return undefined;
  const icao = match[1].replace(/\s+/g, '').toUpperCase();
  const section = Number(match[2].replace(/\s+/g, ''));
  const page = Number(match[3].replace(/\s+/g, ''));
  if (!icao || !section || !page || page > 99) return undefined;
  return `AD 2-${icao}-${section}-${page}`;
}

export function normalizeLetteredChartNo(raw?: string | null): string | undefined {
  const match = raw?.toUpperCase().match(LETTERED_CHART_NO_PATTERN);
  if (!match) return undefined;
  return `AD 2-${match[1]}-${match[2]}`;
}

export function countLetteredChartNos(text: string) {
  return (text.toUpperCase().match(LETTERED_CHART_NO_PATTERN_GLOBAL) || []).length;
}

export interface ChartNoKind {
  role: 'CHART' | 'SUPPORT';
  procedureCategory: ProcedureCategory;
  packageType: PackageType;
}

// 从字母段图号推断图页类型（图页可能没有可提取的标题文本，只能靠图号语义）
export function classifyChartNoType(chartNo?: string | null): ChartNoKind | undefined {
  const match = chartNo?.toUpperCase().match(/^AD 2-[A-Z]{4}-([A-Z][A-Z0-9]*)/);
  if (!match) return undefined;
  const segment = match[1];
  if (segment === 'SID') return { role: 'CHART', procedureCategory: 'DEPARTURE', packageType: 'SID' };
  if (segment === 'STAR') return { role: 'CHART', procedureCategory: 'ARRIVAL', packageType: 'STAR' };
  if (segment === 'IAC') return { role: 'CHART', procedureCategory: 'APPROACH', packageType: 'APPROACH' };
  return { role: 'SUPPORT', procedureCategory: 'UNKNOWN', packageType: 'OTHER' };
}

export function extractLikelyAipPageNo(raw?: string | null): string | undefined {
  if (!raw) return undefined;
  const edgeText = `${raw.slice(0, 650)} ${raw.slice(-650)}`;
  const numeric = normalizeNumericChartNo(edgeText);
  if (numeric) return numeric;
  // 字母段图号只信页首位置：真正的图页文本层以图号开头，正文页开头是纯数字页码。
  // 窗口取大一些避免截断图号，但要求匹配起点在前 100 字符内。
  const head = raw.slice(0, 300);
  const match = head.toUpperCase().match(LETTERED_CHART_NO_PATTERN);
  if (match && (match.index ?? 0) < 100) return `AD 2-${match[1]}-${match[2]}`;
  // 新加坡等 AIP 的图号印在图页页脚，文本层顺序不定可能落在中段；
  // 但页脚图号独立成行，整行精确匹配可避免正文引用（引用总是嵌在语句行内）误配
  for (const line of raw.split(/\r?\n/)) {
    const lineMatch = line.trim().toUpperCase().match(LETTERED_CHART_NO_LINE_PATTERN);
    if (lineMatch) return `AD 2-${lineMatch[1]}-${lineMatch[2]}`;
  }
  return undefined;
}

export function parseChartIndexFromPages(chartIndexPages: PdfPageAsset[]): ChartIndexItem[] {
  const text = chartIndexPages.map((page) => page.textLayerText || page.ocrText || '').join('\n');
  return parseChartIndex(text);
}

export function parseChartIndex(text: string): ChartIndexItem[] {
  const normalized = normalizeIndexText(text);
  const itemPattern =
    /((?:STANDARD\s+DEPARTURE\s+CHART|STANDARD\s+ARRIVAL\s+CHART|INSTRUMENT\s+APPROACH\s+CHART)[\s\S]*?)(A\s*D\s*2\s*-\s*[A-Z]\s*[A-Z]\s*[A-Z]\s*[A-Z]\s*-\s*\d{1,2}\s*-\s*\d{1,2}(?:\s+\d(?!\d))?)/gi;

  const items = Array.from(normalized.matchAll(itemPattern))
    .map((match) => parseChartIndexLine(`${match[1]} ${match[2]}`))
    .filter((item): item is ChartIndexItem => Boolean(item));

  const seen = new Set(items.map((item) => item.chartNo));
  for (const item of parseLetteredChartIndex(text)) {
    if (seen.has(item.chartNo)) continue;
    seen.add(item.chartNo);
    items.push(item);
  }
  return items;
}

// 香港等 AIP 的 AD 2.24 目录格式：图名一行、图号一行交替出现
function parseLetteredChartIndex(text: string): ChartIndexItem[] {
  const items: ChartIndexItem[] = [];
  let nameBuffer: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+/g, ' ').trim();
    if (!line) continue;
    if (isIndexBoilerplateLine(line)) {
      nameBuffer = [];
      continue;
    }
    const upper = line.toUpperCase();
    const match = upper.match(LETTERED_CHART_NO_PATTERN);
    if (!match) {
      nameBuffer.push(line);
      continue;
    }
    const chartNo = `AD 2-${match[1]}-${match[2]}`;
    const before = line.slice(0, upper.indexOf(match[0])).trim();
    const chartName = [nameBuffer.join(' '), before].filter(Boolean).join(' ').trim();
    nameBuffer = [];
    if (chartName) items.push(buildLetteredIndexItem(chartName, chartNo));
  }
  return items;
}

function isIndexBoilerplateLine(line: string) {
  const upper = line.toUpperCase();
  if (/^AIP\b/.test(upper)) return true;
  if (/^©/.test(upper)) return true;
  if (/^CIVIL AVIATION/.test(upper)) return true;
  if (/^HONG KONG$/.test(upper)) return true;
  if (/^AMENDMENT\b/.test(upper)) return true;
  if (/^AIRAC\b/.test(upper)) return true;
  if (/^\d{1,2} [A-Z]{3} \d{2,4}$/.test(upper)) return true;
  if (/^AD 2-[A-Z]{4}-\d+$/.test(upper)) return true;
  if (/CHARTS RELATED TO AN AERODROME/.test(upper)) return true;
  if (/^CHART NAME\b/.test(upper)) return true;
  return false;
}

function buildLetteredIndexItem(chartName: string, chartNo: string): ChartIndexItem {
  const kind = classifyChartNoType(chartNo);
  const isProgramChart = kind?.role === 'CHART';
  const procedureCategory = isProgramChart ? kind!.procedureCategory : detectProcedureCategory(chartName);
  const packageType = isProgramChart ? kind!.packageType : detectPackageType(procedureCategory);
  const runway = detectRunway(chartName);
  const navigationType = detectNavigationTypeForPackage(chartName, packageType);
  const procedureNames =
    packageType === 'APPROACH'
      ? [parseApproachProcedureName(chartName)]
      : detectProcedureNames(chartName, navigationType);
  return {
    chartName,
    chartNo,
    procedureCategory,
    packageType,
    navigationType,
    runway,
    procedureNames,
    isTabular: false,
    tabularNo: undefined,
    // 字母段图号本身唯一标识一张图，直接作为分组键（每张图一个程序包）
    normalizedGroupKey: chartNo,
  };
}

export function parseChartIndexLine(line: string): ChartIndexItem | undefined {
  const chartNo = normalizeChartNo(line);
  if (!chartNo) return undefined;

  const chartNoIndex = line.toUpperCase().lastIndexOf(line.match(CHART_NO_PATTERN)?.[0].toUpperCase() || '');
  const rawName = (chartNoIndex >= 0 ? line.slice(0, chartNoIndex) : line).replace(/\s+/g, ' ').trim();
  if (!PROGRAM_CHART_PATTERN.test(rawName)) return undefined;

  const isTabular = /\(TABULAR\s*\d+\)/i.test(rawName);
  const tabularNoMatch = rawName.match(/\(TABULAR\s*(\d+)\)/i);
  const baseName = stripTabularMarker(rawName);
  const procedureCategory = detectProcedureCategory(baseName);
  const packageType = detectPackageType(procedureCategory);
  const runway = detectRunway(baseName);
  const navigationType = detectNavigationTypeForPackage(baseName, packageType);
  const procedureNames =
    packageType === 'APPROACH'
      ? [parseApproachProcedureName(baseName)]
      : detectProcedureNames(baseName, navigationType);

  return {
    chartName: baseName,
    chartNo,
    procedureCategory,
    packageType,
    navigationType,
    runway,
    procedureNames,
    isTabular,
    tabularNo: tabularNoMatch ? Number(tabularNoMatch[1]) : undefined,
    normalizedGroupKey: buildNormalizedGroupKey({
      procedureCategory,
      packageType,
      navigationType,
      runway,
      procedureNames,
      chartName: baseName,
    }),
  };
}

export function buildNormalizedGroupKey(input: {
  procedureCategory: ProcedureCategory;
  packageType: PackageType;
  navigationType: NavigationType | string;
  runway?: string;
  procedureNames: string[];
  chartName?: string;
}) {
  const runway = input.runway || 'RWY_UNKNOWN';
  if (input.packageType === 'APPROACH') {
    const approachName = normalizeProcedureLabel(input.procedureNames[0] || parseApproachProcedureName(input.chartName || ''));
    return ['APPROACH', input.navigationType, runway, approachName].join('::');
  }

  const signature = input.procedureNames.length
    ? input.procedureNames.map(normalizeProcedureLabel).sort().join('|')
    : normalizeProcedureLabel(stripProcedureChartWords(input.chartName || ''));
  return [input.procedureCategory, input.packageType, input.navigationType, runway, signature].join('::');
}

export function parseApproachProcedureName(chartName: string): string {
  const baseName = stripTabularMarker(chartName).replace(/\s+/g, ' ').trim();
  const runway = detectRunway(baseName);
  // 香港式标题：Instrument Approach Chart - ICAO - ILS - RWY 07R，程序类型在 RWY 之前
  const middle = baseName.match(
    /(?:INSTRUMENT\s+APPROACH\s+CHART|APPROACH\s+TRANSITION\s+CHART)(?:\s*[-–]\s*ICAO)?\s*[-–]\s*(.+?)\s*[-–]?\s*RWY/i,
  )?.[1];
  const runwayMatch = baseName.match(/RWY\s*\d{2}[LRC]?(?:\s*\/\s*(?:\d{2})?[LRC]?)*/i);
  const afterRunway = runwayMatch
    ? baseName.slice((runwayMatch.index ?? 0) + runwayMatch[0].length)
    : baseName.replace(/.*INSTRUMENT\s+APPROACH\s+CHART(?:\s*-\s*ICAO)?/i, '');
  const suffix = afterRunway
    .replace(CHART_NO_PATTERN, '')
    .replace(/\bICAO\b/gi, '')
    .replace(/^[-\s]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
  const procedure = [middle, suffix].filter(Boolean).join(' ').trim();
  return [procedure || detectNavigationType(baseName), runway].filter(Boolean).join(' ').trim();
}

export function detectProcedureCategory(text: string): ProcedureCategory {
  if (/STANDARD\s+ARRIVAL\s+CHART/i.test(text)) return 'ARRIVAL';
  if (/STANDARD\s+DEPARTURE\s+CHART/i.test(text)) return 'DEPARTURE';
  if (/INSTRUMENT\s+APPROACH\s+CHART/i.test(text)) return 'APPROACH';
  if (/AERODROME/i.test(text)) return 'AERODROME';
  return 'UNKNOWN';
}

export function detectPackageType(category: ProcedureCategory): PackageType {
  if (category === 'ARRIVAL') return 'STAR';
  if (category === 'DEPARTURE') return 'SID';
  if (category === 'APPROACH') return 'APPROACH';
  if (category === 'AERODROME') return 'AERODROME';
  if (category === 'AIRSPACE') return 'AIRSPACE';
  return 'OTHER';
}

export function detectNavigationType(text: string): NavigationType {
  return detectNavigationTypeForPackage(text, 'OTHER');
}

export function detectNavigationTypeForPackage(text: string, packageType: PackageType): NavigationType {
  if (/RNP\s+Z\s*\(AR\)|\(\s*AR\s*\)/i.test(text)) return 'RNP_AR';
  if (/DME\s*ARC|11\s*DME\s*ARC/i.test(text)) return 'DME_ARC';
  if (/\bRNP\b/i.test(text)) return 'RNP';
  if (/\bRNAV\b/i.test(text)) return 'RNAV';
  if (/\bILS\b/i.test(text) && /\bLOC\b/i.test(text)) return 'ILS_LOC';
  if (/\bILS\b/i.test(text)) return 'ILS';
  if (/\bLOC\b/i.test(text)) return 'LOC';
  if (/\bVOR\b/i.test(text)) return 'VOR';
  if (/\bNDB\b/i.test(text)) return 'NDB';
  if (/\bRADAR\b/i.test(text)) return 'RADAR';
  if (packageType === 'SID' || packageType === 'STAR') return 'CONVENTIONAL';
  return 'UNKNOWN';
}

export function detectRunway(text: string) {
  // 支持 RWY 16、RWY 16/34、RWY 07L/C/R 等写法
  const match = text.match(/RWY\s*([0-9]{2}[LRC]?(?:\s*\/\s*(?:[0-9]{2}[LRC]?|[LRC]))*)/i);
  if (!match) return undefined;
  return `RWY${match[1].replace(/\s+/g, '').toUpperCase()}`;
}

export function detectApproachProcedureNames(text: string, _navigationType: NavigationType, _runway?: string) {
  return [parseApproachProcedureName(text)];
}

function normalizeIndexText(text: string) {
  return text
    .replace(/\(TABULAR\s*(\d+)\)\s*(?=AD\s*2\s*-)/gi, '(TABULAR $1) ')
    .replace(/([A-Z])(?=AD\s*2\s*-[A-Z]{4}\s*-\s*\d+\s*-\s*\d+)/g, '$1 ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\r/g, '\n')
    .trim();
}

function stripTabularMarker(value: string) {
  return value.replace(/\(TABULAR\s*\d+\)/gi, '').replace(/\s+/g, ' ').trim();
}

function stripProcedureChartWords(value: string) {
  return value
    .replace(/STANDARD\s+(?:DEPARTURE|ARRIVAL)\s+CHART(?:\s*-\s*ICAO)?/gi, '')
    .replace(/INSTRUMENT\s+APPROACH\s+CHART(?:\s*-\s*ICAO)?/gi, '')
    .replace(/\bRWY\s*\d{2}[LRC]?(?:\s*\/\s*\d{2}[LRC]?)?/gi, '')
    .replace(/\bRNAV|DME\s*ARC|11\s*DME\s*ARC|RADAR\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function detectProcedureNames(text: string, navigationType: NavigationType) {
  const names = uniqueMatches(text, /\b[A-Z]{5}\s*\d[A-Z]\b/g).map(normalizeProcedureName);
  if (names.length) return names;
  // 新加坡式图名以程序号收尾：RNAV (GNSS) SID - RWY 02C - VMR 6A（VOR 台名可短于 5 字母）
  const trailing = text.split(/\s+-\s+/).pop()?.trim().toUpperCase();
  if (trailing && !/^RWY/.test(trailing) && /^[A-Z]{2,5}\s?\d{1,2}[A-Z]$/.test(trailing)) {
    return [normalizeProcedureName(trailing)];
  }
  if (navigationType === 'RADAR') {
    const radar = text.match(/\bRADAR\s+([A-Z0-9 ]+?DEPARTURE|[A-Z0-9 ]+?ARRIVAL)\b/i)?.[1];
    return radar ? [normalizeProcedureName(radar)] : [];
  }
  // 香港式命名：RNAV(GNSS) BEKOL SID RWY 07R —— 取 SID/STAR 前的定位点名
  const fix = text.match(/\b([A-Z]{3,6})\s+(?:SID|STAR)\b/i)?.[1]?.toUpperCase();
  if (fix && !['RNAV', 'RNP', 'GNSS', 'ICAO'].includes(fix)) return [fix];
  return [];
}

function normalizeProcedureName(value: string) {
  return value.replace(/\s+/g, ' ').trim().toUpperCase();
}

function normalizeProcedureLabel(value: string) {
  return value
    .toUpperCase()
    .replace(/\(TABULAR\s*\d+\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function uniqueMatches(text: string, regex: RegExp) {
  return Array.from(new Set(Array.from(text.matchAll(regex), (match) => match[0])));
}
