import type { AiInputPackage } from '../types/procedure';
import type { ProcedureGroup } from '../types/procedure';

type JsonRecord = Record<string, unknown>;

export function normalizeProcedureUnderstandingResult(
  value: unknown,
  group: ProcedureGroup,
  aiInputPackage: AiInputPackage,
) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const input = value as JsonRecord;
  const classification = record(input.procedureClassification) ?? {};
  const evidence = normalizeSourceEvidence(array(input.sourceEvidence));
  const evidenceIds = evidence.map((item) => String(item.id));
  const tableLegs = array(input.tableLegs).map((item) => normalizeTableLeg(record(item) ?? {}));

  return {
    airportIcao: stringOrNull(input.airportIcao) ?? airportMetadata(aiInputPackage).airportIcao ?? null,
    airportName: stringOrNull(input.airportName) ?? airportMetadata(aiInputPackage).airportName ?? null,
    packageType: stringOrNull(input.packageType) ?? stringOrNull(classification.packageType) ?? group.packageType ?? null,
    procedureCategory: stringOrNull(input.procedureCategory) ?? stringOrNull(classification.procedureCategory) ?? group.procedureCategory ?? null,
    navigationType: stringOrNull(input.navigationType) ?? stringOrNull(classification.navigationType) ?? group.navigationType ?? null,
    runway: stringOrNull(input.runway) ?? stringOrNull(classification.runway) ?? group.runway ?? null,
    procedureClassification: normalizeClassification(classification, group),
    chartTexts: array(input.chartTexts).map((item) => normalizeChartText(record(item) ?? {})),
    geometrySemantics: array(input.geometrySemantics).map((item) => normalizeGeometrySemantic(record(item) ?? {})),
    supportObjects: array(input.supportObjects).map((item) => normalizeSupportObject(record(item) ?? {})),
    tableLegs,
    procedures: normalizeProcedures(array(input.procedures), tableLegs, group, evidenceIds),
    fixes: array(input.fixes).map((item) => normalizeFix(record(item) ?? {}, evidenceIds)),
    navaids: array(input.navaids).map((item) => normalizeNavaid(record(item) ?? {}, evidenceIds)),
    runways: array(input.runways).map((item) => normalizeRunway(record(item) ?? {}, evidenceIds)),
    communications: array(input.communications).map((item) => normalizeCommunication(record(item) ?? {}, evidenceIds)),
    holdings: array(input.holdings).map((item) => normalizeHolding(record(item) ?? {}, evidenceIds)),
    msa: array(input.msa).map((item) => normalizeMsaSector(record(item) ?? {}, evidenceIds)),
    sourceEvidence: evidence,
    warnings: array(input.warnings).map((item) => normalizeWarning(record(item) ?? {})),
    confidence: numberOr(input.confidence, 0.5),
    reviewRequired: booleanOr(input.reviewRequired, false),
  };
}

function normalizeClassification(input: JsonRecord, group: ProcedureGroup) {
  return {
    packageType: stringOrNull(input.packageType) ?? group.packageType ?? null,
    procedureCategory: stringOrNull(input.procedureCategory) ?? group.procedureCategory ?? null,
    navigationType: stringOrNull(input.navigationType) ?? group.navigationType ?? null,
    runway: stringOrNull(input.runway) ?? group.runway ?? null,
    chartPurpose: stringOrNull(input.chartPurpose) ?? group.chartTitle ?? null,
    procedureNames: array(input.procedureNames).map(String),
    confidence: numberOr(input.confidence, group.confidence ?? 0.5),
  };
}

function normalizeChartText(input: JsonRecord) {
  return {
    text: String(input.text ?? ''),
    normalizedText: stringOrNull(input.normalizedText),
    role: enumString(input.role, ['PROCEDURE_NAME', 'FIX', 'NAVAID', 'DME_LABEL', 'RADIAL_LABEL', 'LEAD_RADIAL', 'COURSE', 'ALTITUDE', 'SPEED', 'HOLDING', 'RUNWAY', 'NOTE', 'MSA', 'OTHER'], 'OTHER'),
    region: enumString(input.region, ['HEADER', 'MAIN_CHART', 'TABLE', 'NOTES', 'MSA', 'PROFILE', 'UNKNOWN'], 'UNKNOWN'),
    sourcePageNo: integerOrNull(input.sourcePageNo),
    usedInProcedure: booleanOr(input.usedInProcedure, false),
    confidence: numberOr(input.confidence, 0.5),
  };
}

