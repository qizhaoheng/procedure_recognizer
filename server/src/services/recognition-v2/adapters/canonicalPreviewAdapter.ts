import {
  RECOGNITION_V2_CONTRACT_VERSION,
  RECOGNITION_V2_SCHEMA_IDS,
  type CanonicalEntity,
  type CanonicalPreviewArtifact,
  type FusionStageResult,
  type ReleaseDecision,
  type V1V2DiffItem,
  type V1V2DiffReport,
} from '../contracts/index';
import { assertValidCanonicalPreview, assertValidV1V2DiffReport } from '../contracts/schemaValidation';
import type { ProcedureUnderstandingResult, TableLegItem } from '../../../types/procedure';

export async function buildCanonicalPreview(input: {
  fusion: FusionStageResult;
  releaseDecision: ReleaseDecision;
  v1?: ProcedureUnderstandingResult;
  now?: string;
}) {
  const warnings: string[] = [];
  const procedureUnderstanding = adaptEntities(input.fusion.entities, input.releaseDecision, warnings);
  const generatedAt = input.now ?? new Date().toISOString();
  const preview: CanonicalPreviewArtifact = {
    contractVersion: RECOGNITION_V2_CONTRACT_VERSION,
    schemaId: RECOGNITION_V2_SCHEMA_IDS.canonicalPreview,
    procedureUnderstanding: procedureUnderstanding as Record<string, unknown>,
    releaseDecision: input.releaseDecision,
    warnings,
    generatedAt,
  };
  const diff = diffProcedureUnderstanding(input.v1, procedureUnderstanding, generatedAt);
  await assertValidCanonicalPreview(preview);
  await assertValidV1V2DiffReport(diff);
  return { preview, diff };
}

function adaptEntities(entities: CanonicalEntity[], releaseDecision: ReleaseDecision, warnings: string[]): ProcedureUnderstandingResult {
  const airport = entities.find((item) => item.entityType === 'AIRPORT');
  const procedure = entities.find((item) => item.entityType === 'PROCEDURE');
  const runwayEntity = entities.find((item) => item.entityType === 'RUNWAY');
  const runwayValues = asArray(runwayEntity?.fields.runway).map(String);
  if (runwayValues.length > 1) warnings.push('Multiple runway values are retained in runways[]; the scalar runway preview is intentionally unset.');

  const procedureNames = asArray(procedure?.fields.procedureName).map(String);
  const legRecords = entities
    .filter((item) => item.entityType === 'LEG')
    .map((item) => ({ entity: item, fields: item.fields }))
    .sort((a, b) => numeric(a.fields.sequence) - numeric(b.fields.sequence) || a.entity.entityKey.localeCompare(b.entity.entityKey));
  const legs = legRecords.map(({ entity, fields }) => compact({
    procedureName: scalarString(fields.procedureName) ?? (procedureNames.length === 1 ? procedureNames[0] : undefined),
    sequence: fields.sequence,
    pathTerminator: fields.pathTerminator,
    fromFix: fields.fromFix,
    toFix: fields.toFix,
    fixIdentifier: fields.toFix,
    courseDeg: fields.courseDegMag ?? fields.courseDeg,
    courseTrueDeg: fields.courseDegTrue,
    magneticVariationDeg: fields.magneticVariationDeg,
    distanceNm: fields.distanceNm,
    altitudeConstraint: fields.altitudeConstraint,
    speedLimitKias: fields.speedLimitKias,
    navigationSpecification: fields.navigationSpecification,
    flyOver: fields.flyOver === 'Y' ? true : fields.flyOver === 'N' ? false : fields.flyOver,
    turnDirection: fields.turnDirection,
    recommendedNavaid: fields.recommendedNavaid,
    remarks: fields.remarks,
    sourceEvidenceIds: allEvidenceIds(entity),
    entityKey: entity.entityKey,
    confidence: entityConfidence(entity),
  })) as TableLegItem[];
  const navigationType = resolveCanonicalNavigationType(procedure?.fields.navigationType, legs);
  if (!usableScalar(procedure?.fields.navigationType) && navigationType) {
    warnings.push(`Navigation type inferred deterministically as ${navigationType} from reviewed leg navigation specifications.`);
  }
  if (procedureNames.length > 1 && legs.some((leg) => !leg.procedureName)) warnings.push('Some legs cannot be associated with one of multiple procedures; they remain unassigned for review.');
  const fixes = entities.filter((item) => item.entityType === 'FIX').map(entityObject);
  const navaids = entities.filter((item) => item.entityType === 'NAVAID').map((entity) => ({
    ...entityObject(entity),
    type: entity.fields.navaidType ?? entity.fields.type,
  }));
  const chartTexts = entities.filter((item) => item.entityType === 'CONSTRAINT').map((entity) => compact({
    text: scalarString(entity.fields.text),
    normalizedText: scalarString(entity.fields.text),
    role: scalarString(entity.fields.constraintType),
    usedInProcedure: true,
    confidence: entityConfidence(entity),
    entityKey: entity.entityKey,
    sourceEvidenceIds: allEvidenceIds(entity),
  })).filter((item) => item.text);
  const procedures = procedureNames.map((name) => ({
    procedureName: String(name),
    runway: runwayValues.length === 1 ? runwayValues[0] : null,
    legs: legs.filter((leg) => leg.procedureName === name).map((leg) => ({ ...leg })),
    sourceEvidenceIds: allEvidenceIds(procedure),
    confidence: entityConfidence(procedure),
    reviewRequired: releaseDecision !== 'READY',
  }));
  const confidences = entities.flatMap((item) => Object.values(item.fieldEvidence).map((evidence) => evidence.confidence));

  return compact({
    airportIcao: scalarString(airport?.fields.airportIcao),
    airportName: scalarString(airport?.fields.airportName),
    packageType: scalarString(procedure?.fields.packageType),
    procedureCategory: scalarString(procedure?.fields.procedureCategory),
    navigationType,
    runway: runwayValues.length === 1 ? runwayValues[0] : undefined,
    transitionAltitudeFt: airport?.fields.transitionAltitudeFt,
    magneticVariationDeg: airport?.fields.magneticVariationDeg,
    procedureClassification: compact({
      packageType: scalarString(procedure?.fields.packageType),
      procedureCategory: scalarString(procedure?.fields.procedureCategory),
      navigationType,
      runway: runwayValues.length === 1 ? runwayValues[0] : undefined,
      procedureNames,
      confidence: entityConfidence(procedure),
    }),
    tableLegs: legs,
    procedures,
    fixes,
    navaids,
    runways: runwayValues.map((runway) => ({ identifier: runway })),
    chartTexts,
    sourceEvidence: entities.map((entity) => ({ entityKey: entity.entityKey, fieldEvidence: entity.fieldEvidence })),
    confidence: confidences.length ? confidences.reduce((sum, value) => sum + value, 0) / confidences.length : 0,
    reviewRequired: releaseDecision !== 'READY',
  }) as ProcedureUnderstandingResult;
}

