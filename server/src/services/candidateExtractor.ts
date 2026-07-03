import type {
  CandidateExtractionResult,
  PdfPageAsset,
  ProcedureGroup,
  TableCandidate,
  TextCandidate,
  WaypointCandidate,
} from '../types/procedure';
import { extractGeometryCandidates } from './geometryCandidateExtractor';

type CandidateKind = TextCandidate['typeCandidate'];

export function extractCandidates(group: ProcedureGroup, pages: PdfPageAsset[]): CandidateExtractionResult {
  const groupPageNos = new Set(allGroupPages(group));
  const sourcePages = pages.filter((page) => groupPageNos.has(page.pageNo));
  const textCandidates: TextCandidate[] = [];
  const waypointCandidates: WaypointCandidate[] = [];
  const tableCandidates: TableCandidate[] = [];
  const seen = new Set<string>();

  for (const page of sourcePages) {
    const text = page.ocrText || page.textLayerText || '';
    collectText(textCandidates, seen, page.pageNo, text, /\b[A-Z]{5}\s?\d[A-Z]\b/g, 'procedure_name', 0.82);
    collectText(textCandidates, seen, page.pageNo, text, /RWY\s?\d{2}[LRC]?/gi, 'runway', 0.78);
    collectText(textCandidates, seen, page.pageNo, text, /\b\d{3}\s?°/g, 'course', 0.72);
    collectText(textCandidates, seen, page.pageNo, text, /\b\d+(?:\.\d+)?\s?NM\b/gi, 'distance', 0.7);
    collectText(textCandidates, seen, page.pageNo, text, /[+-]?\b\d{3,5}\s?FT\b/gi, 'altitude', 0.68);
    collectText(textCandidates, seen, page.pageNo, text, /\b\d{2,3}\s?KIAS\b/gi, 'speed', 0.72);
    collectText(textCandidates, seen, page.pageNo, text, /\b(?:APP|TWR|SMC|ATIS)\b[^\n\r]{0,60}\d{3}\.\d{1,3}/gi, 'frequency', 0.74);
    collectText(textCandidates, seen, page.pageNo, text, /\b(?:RNAV\s?1|RNP APCH|RNP AR|DME\/DME|GNSS REQUIRED|VOR\/DME REQUIRED|RADAR REQUIRED)\b/gi, 'navigation_spec', 0.76);
    collectText(textCandidates, seen, page.pageNo, text, /\b(?:HOLDING PATTERN|TURN LEFT|TURN RIGHT|MHA|MAX KIAS|1 MIN\.? LEGS)\b/gi, 'holding', 0.65);
    collectText(textCandidates, seen, page.pageNo, text, /\bMSA\b[^\n\r]{0,80}/gi, 'msa', 0.65);

    extractWaypointLines(page.pageNo, text).forEach((candidate) => waypointCandidates.push(candidate));
    extractTableLines(page.pageNo, text).forEach((candidate) => tableCandidates.push(candidate));
  }

  return {
    groupId: group.groupId,
    textCandidates,
    geometryCandidates: extractGeometryCandidates(group),
    waypointCandidates,
    tableCandidates,
  };
}

function collectText(
  target: TextCandidate[],
  seen: Set<string>,
  pageNo: number,
  text: string,
  regex: RegExp,
  typeCandidate: CandidateKind,
  confidence: number,
) {
  for (const match of text.matchAll(regex)) {
    const value = match[0].replace(/\s+/g, ' ').trim();
    const key = `${pageNo}:${typeCandidate}:${value.toUpperCase()}`;
    if (!value || seen.has(key)) continue;
    seen.add(key);
    target.push({
      id: `tc_${target.length + 1}`,
      pageNo,
      text: value,
      typeCandidate,
      confidence,
    });
  }
}

function extractWaypointLines(pageNo: number, text: string): WaypointCandidate[] {
  const candidates: WaypointCandidate[] = [];
  const lines = text.split(/\r?\n/);
  const coordPattern =
    /(?<lat>[0-9]{2}°\s?[0-9]{2}[′']\s?[0-9]{2}(?:\.[0-9]+)?["″]?\s?N).*?(?<lon>[0-9]{3}°\s?[0-9]{2}[′']\s?[0-9]{2}(?:\.[0-9]+)?["″]?\s?E)/i;

  for (const line of lines) {
    const match = line.match(coordPattern);
    if (!match?.groups) continue;
    const ident = line.match(/\b[A-Z]{3,6}\b/)?.[0] ?? `WP${candidates.length + 1}`;
    candidates.push({
      ident,
      latText: match.groups.lat,
      lonText: match.groups.lon,
      sourcePage: pageNo,
      sourceText: line.trim(),
      confidence: 0.72,
    });
  }

  return candidates;
}

function extractTableLines(pageNo: number, text: string): TableCandidate[] {
  const upper = text.toUpperCase();
  const hasHeader = ['SEQ', 'PATH TERM', 'WAYPOINT', 'COURSE', 'DISTANCE', 'ALTITUDE', 'SPEED'].some((header) =>
    upper.includes(header),
  );
  if (!hasHeader) return [];

  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /\b(TF|IF|CF|DF|RF|RWY|KIAS|NM|\d{3}°)\b/i.test(line))
    .slice(0, 80);

  return lines.map((line, index) => ({
    id: `tbl_${pageNo}_${index + 1}`,
    pageNo,
    text: line,
    columns: inferColumns(line),
    confidence: 0.58,
  }));
}

function inferColumns(line: string) {
  const columns = [];
  if (/\b(TF|IF|CF|DF|RF)\b/i.test(line)) columns.push('PATH TERM');
  if (/\b[A-Z]{3,6}\b/.test(line)) columns.push('WAYPOINT IDENTIFIER');
  if (/\d{3}\s?°/.test(line)) columns.push('COURSE');
  if (/\d+(?:\.\d+)?\s?NM/i.test(line)) columns.push('DISTANCE');
  if (/\d{3,5}\s?FT/i.test(line)) columns.push('ALTITUDE');
  if (/\d{2,3}\s?KIAS/i.test(line)) columns.push('SPEED LIMIT');
  return columns;
}

function allGroupPages(group: ProcedureGroup) {
  return [...group.chartPages, ...group.tabularPages, ...group.coordinatePages, ...group.minimaPages, ...group.otherPages];
}
