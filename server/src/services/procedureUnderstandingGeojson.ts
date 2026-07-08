import type { Feature, FeatureCollection, Geometry, GeoJsonProperties, LineString, Point } from 'geojson';
import type { ProcedureGroup, ProcedureUnderstandingResult } from '../types/procedure';
import { withBbox } from './geojsonValidator';

type ProcedureFeature = Feature<Geometry | null, GeoJsonProperties>;
type FixRecord = {
  identifier?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  rawCoordinate?: string | null;
  sourcePage?: number | null;
  confidence?: number;
  reviewRequired?: boolean;
};

type ProcedureRecord = {
  procedureName?: string | null;
  runway?: string | null;
  navigationSpec?: string | null;
  legs?: LegRecord[];
  confidence?: number;
  reviewRequired?: boolean;
};

type LegRecord = {
  sequence?: number | null;
  pathTerminator?: string | null;
  fromFix?: string | null;
  fixIdentifier?: string | null;
  courseDegMag?: number | null;
  distanceNm?: number | null;
  turnDirection?: string | null;
  remarks?: string | null;
  altitudeConstraint?: {
    type?: string | null;
    altitudeFt?: number | null;
    lowerFt?: number | null;
    upperFt?: number | null;
    rawText?: string | null;
  } | null;
  confidence?: number;
  reviewRequired?: boolean;
};

type ChartTextRecord = {
  text?: string | null;
  normalizedText?: string | null;
  role?: string | null;
  usedInProcedure?: boolean;
};

type GeometrySemanticRecord = {
  type?: string | null;
  labelText?: string | null;
  centerNavaid?: string | null;
  radiusNm?: number | null;
  radialDeg?: number | null;
  inboundTrackDeg?: number | null;
  relatedProcedures?: string[];
  sourcePageNo?: number | null;
  confidence?: number;
  reviewRequired?: boolean;
};

type LabelPlanRecord = {
  text?: string | null;
  labelKind?: string | null;
  anchorType?: string | null;
  anchorIdent?: string | null;
  procedureName?: string | null;
  legSequence?: number | null;
  placementAlongLine?: string | null;
  sideOfLine?: string | null;
  anchorDirection?: string | null;
  priority?: number | null;
  sourcePageNo?: number | null;
  confidence?: number;
  reviewRequired?: boolean;
};

type SupportNavaidSummary = {
  pageNo?: number | null;
  navaids?: string[];
  idents?: string[];
  coordinates?: string[];
  textSample?: string;
};

const EARTH_RADIUS_NM = 3440.065;

export function buildGeoJsonFromProcedureUnderstanding(
  understanding: ProcedureUnderstandingResult,
  group: ProcedureGroup,
): FeatureCollection<Geometry | null, GeoJsonProperties> {
  const fixes = (understanding.fixes ?? []) as FixRecord[];
  const procedures = (understanding.procedures ?? []) as ProcedureRecord[];
  const geometrySemantics = (understanding.geometrySemantics ?? []) as GeometrySemanticRecord[];
  const chartTexts = (understanding.chartTexts ?? []) as ChartTextRecord[];
  const fixMap = new Map(
    fixes
      .filter((fix) => fix.identifier && isCoordinate(fix.longitude, fix.latitude))
      .map((fix) => [String(fix.identifier).toUpperCase(), fix]),
  );
  const navaidMap = buildNavaidMap(understanding, group);
  const arcContext = resolveArcContext(geometrySemantics, navaidMap);
  const fixMetadata = buildFixMetadata(procedures, chartTexts, understanding, group);
  const syntheticFixes = new Map<string, FixRecord>();
  const legChainFeatures = procedures.flatMap(
    (procedure) => procedureFeatures(procedure, fixMap, arcContext, syntheticFixes, understanding, group),
  );

  const features: ProcedureFeature[] = [
    procedureChartFeature(understanding, group),
    ...navaidFeatures(navaidMap),
    ...fixes.flatMap((fix) => fixFeature(fix, fixMetadata)),
    ...syntheticFixFeatures(syntheticFixes),
    ...legChainFeatures,
    ...geometrySemanticFeatures(geometrySemantics, procedures, fixMap, navaidMap, understanding, group),
  ];
  features.push(...labelPlanFeatures(understanding, group, features));

  return withBbox({
    type: 'FeatureCollection',
    features,
  });
}

function procedureChartFeature(understanding: ProcedureUnderstandingResult, group: ProcedureGroup): ProcedureFeature {
  return {
    type: 'Feature',
    geometry: null,
    properties: baseProps({
      object_type: 'ProcedureChart',
      feature_id: `chart_${group.packageId || group.groupId}`,
      source_page: group.chartPageNo ?? group.chartPages[0] ?? null,
      source_text: group.chartTitle || group.packageName || group.groupName,
      coordinate_quality: 'semantic',
      review_required: understanding.reviewRequired === true,
      confidence: understanding.confidence ?? group.confidence ?? 0.5,
      procedure_names: group.procedureNames,
      runway: understanding.runway ?? group.runway,
      navigation_type: understanding.navigationType ?? group.navigationType,
      procedure_category: understanding.procedureCategory ?? group.procedureCategory,
      airport_icao: understanding.airportIcao,
    }),
  };
}

interface FixMetadata {
  altitudeFt?: number;
  role?: string;
  finalTrackMag?: number;
}

function fixFeature(fix: FixRecord, fixMetadata: Map<string, FixMetadata>): ProcedureFeature[] {
  if (!fix.identifier || !isCoordinate(fix.longitude, fix.latitude)) return [];
  const metadata = fixMetadata.get(String(fix.identifier).toUpperCase());
  return [{
    type: 'Feature',
    geometry: point(fix.longitude, fix.latitude),
    properties: baseProps({
      object_type: 'ProcedureFix',
      feature_id: `fix_${slug(fix.identifier)}`,
      ident: fix.identifier,
      name: fix.identifier,
      source_page: null,
      source_text: fix.rawCoordinate || fix.identifier,
      coordinate_quality: fix.rawCoordinate ? 'source_coordinate' : 'model_coordinate',
      review_required: fix.reviewRequired === true,
      confidence: fix.confidence ?? 0.5,
      raw_coordinate: fix.rawCoordinate ?? null,
      chart_altitude_ft: metadata?.altitudeFt ?? null,
      chart_fix_role: metadata?.role ?? null,
      final_track_mag: metadata?.finalTrackMag ?? null,
    }),
  }];
}

