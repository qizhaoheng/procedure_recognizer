import type { SimpleProcedureLeg } from './types';

export const ROUTE_CODE_TO_PROCEDURE: Record<string, string> = {
  ADLO1J: 'ADLOV 1J',
  AROS1J: 'AROSO 1J',
  PIMO1J: 'PIMOK 1J',
  SABK1J: 'SABKA 1J',
  ADLO1K: 'ADLOV 1K',
  AROS1K: 'AROSO 1K',
  OMKO1K: 'OMKOM 1K',
  PIMO1K: 'PIMOK 1K',
  SABK1K: 'SABKA 1K',
  ADLO1L: 'ADLOV 1L',
  AROS1L: 'AROSO 1L',
  PIMO1L: 'PIMOK 1L',
  SABK1L: 'SABKA 1L',
  ADLO1M: 'ADLOV 1M',
  AROS1M: 'AROSO 1M',
  OMKO1M: 'OMKOM 1M',
  PIMO1M: 'PIMOK 1M',
  SABK1M: 'SABKA 1M',
  ADLO2J: 'ADLOV 2J',
  AROS2J: 'AROSO 2J',
  OMKO2J: 'OMKOM 2J',
  SABK2J: 'SABKA 2J',
  ADLO2L: 'ADLOV 2L',
  AROS2L: 'AROSO 2L',
  OMKO2L: 'OMKOM 2L',
  ADLO2M: 'ADLOV 2M',
  AROS2M: 'AROSO 2M',
  OMKO2M: 'OMKOM 2M',
  ADLO1E: 'ADLOV 1E',
  EMTU1E: 'EMTUV 1E',
  OMKO1E: 'OMKOM 1E',
  PIMO1E: 'PIMOK 1E',
  ADLO1G: 'ADLOV 1G',
  EMTU1G: 'EMTUV 1G',
  OMKO1G: 'OMKOM 1G',
  PIMO1G: 'PIMOK 1G',
};

const PATH_TERMINATORS = ['IF', 'TF', 'CA', 'CI', 'CR', 'AF', 'CF', 'DF', 'RF', 'FM', 'FA', 'FC', 'FD', 'VM', 'VA', 'VI', 'VD', 'VR', 'PI', 'HM', 'HF', 'HA'];

interface PartialLeg {
  procedureName: string;
  runway: string;
  transitionName?: string;
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
  thetaDegMag?: number;
  rhoNm?: number;
  speedLimitKias?: number;
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
    // 记录头 = S + 3位区域码 + P(机场section)，如 WMKJ 的 SSPAP、VHHH 的 SPACP
    if (!line || !/^S[A-Z]{3}P\s/.test(line)) continue;

    const route = parseRoute(line);
    if (!route) continue;
    const leg = parseLegRecord(line, route.routeText);
    if (!leg) continue;

    const key = `${route.routeCode}|${route.runway}|${route.transitionName ?? ''}|${leg.sequence}`;
    const current = merged.get(key) ?? {
      procedureName: route.procedureName,
      runway: route.runway,
      transitionName: route.transitionName,
      routeKey: route.routeCode,
      sequence: leg.sequence,
      fix: leg.fix,
      rawRecords: [],
    };

    current.rawRecords.push(sourceLine);
    current.fix = current.fix || leg.fix;

    if (leg.recordPart === '1E') {
      current.pathTerminator = leg.pathTerminator ?? extractPathTerminator(line) ?? current.pathTerminator;
      current.turnDirection = leg.turnDirection ?? extractTurnDirection(line, leg.recordText) ?? current.turnDirection;
      const altitude = extractAltitude(line, leg.recordText);
      current.altitudeRaw = altitude?.raw ?? current.altitudeRaw;
      current.altitudeValue = altitude?.value ?? current.altitudeValue;
      current.altitudeSign = altitude ? altitudeSignOf(altitude.raw) : current.altitudeSign;
      // 列位读取仅对全宽（132 列）记录生效，短格式/变形粘贴不做定位提取
      if (line.length >= 120) {
        current.altitudeUpperFt = extractSecondAltitude(line) ?? current.altitudeUpperFt;
        current.courseDegMag = extractCourse(line) ?? current.courseDegMag;
        current.thetaDegMag = extractTheta(line) ?? current.thetaDegMag;
        current.rhoNm = extractRho(line) ?? current.rhoNm;
        current.speedLimitKias = extractSpeedLimit(line) ?? current.speedLimitKias;
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
      transitionName: item.transitionName,
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
      thetaDegMag: item.thetaDegMag,
      rhoNm: item.rhoNm,
      speedLimitKias: item.speedLimitKias,
      holdingAtFix: item.holdingAtFix ?? false,
      endOfProcedure: item.endOfProcedure ?? false,
      fixSection: item.fixSection,
      recommendedNavaid: item.recommendedNavaid,
      source: 'JEPPESEN_424',
      rawRecord: item.rawRecords.join('\n'),
    }));
}

