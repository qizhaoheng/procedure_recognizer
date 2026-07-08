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
  const fixMap = new Map(
    fixes
      .filter((fix) => fix.identifier && isCoordinate(fix.longitude, fix.latitude))
      .map((fix) => [String(fix.identifier).toUpperCase(), fix]),
  );
  const navaidMap = buildNavaidMap(understanding, group);
  const arcContext = resolveArcContext(geometrySemantics, navaidMap);
  const syntheticFixes = new Map<string, FixRecord>();
  const legChainFeatures = procedures.flatMap(
    (procedure) => procedureFeatures(procedure, fixMap, arcContext, syntheticFixes, understanding, group),
  );

  const features: ProcedureFeature[] = [
    procedureChartFeature(understanding, group),
    ...navaidFeatures(navaidMap),
    ...fixes.flatMap((fix) => fixFeature(fix)),
    ...syntheticFixFeatures(syntheticFixes),
    ...legChainFeatures,
    ...geometrySemanticFeatures(geometrySemantics, procedures, fixMap, navaidMap, understanding, group),
  ];

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

function fixFeature(fix: FixRecord): ProcedureFeature[] {
  if (!fix.identifier || !isCoordinate(fix.longitude, fix.latitude)) return [];
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
      source_text: `${procedureName} ${leg.pathTerminator ?? ''} ${leg.fromFix ?? ''} -> ${leg.fixIdentifier ?? ''}`.trim(),
      coordinate_quality: quality,
      review_required: leg.reviewRequired === true || quality !== 'derived_from_fix_coordinates',
      confidence: leg.confidence ?? 0.5,
    }),
  };
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