interface ArcContext {
  center: FixRecord;
  centerIdent: string;
  radiusNm: number;
}

function resolveArcContext(semantics: GeometrySemanticRecord[], navaidMap: Map<string, FixRecord>): ArcContext | undefined {
  const arc = semantics.find((item) => item.type === 'DME_ARC' && item.centerNavaid && item.radiusNm);
  if (!arc?.centerNavaid) return undefined;
  const center = navaidMap.get(arc.centerNavaid.toUpperCase());
  if (!center || !isCoordinate(center.longitude, center.latitude)) return undefined;
  return { center, centerIdent: arc.centerNavaid.toUpperCase(), radiusNm: Number(arc.radiusNm) };
}

function procedureFeatures(
  procedure: ProcedureRecord,
  fixMap: Map<string, FixRecord>,
  arcContext: ArcContext | undefined,
  syntheticFixes: Map<string, FixRecord>,
  understanding: ProcedureUnderstandingResult,
  group: ProcedureGroup,
): ProcedureFeature[] {
  const procedureName = procedure.procedureName || 'UNKNOWN';
  const orderedLegs = [...(procedure.legs ?? [])].sort((a, b) => Number(a.sequence ?? 0) - Number(b.sequence ?? 0));

  const features: ProcedureFeature[] = [];
  const chain: number[][] = [];
  let current: [number, number] | undefined;
  let usedDerivedGeometry = false;

  for (const leg of orderedLegs) {
    const pathTerminator = String(leg.pathTerminator ?? '').toUpperCase();
    const resolved = resolveLegTarget(leg, fixMap, arcContext, syntheticFixes);
    let target = resolved?.coordinate;
    let geometry: number[][] | undefined;
    let quality = 'derived_from_fix_coordinates';

    if (pathTerminator === 'CI' && !target && current && Number.isFinite(Number(leg.courseDegMag))) {
      // 航向截获腿：从当前位置沿磁航向推算终点（无命名 Fix）。
      target = destinationPoint(pointRecord(current), Number(leg.courseDegMag), Number(leg.distanceNm ?? 2));
      geometry = [current, target];
      quality = 'derived_from_course_intercept';
    } else if (pathTerminator === 'AF' && arcContext && current && target) {
      // DME 弧腿：绕弧心按转弯方向采样圆弧（L=逆时针，R=顺时针）。
      const radiusNm = resolved?.dmeDistanceNm ?? distanceNmFrom(arcContext.center, target);
      const startDeg = bearingFrom(arcContext.center, current);
      const endDeg = bearingFrom(arcContext.center, target);
      const direction = leg.turnDirection === 'L' || leg.turnDirection === 'R' ? leg.turnDirection : undefined;
      const arcPoints = arcCoordinates(arcContext.center, radiusNm, startDeg, endDeg, direction);
      geometry = [current, ...arcPoints.slice(1, -1), target];
      quality = 'derived_from_dme_arc_semantics';
    } else if (current && target) {
      geometry = [current, target];
      quality = resolved?.synthetic ? 'derived_from_dme_fix_name' : 'derived_from_fix_coordinates';
    }

    if (geometry) {
      if (quality !== 'derived_from_fix_coordinates') usedDerivedGeometry = true;
      features.push(legFeature(procedureName, leg, geometry, quality));
      if (!chain.length) chain.push(geometry[0]);
      chain.push(...geometry.slice(1));
    } else if (target && !chain.length) {
      chain.push(target);
    }
    if (target) current = target;
  }

  if (chain.length >= 2) {
    features.unshift({
      type: 'Feature',
      geometry: line(chain),
      properties: baseProps({
        object_type: 'ProcedureTrack',
        feature_id: `track_${slug(procedureName)}`,
        procedure: procedureName,
        name: procedureName,
        source_page: group.chartPageNo ?? group.chartPages[0] ?? null,
        source_text: `${procedureName} ${understanding.navigationType ?? group.navigationType ?? ''} ${understanding.runway ?? group.runway ?? ''}`.trim(),
        coordinate_quality: usedDerivedGeometry ? 'derived_from_leg_chain' : 'derived_from_fix_coordinates',
        review_required: procedure.reviewRequired === true || usedDerivedGeometry,
        confidence: procedure.confidence ?? understanding.confidence ?? 0.5,
        runway: procedure.runway ?? understanding.runway ?? group.runway,
        navigation_spec: procedure.navigationSpec,
      }),
    });
  }
  return features;
}

function resolveLegTarget(
  leg: LegRecord,
  fixMap: Map<string, FixRecord>,
  arcContext: ArcContext | undefined,
  syntheticFixes: Map<string, FixRecord>,
): { coordinate: [number, number]; synthetic: boolean; dmeDistanceNm?: number } | undefined {
  const ident = String(leg.fixIdentifier ?? '').trim().toUpperCase();
  if (!ident) return undefined;

  const fix = fixMap.get(ident);
  if (fix && isCoordinate(fix.longitude, fix.latitude)) {
    return { coordinate: coord(fix.longitude, fix.latitude), synthetic: false };
  }

  if (!arcContext) return undefined;
  const decoded = decodeDmeFix(ident, arcContext);
  if (!decoded) return undefined;
  if (!syntheticFixes.has(ident)) {
    syntheticFixes.set(ident, {
      identifier: ident,
      longitude: decoded.coordinate[0],
      latitude: decoded.coordinate[1],
      rawCoordinate: null,
      confidence: 0.6,
      reviewRequired: true,
    });
  }
  return { coordinate: decoded.coordinate, synthetic: true, dmeDistanceNm: decoded.distanceNm };
}