function diffProcedureUnderstanding(v1: ProcedureUnderstandingResult | undefined, v2: ProcedureUnderstandingResult, generatedAt: string): V1V2DiffReport {
  const left = flatten(v1 ?? {});
  const right = flatten(v2);
  const items: V1V2DiffItem[] = [];
  for (const path of [...new Set([...left.keys(), ...right.keys()])].sort()) {
    const hasV1 = left.has(path);
    const hasV2 = right.has(path);
    const v1Value = left.get(path);
    const v2Value = right.get(path);
    const status = !hasV1 ? 'ONLY_V2' : !hasV2 ? 'ONLY_V1' : stable(v1Value) === stable(v2Value) ? 'SAME' : 'CHANGED';
    items.push({ path, status, ...(hasV1 ? { v1Value } : {}), ...(hasV2 ? { v2Value } : {}) });
  }
  return {
    contractVersion: RECOGNITION_V2_CONTRACT_VERSION,
    schemaId: RECOGNITION_V2_SCHEMA_IDS.v1V2DiffReport,
    items,
    summary: {
      same: items.filter((item) => item.status === 'SAME').length,
      changed: items.filter((item) => item.status === 'CHANGED').length,
      onlyV1: items.filter((item) => item.status === 'ONLY_V1').length,
      onlyV2: items.filter((item) => item.status === 'ONLY_V2').length,
    },
    generatedAt,
  };
}

function flatten(value: unknown, path = '$', result = new Map<string, unknown>()) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    result.set(path, value);
    return result;
  }
  const entries = Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined);
  if (!entries.length && path !== '$') result.set(path, value);
  for (const [key, item] of entries) flatten(item, `${path}.${key}`, result);
  return result;
}

function entityObject(entity: CanonicalEntity) {
  return { entityKey: entity.entityKey, ...entity.fields, sourceEvidenceIds: allEvidenceIds(entity), confidence: entityConfidence(entity) };
}

function allEvidenceIds(entity: CanonicalEntity | undefined) {
  return entity ? [...new Set(Object.values(entity.fieldEvidence).flatMap((item) => item.sourceEvidenceIds))].sort() : [];
}

function entityConfidence(entity: CanonicalEntity | undefined) {
  const values = entity ? Object.values(entity.fieldEvidence).map((item) => item.confidence) : [];
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function scalarString(value: unknown) {
  return value === undefined || value === null || Array.isArray(value) ? undefined : String(value);
}

function usableScalar(value: unknown) {
  const normalized = scalarString(value)?.trim().toUpperCase();
  return normalized && !['-', '—', 'UNKNOWN', 'N/A', 'NA', 'NULL'].includes(normalized) ? normalized : undefined;
}

export function resolveCanonicalNavigationType(value: unknown, legs: TableLegItem[]) {
  const explicit = usableScalar(value);
  if (explicit) return explicit;
  const specifications = legs
    .map((leg) => String(leg.navigationSpecification ?? '').trim().toUpperCase())
    .filter(Boolean);
  if (specifications.some((item) => /^(?:RNP|RNAV)(?:\s|$)/.test(item))) return 'RNAV';
  return undefined;
}

function asArray(value: unknown): unknown[] {
  return value === undefined || value === null ? [] : Array.isArray(value) ? value : [value];
}

function numeric(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

function stable(value: unknown) {
  return JSON.stringify(value);
}

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}
