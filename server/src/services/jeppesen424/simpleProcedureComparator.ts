import type { FieldCompareResult, LegCompareResult, ProcedureCompareResult, SimpleProcedureLeg } from './types';

const DISTANCE_TOLERANCE_NM = 0.1;
const COURSE_TOLERANCE_DEG = 1;

const FIELD_WEIGHTS = {
  fix: 24,
  pathTerminator: 19,
  distanceNm: 14,
  altitudeValue: 10,
  courseDegMag: 10,
  altitudeSign: 5,
  altitudeUpperFt: 5,
  turnDirection: 5,
  recommendedNavaid: 3,
  fixSection: 2,
  holdingAtFix: 2,
  endOfProcedure: 1,
};

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
    return {
      procedureName,
      runway,
      totalLegs: legResults.length,
      matchedLegs,
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
    compareField('turnDirection', ai.turnDirection || '', jeppesen.turnDirection || '', sameOptionalText(ai.turnDirection, jeppesen.turnDirection), 'WARNING'),
    compareField('distanceNm', ai.distanceNm, jeppesen.distanceNm, sameOptionalDistance(ai.distanceNm, jeppesen.distanceNm), 'WARNING'),
    compareField('altitudeValue', ai.altitudeValue, jeppesen.altitudeValue, sameOptionalNumber(ai.altitudeValue, jeppesen.altitudeValue), 'ERROR'),
    compareField('altitudeSign', ai.altitudeSign || '', jeppesen.altitudeSign || '', sameOptionalText(ai.altitudeSign, jeppesen.altitudeSign), 'ERROR'),
    compareField('altitudeUpperFt', ai.altitudeUpperFt, jeppesen.altitudeUpperFt, sameOptionalNumber(ai.altitudeUpperFt, jeppesen.altitudeUpperFt), 'WARNING'),
    // Jeppesen 只在 CI/AF 腿编码磁航向；TF/IF 腿上 AI 有航向而 424 留空不算差异
    compareField('courseDegMag', ai.courseDegMag, jeppesen.courseDegMag, courseMatches(ai, jeppesen), 'WARNING'),
    // 推荐导航台只在 IF/AF 腿上要求（本例为弧心 VJB）
    compareField('recommendedNavaid', ai.recommendedNavaid ?? '', jeppesen.recommendedNavaid ?? '', navaidMatches(ai, jeppesen), 'WARNING'),
    compareField('fixSection', ai.fixSection ?? '', jeppesen.fixSection ?? '', sameOptionalText(ai.fixSection, jeppesen.fixSection), 'WARNING'),
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