// 终端 DME Fix 命名：D + 径向线(3位) + 距离字母（A=1NM … K=11NM, M=13NM）。
function decodeDmeFix(ident: string, arcContext: ArcContext) {
  const match = ident.match(/^D(\d{3})([A-Z])$/);
  if (!match) return undefined;
  const radialDeg = Number(match[1]);
  if (radialDeg > 360) return undefined;
  const distanceNm = match[2].charCodeAt(0) - 64;
  return {
    radialDeg,
    distanceNm,
    coordinate: destinationPoint(arcContext.center, radialDeg, distanceNm),
  };
}

function syntheticFixFeatures(syntheticFixes: Map<string, FixRecord>): ProcedureFeature[] {
  return [...syntheticFixes.values()].map((fix) => ({
    type: 'Feature' as const,
    geometry: point(fix.longitude, fix.latitude),
    properties: baseProps({
      object_type: 'ProcedureFix',
      feature_id: `fix_${slug(fix.identifier)}`,
      ident: fix.identifier,
      name: fix.identifier,
      source_page: null,
      source_text: `${fix.identifier} derived from D-fix naming (radial + DME distance)`,
      coordinate_quality: 'derived_from_dme_fix_name',
      review_required: true,
      confidence: fix.confidence ?? 0.6,
    }),
  }));
}

function pointRecord(coordinate: [number, number]): FixRecord {
  return { longitude: coordinate[0], latitude: coordinate[1] };
}

function geometrySemanticFeatures(
  semantics: GeometrySemanticRecord[],
  procedures: ProcedureRecord[],
  fixMap: Map<string, FixRecord>,
  navaidMap: Map<string, FixRecord>,
  understanding: ProcedureUnderstandingResult,
  group: ProcedureGroup,
): ProcedureFeature[] {
  const features: ProcedureFeature[] = [];
  const arc = semantics.find((item) => item.type === 'DME_ARC' && item.centerNavaid && item.radiusNm);
  const center = arc?.centerNavaid ? navaidMap.get(arc.centerNavaid.toUpperCase()) : undefined;
  if (!arc || !center || !isCoordinate(center.longitude, center.latitude)) return features;

  const radiusNm = Number(arc.radiusNm);
  const radials = semantics.filter((item) => item.type === 'RADIAL' && Number.isFinite(Number(item.radialDeg)));
  const leadRadials = semantics.filter((item) => item.type === 'LEAD_RADIAL' && Number.isFinite(Number(item.radialDeg)));
  const finalRadial = radials.find((item) => Number(item.radialDeg) === 340) ?? radials[0];
  const finalRadialDeg = Number(finalRadial?.radialDeg ?? 340);

  features.push({
    type: 'Feature',
    geometry: line(circleCoordinates(center, radiusNm, 144)),
    properties: baseProps({
      object_type: 'DMEReferenceCircle',
      feature_id: `dme_arc_${slug(arc.centerNavaid)}_${radiusNm}`,
      name: arc.labelText ?? `${radiusNm} DME ARC ${arc.centerNavaid}`,
      label_on_chart: arc.labelText ?? `${radiusNm} DME ARC`,
      ident: `${radiusNm}D ${arc.centerNavaid}`,
      arc_center: arc.centerNavaid,
      arc_radius_nm: radiusNm,
      source_page: arc.sourcePageNo ?? group.chartPageNo ?? group.chartPages[0] ?? null,
      source_text: arc.labelText ?? `${radiusNm} DME ARC ${arc.centerNavaid}`,
      coordinate_quality: 'derived_from_dme_arc_semantics',
      review_required: true,
      confidence: arc.confidence ?? 0.5,
    }),
  });

  for (const radial of radials) {
    features.push(radialFeature(radial, center, radiusNm + 6, 'RadialReference'));
  }
  for (const radial of leadRadials) {
    features.push(radialFeature(radial, center, radiusNm + 3, 'LeadRadial'));
  }

  const hasLegGeometry = procedures.some((procedure) => (procedure.legs ?? []).length > 0);
  if (!hasLegGeometry) {
    for (const procedure of procedures) {
      const procedureName = procedure.procedureName ?? '';
      const startFix = fixMap.get(procedureName.split(/\s+/)[0]?.toUpperCase());
      const entryRadial = radialForProcedure(radials, procedureName, finalRadialDeg);
      if (!startFix || !isCoordinate(startFix.longitude, startFix.latitude) || !entryRadial) continue;
      const entryDeg = Number(entryRadial.radialDeg);
      const entry13 = destinationPoint(center, entryDeg, radiusNm + 2);
      const entry11 = destinationPoint(center, entryDeg, radiusNm);
      const arcCoords = arcCoordinates(center, radiusNm, entryDeg, finalRadialDeg);
      const final11 = destinationPoint(center, finalRadialDeg, radiusNm);
      const final13 = destinationPoint(center, finalRadialDeg, radiusNm + 2);
      const trackCoords = [coord(startFix.longitude, startFix.latitude), entry13, entry11, ...arcCoords, final11, final13];

      features.push({
        type: 'Feature',
        geometry: line(trackCoords),
        properties: baseProps({
          object_type: 'ProcedureTrack',
          feature_id: `track_${slug(procedureName)}_dme_arc`,
          procedure: procedureName,
          name: procedureName,
          transition_fix: startFix.identifier,
          arc_center: arc.centerNavaid,
          arc_radius_nm: radiusNm,
          final_radial: `RDL${String(finalRadialDeg).padStart(3, '0')} ${arc.centerNavaid}`,
          source_page: group.chartPageNo ?? group.chartPages[0] ?? null,
          source_text: `${procedureName} derived from ${arc.labelText ?? `${radiusNm} DME ARC`} and ${entryRadial.labelText ?? `RDL${entryDeg}`}`,
          coordinate_quality: 'derived_from_dme_arc_semantics',
          review_required: true,
          confidence: Math.min(procedure.confidence ?? 0.5, arc.confidence ?? 0.5),
        }),
      });

      features.push(dmeLegFeature(procedureName, 'TRACK_TO_DME_FIX', 10, [coord(startFix.longitude, startFix.latitude), entry13], startFix.identifier, `${radiusNm + 2}D ${arc.centerNavaid}`, entryRadial, true));
      features.push(dmeLegFeature(procedureName, 'DME_ARC', 20, [entry11, ...arcCoords, final11], `${radiusNm}D ${arc.centerNavaid}`, `RDL${String(finalRadialDeg).padStart(3, '0')} ${arc.centerNavaid}`, arc, true));
    }
  }

  return features;
}

