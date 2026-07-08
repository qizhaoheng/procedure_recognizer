import type { SimpleProcedureLeg } from './types';

export const ROUTE_CODE_TO_PROCEDURE: Record<string, string> = {
  ADLO1E: 'ADLOV 1E',
  EMTU1E: 'EMTUV 1E',
  OMKO1E: 'OMKOM 1E',
  PIMO1E: 'PIMOK 1E',
  ADLO1G: 'ADLOV 1G',
  EMTU1G: 'EMTUV 1G',
  OMKO1G: 'OMKOM 1G',
  PIMO1G: 'PIMOK 1G',
};

const PATH_TERMINATORS = ['IF', 'TF', 'CI', 'AF', 'CF', 'DF', 'RF', 'HM', 'HF', 'HA'];

interface PartialLeg {
  procedureName: string;
  runway: string;
  routeKey: string;
  sequence: string;
  fix: string;
  pathTerminator?: string;
  turnDirection?: 'L' | 'R' | '';
  distanceNm?: number;
  altitudeRaw?: string;
  altitudeValue?: number;
  altitudeSign?: '+' | '-' | '';
  altitudeUpperFt?: number;
  courseDegMag?: number;
  holdingAtFix?: boolean;
  endOfProcedure?: boolean;
  fixSection?: string;
  recommendedNavaid?: string;
  rawRecords: string[];
}

export function parseJeppesen424Text(text: string): SimpleProcedureLeg[] {
  const merged = new Map<string, PartialLeg>();

  for (const sourceLine of text.split(/\r?\n/)) {
    const line = sourceLine.trim();
    if (!line || !line.includes('SSPAP')) continue;

    const route = parseRoute(line);
    if (!route) continue;
    const leg = parseLegRecord(line, route.routeKey);
    if (!leg) continue;

    const key = `${route.procedureName}|${route.runway}|${leg.sequence}`;
    const current = merged.get(key) ?? {
      procedureName: route.procedureName,
      runway: route.runway,
      routeKey: route.routeKey,
      sequence: leg.sequence,
      fix: leg.fix,
      rawRecords: [],
    };

    current.rawRecords.push(sourceLine);
    current.fix = current.fix || leg.fix;

    if (leg.recordPart === '1E') {
      current.pathTerminator = extractPathTerminator(line) ?? current.pathTerminator;
      current.turnDirection = extractTurnDirection(line, leg.recordText) ?? current.turnDirection;
      const altitude = extractAltitude(line, leg.recordText);
      current.altitudeRaw = altitude?.raw ?? current.altitudeRaw;
      current.altitudeValue = altitude?.value ?? current.altitudeValue;
      current.altitudeSign = altitude ? altitudeSignOf(altitude.raw) : current.altitudeSign;
      // 列位读取仅对全宽（132 列）记录生效，短格式/变形粘贴不做定位提取
      if (line.length >= 120) {
        current.altitudeUpperFt = extractSecondAltitude(line) ?? current.altitudeUpperFt;
        current.courseDegMag = extractCourse(line) ?? current.courseDegMag;
        current.holdingAtFix = line[42] === 'H' || current.holdingAtFix;
        current.recommendedNavaid = extractRecommendedNavaid(line) ?? current.recommendedNavaid;
      }
      current.endOfProcedure = leg.endOfProcedure || current.endOfProcedure;
      current.fixSection = leg.fixSection ?? current.fixSection;
    }

    if (leg.recordPart === '2P') {
      current.distanceNm = extractDistance(line, leg.recordText) ?? current.distanceNm;
    }

    merged.set(key, current);
  }

  return [...merged.values()]
    .sort((a, b) => compareProcedureLegs(a, b))
    .map((item) => ({
      procedureName: item.procedureName,
      runway: item.runway,
      routeKey: item.routeKey,
      sequence: item.sequence,
      fix: item.fix,
      pathTerminator: item.pathTerminator,
      turnDirection: item.turnDirection ?? '',
      distanceNm: item.distanceNm,
      altitudeRaw: item.altitudeRaw,
      altitudeValue: item.altitudeValue,
      altitudeSign: item.altitudeSign,
      altitudeUpperFt: item.altitudeUpperFt,
      courseDegMag: item.courseDegMag,
      holdingAtFix: item.holdingAtFix ?? false,
      endOfProcedure: item.endOfProcedure ?? false,
      fixSection: item.fixSection,
      recommendedNavaid: item.recommendedNavaid,
      source: 'JEPPESEN_424',
      rawRecord: item.rawRecords.join('\n'),
    }));
}

function parseRoute(line: string) {
  const match = line.match(/\b(WMKJWME([A-Z0-9]{6})2(RW\d{2}[A-Z]?))/);
  if (!match) return undefined;
  const routeKey = match[1];
  const routeCode = match[2];
  const procedureName = ROUTE_CODE_TO_PROCEDURE[routeCode] ?? routeCode.replace(/^([A-Z]{4})(\d[A-Z])$/, '$1 $2');
  return {
    routeKey,
    routeCode,
    runway: match[3],
    procedureName,
  };
}

