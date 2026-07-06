import type { EvaluationError, EvaluationResult, EvaluationWarning, ProcedureUnderstandingResult } from '../../types/procedure';

export interface GoldenCase {
  caseId: string;
  packageName: string;
  procedures: GoldenProcedure[];
  waypoints: string[];
}

interface GoldenProcedure {
  procedureName: string;
  legs: GoldenLeg[];
}

interface GoldenLeg {
  sequence: number;
  pathTerminator?: string;
  fixIdentifier?: string;
  courseDegMag?: number;
  distanceNm?: number;
  turnDirection?: string;
  altitudeConstraint?: GoldenAltitude;
  navigationSpec?: string;
}

interface GoldenAltitude {
  type?: string;
  altitudeFt?: number;
  lowerFt?: number;
  upperFt?: number;
}

const COURSE_TOLERANCE_DEG = 1;
const DISTANCE_TOLERANCE_NM = 0.1;

export function evaluateProcedureUnderstanding(
  actual: ProcedureUnderstandingResult | undefined,
  expected: GoldenCase,
): EvaluationResult {
  const errors: EvaluationError[] = [];
  const warnings: EvaluationWarning[] = [];
  const schemaValid = validateShape(actual, errors);
  const actualProcedures = actual?.procedures ?? [];
  const actualByName = new Map(actualProcedures.map((procedure) => [normalizeName(procedure.procedureName), procedure]));

  let procedureNameHits = 0;
  let legCountHits = 0;
  let pathTerminatorHits = 0;
  let fixHits = 0;
  let courseHits = 0;
  let courseTotal = 0;
  let distanceHits = 0;
  let distanceTotal = 0;
  let altitudeHits = 0;
  let altitudeTotal = 0;
  let evidenceHits = 0;
  let evidenceTotal = 0;
  let pathTotal = 0;
  let fixTotal = 0;

  for (const expectedProcedure of expected.procedures) {
    const actualProcedure = actualByName.get(normalizeName(expectedProcedure.procedureName));
    if (!actualProcedure) {
      errors.push(error('MISSING_PROCEDURE', `Missing procedure ${expectedProcedure.procedureName}`, expectedProcedure.procedureName));
      continue;
    }
    procedureNameHits += 1;
    const actualLegs = actualProcedure.legs ?? [];
    if (actualLegs.length === expectedProcedure.legs.length) {
      legCountHits += 1;
    } else {
      errors.push(error('LEG_COUNT', `Leg count mismatch for ${expectedProcedure.procedureName}`, expectedProcedure.procedureName, undefined, 'legs', expectedProcedure.legs.length, actualLegs.length));
    }

    const actualLegsBySequence = new Map(actualLegs.map((leg) => [numberValue(leg.sequence), leg]));
    for (const expectedLeg of expectedProcedure.legs) {
      const actualLeg = actualLegsBySequence.get(expectedLeg.sequence) ?? actualLegsBySequence.get(expectedLeg.sequence / 10);
      if (!actualLeg) {
        errors.push(error('MISSING_LEG', `Missing leg ${expectedLeg.sequence}`, expectedProcedure.procedureName, expectedLeg.sequence));
        continue;
      }

      evidenceTotal += 1;
      if (Array.isArray(actualLeg.sourceEvidenceIds) && actualLeg.sourceEvidenceIds.length > 0) evidenceHits += 1;
      else warnings.push(warning('MISSING_LEG_EVIDENCE', `Missing sourceEvidenceIds for leg ${expectedLeg.sequence}`, expectedProcedure.procedureName, expectedLeg.sequence, 'sourceEvidenceIds'));

      if (expectedLeg.pathTerminator !== undefined) {
        pathTotal += 1;
        if (textValue(actualLeg.pathTerminator) === expectedLeg.pathTerminator) pathTerminatorHits += 1;
        else errors.push(error('PATH_TERMINATOR', 'Path terminator mismatch', expectedProcedure.procedureName, expectedLeg.sequence, 'pathTerminator', expectedLeg.pathTerminator, actualLeg.pathTerminator));
      }
      if (expectedLeg.fixIdentifier !== undefined) {
        fixTotal += 1;
        if (textValue(actualLeg.fixIdentifier) === expectedLeg.fixIdentifier) fixHits += 1;
        else errors.push(error('FIX_IDENTIFIER', 'Fix identifier mismatch', expectedProcedure.procedureName, expectedLeg.sequence, 'fixIdentifier', expectedLeg.fixIdentifier, actualLeg.fixIdentifier));
      }
      if (expectedLeg.courseDegMag !== undefined) {
        courseTotal += 1;
        if (within(numberValue(actualLeg.courseDegMag), expectedLeg.courseDegMag, COURSE_TOLERANCE_DEG)) courseHits += 1;
        else errors.push(error('COURSE', 'Course mismatch', expectedProcedure.procedureName, expectedLeg.sequence, 'courseDegMag', expectedLeg.courseDegMag, actualLeg.courseDegMag));
      }
      if (expectedLeg.distanceNm !== undefined) {
        distanceTotal += 1;
        if (within(numberValue(actualLeg.distanceNm), expectedLeg.distanceNm, DISTANCE_TOLERANCE_NM)) distanceHits += 1;
        else errors.push(error('DISTANCE', 'Distance mismatch', expectedProcedure.procedureName, expectedLeg.sequence, 'distanceNm', expectedLeg.distanceNm, actualLeg.distanceNm));
      }
      if (expectedLeg.altitudeConstraint !== undefined) {
        altitudeTotal += 1;
        if (sameAltitude(actualLeg.altitudeConstraint, expectedLeg.altitudeConstraint)) altitudeHits += 1;
        else errors.push(error('ALTITUDE', 'Altitude constraint mismatch', expectedProcedure.procedureName, expectedLeg.sequence, 'altitudeConstraint', expectedLeg.altitudeConstraint, actualLeg.altitudeConstraint));
      }
    }
  }

  for (const actualProcedure of actualProcedures) {
    if (!expected.procedures.some((procedure) => normalizeName(procedure.procedureName) === normalizeName(actualProcedure.procedureName))) {
      warnings.push(warning('EXTRA_PROCEDURE', `Unexpected procedure ${actualProcedure.procedureName ?? '(unnamed)'}`, String(actualProcedure.procedureName ?? '')));
    }
  }

  const expectedFixes = new Set(expected.waypoints.map((ident) => normalizeName(ident)));
  const actualFixes = new Set((actual?.fixes ?? []).map((fix) => normalizeName(identifierOf(fix))).filter(Boolean));
  let coordinateHits = 0;
  for (const expectedFix of expectedFixes) {
    if (actualFixes.has(expectedFix)) coordinateHits += 1;
    else errors.push(error('MISSING_FIX', `Missing waypoint ${expectedFix}`, undefined, undefined, 'fixes', expectedFix, undefined));
  }

  const result = {
    procedureNameAccuracy: ratio(procedureNameHits, expected.procedures.length),
    legCountAccuracy: ratio(legCountHits, expected.procedures.length),
    pathTerminatorAccuracy: ratio(pathTerminatorHits, pathTotal),
    fixAccuracy: ratio(fixHits, fixTotal),
    courseAccuracy: ratio(courseHits, courseTotal),
    distanceAccuracy: ratio(distanceHits, distanceTotal),
    altitudeAccuracy: ratio(altitudeHits, altitudeTotal),
    coordinateAccuracy: ratio(coordinateHits, expectedFixes.size),
    sourceEvidenceCoverage: ratio(evidenceHits, evidenceTotal),
    schemaValid,
    errors,
    warnings,
  };

  return {
    totalScore: weightedScore(result),
    ...result,
  };
}