function navaidFeatures(navaidMap: Map<string, FixRecord>): ProcedureFeature[] {
  return [...navaidMap.values()].flatMap((navaid) => {
    if (!navaid.identifier || !isCoordinate(navaid.longitude, navaid.latitude)) return [];
    return [{
      type: 'Feature',
      geometry: point(navaid.longitude, navaid.latitude),
      properties: baseProps({
        object_type: 'Navaid',
        feature_id: `navaid_${slug(navaid.identifier)}`,
        ident: navaid.identifier,
        name: navaid.identifier,
        type: 'VOR/DME',
        source_text: navaid.rawCoordinate ?? navaid.identifier,
        source_page: navaid.sourcePage ?? null,
        coordinate_quality: 'supporting_info_coordinate',
        review_required: false,
        confidence: navaid.confidence ?? 0.7,
      }),
    }];
  });
}

function radialFeature(radial: GeometrySemanticRecord, center: FixRecord, lengthNm: number, objectType: 'RadialReference' | 'LeadRadial'): ProcedureFeature {
  const radialDeg = Number(radial.radialDeg);
  const start = destinationPoint(center, radialDeg, 0.5);
  const end = destinationPoint(center, radialDeg, lengthNm);
  return {
    type: 'Feature',
    geometry: line([start, end]),
    properties: baseProps({
      object_type: objectType,
      feature_id: `${objectType === 'LeadRadial' ? 'lead_radial' : 'radial'}_${slug(radial.labelText ?? radialDeg)}`,
      ident: radial.labelText ?? `RDL${String(radialDeg).padStart(3, '0')}`,
      name: radial.labelText ?? `RDL${String(radialDeg).padStart(3, '0')}`,
      radial_deg: radialDeg,
      inbound_track_mag: radial.inboundTrackDeg ?? null,
      source_page: radial.sourcePageNo ?? null,
      source_text: radial.labelText ?? null,
      coordinate_quality: 'derived_from_radial_semantics',
      review_required: radial.reviewRequired ?? true,
      confidence: radial.confidence ?? 0.5,
    }),
  };
}

function dmeLegFeature(
  procedureName: string,
  legType: string,
  sequence: number,
  coordinates: number[][],
  fromFix: unknown,
  toFix: unknown,
  source: GeometrySemanticRecord,
  reviewRequired: boolean,
): ProcedureFeature {
  return {
    type: 'Feature',
    geometry: line(coordinates),
    properties: baseProps({
      object_type: 'ProcedureLeg',
      feature_id: `leg_${slug(procedureName)}_${sequence}_${slug(legType)}`,
      procedure: procedureName,
      leg_seq: sequence,
      leg_type: legType,
      path_terminator: legType,
      from_fix: fromFix,
      to_fix: toFix,
      source_page: source.sourcePageNo ?? null,
      source_text: source.labelText ?? legType,
      coordinate_quality: 'derived_from_dme_arc_semantics',
      review_required: reviewRequired,
      confidence: source.confidence ?? 0.5,
    }),
  };
}

function legFeature(procedureName: string, leg: LegRecord, coordinates: number[][], quality: string): ProcedureFeature {
  return {
    type: 'Feature',
    geometry: line(coordinates),
    properties: baseProps({
      object_type: 'ProcedureLeg',
      feature_id: `leg_${slug(procedureName)}_${leg.sequence ?? 'x'}_${slug(leg.fixIdentifier ?? '')}`,
      procedure: procedureName,
      leg_seq: leg.sequence ?? null,
      leg_type: leg.pathTerminator ?? null,
      path_terminator: leg.pathTerminator ?? null,
      from_fix: leg.fromFix ?? null,
      to_fix: leg.fixIdentifier ?? null,
      fix_identifier: leg.fixIdentifier ?? null,
      course_deg_mag: leg.courseDegMag ?? null,
      distance_nm: leg.distanceNm ?? null,
      turn_direction: leg.turnDirection ?? null,
      altitude_constraint: leg.altitudeConstraint?.rawText ?? leg.altitudeConstraint?.type ?? null,
      altitude_ft: leg.altitudeConstraint?.altitudeFt ?? null,
      lower_ft: leg.altitudeConstraint?.lowerFt ?? null,
      upper_ft: leg.altitudeConstraint?.upperFt ?? null,
      source_page: null,
      source_text: [procedureName, leg.pathTerminator ?? '', leg.fromFix ?? '', '->', leg.fixIdentifier ?? '', leg.remarks ?? ''].filter(Boolean).join(' ').trim(),
      coordinate_quality: quality,
      review_required: leg.reviewRequired === true || quality !== 'derived_from_fix_coordinates',
      confidence: leg.confidence ?? 0.5,
    }),
  };
}

