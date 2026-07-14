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
  const chartTexts = array(input.chartTexts).map((item) => normalizeChartText(record(item) ?? {}));
  const geometrySemantics = array(input.geometrySemantics).map((item) => normalizeGeometrySemantic(record(item) ?? {}));
  const fixes = array(input.fixes).map((item) => normalizeFix(record(item) ?? {}, evidenceIds));
  const navigationType = stringOrNull(input.navigationType) ?? stringOrNull(classification.navigationType) ?? group.navigationType ?? null;
  const procedures = applyDmeArcLegFallback(
    normalizeProcedures(array(input.procedures), tableLegs, group, evidenceIds),
    geometrySemantics,
    chartTexts,
    fixes,
    navigationType,
    evidenceIds,
  );
  const warnings = array(input.warnings).map((item) => normalizeWarning(record(item) ?? {}));
  const usedLegFallback = procedures.some(
    (procedure) => procedure.legs.some((leg) => String(leg.derivationMethod ?? '').startsWith('synthesized')),
  );
  if (usedLegFallback) {
    // 兜底必须显式亮牌：它只保证产物可用，不代表模型识别达标
    warnings.push({
      message: '模型未输出 tableLegs：procedures[].legs 为 DME ARC 几何合成兜底（缺高度约束），模型识别仍不完整，请继续打磨 Prompt。',
      pageNos: [],
      fieldName: 'tableLegs',
      reviewRequired: true,
    });
  }

  return {
    airportIcao: stringOrNull(input.airportIcao)
      ?? airportMetadata(aiInputPackage).airportIcao
      ?? airportIcaoFromGroup(group)
      ?? null,
    airportName: stringOrNull(input.airportName) ?? airportMetadata(aiInputPackage).airportName ?? null,
    packageType: stringOrNull(input.packageType) ?? stringOrNull(classification.packageType) ?? group.packageType ?? null,
    procedureCategory: stringOrNull(input.procedureCategory) ?? stringOrNull(classification.procedureCategory) ?? group.procedureCategory ?? null,
    navigationType,
    runway: stringOrNull(input.runway) ?? stringOrNull(classification.runway) ?? group.runway ?? null,
    procedureClassification: normalizeClassification(classification, group),
    chartTexts,
    geometrySemantics,
    labelPlan: array(input.labelPlan).map((item) => normalizeLabelPlanItem(record(item) ?? {})),
    supportObjects: array(input.supportObjects).map((item) => normalizeSupportObject(record(item) ?? {})),
    tableLegs,
    procedures,
    fixes,
    navaids: array(input.navaids).map((item) => normalizeNavaid(record(item) ?? {}, evidenceIds)),
    runways: array(input.runways).map((item) => normalizeRunway(record(item) ?? {}, evidenceIds)),
    communications: array(input.communications).map((item) => normalizeCommunication(record(item) ?? {}, evidenceIds)),
    holdings: array(input.holdings).map((item) => normalizeHolding(record(item) ?? {}, evidenceIds)),
    msa: array(input.msa).map((item) => normalizeMsaSector(record(item) ?? {}, evidenceIds)),
    sourceEvidence: evidence,
    warnings,
    confidence: numberOr(input.confidence, 0.5),
    reviewRequired: booleanOr(input.reviewRequired, false) || usedLegFallback,
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

function normalizeLabelPlanItem(input: JsonRecord) {
  return {
    // 模型偶发输出字面量 "\n"，统一转成真实换行供地图分行渲染
    text: String(input.text ?? '').replace(/\\n/g, '\n'),
    labelKind: enumString(input.labelKind, ['FIX_NAME', 'PROCEDURE_NAME', 'COURSE_DISTANCE', 'NAVAID_INFO', 'DME_ARC', 'RADIAL', 'LEAD_RADIAL', 'RUNWAY', 'HOLDING', 'MSA', 'NOTE'], 'NOTE'),
    anchorType: enumString(input.anchorType, ['FIX', 'NAVAID', 'LEG', 'PROCEDURE_TRACK', 'DME_ARC', 'RADIAL', 'RUNWAY'], 'FIX'),
    anchorIdent: stringOrNull(input.anchorIdent),
    procedureName: stringOrNull(input.procedureName),
    legSequence: integerOrNull(input.legSequence),
    placementAlongLine: enumString(input.placementAlongLine, ['START', 'MIDDLE', 'END'], null),
    sideOfLine: enumString(input.sideOfLine, ['LEFT', 'RIGHT', 'AUTO'], null),
    anchorDirection: enumString(input.anchorDirection, ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW', 'AUTO'], null),
    priority: numberOrNull(input.priority),
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
    recommendedNavaid: stringOrNull(input.recommendedNavaid),
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
  const recognizedNames = new Set([
    ...tableLegs.map((item) => item.procedureName).filter(Boolean) as string[],
    ...rawByName.keys(),
  ]);
  const names = new Set(recognizedNames);
  for (const groupName of recognizedNames.size ? [] : (group.procedureNames ?? [])) {
    const family = normalizedProcedureFamily(groupName);
    const alreadyRepresented = [...recognizedNames].some(
      (recognizedName) => normalizedProcedureFamily(recognizedName) === family,
    );
    if (!alreadyRepresented) names.add(groupName);
  }

  return [...names].map((name) => {
    const raw = rawByName.get(name) ?? {};
    const transitionName = stringOrNull(raw.transitionName)?.replace(/\s+TRANSITION$/i, '').trim() ?? null;
    const legs = tableLegs
      .filter((leg) => leg.procedureName === name)
      .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))
      .map((leg) => normalizeLeg(leg, evidenceIds));
    return {
      procedureName: name,
      runway: transitionName ? null : (stringOrNull(raw.runway) ?? group.runway ?? null),
      transitionName,
      navigationSpec: stringOrNull(raw.navigationSpec) ?? stringOrNull(raw.navSpec) ?? inferNavigationSpec(tableLegs) ?? null,
      legs,
      sourceEvidenceIds: evidenceIds,
      confidence: numberOr(raw.confidence, averageConfidence(legs)),
      reviewRequired: booleanOr(raw.reviewRequired, false),
    };
  });
}

function normalizedProcedureFamily(name: string) {
  return name
    .trim()
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .replace(/\s+RWY?\s*\d{2}[LRCB]?(?:\s*\/\s*\d{2}[LRCB]?)*$/, '')
    .replace(/\s+(?:DEPARTURE|ARRIVAL)$/, '');
}

type NormalizedGeometrySemantic = ReturnType<typeof normalizeGeometrySemantic>;
type NormalizedLeg = ReturnType<typeof normalizeLeg>;
type NormalizedProcedure = ReturnType<typeof normalizeProcedures>[number];

// 模型偶发把输出预算花在穷举标签上而漏掉 tableLegs。DME ARC 的腿链结构是确定的：
// IF 入航点 → TF 外圈 D-Fix → CI 截获 → AF 弧段（遇约束径向线拆分）→ TF 共用入航点。
// 当 tableLegs 缺失但语义要素（弧、径向线、relatedProcedures）齐全时，按几何合成腿段，
// AF 弧长 = 半径 × 弧角，全部标记 reviewRequired=true。高度约束无法合成，留 null。
function applyDmeArcLegFallback(
  procedures: NormalizedProcedure[],
  geometrySemantics: NormalizedGeometrySemantic[],
  chartTexts: Array<{ text: string; role: string | null }>,
  fixes: Array<{ identifier: string | null }>,
  navigationType: string | null,
  evidenceIds: string[],
): NormalizedProcedure[] {
  if (!/DME/i.test(String(navigationType ?? ''))) return procedures;
  if (!procedures.length || procedures.some((procedure) => procedure.legs.length > 0)) return procedures;

  const arc = geometrySemantics.find((item) => item.type === 'DME_ARC' && (item.radiusNm ?? 0) > 0);
  const radials = geometrySemantics.filter((item) => item.type === 'RADIAL' && item.radialDeg !== null);
  if (!arc || radials.length < 2) return procedures;

  const finalRadial = [...radials].sort(
    (a, b) => (b.relatedProcedures.length - a.relatedProcedures.length)
      || ((b.inboundTrackDeg !== null ? 1 : 0) - (a.inboundTrackDeg !== null ? 1 : 0)),
  )[0];
  const finalDeg = Number(finalRadial.radialDeg);
  const radiusNm = Number(arc.radiusNm);
  const outerNm = outerDmeDistance(chartTexts, radiusNm);
  const entryFixIdents = new Set(procedures.map((procedure) => firstWord(procedure.procedureName)));
  const commonFix = fixes
    .map((fix) => String(fix.identifier ?? '').toUpperCase())
    .find((ident) => ident && !entryFixIdents.has(ident) && !/^D\d{3}[A-Z]$/.test(ident)) ?? null;

  return procedures.map((procedure) => {
    const name = String(procedure.procedureName ?? '');
    const related = radials.filter(
      (radial) => radial !== finalRadial
        && radial.relatedProcedures.some((item) => item.toUpperCase() === name.toUpperCase()),
    );
    if (!related.length) return procedure;

    const entry = [...related].sort(
      (a, b) => angularDistanceDeg(Number(b.radialDeg), finalDeg) - angularDistanceDeg(Number(a.radialDeg), finalDeg),
    )[0];
    const entryDeg = Number(entry.radialDeg);
    const signedDelta = ((finalDeg - entryDeg + 540) % 360) - 180;
    const turn: 'L' | 'R' = signedDelta >= 0 ? 'R' : 'L';
    const crossings = related
      .filter((radial) => radial !== entry)
      .map((radial) => Number(radial.radialDeg))
      .filter((deg) => forwardOffsetDeg(entryDeg, deg, turn) < forwardOffsetDeg(entryDeg, finalDeg, turn))
      .sort((a, b) => forwardOffsetDeg(entryDeg, a, turn) - forwardOffsetDeg(entryDeg, b, turn));

    const entryFix = firstWord(procedure.procedureName);
    const outerFix = dFixName(entryDeg, outerNm);
    // IF/AF 腿引用弧心导航台（424 的推荐导航台列）
    const centerNavaid = arc.centerNavaid ? String(arc.centerNavaid).toUpperCase() : null;
    const legs: NormalizedLeg[] = [
      synthesizedLeg(10, 'IF', null, entryFix, null, null, null, evidenceIds, centerNavaid),
      synthesizedLeg(20, 'TF', entryFix, outerFix, null, null, null, evidenceIds),
      synthesizedLeg(30, 'CI', outerFix, null, (entryDeg + 180) % 360, round1(outerNm - radiusNm), null, evidenceIds),
    ];
    let sequence = 30;
    let previousDeg = entryDeg;
    let previousFix: string | null = null;
    for (const crossingDeg of [...crossings, finalDeg]) {
      sequence += 10;
      const fixName = dFixName(crossingDeg, radiusNm);
      legs.push(synthesizedLeg(
        sequence,
        'AF',
        previousFix,
        fixName,
        null,
        arcLengthNm(radiusNm, forwardOffsetDeg(previousDeg, crossingDeg, turn)),
        turn,
        evidenceIds,
        centerNavaid,
      ));
      previousDeg = crossingDeg;
      previousFix = fixName;
    }
    if (commonFix) {
      sequence += 10;
      legs.push(synthesizedLeg(sequence, 'TF', previousFix, commonFix, finalRadial.inboundTrackDeg, null, null, evidenceIds));
    }
    return { ...procedure, legs, reviewRequired: true };
  });
}

export const SYNTHESIZED_LEG_DERIVATION = 'synthesized from DME ARC geometry semantics (tableLegs missing)';
function synthesizedLeg(
  sequence: number,
  pathTerminator: string,
  fromFix: string | null,
  fixIdentifier: string | null,
  courseDegMag: number | null,
  distanceNm: number | null,
  turnDirection: 'L' | 'R' | null,
  evidenceIds: string[],
  recommendedNavaid: string | null = null,
): NormalizedLeg {
  return {
    sequence,
    pathTerminator,
    fromFix,
    fixIdentifier,
    courseDegMag,
    distanceNm,
    turnDirection,
    altitudeConstraint: null,
    speedLimitKias: null,
    navigationSpec: null,
    recommendedNavaid,
    remarks: null,
    derivationMethod: SYNTHESIZED_LEG_DERIVATION,
    sourceEvidenceIds: evidenceIds,
    confidence: 0.55,
    reviewRequired: true,
  };
}

// 外圈 DME 距离取自图上 "13D" 之类的 DME 标签（比弧半径大的最小值），缺省半径+2。
function outerDmeDistance(chartTexts: Array<{ text: string; role: string | null }>, radiusNm: number) {
  const candidates = chartTexts
    .filter((item) => item.role === 'DME_LABEL')
    .flatMap((item) => [...String(item.text).matchAll(/(\d+(?:\.\d+)?)\s*D(?:ME)?\b/gi)].map((match) => Number(match[1])))
    .filter((value) => Number.isFinite(value) && value > radiusNm);
  return candidates.length ? Math.min(...candidates) : radiusNm + 2;
}

function dFixName(radialDeg: number, distanceNm: number) {
  const letter = String.fromCharCode(64 + Math.max(1, Math.min(26, Math.round(distanceNm))));
  return `D${String(Math.round(radialDeg)).padStart(3, '0')}${letter}`;
}

function forwardOffsetDeg(fromDeg: number, toDeg: number, turn: 'L' | 'R') {
  return turn === 'R' ? (toDeg - fromDeg + 360) % 360 : (fromDeg - toDeg + 360) % 360;
}

function arcLengthNm(radiusNm: number, deltaDeg: number) {
  return round1(radiusNm * (deltaDeg * Math.PI) / 180);
}

function angularDistanceDeg(a: number, b: number) {
  const diff = Math.abs(a - b) % 360;
  return diff > 180 ? 360 - diff : diff;
}

function firstWord(value: string | null) {
  return String(value ?? '').trim().split(/\s+/)[0]?.toUpperCase() ?? '';
}

function round1(value: number) {
  return Math.round(value * 10) / 10;
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
    recommendedNavaid: input.recommendedNavaid,
    remarks: input.remarks,
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
  const latitude = numberOrNull(input.latitude) ?? parseDmsCoordinate(latRaw);
  const longitude = numberOrNull(input.longitude) ?? parseDmsCoordinate(lonRaw);
  // 模型常用 (0,0) 表示"未知坐标"，按缺失处理，避免轨迹被拉到零点。
  const zeroed = latitude === 0 && longitude === 0;
  return {
    identifier: stringOrNull(input.identifier) ?? stringOrNull(input.ident),
    latitude: zeroed ? null : latitude,
    longitude: zeroed ? null : longitude,
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
  const trimmed = raw.trim();
  const first = trimmed.match(/([+-]?)\s*(\d{3,5})/);
  const rest = first ? trimmed.slice((first.index ?? 0) + first[0].length) : '';
  const second = rest.match(/\b(\d{3,5})\b/);
  const altitudeFt = first ? Number(first[2]) : null;
  const secondAltitudeFt = second ? Number(second[1]) : null;
  const isNumber = altitudeFt !== null && Number.isFinite(altitudeFt);
  const sign = first?.[1] ?? '';
  return {
    type: sign === '+' ? 'AT_OR_ABOVE' : sign === '-' ? 'AT_OR_BELOW' : null,
    altitudeFt: isNumber ? altitudeFt : null,
    lowerFt: sign === '+' && isNumber ? altitudeFt : null,
    upperFt: secondAltitudeFt ?? (sign === '-' && isNumber ? altitudeFt : null),
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

export function airportIcaoFromGroup(group: ProcedureGroup) {
  const values = [group.chartNo, ...(group.relatedChartNos ?? [])];
  for (const value of values) {
    const text = String(value ?? '').toUpperCase();
    const aipSection = text.match(/\bAD\s*2(?:\.\d+)?\s*[- ]\s*([A-Z]{4})\b/);
    if (aipSection) return aipSection[1];
    const chartDialect = text.match(/\b([A-Z]{4})\s+AD\s+CHART\b/);
    if (chartDialect) return chartDialect[1];
  }
  return null;
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
