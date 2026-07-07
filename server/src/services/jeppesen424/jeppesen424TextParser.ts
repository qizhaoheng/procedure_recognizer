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
    const match = candidate.match(/(\d{3})([A-Z0-9]{5})[A-Z0-9]{4}(1E+|2P)(?:\b|$)/);
    if (match) {
      return {
        sequence: match[1],
        fix: match[2],
        recordPart: match[3].startsWith('1E') ? '1E' as const : '2P' as const,
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

function extractDistance(line: string, recordText: string) {
  const afterRecord = line.slice(line.indexOf(recordText) + recordText.length);
  const match = [...afterRecord.matchAll(/\b(\d{4})\b/g)].at(-1);
  if (!match) return undefined;
  return Number((Number(match[1]) / 10).toFixed(1));
}

function compareProcedureLegs(a: Pick<SimpleProcedureLeg, 'procedureName' | 'sequence'>, b: Pick<SimpleProcedureLeg, 'procedureName' | 'sequence'>) {
  return a.procedureName.localeCompare(b.procedureName) || Number(a.sequence) - Number(b.sequence);
}
