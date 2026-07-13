import { deriveRouteCode } from './routeCode';
import type { FieldCompareResult, LegCompareResult, ProcedureCompareResult, SimpleProcedureLeg } from './types';

const DISTANCE_TOLERANCE_NM = 0.1;
const COURSE_TOLERANCE_DEG = 1;

const FIELD_WEIGHTS = {
  fix: 25,
  pathTerminator: 18,
  distanceNm: 13,
  altitudeValue: 10,
  courseDegMag: 10,
  altitudeSign: 5,
  altitudeUpperFt: 5,
  turnDirection: 5,
  recommendedNavaid: 3,
  speedLimitKias: 3,
  holdingAtFix: 2,
  endOfProcedure: 1,
};

// AI 程序名与 424 记录名写法常不一致（跑道后缀、5 字母 Fix 截断），
// 用 424 路线代码（parser 已存入 leg.routeKey）把 Jeppesen 腿段改挂到 AI 的程序名下。
// 跑道同理：424 用 RW02B（B=全部平行跑道）而 AI 用 RW02L/02C/02R，
// 路线代码匹配且跑道号一致时，直接采用 AI 侧跑道，保证过滤与对齐键一致。
export function alignJeppesenProcedureNames(aiLegs: SimpleProcedureLeg[], jeppesenLegs: SimpleProcedureLeg[]): SimpleProcedureLeg[] {
  const codeToAi = new Map<string, { procedureName: string; runway: string }>();
  for (const leg of aiLegs) {
    const code = deriveRouteCode(leg.procedureName);
    if (code && !codeToAi.has(code)) codeToAi.set(code, { procedureName: leg.procedureName, runway: leg.runway });
  }
  return jeppesenLegs.map((leg) => {
    const ai = leg.routeKey ? codeToAi.get(leg.routeKey.trim().toUpperCase()) : undefined;
    if (!ai) return leg;
    return {
      ...leg,
      procedureName: ai.procedureName,
      runway: runwayNumbersOverlap(leg.runway, ai.runway) ? ai.runway : leg.runway,
    };
  });
}

function runwayNumbersOverlap(a: string, b: string) {
  const numbersA = runwayNumbers(a);
  const numbersB = runwayNumbers(b);
  return numbersA.some((value) => numbersB.includes(value));
}

function runwayNumbers(value: string) {
  return [...String(value ?? '').matchAll(/(\d{2})/g)].map((match) => match[1]);
}

export function compareSimpleProcedureLegs(aiLegs: SimpleProcedureLeg[], jeppesenLegs: SimpleProcedureLeg[]): ProcedureCompareResult[] {
  const procedureKeys = new Set<string>();
  for (const leg of [...aiLegs, ...jeppesenLegs]) {
    procedureKeys.add(procedureKey(leg));
  }

  return [...procedureKeys].sort().map((key) => {
    const [procedureName, runway] = key.split('|');
    const aiBySequence = bySequence(aiLegs.filter((leg) => procedureKey(leg) === key));
    const jeppesenBySequence = bySequence(jeppesenLegs.filter((leg) => procedureKey(leg) === key));
    const sequences = [...new Set([...aiBySequence.keys(), ...jeppesenBySequence.keys()])].sort((a, b) => Number(a) - Number(b));
    const legResults = sequences.map((sequence) => compareLeg(sequence, aiBySequence.get(sequence), jeppesenBySequence.get(sequence)));
    const matchedLegs = legResults.filter((result) => result.status === 'MATCH').length;
    const partialLegs = legResults.filter((result) => result.status === 'PARTIAL').length;
    const mismatchedLegs = legResults.filter((result) => result.status === 'MISMATCH').length;
    return {
      procedureName,
      runway,
      totalLegs: legResults.length,
      matchedLegs,
      partialLegs,
      mismatchedLegs,
      score: roundScore(average(legResults.map((result) => result.score))),
      legResults,
    };
  });
}

