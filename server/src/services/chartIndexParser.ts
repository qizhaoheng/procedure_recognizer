import type { ChartIndexItem, NavigationType, PackageType, PdfPageAsset, ProcedureCategory } from '../types/procedure';

const CHART_NO_PATTERN = /A\s*D\s*2\s*-\s*([A-Z]\s*[A-Z]\s*[A-Z]\s*[A-Z])\s*-\s*(\d{1,2})\s*-\s*(\d{1,2}(?:\s+\d(?!\d))?)/i;
const PROGRAM_CHART_PATTERN = /STANDARD\s+DEPARTURE\s+CHART|STANDARD\s+ARRIVAL\s+CHART|INSTRUMENT\s+APPROACH\s+CHART/i;

export function normalizeChartNo(raw?: string | null): string | undefined {
  const match = raw?.match(CHART_NO_PATTERN);
  if (!match) return undefined;
  const icao = match[1].replace(/\s+/g, '').toUpperCase();
  const section = Number(match[2].replace(/\s+/g, ''));
  const page = Number(match[3].replace(/\s+/g, ''));
  if (!icao || !section || !page || page > 99) return undefined;
  return `AD 2-${icao}-${section}-${page}`;
}

export function extractLikelyAipPageNo(raw?: string | null): string | undefined {
  if (!raw) return undefined;
  const edgeText = `${raw.slice(0, 650)} ${raw.slice(-650)}`;
  return normalizeChartNo(edgeText);
}

export function parseChartIndexFromPages(chartIndexPages: PdfPageAsset[]): ChartIndexItem[] {
  const text = chartIndexPages.map((page) => page.textLayerText || page.ocrText || '').join('\n');
  return parseChartIndex(text);
}

export function parseChartIndex(text: string): ChartIndexItem[] {
  const normalized = normalizeIndexText(text);
  const itemPattern =
    /((?:STANDARD\s+DEPARTURE\s+CHART|STANDARD\s+ARRIVAL\s+CHART|INSTRUMENT\s+APPROACH\s+CHART)[\s\S]*?)(A\s*D\s*2\s*-\s*[A-Z]\s*[A-Z]\s*[A-Z]\s*[A-Z]\s*-\s*\d{1,2}\s*-\s*\d{1,2}(?:\s+\d(?!\d))?)/gi;

  return Array.from(normalized.matchAll(itemPattern))
    .map((match) => parseChartIndexLine(`${match[1]} ${match[2]}`))
    .filter((item): item is ChartIndexItem => Boolean(item));
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
  const runwayMatch = baseName.match(/RWY\s*\d{2}[LRC]?(?:\s*\/\s*\d{2}[LRC]?)?/i);
  const afterRunway = runwayMatch
    ? baseName.slice((runwayMatch.index ?? 0) + runwayMatch[0].length)
    : baseName.replace(/.*INSTRUMENT\s+APPROACH\s+CHART(?:\s*-\s*ICAO)?/i, '');
  const procedure = afterRunway
    .replace(CHART_NO_PATTERN, '')
    .replace(/\bICAO\b/gi, '')
    .replace(/^[-\s]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
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
  const match = text.match(/RWY\s*([0-9]{2}[LRC]?)(?:\s*\/\s*([0-9]{2}[LRC]?))?/i);
  if (!match) return undefined;
  return match[2] ? `RWY${match[1].toUpperCase()}/${match[2].toUpperCase()}` : `RWY${match[1].toUpperCase()}`;
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
  if (navigationType === 'RADAR') {
    const radar = text.match(/\bRADAR\s+([A-Z0-9 ]+?DEPARTURE|[A-Z0-9 ]+?ARRIVAL)\b/i)?.[1];
    return radar ? [normalizeProcedureName(radar)] : [];
  }
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