// labelPlan → LabelPoint：把识别阶段的标签规划落成带 text_anchor/text_offset 的点要素。
// 节点标签自动避开进出航段方向；航段/弧线/径向线标签沿线取位并向规划侧偏置。
const LABEL_KIND_TO_TYPE: Record<string, string> = {
  FIX_NAME: 'ProcedureFix',
  PROCEDURE_NAME: 'ProcedureName',
  COURSE_DISTANCE: 'ProcedureCourse',
  NAVAID_INFO: 'Navaid',
  DME_ARC: 'DMEArc',
  RADIAL: 'Radial',
  LEAD_RADIAL: 'LeadRadial',
  RUNWAY: 'Runway',
  HOLDING: 'ChartLabel',
  MSA: 'MSA',
  NOTE: 'ChartLabel',
};

const LABEL_KIND_PRIORITY: Record<string, number> = {
  NAVAID_INFO: 100,
  FIX_NAME: 90,
  PROCEDURE_NAME: 88,
  LEAD_RADIAL: 85,
  RUNWAY: 82,
  DME_ARC: 80,
  COURSE_DISTANCE: 76,
  RADIAL: 70,
  HOLDING: 65,
  NOTE: 55,
  MSA: 40,
};

// 罗盘方位 → MapLibre text-anchor（anchor 指文字块贴向锚点的边）与 em 偏移
const DIRECTION_PLACEMENT: Record<string, { anchor: string; offset: [number, number] }> = {
  N: { anchor: 'bottom', offset: [0, -0.9] },
  NE: { anchor: 'bottom-left', offset: [0.7, -0.7] },
  E: { anchor: 'left', offset: [0.9, 0] },
  SE: { anchor: 'top-left', offset: [0.7, 0.7] },
  S: { anchor: 'top', offset: [0, 0.9] },
  SW: { anchor: 'top-right', offset: [-0.7, 0.7] },
  W: { anchor: 'right', offset: [-0.9, 0] },
  NW: { anchor: 'bottom-right', offset: [-0.7, -0.7] },
};

const POINT_ANCHOR_TYPES: Record<string, string[]> = {
  FIX: ['ProcedureFix'],
  NAVAID: ['Navaid'],
  RUNWAY: ['RunwayThreshold', 'RunwayEnd'],
};

interface ResolvedLabelAnchor {
  coordinate: [number, number];
  textAnchor: string;
  offset: [number, number];
  parentFeatureId: string;
  parentObjectType: string;
}

function labelPlanFeatures(
  understanding: ProcedureUnderstandingResult,
  group: ProcedureGroup,
  features: ProcedureFeature[],
): ProcedureFeature[] {
  const plan = (understanding.labelPlan ?? []) as LabelPlanRecord[];
  if (!plan.length) return [];

  const result: ProcedureFeature[] = [];
  const seen = new Set<string>();

  plan.forEach((label, index) => {
    const text = String(label.text ?? '').trim();
    if (!text) return;
    const anchor = resolveLabelAnchor(label, features);
    if (!anchor) return;
    const kind = String(label.labelKind ?? 'NOTE').toUpperCase();
    const dedupeKey = `${anchor.parentFeatureId}|${kind}|${text}`;
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);

    result.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: anchor.coordinate },
      properties: baseProps({
        object_type: 'LabelPoint',
        feature_id: `label_${index + 1}_${slug(text.split('\n')[0])}`,
        label_text: text,
        label_type: LABEL_KIND_TO_TYPE[kind] ?? 'ChartLabel',
        label_kind: kind,
        priority: Number.isFinite(Number(label.priority)) && label.priority !== null
          ? Number(label.priority)
          : LABEL_KIND_PRIORITY[kind] ?? 50,
        parent_feature_id: anchor.parentFeatureId,
        parent_object_type: anchor.parentObjectType,
        text_anchor: anchor.textAnchor,
        text_offset_x: anchor.offset[0],
        text_offset_y: anchor.offset[1],
        source_page: label.sourcePageNo ?? group.chartPageNo ?? group.chartPages?.[0] ?? null,
        source_text: text,
        coordinate_quality: 'derived_from_label_plan',
        review_required: label.reviewRequired === true,
        confidence: label.confidence ?? 0.6,
      }),
    });
  });

  return result;
}

function resolveLabelAnchor(label: LabelPlanRecord, features: ProcedureFeature[]): ResolvedLabelAnchor | undefined {
  const anchorType = String(label.anchorType ?? 'FIX').toUpperCase();
  const pointTypes = POINT_ANCHOR_TYPES[anchorType];
  if (pointTypes) return resolvePointAnchor(label, pointTypes, features);
  return resolveLineAnchor(label, anchorType, features);
}

function resolvePointAnchor(
  label: LabelPlanRecord,
  objectTypes: string[],
  features: ProcedureFeature[],
): ResolvedLabelAnchor | undefined {
  const ident = String(label.anchorIdent ?? '').trim().toUpperCase();
  if (!ident) return undefined;
  const target = features.find(
    (feature) => feature.geometry?.type === 'Point'
      && objectTypes.includes(String(feature.properties?.object_type))
      && String(feature.properties?.ident ?? feature.properties?.name ?? '').toUpperCase() === ident,
  );
  if (!target || target.geometry?.type !== 'Point') return undefined;
  const coordinate = target.geometry.coordinates as [number, number];

  const requested = String(label.anchorDirection ?? 'AUTO').toUpperCase();
  const direction = DIRECTION_PLACEMENT[requested]
    ? requested
    : clearDirectionAt(coordinate, features);
  const placement = DIRECTION_PLACEMENT[direction] ?? DIRECTION_PLACEMENT.E;
  return {
    coordinate,
    textAnchor: placement.anchor,
    offset: placement.offset,
    parentFeatureId: String(target.properties?.feature_id ?? ''),
    parentObjectType: String(target.properties?.object_type ?? ''),
  };
}