function normalizeGeometrySemantic(input: JsonRecord) {
  return {
    type: enumString(input.type, ['DME_ARC', 'RADIAL', 'LEAD_RADIAL', 'PROCEDURE_TRACK', 'COMMON_SEGMENT', 'TURN', 'HOLDING', 'RUNWAY_ALIGNMENT', 'MSA_SECTOR', 'LABEL_BINDING'], 'LABEL_BINDING'),
    labelText: stringOrNull(input.labelText),
    centerNavaid: stringOrNull(input.centerNavaid),
    radiusNm: numberOrNull(input.radiusNm),
    radialDeg: numberOrNull(input.radialDeg),
    inboundTrackDeg: numberOrNull(input.inboundTrackDeg),
    direction: enumString(input.direction, ['CLOCKWISE', 'COUNTERCLOCKWISE', 'UNKNOWN'], 'UNKNOWN'),
    relatedProcedures: array(input.relatedProcedures).map(String),
    sourcePageNo: integerOrNull(input.sourcePageNo),
    confidence: numberOr(input.confidence, 0.5),
    reviewRequired: booleanOr(input.reviewRequired, false),
  };
}

function normalizeSupportObject(input: JsonRecord) {
  return {
    ident: String(input.ident ?? ''),
    type: enumString(input.type, ['NAVAID', 'RUNWAY', 'AIRPORT', 'COMMUNICATION', 'OTHER'], 'OTHER'),
    sourcePageNo: integerOrNull(input.sourcePageNo),
    usedInProcedure: booleanOr(input.usedInProcedure, false),
    supportOnly: booleanOr(input.supportOnly, true),
    reason: stringOrNull(input.reason),
    confidence: numberOr(input.confidence, 0.5),
  };
}

function normalizeTableLeg(input: JsonRecord) {
  return {
    procedureName: stringOrNull(input.procedureName),
    sequence: integerOrNull(input.sequence),
    pathTerminator: stringOrNull(input.pathTerminator),
    fromFix: stringOrNull(input.fromFix),
    toFix: stringOrNull(input.toFix),
    courseDeg: numberOrNull(input.courseDeg),
    distanceNm: numberOrNull(input.distanceNm),
    altitudeConstraint: stringOrNull(input.altitudeConstraint),
    turnDirection: enumString(input.turnDirection, ['L', 'R', 'NONE', 'UNKNOWN'], 'UNKNOWN'),
    remarks: stringOrNull(input.remarks),
    sourcePageNo: integerOrNull(input.sourcePageNo),
    confidence: numberOr(input.confidence, 0.5),
  };
}

function normalizeProcedures(rawProcedures: unknown[], tableLegs: ReturnType<typeof normalizeTableLeg>[], group: ProcedureGroup, evidenceIds: string[]) {
  const rawByName = new Map<string, JsonRecord>();
  for (const item of rawProcedures) {
    const raw = record(item);
    const name = stringOrNull(raw?.procedureName) ?? stringOrNull(raw?.name);
    if (raw && name) rawByName.set(name, raw);
  }
  const names = new Set([
    ...tableLegs.map((item) => item.procedureName).filter(Boolean) as string[],
    ...rawByName.keys(),
    ...(group.procedureNames ?? []),
  ]);

  return [...names].map((name) => {
    const raw = rawByName.get(name) ?? {};
    const legs = tableLegs
      .filter((leg) => leg.procedureName === name)
      .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))
      .map((leg) => normalizeLeg(leg, evidenceIds));
    return {
      procedureName: name,
      runway: stringOrNull(raw.runway) ?? group.runway ?? null,
      navigationSpec: stringOrNull(raw.navigationSpec) ?? stringOrNull(raw.navSpec) ?? inferNavigationSpec(tableLegs) ?? null,
      legs,
      sourceEvidenceIds: evidenceIds,
      confidence: numberOr(raw.confidence, averageConfidence(legs)),
      reviewRequired: booleanOr(raw.reviewRequired, false),
    };
  });
}

