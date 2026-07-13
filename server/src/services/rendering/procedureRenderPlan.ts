import type {
  GeoJsonRenderMode,
  GeoJsonRenderSource,
  ProcedureGroup,
  ProcedureUnderstandingProcedure,
  ProcedureUnderstandingResult,
} from '../../types/procedure';
import type { SimpleProcedureLeg } from '../jeppesen424/types';

export interface ProcedureRenderPlan {
  requestedMode: GeoJsonRenderMode;
  source: GeoJsonRenderSource;
  procedures: ProcedureUnderstandingProcedure[];
  canonicalProcedureCount: number;
  canonicalLegCount: number;
  aiProcedureCount: number;
  warnings: string[];
}

export function buildProcedureRenderPlan(
  understanding: ProcedureUnderstandingResult,
  group: ProcedureGroup,
  canonicalLegs: SimpleProcedureLeg[] = [],
  requestedMode: GeoJsonRenderMode = 'AUTO',
): ProcedureRenderPlan {
  const aiProcedures = (understanding.procedures ?? []).map(cloneProcedure);
  if (requestedMode === 'AI') return aiPlan(aiProcedures, requestedMode);

  const runway = normalizeRunway(understanding.runway ?? group.runway);
  const targetNames = new Set(
    [
      ...aiProcedures.map((procedure) => procedure.procedureName),
      ...(group.procedureNames ?? []),
    ]
      .map(normalizeProcedureName)
      .filter(Boolean),
  );
  const applicableLegs = canonicalLegs.filter((leg) => {
    if (runway && normalizeRunway(leg.runway) !== runway) return false;
    if (!targetNames.size) return true;
    return [...targetNames].some((target) => procedureNamesMatch(target, leg.procedureName));
  });
  const canonicalGroups = groupCanonicalLegs(applicableLegs);

  if (!canonicalGroups.length) {
    const warning = 'No matching Jeppesen 424 procedures were found for this package.';
    return {
      ...aiPlan(aiProcedures, requestedMode),
      warnings: requestedMode === 'JEPPESEN_424' ? [warning] : [],
    };
  }

  const usedCanonical = new Set<string>();
  const procedures = aiProcedures.map((procedure) => {
    const canonical = canonicalGroups.find((candidate) => procedureNamesMatch(procedure.procedureName, candidate.procedureName));
    if (!canonical) return procedure;
    usedCanonical.add(canonical.key);
    return canonicalProcedure(procedure, canonical.procedureName, canonical.runway, canonical.legs);
  });

  for (const canonical of canonicalGroups) {
    if (usedCanonical.has(canonical.key)) continue;
    if (targetNames.size && ![...targetNames].some((target) => procedureNamesMatch(target, canonical.procedureName))) continue;
    procedures.push(canonicalProcedure(undefined, canonical.procedureName, canonical.runway, canonical.legs));
    usedCanonical.add(canonical.key);
  }

  const canonicalProcedureCount = usedCanonical.size;
  const canonicalLegCount = canonicalGroups
    .filter((grouped) => usedCanonical.has(grouped.key))
    .reduce((sum, grouped) => sum + grouped.legs.length, 0);
  const aiOnlyProcedures = procedures.filter((procedure) => !procedureUses424(procedure)).length;
  const source: GeoJsonRenderSource = aiOnlyProcedures ? 'HYBRID' : 'JEPPESEN_424';
  const warnings = aiOnlyProcedures
    ? [`${aiOnlyProcedures} procedure(s) have no matching 424 record and still use AI legs.`]
    : [];

  return {
    requestedMode,
    source,
    procedures,
    canonicalProcedureCount,
    canonicalLegCount,
    aiProcedureCount: aiProcedures.length,
    warnings,
  };
}

export function procedureUses424(procedure: ProcedureUnderstandingProcedure) {
  return (procedure.legs ?? []).some((leg) => String(leg.renderSource ?? '') === 'JEPPESEN_424');
}

function aiPlan(procedures: ProcedureUnderstandingProcedure[], requestedMode: GeoJsonRenderMode): ProcedureRenderPlan {
  return {
    requestedMode,
    source: 'AI',
    procedures,
    canonicalProcedureCount: 0,
    canonicalLegCount: 0,
    aiProcedureCount: procedures.length,
    warnings: [],
  };
}