// 专业制图规则：节点文字放在没有航线经过的一侧。
// 汇总所有经过该点的线段的进出方向向量，取合向量的反方向作为标签方位。
function clearDirectionAt(coordinate: [number, number], features: ProcedureFeature[]): string {
  const epsilon = 1e-4;
  let sumX = 0;
  let sumY = 0;
  for (const feature of features) {
    if (feature.geometry?.type !== 'LineString') continue;
    const coords = feature.geometry.coordinates;
    coords.forEach((vertex, index) => {
      if (Math.abs(vertex[0] - coordinate[0]) > epsilon || Math.abs(vertex[1] - coordinate[1]) > epsilon) return;
      for (const neighbor of [coords[index - 1], coords[index + 1]]) {
        if (!neighbor) continue;
        const dx = neighbor[0] - coordinate[0];
        const dy = coordinate[1] - neighbor[1]; // 屏幕坐标 y 向下
        const length = Math.hypot(dx, dy);
        if (!length) continue;
        sumX += dx / length;
        sumY += dy / length;
      }
    });
  }
  if (!sumX && !sumY) return 'E';
  // 反方向 = 远离所有航线的一侧
  const angle = (Math.atan2(-sumX, sumY) * 180) / Math.PI; // 0=N, 顺时针
  const sectors = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return sectors[Math.round(((angle + 360) % 360) / 45) % 8];
}

function resolveLineAnchor(
  label: LabelPlanRecord,
  anchorType: string,
  features: ProcedureFeature[],
): ResolvedLabelAnchor | undefined {
  const target = findLineFeature(label, anchorType, features);
  if (!target || target.geometry?.type !== 'LineString') return undefined;

  const placement = String(label.placementAlongLine ?? 'MIDDLE').toUpperCase();
  const fraction = placement === 'START' ? 0.18 : placement === 'END' ? 0.82 : 0.5;
  const located = lineLabelPosition(target.geometry.coordinates, fraction);
  if (!located) return undefined;

  const side = String(label.sideOfLine ?? 'RIGHT').toUpperCase() === 'LEFT' ? -1 : 1;
  const bearingRad = (located.bearingDeg * Math.PI) / 180;
  // 行进方向右侧的屏幕偏移向量 = (cos b, sin b)，b 为自北顺时针方位角
  const offset: [number, number] = [
    Math.cos(bearingRad) * 1.2 * side,
    Math.sin(bearingRad) * 1.2 * side,
  ];
  return {
    coordinate: located.coordinate,
    textAnchor: 'center',
    offset: [round2(offset[0]), round2(offset[1])],
    parentFeatureId: String(target.properties?.feature_id ?? ''),
    parentObjectType: String(target.properties?.object_type ?? ''),
  };
}

function findLineFeature(label: LabelPlanRecord, anchorType: string, features: ProcedureFeature[]) {
  const procedureName = String(label.procedureName ?? '').trim().toUpperCase();
  const ident = String(label.anchorIdent ?? '').trim().toUpperCase();
  const lines = features.filter((feature) => feature.geometry?.type === 'LineString');
  const matchesProcedure = (feature: ProcedureFeature) =>
    !procedureName || String(feature.properties?.procedure ?? '').toUpperCase() === procedureName;

  if (anchorType === 'LEG') {
    return lines.find((feature) =>
      String(feature.properties?.object_type) === 'ProcedureLeg'
      && matchesProcedure(feature)
      && (label.legSequence == null || Number(feature.properties?.leg_seq) === Number(label.legSequence))
      && (!ident
        || String(feature.properties?.to_fix ?? '').toUpperCase() === ident
        || String(feature.properties?.from_fix ?? '').toUpperCase() === ident),
    );
  }
  if (anchorType === 'PROCEDURE_TRACK') {
    return lines.find((feature) => String(feature.properties?.object_type) === 'ProcedureTrack' && matchesProcedure(feature));
  }
  if (anchorType === 'DME_ARC') {
    // 优先锚在弧形航段上（真实飞行轨迹），弧参考圆兜底
    return lines.find((feature) =>
      String(feature.properties?.object_type) === 'ProcedureLeg'
      && matchesProcedure(feature)
      && ['AF', 'DME_ARC'].includes(String(feature.properties?.path_terminator ?? feature.properties?.leg_type ?? '').toUpperCase()),
    ) ?? lines.find((feature) => String(feature.properties?.object_type) === 'DMEReferenceCircle');
  }
  if (anchorType === 'RADIAL') {
    return lines.find((feature) =>
      ['RadialReference', 'LeadRadial'].includes(String(feature.properties?.object_type))
      && (!ident || String(feature.properties?.ident ?? feature.properties?.name ?? '').toUpperCase().includes(ident)),
    );
  }
  return undefined;
}

function lineLabelPosition(coordinates: number[][], fraction: number) {
  if (coordinates.length < 2) return undefined;
  const lengths = coordinates.slice(0, -1).map((vertex, index) => Math.hypot(
    coordinates[index + 1][0] - vertex[0],
    coordinates[index + 1][1] - vertex[1],
  ));
  const total = lengths.reduce((sum, value) => sum + value, 0);
  if (!total) return undefined;

  let traversed = 0;
  let segment = 0;
  const targetLength = total * Math.max(0, Math.min(1, fraction));
  for (; segment < lengths.length - 1; segment += 1) {
    if (traversed + lengths[segment] >= targetLength) break;
    traversed += lengths[segment];
  }
  const from = coordinates[segment];
  const to = coordinates[segment + 1];
  const segmentFraction = lengths[segment] ? Math.max(0, Math.min(1, (targetLength - traversed) / lengths[segment])) : 0;
  const coordinate: [number, number] = [
    from[0] + (to[0] - from[0]) * segmentFraction,
    from[1] + (to[1] - from[1]) * segmentFraction,
  ];
  const bearingDeg = ((Math.atan2(to[0] - from[0], to[1] - from[1]) * 180) / Math.PI + 360) % 360;
  return { coordinate, bearingDeg };
}

function round2(value: number) {
  return Math.round(value * 100) / 100;
}