function parseLegRecord(line: string, routeKey: string) {
  const afterRoute = line.slice(line.indexOf(routeKey) + routeKey.length);
  const candidates = [afterRoute, line];
  for (const candidate of candidates) {
    const match = candidate.match(/(\d{3})([A-Z0-9]{5})([A-Z0-9]{4})(1E+|2P)(?:\b|$)/);
    if (match) {
      return {
        sequence: match[1],
        fix: match[2],
        // 4 字符 = ICAO 区域(2) + section/subsection(2)，如 WMEA / WMPC
        fixSection: match[3].slice(2),
        recordPart: match[4].startsWith('1E') ? '1E' as const : '2P' as const,
        // 1EE = 航路点描述第二个 E，标记程序末段腿
        endOfProcedure: match[4].startsWith('1EE'),
        recordText: match[0],
      };
    }
  }
  return undefined;
}

function extractPathTerminator(line: string) {
  const terms = PATH_TERMINATORS.join('|');
  const spaced = line.match(new RegExp(`(?:^|[^A-Z])(${terms})(?:[^A-Z]|$)`));
  if (spaced) return spaced[1];

  // Static text exports sometimes lose spacing. Prefer the first plausible PT
  // after the record identifier, but avoid treating route suffixes as PTs.
  const afterRecord = line.replace(/^.*\d{3}[A-Z0-9]{5}[A-Z0-9]{4}1E+/, '');
  return PATH_TERMINATORS.find((term) => afterRecord.includes(term));
}

function extractTurnDirection(line: string, recordText: string): 'L' | 'R' | '' | undefined {
  const afterRecord = line.slice(line.indexOf(recordText) + recordText.length);
  const match = afterRecord.match(/(?:^|\s)([LR])(?:\s|$)/);
  return match ? (match[1] as 'L' | 'R') : undefined;
}

function extractAltitude(line: string, recordText: string) {
  // 全宽行按列位读取（符号 83 列、数值 85-89 列），避免把 95-99 列的第二高度误当 alt1
  if (line.length >= 120) {
    const digits = positionalDigits(line, 84, 5);
    if (digits === undefined) return undefined;
    const sign = line[82] === '+' || line[82] === '-' ? line[82] : '';
    return { raw: `${sign}${String(digits).padStart(5, '0')}`, value: digits };
  }

  const afterRecord = line.slice(line.indexOf(recordText) + recordText.length);
  const signed = [...afterRecord.matchAll(/[+-]\s*(\d{4,5})\b/g)].at(-1);
  if (signed) {
    const raw = `${signed[0].trim()[0]}${signed[1]}`;
    return { raw, value: Number(signed[1]) };
  }

  const candidates = [...afterRecord.matchAll(/\b(\d{4,5})\b/g)]
    .map((match) => match[1])
    .filter((value) => Number(value) >= 1000 && Number(value) <= 60000);
  const raw = candidates.at(-1);
  return raw ? { raw, value: Number(raw) } : undefined;
}

function altitudeSignOf(raw: string | undefined): '+' | '-' | '' {
  if (raw?.startsWith('+')) return '+';
  if (raw?.startsWith('-')) return '-';
  return '';
}

// 以下两个字段按 132 列定宽的列位读取（短格式/粘贴变形的行读不到则为 undefined）。
// 磁航向：第 71-74 列（0 基 70-73），×10 存储，如 CI 的 1960 = 196.0°。
function extractCourse(line: string) {
  const value = positionalDigits(line, 70, 4);
  if (value === undefined) return undefined;
  const course = value / 10;
  return course <= 360 ? course : undefined;
}

// 第二高度：第 95-99 列（0 基 94-98），如入航段的 13000。
function extractSecondAltitude(line: string) {
  const value = positionalDigits(line, 94, 5);
  return value !== undefined && value >= 1000 && value <= 60000 ? value : undefined;
}

// 推荐导航台：AF/CI 腿在第 51-54 列（0 基 50-53），IF 腿在第 107-110 列（0 基 106-109）。
function extractRecommendedNavaid(line: string) {
  const primary = line.slice(50, 54).trim();
  if (/^[A-Z]{2,4}$/.test(primary)) return primary;
  const centerFix = line.slice(106, 110).trim();
  if (/^[A-Z]{2,4}$/.test(centerFix)) return centerFix;
  return undefined;
}

function positionalDigits(line: string, start: number, length: number) {
  const slice = line.slice(start, start + length);
  return slice.length === length && /^\d+$/.test(slice) ? Number(slice) : undefined;
}

function extractDistance(line: string, recordText: string) {
  const afterRecord = line.slice(line.indexOf(recordText) + recordText.length);
  const match = [...afterRecord.matchAll(/\b(\d{4})\b/g)].at(-1);
  if (!match) return undefined;
  return Number((Number(match[1]) / 10).toFixed(1));
}

function compareProcedureLegs(a: Pick<SimpleProcedureLeg, 'procedureName' | 'sequence'>, b: Pick<SimpleProcedureLeg, 'procedureName' | 'sequence'>) {
  return a.procedureName.localeCompare(b.procedureName) || Number(a.sequence) - Number(b.sequence);
}