function compareLeg(sequence: string, ai: SimpleProcedureLeg | undefined, jeppesen: SimpleProcedureLeg | undefined): LegCompareResult {
  const procedureName = ai?.procedureName ?? jeppesen?.procedureName ?? '';
  if (!ai) {
    return { procedureName, sequence, jeppesen, fieldResults: [], score: 0, status: 'MISSING_AI' };
  }
  if (!jeppesen) {
    return { procedureName, sequence, ai, fieldResults: [], score: 0, status: 'MISSING_JEPPESEN' };
  }

  const fieldResults: FieldCompareResult[] = [
    compareField('fix', ai.fix, jeppesen.fix, sameText(ai.fix, jeppesen.fix), 'ERROR'),
    compareField('pathTerminator', ai.pathTerminator, jeppesen.pathTerminator, sameText(ai.pathTerminator, jeppesen.pathTerminator), 'ERROR'),
    compareField('turnDirection', ai.turnDirection || '', jeppesen.turnDirection || '', turnDirectionMatches(ai, jeppesen), 'WARNING'),
    compareField('distanceNm', ai.distanceNm, jeppesen.distanceNm, sameOptionalDistance(ai.distanceNm, jeppesen.distanceNm), 'WARNING'),
    compareField('altitudeValue', ai.altitudeValue, jeppesen.altitudeValue, sameOptionalNumber(ai.altitudeValue, jeppesen.altitudeValue), 'ERROR'),
    compareField('altitudeSign', ai.altitudeSign || '', jeppesen.altitudeSign || '', sameOptionalText(ai.altitudeSign, jeppesen.altitudeSign), 'ERROR'),
    compareField('altitudeUpperFt', ai.altitudeUpperFt, jeppesen.altitudeUpperFt, sameOptionalNumber(ai.altitudeUpperFt, jeppesen.altitudeUpperFt), 'WARNING'),
    // Jeppesen 只在 CI/AF 腿编码磁航向；TF/IF 腿上 AI 有航向而 424 留空不算差异
    compareField('courseDegMag', ai.courseDegMag, jeppesen.courseDegMag, courseMatches(ai, jeppesen), 'WARNING'),
    // 推荐导航台只在 IF/AF 腿上要求（本例为弧心 VJB）
    compareField('recommendedNavaid', ai.recommendedNavaid ?? '', jeppesen.recommendedNavaid ?? '', navaidMatches(ai, jeppesen), 'WARNING'),
    compareField('speedLimitKias', ai.speedLimitKias, jeppesen.speedLimitKias, sameOptionalNumber(ai.speedLimitKias, jeppesen.speedLimitKias), 'WARNING'),
    // fixSection 不计分：AI 侧是启发式推断（首腿 EA），而 424 中途航路点也可为 EA（如 WSSS 的 BOBAG），
    // 计分只会把我们自己的猜测误记成模型差异。表格“标记”列仍展示两侧取值。
    compareField('holdingAtFix', ai.holdingAtFix ?? false, jeppesen.holdingAtFix ?? false, (ai.holdingAtFix ?? false) === (jeppesen.holdingAtFix ?? false), 'WARNING'),
    compareField('endOfProcedure', ai.endOfProcedure ?? false, jeppesen.endOfProcedure ?? false, (ai.endOfProcedure ?? false) === (jeppesen.endOfProcedure ?? false), 'WARNING'),
  ];
  const score = scoreFields(fieldResults);
  return {
    procedureName,
    sequence,
    ai,
    jeppesen,
    fieldResults,
    score,
    status: score >= 99.999 ? 'MATCH' : score > 0 ? 'PARTIAL' : 'MISMATCH',
  };
}

function compareField(field: FieldCompareResult['field'], aiValue: unknown, jeppesenValue: unknown, matched: boolean, severity: FieldCompareResult['severity']): FieldCompareResult {
  return {
    field,
    aiValue,
    jeppesenValue,
    matched,
    severity: matched ? 'INFO' : severity,
  };
}

