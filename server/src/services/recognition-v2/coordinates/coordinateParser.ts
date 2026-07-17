export type AipCoordinateFormat = 'COMPACT_DMS' | 'SYMBOL_DMS' | 'SPACED_DMS' | 'DEGREES_MINUTES' | 'DECIMAL_DEGREES';

export interface ParsedAipCoordinate {
  rawText: string;
  format: AipCoordinateFormat;
  latitude: number;
  longitude: number;
  startIndex: number;
  endIndex: number;
}

interface CoordinatePattern {
  format: AipCoordinateFormat;
  regex: RegExp;
  convert: (match: RegExpExecArray) => [number, number] | undefined;
}

const patterns: CoordinatePattern[] = [
  {
    format: 'SYMBOL_DMS',
    regex: /\b(\d{1,2})\s*[\u00b0o]\s*(\d{1,2})\s*['\u2019]\s*(\d{1,2}(?:\.\d+)?)\s*(?:["\u201d]|'')?\s*([NS])\s*[,;/]?\s*(\d{1,3})\s*[\u00b0o]\s*(\d{1,2})\s*['\u2019]\s*(\d{1,2}(?:\.\d+)?)\s*(?:["\u201d]|'')?\s*([EW])\b/gi,
    convert: (m) => pair(dms(m[1], m[2], m[3], m[4]), dms(m[5], m[6], m[7], m[8])),
  },
  {
    format: 'COMPACT_DMS',
    regex: /\b(\d{2})(\d{2})(\d{2}(?:\.\d+)?)\s*([NS])\s*[,;/]?\s*(\d{3})(\d{2})(\d{2}(?:\.\d+)?)\s*([EW])\b/gi,
    convert: (m) => pair(dms(m[1], m[2], m[3], m[4]), dms(m[5], m[6], m[7], m[8])),
  },
  {
    format: 'SYMBOL_DMS',
    regex: /\b(\d{1,2})\s*°\s*(\d{1,2})\s*'\s*(\d{1,2}(?:\.\d+)?)\s*(?:"|'')?\s*([NS])\s*[,;/]?\s*(\d{1,3})\s*°\s*(\d{1,2})\s*'\s*(\d{1,2}(?:\.\d+)?)\s*(?:"|'')?\s*([EW])\b/gi,
    convert: (m) => pair(dms(m[1], m[2], m[3], m[4]), dms(m[5], m[6], m[7], m[8])),
  },
  {
    format: 'DEGREES_MINUTES',
    regex: /\b(\d{1,2})\s*°\s*(\d{1,2}(?:\.\d+)?)\s*'\s*([NS])\s*[,;/]?\s*(\d{1,3})\s*°\s*(\d{1,2}(?:\.\d+)?)\s*'\s*([EW])\b/gi,
    convert: (m) => pair(dm(m[1], m[2], m[3]), dm(m[4], m[5], m[6])),
  },
  {
    format: 'SPACED_DMS',
    regex: /\b(\d{1,2})\s+(\d{1,2})\s+(\d{1,2}(?:\.\d+)?)\s*([NS])\s*[,;/]?\s*(\d{1,3})\s+(\d{1,2})\s+(\d{1,2}(?:\.\d+)?)\s*([EW])\b/gi,
    convert: (m) => pair(dms(m[1], m[2], m[3], m[4]), dms(m[5], m[6], m[7], m[8])),
  },
  {
    format: 'DECIMAL_DEGREES',
    regex: /\b(\d{1,2}(?:\.\d+))\s*([NS])\s*[,;/]?\s*(\d{1,3}(?:\.\d+))\s*([EW])\b/gi,
    convert: (m) => pair(decimal(m[1], m[2]), decimal(m[3], m[4])),
  },
];

export function parseAipCoordinatePair(input: string): ParsedAipCoordinate | undefined {
  return extractAipCoordinatePairs(input)[0];
}

export function extractAipCoordinatePairs(input: string): ParsedAipCoordinate[] {
  const normalized = normalizeSymbols(input);
  const results: ParsedAipCoordinate[] = [];
  const occupied: Array<[number, number]> = [];
  for (const pattern of patterns) {
    pattern.regex.lastIndex = 0;
    for (let match = pattern.regex.exec(normalized); match; match = pattern.regex.exec(normalized)) {
      const endIndex = match.index + match[0].length;
      if (occupied.some(([start, end]) => match!.index < end && endIndex > start)) continue;
      const converted = pattern.convert(match);
      if (!converted || !validCoordinate(converted[0], converted[1])) continue;
      occupied.push([match.index, endIndex]);
      results.push({
        rawText: input.slice(match.index, endIndex),
        format: pattern.format,
        latitude: roundCoordinate(converted[0]),
        longitude: roundCoordinate(converted[1]),
        startIndex: match.index,
        endIndex,
      });
    }
  }
  return results.sort((a, b) => a.startIndex - b.startIndex);
}

function normalizeSymbols(value: string) {
  return value
    .replace(/[º˚]/g, '°')
    .replace(/[′’`]/g, "'")
    .replace(/[″“”]/g, '"')
    .toUpperCase();
}

function dms(degreesText: string, minutesText: string, secondsText: string, hemisphere: string) {
  const degrees = Number(degreesText);
  const minutes = Number(minutesText);
  const seconds = Number(secondsText);
  if (![degrees, minutes, seconds].every(Number.isFinite) || minutes >= 60 || seconds >= 60) return undefined;
  return signed(degrees + minutes / 60 + seconds / 3600, hemisphere);
}

function dm(degreesText: string, minutesText: string, hemisphere: string) {
  const degrees = Number(degreesText);
  const minutes = Number(minutesText);
  if (![degrees, minutes].every(Number.isFinite) || minutes >= 60) return undefined;
  return signed(degrees + minutes / 60, hemisphere);
}

function decimal(valueText: string, hemisphere: string) {
  const value = Number(valueText);
  return Number.isFinite(value) ? signed(value, hemisphere) : undefined;
}

function signed(value: number, hemisphere: string) {
  return /[SW]/i.test(hemisphere) ? -value : value;
}

function pair(latitude: number | undefined, longitude: number | undefined): [number, number] | undefined {
  return latitude === undefined || longitude === undefined ? undefined : [latitude, longitude];
}

function validCoordinate(latitude: number, longitude: number) {
  return Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180;
}

function roundCoordinate(value: number) {
  return Math.round(value * 1e9) / 1e9;
}
