import type { ChartRole, NavigationType, PdfPageAsset, ProcedureCategory } from '../types/procedure';

export function classifyPage(pageNo: number, text: string): PdfPageAsset {
  const normalized = text.replace(/\s+/g, ' ').trim();
  const upper = normalized.toUpperCase();
  const chartRole = detectChartRole(upper);
  const procedureCategory = detectProcedureCategory(upper);
  const navigationType = detectNavigationType(upper);
  const aipPageNo = firstMatch(normalized, /AD\s*2-[A-Z]{4}-\d+-\d+/i)?.toUpperCase().replace(/\s+/g, ' ');
  const runwayMatch = firstMatch(normalized, /RWY\s?(\d{2}[LRC]?)/i);
  const procedureNames = uniqueMatches(normalized, /\b[A-Z]{5}\s?\d[A-Z]\b/g).map((name) => name.replace(/\s+/, ' '));
  const chartTitle = detectTitle(text);
  const confidence = calculateConfidence(chartRole, procedureCategory, navigationType, aipPageNo, runwayMatch);

  return {
    pageNo,
    aipPageNo,
    textLayerText: text,
    ocrText: text,
    chartRole,
    procedureCategory,
    navigationType,
    runway: runwayMatch ? `RWY${runwayMatch.replace(/RWY\s?/i, '')}` : undefined,
    chartTitle,
    procedureNames,
    confidence,
    reviewRequired: confidence < 0.72 || chartRole === 'UNKNOWN' || procedureCategory === 'UNKNOWN',
  };
}

function detectChartRole(upper: string): ChartRole {
  if (!upper.trim()) return 'BLANK';
  if (upper.includes('INTENTIONALLY BLANK')) return 'BLANK';
  if (upper.includes('CHARTS RELATED TO AN AERODROME')) return 'CHART_INDEX';
  if (upper.includes('WAYPOINT COORDINATES') || upper.includes('AERONAUTICAL DATA TABULATION')) return 'WAYPOINT_COORDINATES';
  if (upper.includes('MINIMA') || upper.includes('OCA') || upper.includes('OCH')) return 'MINIMA_TABLE';
  if (upper.includes('TABULAR DESCRIPTION')) return 'TABULAR_DESCRIPTION';
  if (
    upper.includes('STANDARD ARRIVAL CHART') ||
    upper.includes('STANDARD DEPARTURE CHART') ||
    upper.includes('INSTRUMENT APPROACH CHART')
  ) {
    return 'CHART';
  }
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
  if (upper.includes('DME ARC') || upper.includes('11 DME ARC')) return 'DME_ARC';
  if (upper.includes('RNP')) return 'RNP';
  if (upper.includes('RNAV')) return 'RNAV';
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