function scoreFields(fieldResults: FieldCompareResult[]) {
  const score = fieldResults.reduce((sum, result) => {
    const field = result.field as keyof typeof FIELD_WEIGHTS;
    return sum + (result.matched ? FIELD_WEIGHTS[field] : 0);
  }, 0);
  return roundScore(score);
}

function procedureKey(leg: SimpleProcedureLeg) {
  return `${leg.procedureName}|${leg.runway}`;
}

function bySequence(legs: SimpleProcedureLeg[]) {
  return new Map(legs.map((leg) => [leg.sequence, leg]));
}

function sameText(a: unknown, b: unknown) {
  return String(a ?? '').trim().toUpperCase() === String(b ?? '').trim().toUpperCase();
}

function sameOptionalText(a: unknown, b: unknown) {
  const left = String(a ?? '').trim().toUpperCase();
  const right = String(b ?? '').trim().toUpperCase();
  if (!left && !right) return true;
  return left === right;
}

function sameOptionalDistance(a: number | undefined, b: number | undefined) {
  if (a === undefined && b === undefined) return true;
  if (a === undefined || b === undefined) return false;
  return Math.abs(a - b) <= DISTANCE_TOLERANCE_NM;
}

function sameOptionalNumber(a: number | undefined, b: number | undefined) {
  if (a === undefined && b === undefined) return true;
  if (a === undefined || b === undefined) return false;
  return a === b;
}

function turnDirectionMatches(ai: SimpleProcedureLeg, jeppesen: SimpleProcedureLeg) {
  if (sameOptionalText(ai.turnDirection, jeppesen.turnDirection)) return true;

  const aiTurn = String(ai.turnDirection ?? '').trim().toUpperCase();
  const jeppesenTurn = String(jeppesen.turnDirection ?? '').trim().toUpperCase();
  const pathTerminator = String(jeppesen.pathTerminator ?? ai.pathTerminator ?? '').toUpperCase();
  const isTerminalTransitionFix = (jeppesen.endOfProcedure || ai.endOfProcedure)
    && String(jeppesen.fixSection ?? ai.fixSection ?? '').toUpperCase() === 'EA'
    && ['DF', 'TF'].includes(pathTerminator)
    && Boolean(jeppesen.fix || ai.fix);

  if (!jeppesenTurn && (aiTurn === 'L' || aiTurn === 'R') && isTerminalTransitionFix) return true;
  return false;
}

function navaidMatches(ai: SimpleProcedureLeg, jeppesen: SimpleProcedureLeg) {
  const pathTerminator = String(jeppesen.pathTerminator ?? ai.pathTerminator ?? '').toUpperCase();
  const navaidCoded = pathTerminator === 'IF' || pathTerminator === 'AF' || jeppesen.recommendedNavaid !== undefined;
  if (!navaidCoded) return true;
  return sameOptionalText(ai.recommendedNavaid, jeppesen.recommendedNavaid);
}

function courseMatches(ai: SimpleProcedureLeg, jeppesen: SimpleProcedureLeg) {
  const pathTerminator = String(jeppesen.pathTerminator ?? ai.pathTerminator ?? '').toUpperCase();
  const courseCoded = pathTerminator === 'CI' || pathTerminator === 'AF' || jeppesen.courseDegMag !== undefined;
  if (!courseCoded) return true;
  return sameOptionalCourse(ai.courseDegMag, jeppesen.courseDegMag);
}

function sameOptionalCourse(a: number | undefined, b: number | undefined) {
  if (a === undefined && b === undefined) return true;
  if (a === undefined || b === undefined) return false;
  const diff = Math.abs(a - b) % 360;
  return Math.min(diff, 360 - diff) <= COURSE_TOLERANCE_DEG;
}

function average(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function roundScore(value: number) {
  return Math.round(value * 10) / 10;
}