function validateShape(actual: ProcedureUnderstandingResult | undefined, errors: EvaluationError[]) {
  if (!actual || typeof actual !== 'object') {
    errors.push(error('SCHEMA', 'Actual result is not an object'));
    return false;
  }
  const required = ['procedures', 'fixes', 'sourceEvidence', 'warnings', 'confidence', 'reviewRequired'];
  for (const key of required) {
    if (!(key in actual)) errors.push(error('SCHEMA', `Missing required field ${key}`, undefined, undefined, key));
  }
  return required.every((key) => key in actual) && Array.isArray(actual.procedures) && Array.isArray(actual.fixes);
}

function weightedScore(result: Omit<EvaluationResult, 'totalScore'>) {
  const score =
    result.procedureNameAccuracy * 0.16 +
    result.legCountAccuracy * 0.10 +
    result.pathTerminatorAccuracy * 0.12 +
    result.fixAccuracy * 0.14 +
    result.courseAccuracy * 0.12 +
    result.distanceAccuracy * 0.10 +
    result.altitudeAccuracy * 0.10 +
    result.coordinateAccuracy * 0.10 +
    result.sourceEvidenceCoverage * 0.06;
  return round(score * (result.schemaValid ? 1 : 0.85));
}

function identifierOf(fix: Record<string, unknown>) {
  return fix.identifier ?? fix.ident ?? fix.fixIdentifier ?? fix.name;
}

function sameAltitude(actual: unknown, expected: GoldenAltitude) {
  if (!actual || typeof actual !== 'object') return false;
  const record = actual as Record<string, unknown>;
  return tokenValue(record.type) === tokenValue(expected.type)
    && optionalNumberEqual(numberValue(record.altitudeFt), expected.altitudeFt)
    && optionalNumberEqual(numberValue(record.lowerFt), expected.lowerFt)
    && optionalNumberEqual(numberValue(record.upperFt), expected.upperFt);
}

function optionalNumberEqual(actual: number | undefined, expected: number | undefined) {
  return expected === undefined || actual === expected;
}

function within(actual: number | undefined, expected: number, tolerance: number) {
  return actual !== undefined && Math.abs(actual - expected) <= tolerance;
}

function ratio(hit: number, total: number) {
  return total ? round(hit / total) : 1;
}

function round(value: number) {
  return Math.round(value * 1000) / 1000;
}

function textValue(value: unknown) {
  return typeof value === 'string' ? normalizeName(value) : value === undefined || value === null ? undefined : normalizeName(String(value));
}

function numberValue(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function normalizeName(value: unknown) {
  return String(value ?? '').trim().toUpperCase().replace(/\s+/g, ' ');
}

function tokenValue(value: unknown) {
  return normalizeName(value).replace(/[^A-Z0-9]+/g, '');
}

function error(code: string, message: string, procedureName?: string, sequence?: number, fieldName?: string, expected?: unknown, actual?: unknown): EvaluationError {
  return { code, message, procedureName, sequence, fieldName, expected, actual };
}

function warning(code: string, message: string, procedureName?: string, sequence?: number, fieldName?: string): EvaluationWarning {
  return { code, message, procedureName, sequence, fieldName };
}