// 路由段按固定列位解析（0 基）：机场 6-9 | ICAO 区域 10-11 | subsection 12（D=SID/E=STAR/F=进近）
// | 路线代码 13-18 | 路线类型 19（RNAV SID 为 N、常规为数字）| 过渡跑道 20 起（RWxx[LRC]）。
function parseRoute(line: string) {
  const airport = line.slice(6, 10);
  const region = line.slice(10, 12);
  const subsection = line[12] ?? '';
  const routeCode = line.slice(13, 19).trim();
  if (!/^[A-Z]{4}$/.test(airport) || !/^[A-Z]{2}$/.test(region)) return undefined;
  if (!/^[DEF]$/.test(subsection)) return undefined;
  if (!/^[A-Z0-9]{4,6}$/.test(routeCode)) return undefined;

  // Runway branches carry RWxx; route-type 3 records carry a named enroute
  // transition in the same qualifier field (for example a five-letter fix).
  const runwayStart = line[19] === 'R' && line[20] === 'W' ? 19 : 20;
  const runwayMatch = line.slice(runwayStart, runwayStart + 6).match(/^RW\d{2}[A-Z]?/);
  const transitionName = !runwayMatch && line[19] === '3'
    ? line.slice(20, 25).trim()
    : '';
  if (!runwayMatch && !/^[A-Z0-9]{2,5}$/.test(transitionName)) return undefined;
  const qualifier = runwayMatch?.[0] ?? transitionName;
  const qualifierStart = runwayMatch ? runwayStart : 20;

  return {
    // routeText 是记录中的原文片段，供后续按位置截取腿段区
    routeText: line.slice(6, qualifierStart) + qualifier,
    routeCode,
    runway: runwayMatch?.[0] ?? '',
    transitionName: transitionName || undefined,
    procedureName: ROUTE_CODE_TO_PROCEDURE[routeCode] ?? procedureNameFromRouteCode(routeCode),
  };
}

function parseLegRecord(line: string, routeText: string) {
  // 全宽行（132 列）按列位解析：序号 27-29 | Fix 30-34（导航台型短 Fix 空格补齐，如 "PU   "）
  // | 区域+section 35-38 | 续行号 39 | 航路点描述 40-43。3E 等规划续行不参与腿段合并。
  if (line.length >= 120) {
    const sequence = line.slice(26, 29);
    if (!/^\d{3}$/.test(sequence)) return undefined;
    const continuation = line[38];
    const base = {
      sequence,
      fix: line.slice(29, 34).trim(),
      fixSection: line.slice(36, 38).trim() || undefined,
      recordText: line.slice(26, 43),
    };
    if (continuation === '2' && line[39] === 'P') {
      return { ...base, recordPart: '2P' as const, endOfProcedure: false };
    }
    if (continuation === '1') {
      return { ...base, recordPart: '1E' as const, endOfProcedure: line[40] === 'E' };
    }
    return undefined;
  }

  const afterRoute = line.slice(line.indexOf(routeText) + routeText.length);
  const candidates = [afterRoute, line];
  const pathTerminatorPattern = PATH_TERMINATORS.join('|');
  for (const candidate of candidates) {
    // 续行号+航路点描述：1E / 1EE / 1EY（Y=飞越）等一律视为主记录，2P 为续行
    const match = candidate.match(/(\d{3})([A-Z0-9]{5})([A-Z0-9]{4})(1[A-Z]{1,4}|2P)(?:\b|$)/);
    if (match) {
      return {
        sequence: match[1],
        fix: match[2],
        // 4 字符 = ICAO 区域(2) + section/subsection(2)，如 WMEA / WMPC
        fixSection: match[3].slice(2),
        recordPart: match[4].startsWith('2P') ? '2P' as const : '1E' as const,
        // 航路点描述第 2 字符为 E（如 1EE）标记程序末段腿
        endOfProcedure: match[4].charAt(0) === '1' && match[4].charAt(2) === 'E',
        recordText: match[0],
      };
    }

    const noFixContinuationMatch = candidate.match(/(\d{3})\s+2P(?:\s|$)/);
    if (noFixContinuationMatch) {
      return {
        sequence: noFixContinuationMatch[1],
        fix: '',
        fixSection: undefined,
        recordPart: '2P' as const,
        endOfProcedure: false,
        recordText: noFixContinuationMatch[0],
      };
    }

    const noFixMatch = candidate.match(new RegExp(`(\\d{3})\\s+([123][A-Z]?)\\s+(?:([LR])\\s+)?(${pathTerminatorPattern})(?=[A-Z0-9\\s]|$)`));
    if (noFixMatch) {
      return {
        sequence: noFixMatch[1],
        fix: '',
        fixSection: undefined,
        recordPart: noFixMatch[2].startsWith('2P') ? '2P' as const : '1E' as const,
        endOfProcedure: false,
        recordText: noFixMatch[0],
        turnDirection: noFixMatch[3] as 'L' | 'R' | undefined,
        pathTerminator: noFixMatch[4],
      };
    }
  }
  return undefined;
}

function procedureNameFromRouteCode(routeCode: string) {
  const match = routeCode.match(/^([A-Z]{4})(\d[A-Z])$/);
  if (!match) return routeCode;
  return `${match[1]} ${match[2]}`;
}