function buildFixMetadata(
  procedures: ProcedureRecord[],
  chartTexts: ChartTextRecord[],
  understanding: ProcedureUnderstandingResult,
  group: ProcedureGroup,
) {
  const metadata = new Map<string, FixMetadata>();
  const ensure = (ident: unknown) => {
    const key = String(ident ?? '').trim().toUpperCase();
    if (!key) return undefined;
    const item = metadata.get(key) ?? {};
    metadata.set(key, item);
    return item;
  };

  for (const procedure of procedures) {
    const procedureName = String(procedure.procedureName ?? '').trim();
    const orderedLegs = [...(procedure.legs ?? [])].sort((a, b) => Number(a.sequence ?? 0) - Number(b.sequence ?? 0));
    const finalLeg = orderedLegs[orderedLegs.length - 1];
    for (const leg of orderedLegs) {
      const ident = String(leg.fixIdentifier ?? '').toUpperCase();
      const item = ensure(ident);
      if (!item) continue;
      const altitudeFt = leg.altitudeConstraint?.altitudeFt ?? leg.altitudeConstraint?.lowerFt ?? leg.altitudeConstraint?.upperFt;
      if (Number.isFinite(Number(altitudeFt))) item.altitudeFt ??= Number(altitudeFt);
      const isEntryProcedureFix = procedureName && firstToken(procedureName) === ident;
      if (String(leg.pathTerminator ?? '').toUpperCase() === 'IF' && !isEntryProcedureFix) item.role ??= 'IF';
      if (finalLeg === leg) item.finalTrackMag ??= runwayCourse(understanding, group);
    }
  }

  for (const chartText of chartTexts) {
    const text = String(chartText.normalizedText ?? chartText.text ?? '').toUpperCase();
    const match = text.match(/\b([A-Z][A-Z0-9]{2,4})\s*(?:\((IAF|IF)\))?\s*(\d{4,5})?\b/);
    if (!match) continue;
    const item = ensure(match[1]);
    if (!item) continue;
    if (match[2]) item.role = match[2];
    if (match[3] && Number.isFinite(Number(match[3]))) item.altitudeFt ??= Number(match[3]);
  }

  return metadata;
}

function firstToken(value: string) {
  return value.trim().split(/\s+/)[0]?.toUpperCase() ?? '';
}

function runwayCourse(understanding: ProcedureUnderstandingResult, group: ProcedureGroup) {
  const runwayRecord = (understanding.runways ?? []).find((runway) => String((runway as Record<string, unknown>).identifier ?? '').toUpperCase().includes(String(understanding.runway ?? group.runway ?? '').replace(/^RWY?/i, 'RW')));
  const runwayBearing = runwayRecord ? Number((runwayRecord as Record<string, unknown>).magneticBearing) : NaN;
  if (Number.isFinite(runwayBearing)) return runwayBearing;
  const runway = String(understanding.runway ?? group.runway ?? '').toUpperCase();
  const match = runway.match(/(?:RWY?|RUNWAY)?\s*(\d{2})/);
  return match ? Number(match[1]) * 10 : undefined;
}

function baseProps(properties: Record<string, unknown>) {
  return {
    ...properties,
    review_required: properties.review_required === true,
    coordinate_quality: properties.coordinate_quality || 'unknown',
    confidence: typeof properties.confidence === 'number' ? properties.confidence : 0.5,
  };
}

function point(lon: number | null | undefined, lat: number | null | undefined): Point {
  return { type: 'Point', coordinates: coord(lon, lat) };
}

function line(coordinates: number[][]): LineString {
  return { type: 'LineString', coordinates };
}

function coord(lon: number | null | undefined, lat: number | null | undefined): [number, number] {
  return [Number(lon), Number(lat)];
}

function isCoordinate(lon: unknown, lat: unknown) {
  if (lon === null || lon === undefined || lat === null || lat === undefined) return false;
  if (!Number.isFinite(Number(lon)) || !Number.isFinite(Number(lat))) return false;
  // (0,0) 是模型对"未知坐标"的常见占位，不是合法程序点位
  return Number(lon) !== 0 || Number(lat) !== 0;
}

function slug(value: unknown) {
  return String(value ?? 'unknown').trim().replace(/[^\w]+/g, '_').replace(/^_+|_+$/g, '') || 'unknown';
}

function buildNavaidMap(understanding: ProcedureUnderstandingResult, group: ProcedureGroup) {
  const navaids = new Map<string, FixRecord>();
  const semanticCenterIdents = new Set(
    ((understanding.geometrySemantics ?? []) as GeometrySemanticRecord[])
      .map((semantic) => semantic.centerNavaid?.toUpperCase())
      .filter((ident): ident is string => Boolean(ident)),
  );

  for (const navaid of (understanding.navaids ?? []) as Array<{ identifier?: string | null; latitude?: number | null; longitude?: number | null; rawCoordinate?: string | null; confidence?: number; reviewRequired?: boolean }>) {
    if (!navaid.identifier) continue;
    const supportCoordinate = findSupportNavaidCoordinate(group, navaid.identifier);
    const parsed = parseCompactLatLon(navaid.rawCoordinate) ?? supportCoordinate?.coordinate;
    const latitude = navaid.latitude ?? parsed?.lat;
    const longitude = navaid.longitude ?? parsed?.lon;
    if (isCoordinate(longitude, latitude)) {
      navaids.set(navaid.identifier.toUpperCase(), {
        identifier: navaid.identifier,
        latitude,
        longitude,
        rawCoordinate: navaid.rawCoordinate ?? supportCoordinate?.raw ?? null,
        sourcePage: supportCoordinate?.sourcePage ?? null,
        confidence: navaid.confidence ?? 0.5,
        reviewRequired: navaid.reviewRequired ?? false,
      });
    }
  }

  for (const ident of semanticCenterIdents) {
    if (navaids.has(ident)) continue;
    const supportCoordinate = findSupportNavaidCoordinate(group, ident);
    if (!supportCoordinate) continue;
    navaids.set(ident, {
      identifier: ident,
      latitude: supportCoordinate.coordinate.lat,
      longitude: supportCoordinate.coordinate.lon,
      rawCoordinate: supportCoordinate.raw,
      sourcePage: supportCoordinate.sourcePage,
      confidence: 0.72,
      reviewRequired: true,
    });
  }
  return navaids;
}