function normalizeLeg(input: ReturnType<typeof normalizeTableLeg>, evidenceIds: string[]) {
  return {
    sequence: input.sequence ?? 1,
    pathTerminator: input.pathTerminator,
    fromFix: input.fromFix,
    fixIdentifier: input.toFix,
    courseDegMag: input.courseDeg,
    distanceNm: input.distanceNm,
    turnDirection: legTurnDirection(input.turnDirection),
    altitudeConstraint: parseAltitudeConstraint(input.altitudeConstraint),
    speedLimitKias: null,
    navigationSpec: inferNavigationSpec([input]),
    derivationMethod: input.sourcePageNo ? `tabular page ${input.sourcePageNo}` : 'tableLegs',
    sourceEvidenceIds: evidenceIds,
    confidence: input.confidence,
    reviewRequired: false,
  };
}

function normalizeFix(input: JsonRecord, evidenceIds: string[]) {
  const coordinates = record(input.coordinates) ?? {};
  const latRaw = stringOrNull(coordinates.lat) ?? stringOrNull(input.latitudeText) ?? stringOrNull(input.latText);
  const lonRaw = stringOrNull(coordinates.lon) ?? stringOrNull(input.longitudeText) ?? stringOrNull(input.lonText);
  return {
    identifier: stringOrNull(input.identifier) ?? stringOrNull(input.ident),
    latitude: numberOrNull(input.latitude) ?? parseDmsCoordinate(latRaw),
    longitude: numberOrNull(input.longitude) ?? parseDmsCoordinate(lonRaw),
    rawCoordinate: stringOrNull(input.rawCoordinate) ?? ([latRaw, lonRaw].filter(Boolean).join(' ') || null),
    sourceEvidenceIds: evidenceIds,
    confidence: numberOr(input.confidence, 0.5),
    reviewRequired: booleanOr(input.reviewRequired, false),
  };
}

function normalizeNavaid(input: JsonRecord, evidenceIds: string[]) {
  return {
    identifier: stringOrNull(input.identifier) ?? stringOrNull(input.ident),
    type: stringOrNull(input.type),
    frequency: stringOrNull(input.frequency),
    sourceEvidenceIds: evidenceIds,
    confidence: numberOr(input.confidence, 0.5),
    reviewRequired: booleanOr(input.reviewRequired, false),
  };
}

function normalizeRunway(input: JsonRecord, evidenceIds: string[]) {
  return {
    identifier: stringOrNull(input.identifier),
    thresholdLatitude: numberOrNull(input.thresholdLatitude),
    thresholdLongitude: numberOrNull(input.thresholdLongitude),
    magneticBearing: numberOrNull(input.magneticBearing),
    sourceEvidenceIds: evidenceIds,
    confidence: numberOr(input.confidence, 0.5),
    reviewRequired: booleanOr(input.reviewRequired, false),
  };
}

function normalizeCommunication(input: JsonRecord, evidenceIds: string[]) {
  return {
    service: stringOrNull(input.service),
    frequency: stringOrNull(input.frequency),
    sourceEvidenceIds: evidenceIds,
    confidence: numberOr(input.confidence, 0.5),
    reviewRequired: booleanOr(input.reviewRequired, false),
  };
}

function normalizeHolding(input: JsonRecord, evidenceIds: string[]) {
  return {
    fixIdentifier: stringOrNull(input.fixIdentifier) ?? stringOrNull(input.fix),
    inboundCourseDegMag: numberOrNull(input.inboundCourseDegMag) ?? numberOrNull(input.inboundTrack),
    turnDirection: enumString(input.turnDirection, ['L', 'R'], null),
    sourceEvidenceIds: evidenceIds,
    confidence: numberOr(input.confidence, 0.5),
    reviewRequired: booleanOr(input.reviewRequired, false),
  };
}