function extractPathTerminator(line: string) {
  // 全宽行 PT 固定在第 48-49 列（0 基 47-48）
  if (line.length >= 120) {
    const token = line.slice(47, 49);
    return /^[A-Z]{2}$/.test(token) ? token : undefined;
  }
  const terms = PATH_TERMINATORS.join('|');
  const spaced = line.match(new RegExp(`(?:^|[^A-Z])(${terms})(?:[^A-Z]|$)`));
  if (spaced) return spaced[1];

  // Static text exports sometimes lose spacing. Prefer the first plausible PT
  // after the record identifier, but avoid treating route suffixes as PTs.
  const afterRecord = line.replace(/^.*\d{3}[A-Z0-9]{5}[A-Z0-9]{4}1E+/, '');
  return PATH_TERMINATORS.find((term) => afterRecord.includes(term));
}

function extractTurnDirection(line: string, recordText: string): 'L' | 'R' | '' | undefined {
  // 全宽行转弯方向固定在第 44 列（0 基 43）；RNP 列紧随其后（如 R010RF），正则会漏
  if (line.length >= 120) {
    const turn = line[43];
    return turn === 'L' || turn === 'R' ? turn : undefined;
  }
  const afterRecord = line.slice(line.indexOf(recordText) + recordText.length);
  const match = afterRecord.match(/(?:^|\s)([LR])(?:\s|$)/);
  return match ? (match[1] as 'L' | 'R') : undefined;
}

function extractAltitude(line: string, recordText: string) {
  // 全宽行按列位读取：高度描述符 83 列（+/-/B），数值 85-89 列（支持 FLxxx 飞行高度层）
  if (line.length >= 120) {
    const token = line.slice(84, 89).trim();
    const value = parseAltitudeToken(token);
    if (value === undefined) return undefined;
    const desc = line[82];
    const sign = desc === '+' || desc === '-' ? desc : '';
    const rawPrefix = sign || (desc === 'B' ? 'B' : '');
    return { raw: `${rawPrefix}${token}`, value };
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

function extractTheta(line: string) {
  const value = positionalDigits(line, 62, 4);
  if (value === undefined) return undefined;
  const theta = value / 10;
  return theta <= 360 ? theta : undefined;
}

function extractRho(line: string) {
  const value = positionalDigits(line, 66, 4);
  if (value === undefined) return undefined;
  return Number((value / 10).toFixed(1));
}

// 第二高度：第 90-94 列（0 基 89-93），仅 B 型（BETWEEN）等双高度约束才有。
// 注意：第 95-99 列（0 基 94-98）是过渡高度/过渡高度层（如 WMKJ 13000、VHHH 09000），
// 属机场级信息而非腿段约束，刻意不读。
function extractSecondAltitude(line: string) {
  const value = parseAltitudeToken(line.slice(89, 94).trim());
  return value !== undefined && value >= 500 && value <= 60000 ? value : undefined;
}

// 速度限制：第 100-102 列（0 基 99-101），3 位 KIAS，如 205/210/230。
function extractSpeedLimit(line: string) {
  const value = positionalDigits(line, 99, 3);
  return value !== undefined && value >= 100 && value <= 400 ? value : undefined;
}

function parseAltitudeToken(token: string) {
  const flightLevel = token.match(/^FL(\d{2,3})$/);
  if (flightLevel) return Number(flightLevel[1]) * 100;
  return /^\d{4,5}$/.test(token) ? Number(token) : undefined;
}

// 推荐导航台：AF/CI/CF 腿在第 51-54 列（0 基 50-53）；
// 中心 Fix（RF 弧心如 HH941、IF 参考台）在第 107-111 列（0 基 106-110，最长 5 字符）。
function extractRecommendedNavaid(line: string) {
  const primary = line.slice(50, 54).trim();
  if (/^[A-Z]{2,4}$/.test(primary)) return primary;
  const centerFix = line.slice(106, 111).trim();
  if (/^[A-Z][A-Z0-9]{1,4}$/.test(centerFix)) return centerFix;
  return undefined;
}

function positionalDigits(line: string, start: number, length: number) {
  const slice = line.slice(start, start + length);
  return slice.length === length && /^\d+$/.test(slice) ? Number(slice) : undefined;
}

function extractDistance(line: string, recordText: string) {
  // 全宽行 2P 距离固定在第 75-78 列（0 基 74-77），×10
  if (line.length >= 120) {
    const value = positionalDigits(line, 74, 4);
    return value === undefined ? undefined : Number((value / 10).toFixed(1));
  }
  const afterRecord = line.slice(line.indexOf(recordText) + recordText.length);
  const match = [...afterRecord.matchAll(/\b(\d{4})\b/g)].at(-1);
  if (!match) return undefined;
  return Number((Number(match[1]) / 10).toFixed(1));
}

function compareProcedureLegs(a: Pick<SimpleProcedureLeg, 'procedureName' | 'sequence'>, b: Pick<SimpleProcedureLeg, 'procedureName' | 'sequence'>) {
  return a.procedureName.localeCompare(b.procedureName) || Number(a.sequence) - Number(b.sequence);
}
