import { deriveRouteCode } from './routeCode';
import type { FieldCompareResult, LegCompareResult, ProcedureCompareResult, SimpleProcedureLeg } from './types';

const DISTANCE_TOLERANCE_NM = 0.1;
const COURSE_TOLERANCE_DEG = 1;

const FIELD_WEIGHTS = {
  fix: 23,
  pathTerminator: 18,
  distanceNm: 13,
  altitudeValue: 10,
  courseDegMag: 10,
  altitudeSign: 5,
  altitudeUpperFt: 5,
  turnDirection: 5,
  recommendedNavaid: 3,
  speedLimitKias: 3,
  flyOver: 2,
  holdingAtFix: 2,
  endOfProcedure: 1,
};

// AI 程序名与 424 记录名写法常不一致（跑道后缀、5 字母 Fix 截断），
// 用 424 路线代码（parser 已存入 leg.routeKey）把 Jeppesen 腿段改挂到 AI 的程序名下。
// 跑道同理：424 用 RW02B（B=全部平行跑道）而 AI 用 RW02L/02C/02R，
// 路线代码匹配且跑道号一致时，直接采用 AI 侧跑道，保证过滤与对齐键一致。
export function alignJeppesenProcedureNames(aiLegs: SimpleProcedureLeg[], jeppesenLegs: SimpleProcedureLeg[]): SimpleProcedureLeg[] {
  const codeToAi = new Map<string, Array<{ procedureName: string; runway: string; transitionName?: string }>>();
  for (const leg of aiLegs) {
    const code = deriveRouteCode(leg.procedureName);
    if (!code) continue;
    const variants = codeToAi.get(code) ?? [];
    if (!variants.some((item) => item.procedureName === leg.procedureName
      && item.runway === leg.runway
      && item.transitionName === leg.transitionName)) {
      variants.push({ procedureName: leg.procedureName, runway: leg.runway, transitionName: leg.transitionName });
    }
    codeToAi.set(code, variants);
  }
  return jeppesenLegs.map((leg) => {
    const variants = leg.routeKey ? codeToAi.get(leg.routeKey.trim().toUpperCase()) ?? [] : [];
    const ai = findAiRouteVariant(leg, variants);
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
    const [procedureName, runway, transitionName = ''] = key.split('|');
    const aiProcedureLegs = sortLegs(aiLegs.filter((leg) => procedureKey(leg) === key));
    const jeppesenProcedureLegs = sortLegs(jeppesenLegs.filter((leg) => procedureKey(leg) === key));
    const legResults = alignProcedureLegs(aiProcedureLegs, jeppesenProcedureLegs)
      .map(({ ai, jeppesen }) => compareLeg(ai?.sequence ?? jeppesen?.sequence ?? '', ai, jeppesen));
    const matchedLegs = legResults.filter((result) => result.status === 'MATCH').length;
    const partialLegs = legResults.filter((result) => result.status === 'PARTIAL').length;
    const mismatchedLegs = legResults.filter((result) => result.status === 'MISMATCH').length;
    return {
      procedureName,
      runway,
      transitionName: transitionName || undefined,
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
    compareField('flyOver', ai.flyOver ?? false, jeppesen.flyOver ?? false, (ai.flyOver ?? false) === (jeppesen.flyOver ?? false), 'ERROR'),
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
  return `${leg.procedureName}|${leg.runway}|${leg.transitionName ?? ''}`;
}

function findAiRouteVariant(
  jeppesen: Pick<SimpleProcedureLeg, 'runway' | 'transitionName'>,
  variants: Array<{ procedureName: string; runway: string; transitionName?: string }>,
) {
  if (jeppesen.transitionName) {
    const transition = jeppesen.transitionName.trim().toUpperCase();
    return variants.find((item) => item.transitionName?.trim().toUpperCase() === transition);
  }
  const jeppRunway = normalizedRunway(jeppesen.runway);
  const exact = variants.find((item) => !item.transitionName && normalizedRunway(item.runway) === jeppRunway);
  if (exact) return exact;
  return variants.find((item) => !item.transitionName && runwayGroupCompatible(jeppesen.runway, item.runway));
}

function runwayGroupCompatible(a: string, b: string) {
  const left = normalizedRunway(a);
  const right = normalizedRunway(b);
  const hasGroupMarker = /B$/.test(left) || /B$/.test(right)
    || runwayNumbers(left).length > 1 || runwayNumbers(right).length > 1;
  return hasGroupMarker && runwayNumbersOverlap(left, right);
}

function normalizedRunway(value: string) {
  return value.trim().toUpperCase().replace(/^RWY/, 'RW').replace(/\s+/g, '');
}

function sortLegs(legs: SimpleProcedureLeg[]) {
  return [...legs].sort((a, b) => Number(a.sequence) - Number(b.sequence));
}

// AIP tables and vendor 424 datasets may assign different sequence numbers to
// the same ordered leg (for example 030 versus 070). Align by route order and
// leg semantics; sequence equality is only a tie-breaker.
function alignProcedureLegs(ai: SimpleProcedureLeg[], jeppesen: SimpleProcedureLeg[]) {
  const rows = ai.length + 1;
  const cols = jeppesen.length + 1;
  const score = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
  const move = Array.from({ length: rows }, () => new Array<'PAIR' | 'AI' | 'JEPP'>(cols).fill('PAIR'));
  const gapPenalty = -2;
  for (let i = 1; i < rows; i += 1) {
    score[i][0] = i * gapPenalty;
    move[i][0] = 'AI';
  }
  for (let j = 1; j < cols; j += 1) {
    score[0][j] = j * gapPenalty;
    move[0][j] = 'JEPP';
  }
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const pair = score[i - 1][j - 1] + legAlignmentScore(ai[i - 1], jeppesen[j - 1]);
      const skipAi = score[i - 1][j] + gapPenalty;
      const skipJepp = score[i][j - 1] + gapPenalty;
      if (pair >= skipAi && pair >= skipJepp) {
        score[i][j] = pair;
        move[i][j] = 'PAIR';
      } else if (skipAi >= skipJepp) {
        score[i][j] = skipAi;
        move[i][j] = 'AI';
      } else {
        score[i][j] = skipJepp;
        move[i][j] = 'JEPP';
      }
    }
  }

  const aligned: Array<{ ai?: SimpleProcedureLeg; jeppesen?: SimpleProcedureLeg }> = [];
  let i = ai.length;
  let j = jeppesen.length;
  while (i > 0 || j > 0) {
    const selected = move[i][j];
    if (i > 0 && j > 0 && selected === 'PAIR') {
      aligned.push({ ai: ai[i - 1], jeppesen: jeppesen[j - 1] });
      i -= 1;
      j -= 1;
    } else if (i > 0 && (j === 0 || selected === 'AI')) {
      aligned.push({ ai: ai[i - 1] });
      i -= 1;
    } else {
      aligned.push({ jeppesen: jeppesen[j - 1] });
      j -= 1;
    }
  }
  return aligned.reverse();
}

function legAlignmentScore(ai: SimpleProcedureLeg, jeppesen: SimpleProcedureLeg) {
  const aiFix = String(ai.fix ?? '').trim().toUpperCase();
  const jeppFix = String(jeppesen.fix ?? '').trim().toUpperCase();
  const aiPt = String(ai.pathTerminator ?? '').trim().toUpperCase();
  const jeppPt = String(jeppesen.pathTerminator ?? '').trim().toUpperCase();
  let score = aiFix && aiFix === jeppFix ? 4 : (!aiFix && !jeppFix ? 1 : -3);
  score += aiPt && aiPt === jeppPt ? 2 : -1;
  if (ai.sequence === jeppesen.sequence) score += 1;
  return score;
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