function findSupportNavaidCoordinate(group: ProcedureGroup, ident: string) {
  const supportNavaids = group.supportingInfoSummary?.navaids;
  const summaries = Array.isArray(supportNavaids) ? supportNavaids as SupportNavaidSummary[] : [];
  const identUpper = ident.toUpperCase();

  for (const summary of summaries) {
    const hasIdent = (summary.idents ?? []).some((item) => item.toUpperCase() === identUpper)
      || (summary.textSample ?? '').toUpperCase().includes(identUpper)
      || (summary.navaids ?? []).some((item) => item.toUpperCase().includes(identUpper));
    if (!hasIdent) continue;

    const rows = (summary.navaids ?? []).filter((row) => !/position of transmitting antenna|hours of operation|frequency/i.test(row));
    const rowIndex = rows.findIndex((row) => row.toUpperCase().includes(identUpper));
    const rawCoordinate = rowIndex >= 0 ? summary.coordinates?.[rowIndex] : undefined;
    const fallbackRaw = rowIndex === rows.length - 1 ? summary.coordinates?.[summary.coordinates.length - 1] : undefined;
    const parsed = parseCompactLatLon(rawCoordinate) ?? parseCompactLatLon(fallbackRaw);
    if (parsed) {
      return {
        coordinate: parsed,
        raw: rawCoordinate ?? fallbackRaw ?? null,
        sourcePage: summary.pageNo ?? null,
      };
    }
  }

  return undefined;
}

function radialForProcedure(radials: GeometrySemanticRecord[], procedureName: string, finalRadialDeg: number) {
  const candidates = radials.filter((radial) =>
    Number(radial.radialDeg) !== finalRadialDeg
    && (radial.relatedProcedures ?? []).some((name) => name.toUpperCase() === procedureName.toUpperCase()),
  );
  if (!candidates.length) return undefined;
  // 入弧径向线是离出弧径向线角距最远的那条；较近的（如 RDL295）是弧上中途约束径向线。
  return candidates.sort(
    (a, b) => angularDistanceDeg(Number(b.radialDeg), finalRadialDeg) - angularDistanceDeg(Number(a.radialDeg), finalRadialDeg),
  )[0];
}

function angularDistanceDeg(a: number, b: number) {
  const diff = Math.abs(a - b) % 360;
  return diff > 180 ? 360 - diff : diff;
}

function circleCoordinates(center: FixRecord, radiusNm: number, steps: number) {
  return Array.from({ length: steps + 1 }, (_, index) => destinationPoint(center, (index / steps) * 360, radiusNm));
}

function arcCoordinates(center: FixRecord, radiusNm: number, startDeg: number, endDeg: number, direction?: 'L' | 'R') {
  const deltaClockwise = (endDeg - startDeg + 360) % 360;
  const deltaCounter = deltaClockwise - 360;
  let delta: number;
  if (deltaClockwise === 0) delta = 0;
  else if (direction === 'R') delta = deltaClockwise;
  else if (direction === 'L') delta = deltaCounter;
  else delta = Math.abs(deltaClockwise) <= Math.abs(deltaCounter) ? deltaClockwise : deltaCounter;
  const steps = Math.max(8, Math.ceil(Math.abs(delta) / 5));
  return Array.from({ length: steps + 1 }, (_, index) => destinationPoint(center, startDeg + (delta * index) / steps, radiusNm));
}

function bearingFrom(center: FixRecord, target: number[]) {
  const lat1 = toRad(Number(center.latitude));
  const lon1 = toRad(Number(center.longitude));
  const lat2 = toRad(Number(target[1]));
  const lon2 = toRad(Number(target[0]));
  const y = Math.sin(lon2 - lon1) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(lon2 - lon1);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

function distanceNmFrom(center: FixRecord, target: number[]) {
  const lat1 = toRad(Number(center.latitude));
  const lat2 = toRad(Number(target[1]));
  const dLat = lat2 - lat1;
  const dLon = toRad(Number(target[0])) - toRad(Number(center.longitude));
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * Math.asin(Math.sqrt(h)) * EARTH_RADIUS_NM;
}

function destinationPoint(center: FixRecord, bearingDeg: number, distanceNm: number): [number, number] {
  const lat1 = toRad(Number(center.latitude));
  const lon1 = toRad(Number(center.longitude));
  const bearing = toRad(bearingDeg);
  const angularDistance = distanceNm / EARTH_RADIUS_NM;
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(angularDistance)
    + Math.cos(lat1) * Math.sin(angularDistance) * Math.cos(bearing),
  );
  const lon2 = lon1 + Math.atan2(
    Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(lat1),
    Math.cos(angularDistance) - Math.sin(lat1) * Math.sin(lat2),
  );
  return [toDeg(lon2), toDeg(lat2)];
}

function parseCompactLatLon(raw: string | null | undefined) {
  if (!raw) return undefined;
  const matches = [...raw.matchAll(/(\d{2,3})(\d{2})(\d{2}(?:\.\d+)?)([NSEW])/gi)];
  if (matches.length < 2) return undefined;
  const lat = compactDmsToDecimal(matches[0]);
  const lon = compactDmsToDecimal(matches[1]);
  return lat === undefined || lon === undefined ? undefined : { lat, lon };
}

function compactDmsToDecimal(match: RegExpMatchArray) {
  const degrees = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const direction = match[4].toUpperCase();
  if (![degrees, minutes, seconds].every(Number.isFinite)) return undefined;
  const sign = direction === 'S' || direction === 'W' ? -1 : 1;
  return sign * (degrees + minutes / 60 + seconds / 3600);
}

function toRad(value: number) {
  return (value * Math.PI) / 180;
}

function toDeg(value: number) {
  return (value * 180) / Math.PI;
}