function groupCanonicalLegs(legs: SimpleProcedureLeg[]) {
  const grouped = new Map<string, { key: string; procedureName: string; runway: string; legs: SimpleProcedureLeg[] }>();
  for (const leg of legs) {
    const key = `${normalizeProcedureName(leg.procedureName)}|${normalizeRunway(leg.runway)}`;
    const current = grouped.get(key) ?? { key, procedureName: leg.procedureName, runway: leg.runway, legs: [] };
    current.legs.push(leg);
    grouped.set(key, current);
  }
  return [...grouped.values()].map((item) => ({
    ...item,
    legs: [...item.legs].sort((a, b) => Number(a.sequence) - Number(b.sequence)),
  }));
}

function canonicalProcedure(
  aiProcedure: ProcedureUnderstandingProcedure | undefined,
  procedureName: string,
  runway: string,
  legs: SimpleProcedureLeg[],
): ProcedureUnderstandingProcedure {
  return {
    ...aiProcedure,
    procedureName: aiProcedure?.procedureName ?? procedureName,
    runway: aiProcedure?.runway ?? runway,
    legs: legs.map((leg, index) => canonicalLeg(leg, legs[index - 1], legs[index + 1])),
    confidence: Math.max(aiProcedure?.confidence ?? 0, 0.98),
    reviewRequired: false,
  };
}

function canonicalLeg(leg: SimpleProcedureLeg, previous: SimpleProcedureLeg | undefined, next: SimpleProcedureLeg | undefined) {
  const altitudeConstraint = leg.altitudeValue === undefined && leg.altitudeUpperFt === undefined
    ? null
    : {
      type: leg.altitudeSign === '+' ? 'AT_OR_ABOVE' : leg.altitudeSign === '-' ? 'AT_OR_BELOW' : 'AT',
      altitudeFt: leg.altitudeValue ?? null,
      lowerFt: leg.altitudeSign === '+' ? leg.altitudeValue ?? null : null,
      upperFt: leg.altitudeUpperFt ?? (leg.altitudeSign === '-' ? leg.altitudeValue ?? null : null),
      rawText: [leg.altitudeRaw, leg.altitudeUpperFt].filter((value) => value !== undefined && value !== '').join(' ') || null,
    };
  const radial = leg.thetaDegMag ?? (String(leg.pathTerminator ?? '').toUpperCase() === 'CI' ? next?.thetaDegMag : undefined);
  const navaid = leg.recommendedNavaid ?? next?.recommendedNavaid;

  return {
    sequence: Number(leg.sequence),
    pathTerminator: leg.pathTerminator ?? null,
    fromFix: previous?.fix || null,
    fixIdentifier: leg.fix || null,
    courseDegMag: leg.courseDegMag ?? null,
    distanceNm: leg.distanceNm ?? null,
    turnDirection: leg.turnDirection || null,
    recommendedNavaid: leg.recommendedNavaid ?? null,
    thetaDegMag: leg.thetaDegMag ?? null,
    rhoNm: leg.rhoNm ?? null,
    altitudeConstraint,
    remarks: radial !== undefined && navaid
      ? `RDL${String(Math.round(radial)).padStart(3, '0')} ${navaid}`
      : null,
    fixSection: leg.fixSection ?? null,
    endOfProcedure: leg.endOfProcedure ?? false,
    holdingAtFix: leg.holdingAtFix ?? false,
    renderSource: 'JEPPESEN_424',
    derivationMethod: 'Jeppesen 424 static text',
    source424Record: leg.rawRecord ?? null,
    confidence: 0.98,
    reviewRequired: false,
  };
}

function cloneProcedure(procedure: ProcedureUnderstandingProcedure): ProcedureUnderstandingProcedure {
  return {
    ...procedure,
    legs: (procedure.legs ?? []).map((leg) => ({
      ...leg,
      altitudeConstraint: leg.altitudeConstraint && typeof leg.altitudeConstraint === 'object'
        ? { ...(leg.altitudeConstraint as Record<string, unknown>) }
        : leg.altitudeConstraint,
    })),
  };
}

function procedureNamesMatch(left: unknown, right: unknown) {
  const a = normalizeProcedureName(left);
  const b = normalizeProcedureName(right);
  if (!a || !b) return false;
  return a === b || procedureSignature(a) === procedureSignature(b);
}

function procedureSignature(value: string) {
  const match = value.match(/^([A-Z][A-Z0-9]{2,5})\s*(\d[A-Z])$/);
  return match ? `${match[1].slice(0, 4)}|${match[2]}` : value;
}

function normalizeProcedureName(value: unknown) {
  return String(value ?? '').trim().toUpperCase().replace(/\s+/g, ' ');
}

function normalizeRunway(value: unknown) {
  const text = String(value ?? '').trim().toUpperCase().replace(/\s+/g, '').replace(/^RWY/, 'RW');
  const match = text.match(/RW(\d{2}[A-Z]?)/);
  return match ? `RW${match[1]}` : text;
}