function normalizeMsaSector(input: JsonRecord, evidenceIds: string[]) {
  return {
    reference: stringOrNull(input.reference),
    minimumAltitudeFt: numberOrNull(input.minimumAltitudeFt),
    sector: stringOrNull(input.sector),
    sourceEvidenceIds: evidenceIds,
    confidence: numberOr(input.confidence, 0.5),
    reviewRequired: booleanOr(input.reviewRequired, false),
  };
}

function normalizeSourceEvidence(items: unknown[]) {
  return items.map((item, index) => {
    const input = record(item) ?? {};
    return {
      id: stringOrNull(input.id) ?? `evidence_${index + 1}`,
      pageNo: integerOrNull(input.pageNo) ?? 1,
      aipPageNo: stringOrNull(input.aipPageNo),
      evidenceType: String(input.evidenceType ?? 'MODEL_OUTPUT'),
      fieldName: String(input.fieldName ?? 'unknown'),
      rawText: stringOrNull(input.rawText),
      visualDescription: stringOrNull(input.visualDescription),
      confidence: numberOr(input.confidence, 0.5),
    };
  });
}

function normalizeWarning(input: JsonRecord) {
  return {
    message: String(input.message ?? ''),
    pageNos: array(input.pageNos).map(Number).filter((item) => Number.isInteger(item)),
    fieldName: stringOrNull(input.fieldName),
    reviewRequired: booleanOr(input.reviewRequired, true),
  };
}

function parseAltitudeConstraint(raw: string | null) {
  if (!raw) return null;
  const altitudeFt = Number(raw.replace(/[^\d.]/g, ''));
  const isNumber = Number.isFinite(altitudeFt);
  return {
    type: raw.startsWith('+') ? 'AT_OR_ABOVE' : raw.startsWith('-') ? 'AT_OR_BELOW' : null,
    altitudeFt: isNumber ? altitudeFt : null,
    lowerFt: raw.startsWith('+') && isNumber ? altitudeFt : null,
    upperFt: raw.startsWith('-') && isNumber ? altitudeFt : null,
    rawText: raw,
  };
}

function parseDmsCoordinate(raw: string | null) {
  if (!raw) return null;
  const match = raw.match(/(\d+(?:\.\d+)?)\D+(\d+(?:\.\d+)?)\D+(\d+(?:\.\d+)?)\D*([NSEW])/i);
  if (!match) return null;
  const degrees = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const direction = match[4].toUpperCase();
  if (![degrees, minutes, seconds].every(Number.isFinite)) return null;
  const sign = direction === 'S' || direction === 'W' ? -1 : 1;
  return sign * (degrees + minutes / 60 + seconds / 3600);
}

function legTurnDirection(value: string | null) {
  if (value === 'L' || value === 'R') return value;
  if (value === 'NONE') return 'STRAIGHT';
  return null;
}

function inferNavigationSpec(tableLegs: Array<{ remarks: string | null }>) {
  return tableLegs.find((item) => /RNAV\s*\d/i.test(item.remarks ?? ''))?.remarks ?? null;
}

function averageConfidence(items: Array<{ confidence: number }>) {
  if (!items.length) return 0.5;
  return items.reduce((sum, item) => sum + item.confidence, 0) / items.length;
}

function airportMetadata(aiInputPackage: AiInputPackage) {
  const airport = record(record(aiInputPackage.supportSummary)?.airportMetadata) ?? {};
  return {
    airportIcao: stringOrNull(airport.airportIcao),
    airportName: stringOrNull(airport.airportName),
  };
}

function record(value: unknown): JsonRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : undefined;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringOrNull(value: unknown) {
  return typeof value === 'string' ? value : null;
}

function numberOrNull(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function numberOr(value: unknown, fallback: number) {
  return numberOrNull(value) ?? fallback;
}

function integerOrNull(value: unknown) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : null;
}

function booleanOr(value: unknown, fallback: boolean) {
  return typeof value === 'boolean' ? value : fallback;
}

function enumString<T extends string>(value: unknown, allowed: T[], fallback: T | null): T | null {
  return typeof value === 'string' && allowed.includes(value as T) ? value as T : fallback;
}
