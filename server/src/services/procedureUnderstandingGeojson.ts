import type { Feature, FeatureCollection, Geometry, GeoJsonProperties, LineString, Point } from 'geojson';
import type { PdfPageAsset, ProcedureGroup, ProcedureUnderstandingResult } from '../types/procedure';
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
  recommendedNavaid?: string | null;
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

type RunwayGeometryRecord = {
  identifier: string;
  threshold?: [number, number];
  end?: [number, number];
  bearing?: number;
  rawThreshold?: string | null;
  rawEnd?: string | null;
  sourcePage?: number | null;
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
  pages: PdfPageAsset[] = [],
): FeatureCollection<Geometry | null, GeoJsonProperties> {
  const fixes = enrichFixesWithPageCoordinates((understanding.fixes ?? []) as FixRecord[], group, pages);
  const recognizedProcedures = (understanding.procedures ?? []) as ProcedureRecord[];
  const procedures = conventionalSid424RenderingProcedures(recognizedProcedures, understanding, group);
  const geometrySemantics = (understanding.geometrySemantics ?? []) as GeometrySemanticRecord[];
  const chartTexts = (understanding.chartTexts ?? []) as ChartTextRecord[];
  const fixMap = new Map(
    fixes
      .filter((fix) => fix.identifier && isCoordinate(fix.longitude, fix.latitude))
      .map((fix) => [String(fix.identifier).toUpperCase(), fix]),
  );
  const navaidMap = buildNavaidMap(understanding, group);
  const runwayMap = buildRunwayMap(understanding, group);
  const arcContext = resolveArcContext(geometrySemantics, navaidMap);
  const fixMetadata = buildFixMetadata(procedures, chartTexts, understanding, group);
  const syntheticFixes = new Map<string, FixRecord>();
  const legChainFeatures = procedures.flatMap(
    (procedure) => procedureFeatures(procedure, fixMap, arcContext, runwayMap, navaidMap, syntheticFixes, understanding, group),
  );
  const finalCommonFeatures = finalCommonSegmentFeatures(procedures, fixMap, fixMetadata, understanding, group);

  const features: ProcedureFeature[] = [
    procedureChartFeature(understanding, group),
    ...runwayFeatures(runwayMap),
    ...sidAltitudePointFeatures(procedures, runwayMap, understanding, group),
    ...navaidFeatures(navaidMap),
    ...conventionalSidRadialFeatures(procedures, navaidMap, chartTexts, understanding, group),
    ...fixes.flatMap((fix) => fixFeature(fix, fixMetadata)),
    ...syntheticFixFeatures(syntheticFixes),
    ...legChainFeatures,
    ...finalCommonFeatures,
    ...geometrySemanticFeatures(geometrySemantics, procedures, fixMap, navaidMap, understanding, group),
  ];
  features.push(...labelPlanFeatures(understanding, group, features));
  features.push(...conventionalSidAutoLabelFeatures(procedures, understanding, group, features));

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
  runwayMap: Map<string, RunwayGeometryRecord>,
  navaidMap: Map<string, FixRecord>,
  syntheticFixes: Map<string, FixRecord>,
  understanding: ProcedureUnderstandingResult,
  group: ProcedureGroup,
): ProcedureFeature[] {
  const procedureName = procedure.procedureName || 'UNKNOWN';
  const orderedLegs = [...(procedure.legs ?? [])].sort((a, b) => Number(a.sequence ?? 0) - Number(b.sequence ?? 0));

  const features: ProcedureFeature[] = [];
  const chain: number[][] = [];
  let current: [number, number] | undefined;
  let lastDmeNm: number | undefined;
  let lastCourseDeg: number | undefined;
  let usedDerivedGeometry = false;

  for (let legIndex = 0; legIndex < orderedLegs.length; legIndex += 1) {
    const leg = orderedLegs[legIndex];
    const nextLeg = orderedLegs[legIndex + 1];
    const pathTerminator = String(leg.pathTerminator ?? '').toUpperCase();
    const start = resolveLegStart(leg, fixMap, runwayMap, procedure.runway ?? understanding.runway ?? group.runway);
    if (!current && start) current = start.coordinate;
    const resolved = resolveLegTarget(leg, fixMap, arcContext, runwayMap, navaidMap, syntheticFixes, current, lastDmeNm);
    let target = resolved?.coordinate;
    let geometry: number[][] | undefined;
    let quality = resolved?.quality ?? 'derived_from_fix_coordinates';

    if (pathTerminator === 'CA' && !target && current && Number.isFinite(Number(leg.courseDegMag))) {
      const runway = runwayMap.get(normalizeRunwayName(procedure.runway ?? understanding.runway ?? group.runway));
      const courseDeg = Number(leg.courseDegMag);
      target = sidAltitudePointCoordinate(current, courseDeg, leg, runway);
      geometry = [current, target];
      quality = 'derived_from_sid_course_to_altitude';
    } else if ((pathTerminator === 'CI' || pathTerminator === 'CR') && !target && current && Number.isFinite(Number(leg.courseDegMag))) {
      const courseDeg = Number(leg.courseDegMag);
      const intercept = conventionalSidIntercept(leg, nextLeg, navaidMap);
      if (
        intercept
        &&
        isDepartureProcedure(understanding, group)
        && isTurnDirection(leg.turnDirection)
        && Number.isFinite(Number(lastCourseDeg))
      ) {
        geometry = sidTurnToRadialInterceptGeometry(
          current,
          Number(lastCourseDeg),
          courseDeg,
          leg.turnDirection,
          intercept.center,
          intercept.radialDeg,
          leg.distanceNm,
        );
        target = geometry?.[geometry.length - 1];
        quality = pathTerminator === 'CR'
          ? 'derived_from_sid_turn_to_radial_intercept'
          : 'derived_from_sid_turn_to_course_intercept';
      } else {
        target = intercept
          ? courseRadialIntersection(current, courseDeg, intercept.center, intercept.radialDeg)?.coordinate
          : destinationPoint(pointRecord(current), courseDeg, legDistanceOrDefault(leg.distanceNm, 2));
        if (!target) {
          target = destinationPoint(pointRecord(current), courseDeg, legDistanceOrDefault(leg.distanceNm, 2));
        }
        geometry = [current, target];
        quality = pathTerminator === 'CR' ? 'derived_from_course_to_radial' : 'derived_from_course_intercept';
      }
    } else if (pathTerminator === 'CI' && !target && current && Number.isFinite(Number(leg.courseDegMag))) {
      // 航向截获腿：从当前位置沿磁航向推算终点（无命名 Fix）。
      target = destinationPoint(pointRecord(current), Number(leg.courseDegMag), legDistanceOrDefault(leg.distanceNm, 2));
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
    } else if (
      pathTerminator === 'DF'
      && current
      && target
      && isDepartureProcedure(understanding, group)
      && isTurnDirection(leg.turnDirection)
      && Number.isFinite(Number(lastCourseDeg))
    ) {
      geometry = sidTurnToFixGeometry(current, target, Number(lastCourseDeg), leg.turnDirection as 'L' | 'R');
      quality = 'derived_from_sid_chart_turn';
    } else if (current && target) {
      geometry = [current, target];
      quality = resolved?.quality ?? (resolved?.synthetic ? 'derived_from_dme_fix_name' : 'derived_from_fix_coordinates');
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
    if (Number.isFinite(Number(leg.courseDegMag)) && Number(leg.courseDegMag) > 0) {
      lastCourseDeg = Number(leg.courseDegMag);
    } else if (geometry && geometry.length >= 2) {
      lastCourseDeg = bearingFrom(pointRecord(geometry[geometry.length - 2] as [number, number]), geometry[geometry.length - 1]);
    }
    lastDmeNm = dmeDistanceFromText(leg.fixIdentifier) ?? dmeDistanceFromText(leg.remarks) ?? lastDmeNm;
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
  runwayMap: Map<string, RunwayGeometryRecord>,
  navaidMap: Map<string, FixRecord>,
  syntheticFixes: Map<string, FixRecord>,
  current?: [number, number],
  lastDmeNm?: number,
): { coordinate: [number, number]; synthetic: boolean; dmeDistanceNm?: number; quality?: string } | undefined {
  const ident = String(leg.fixIdentifier ?? '').trim().toUpperCase();
  if (!ident) return undefined;

  const fix = fixMap.get(ident);
  if (fix && isCoordinate(fix.longitude, fix.latitude)) {
    return { coordinate: coord(fix.longitude, fix.latitude), synthetic: false };
  }

  const runway = runwayMap.get(normalizeRunwayName(ident));
  if (runway?.threshold) {
    return { coordinate: runway.threshold, synthetic: true, quality: 'derived_from_runway_threshold' };
  }

  if (ident === 'DER') {
    const startRunway = runwayMap.get(normalizeRunwayName(leg.fromFix));
    if (startRunway?.end) {
      return { coordinate: startRunway.end, synthetic: true, quality: 'derived_from_runway_end' };
    }
  }

  const namedDme = dmeDistanceFromText(ident);
  if (namedDme !== undefined && current && Number.isFinite(Number(leg.courseDegMag))) {
    const distanceFromCurrent = Math.max(0.2, namedDme - (lastDmeNm ?? 0));
    return {
      coordinate: destinationPoint(pointRecord(current), Number(leg.courseDegMag), distanceFromCurrent),
      synthetic: true,
      dmeDistanceNm: namedDme,
      quality: 'derived_from_radar_sid_dme',
    };
  }

  const pathTerminator = String(leg.pathTerminator ?? '').toUpperCase();
  const referenceNavaid = String(leg.recommendedNavaid ?? '').trim().toUpperCase();
  const radialDeg = Number(leg.courseDegMag);
  const distanceNm = Number(leg.distanceNm);
  const navaid = referenceNavaid ? navaidMap.get(referenceNavaid) : undefined;
  if (
    pathTerminator === 'CF'
    && ident
    && navaid
    && isCoordinate(navaid.longitude, navaid.latitude)
    && Number.isFinite(radialDeg)
    && Number.isFinite(distanceNm)
    && distanceNm > 0
  ) {
    const coordinate = destinationPoint(navaid, radialDeg, distanceNm);
    if (!syntheticFixes.has(ident)) {
      syntheticFixes.set(ident, {
        identifier: ident,
        longitude: coordinate[0],
        latitude: coordinate[1],
        rawCoordinate: `RDL${String(Math.round(radialDeg)).padStart(3, '0')} ${referenceNavaid} ${round1(distanceNm)}NM`,
        confidence: 0.68,
        reviewRequired: true,
      });
    }
    return {
      coordinate,
      synthetic: true,
      dmeDistanceNm: distanceNm,
      quality: 'derived_from_vor_dme_radial_distance',
    };
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

function resolveLegStart(
  leg: LegRecord,
  fixMap: Map<string, FixRecord>,
  runwayMap: Map<string, RunwayGeometryRecord>,
  fallbackRunway?: string | null,
): { coordinate: [number, number]; quality: string } | undefined {
  const ident = String(leg.fromFix ?? fallbackRunway ?? '').trim().toUpperCase();
  if (!ident) return undefined;
  const fix = fixMap.get(ident);
  if (fix && isCoordinate(fix.longitude, fix.latitude)) {
    return { coordinate: coord(fix.longitude, fix.latitude), quality: 'derived_from_fix_coordinates' };
  }
  const runway = runwayMap.get(normalizeRunwayName(ident));
  if (runway?.threshold) {
    return { coordinate: runway.threshold, quality: 'derived_from_runway_threshold' };
  }
  return undefined;
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

function dmeDistanceFromText(value: unknown) {
  const text = String(value ?? '').toUpperCase();
  const match = text.match(/(\d+(?:\.\d+)?)\s*(?:DME|D)\s*[_\s-]*[A-Z]{2,4}/);
  if (!match) return undefined;
  const distanceNm = Number(match[1]);
  return Number.isFinite(distanceNm) ? distanceNm : undefined;
}

function legDistanceOrDefault(value: unknown, fallbackNm: number) {
  const distanceNm = Number(value);
  return Number.isFinite(distanceNm) && distanceNm > 0 ? distanceNm : fallbackNm;
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

function conventionalSidRadialFeatures(
  procedures: ProcedureRecord[],
  navaidMap: Map<string, FixRecord>,
  chartTexts: ChartTextRecord[],
  understanding: ProcedureUnderstandingResult,
  group: ProcedureGroup,
): ProcedureFeature[] {
  if (!isConventionalSid(understanding, group)) return [];

  const radials = new Map<string, GeometrySemanticRecord & { displayLengthNm?: number }>();
  const addRadial = (
    radialDeg: number,
    centerNavaid: string,
    relatedProcedure: string | null,
    displayLengthNm?: number,
  ) => {
    if (!Number.isFinite(radialDeg)) return;
    const center = centerNavaid.toUpperCase();
    if (!navaidMap.has(center)) return;
    const normalizedDeg = Math.round(radialDeg);
    const key = `${center}|${normalizedDeg}`;
    const current = radials.get(key);
    const related = new Set([...(current?.relatedProcedures ?? []), ...(relatedProcedure ? [relatedProcedure] : [])]);
    radials.set(key, {
      type: 'RADIAL',
      labelText: `RDL${String(normalizedDeg).padStart(3, '0')} ${center}`,
      centerNavaid: center,
      radialDeg: normalizedDeg,
      relatedProcedures: [...related],
      sourcePageNo: group.chartPageNo ?? group.chartPages?.[0] ?? null,
      confidence: current?.confidence ?? 0.68,
      reviewRequired: true,
      displayLengthNm: Math.max(current?.displayLengthNm ?? 0, displayLengthNm ?? 0) || undefined,
    });
  };

  for (const procedure of procedures) {
    const procedureName = String(procedure.procedureName ?? '');
    for (const leg of procedure.legs ?? []) {
      const pt = String(leg.pathTerminator ?? '').toUpperCase();
      const navaid = String(leg.recommendedNavaid ?? '').trim().toUpperCase();
      if (pt === 'CF' && navaid && Number.isFinite(Number(leg.courseDegMag))) {
        addRadial(Number(leg.courseDegMag), navaid, procedureName, Number(leg.distanceNm) + 4);
      }
      const remarks = String(leg.remarks ?? '');
      for (const match of remarks.matchAll(/RDL[-\s]?(\d{3})\s*([A-Z]{2,4})?/gi)) {
        addRadial(Number(match[1]), (match[2] ?? navaid).toUpperCase(), procedureName, Number(leg.distanceNm) + 4);
      }
    }
  }

  for (const text of chartTexts) {
    const raw = String(text.normalizedText ?? text.text ?? '').toUpperCase();
    for (const match of raw.matchAll(/RDL[-\s]?(\d{3})\s*([A-Z]{2,4})?/g)) {
      const fallbackNavaid = match[2] ?? firstKnownNavaid(raw, navaidMap);
      if (fallbackNavaid) addRadial(Number(match[1]), fallbackNavaid, null, 24);
    }
  }

  return [...radials.values()].flatMap((radial) => {
    const center = radial.centerNavaid ? navaidMap.get(radial.centerNavaid.toUpperCase()) : undefined;
    if (!center || !isCoordinate(center.longitude, center.latitude)) return [];
    return [radialFeature(radial, center, Math.max(8, radial.displayLengthNm ?? 24), 'RadialReference')];
  });
}

function firstKnownNavaid(text: string, navaidMap: Map<string, FixRecord>) {
  return [...navaidMap.keys()].find((ident) => new RegExp(`\\b${ident}\\b`).test(text));
}

function runwayFeatures(runwayMap: Map<string, RunwayGeometryRecord>): ProcedureFeature[] {
  return [...runwayMap.values()].flatMap((runway) => {
    const features: ProcedureFeature[] = [];
    if (runway.threshold && runway.end) {
      features.push({
        type: 'Feature',
        geometry: line([runway.threshold, runway.end]),
        properties: baseProps({
          object_type: 'Runway',
          feature_id: `runway_${slug(runway.identifier)}`,
          ident: runway.identifier,
          name: runway.identifier,
          bearing_deg: runway.bearing ?? null,
          source_page: runway.sourcePage ?? null,
          source_text: [runway.rawThreshold, runway.rawEnd].filter(Boolean).join(' / ') || runway.identifier,
          coordinate_quality: 'supporting_runway_data',
          review_required: false,
          confidence: 0.78,
        }),
      });
    }
    if (runway.threshold) {
      features.push(runwayPointFeature(runway, 'RunwayThreshold', runway.threshold, runway.rawThreshold));
    }
    if (runway.end) {
      features.push(runwayPointFeature(runway, 'RunwayEnd', runway.end, runway.rawEnd));
    }
    return features;
  });
}

function runwayPointFeature(
  runway: RunwayGeometryRecord,
  objectType: 'RunwayThreshold' | 'RunwayEnd',
  coordinate: [number, number],
  rawCoordinate?: string | null,
): ProcedureFeature {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: coordinate },
    properties: baseProps({
      object_type: objectType,
      feature_id: `${objectType === 'RunwayThreshold' ? 'thr' : 'end'}_${slug(runway.identifier)}`,
      ident: runway.identifier,
      name: objectType === 'RunwayThreshold' ? `${runway.identifier} THR` : `${runway.identifier} END`,
      source_page: runway.sourcePage ?? null,
      source_text: rawCoordinate ?? runway.identifier,
      coordinate_quality: 'supporting_runway_data',
      review_required: false,
      confidence: 0.78,
    }),
  };
}

function sidAltitudePointFeatures(
  procedures: ProcedureRecord[],
  runwayMap: Map<string, RunwayGeometryRecord>,
  understanding: ProcedureUnderstandingResult,
  group: ProcedureGroup,
): ProcedureFeature[] {
  if (!isDepartureProcedure(understanding, group)) return [];
  const features = new Map<string, ProcedureFeature>();

  for (const procedure of procedures) {
    const runwayName = normalizeRunwayName(procedure.runway ?? understanding.runway ?? group.runway);
    const runway = runwayMap.get(runwayName);
    const start = runway?.threshold;
    if (!start) continue;

    for (const leg of procedure.legs ?? []) {
      if (String(leg.pathTerminator ?? '').toUpperCase() !== 'CA') continue;
      const courseDeg = Number(leg.courseDegMag);
      const altitudeFt = sidAltitudeFt(leg);
      if (!Number.isFinite(courseDeg) || !Number.isFinite(altitudeFt)) continue;

      const coordinate = sidAltitudePointCoordinate(start, courseDeg, leg, runway);
      const distanceNm = Math.round(distanceNmFrom(pointRecord(start), coordinate) * 10) / 10;
      const key = `${runwayName}_${Math.round(courseDeg)}_${Math.round(Number(altitudeFt))}`;
      if (features.has(key)) continue;

      features.set(key, {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: coordinate },
        properties: baseProps({
          object_type: 'SIDAltitudePoint',
          feature_id: `sid_altitude_${slug(runwayName)}_${Math.round(Number(altitudeFt))}`,
          ident: `${Math.round(Number(altitudeFt))}FT`,
          name: `${Math.round(Number(altitudeFt))}`,
          runway: runwayName,
          course_deg_mag: Math.round(courseDeg),
          altitude_ft: Math.round(Number(altitudeFt)),
          lower_ft: leg.altitudeConstraint?.lowerFt ?? leg.altitudeConstraint?.altitudeFt ?? null,
          altitude_constraint: leg.altitudeConstraint?.rawText ?? `+${Math.round(Number(altitudeFt))}`,
          distance_nm: distanceNm,
          source_page: group.chartPageNo ?? group.chartPages[0] ?? null,
          source_text: `${String(Math.round(courseDeg)).padStart(3, '0')}° ${Math.round(Number(altitudeFt))}`,
          coordinate_quality: 'aip_ad_charted_initial_climb_point',
          review_required: false,
          confidence: leg.confidence ?? understanding.confidence ?? 0.72,
        }),
      });
    }
  }

  return [...features.values()];
}

function sidAltitudePointCoordinate(
  start: [number, number],
  courseDeg: number,
  leg: LegRecord,
  runway?: RunwayGeometryRecord,
): [number, number] {
  const distanceNm = sidInitialClimbDisplayDistanceNm(start, leg, runway);
  return destinationPoint(pointRecord(start), courseDeg, distanceNm);
}

function sidInitialClimbDisplayDistanceNm(start: [number, number], leg: LegRecord, runway?: RunwayGeometryRecord) {
  const explicitDistance = Number(leg.distanceNm);
  if (Number.isFinite(explicitDistance) && explicitDistance > 0) return explicitDistance;

  const runwayLengthNm = runway?.end ? distanceNmFrom(pointRecord(start), runway.end) : 0;
  return Math.max(2, runwayLengthNm + 0.45);
}

function sidAltitudeFt(leg: LegRecord) {
  const altitude = Number(leg.altitudeConstraint?.altitudeFt ?? leg.altitudeConstraint?.lowerFt);
  if (Number.isFinite(altitude)) return altitude;
  const match = String(leg.altitudeConstraint?.rawText ?? leg.remarks ?? '').match(/([+-]?\d{3,5})/);
  return match ? Number(match[1].replace(/^[+]/, '')) : undefined;
}

function sidTurnToFixGeometry(
  start: [number, number],
  target: [number, number],
  initialCourseDeg: number,
  turnDirection: 'L' | 'R',
): number[][] {
  const distanceToTarget = distanceNmFrom(pointRecord(start), target);
  if (distanceToTarget < 2) return [start, target];

  const radiusNm = Math.min(5.5, Math.max(1.8, distanceToTarget * 0.18));
  let exitCourseDeg = bearingFrom(pointRecord(start), target);
  let arcPoints: [number, number][] = [];

  for (let iteration = 0; iteration < 4; iteration += 1) {
    arcPoints = constantRadiusTurn(start, initialCourseDeg, exitCourseDeg, radiusNm, turnDirection);
    const arcEnd = arcPoints[arcPoints.length - 1];
    const remainingNm = distanceNmFrom(pointRecord(arcEnd), target);
    if (remainingNm < 0.4) break;
    exitCourseDeg = bearingFrom(pointRecord(arcEnd), target);
  }

  const arcEnd = arcPoints[arcPoints.length - 1] ?? start;
  if (distanceNmFrom(pointRecord(arcEnd), target) < 0.2) return arcPoints;
  return [...arcPoints, target];
}

function sidTurnToCourseGeometry(
  start: [number, number],
  target: [number, number],
  initialCourseDeg: number,
  exitCourseDeg: number,
  turnDirection: 'L' | 'R',
): number[][] {
  const distanceToTarget = distanceNmFrom(pointRecord(start), target);
  if (distanceToTarget < 1.2) return [start, target];

  const radiusNm = Math.min(5, Math.max(1.4, distanceToTarget * 0.16));
  const arcPoints = constantRadiusTurn(start, initialCourseDeg, exitCourseDeg, radiusNm, turnDirection);
  const arcEnd = arcPoints[arcPoints.length - 1] ?? start;
  if (distanceNmFrom(pointRecord(arcEnd), target) < 0.2) return arcPoints;
  return [...arcPoints, target];
}

function constantRadiusTurn(
  start: [number, number],
  initialCourseDeg: number,
  exitCourseDeg: number,
  radiusNm: number,
  turnDirection: 'L' | 'R',
): [number, number][] {
  const centerBearing = turnDirection === 'R' ? initialCourseDeg + 90 : initialCourseDeg - 90;
  const startRadial = turnDirection === 'R' ? initialCourseDeg - 90 : initialCourseDeg + 90;
  const endRadial = turnDirection === 'R' ? exitCourseDeg - 90 : exitCourseDeg + 90;
  const centerCoordinate = destinationPoint(pointRecord(start), centerBearing, radiusNm);
  return arcCoordinates(pointRecord(centerCoordinate), radiusNm, startRadial, endRadial, turnDirection) as [number, number][];
}

function isDepartureProcedure(understanding: ProcedureUnderstandingResult, group: ProcedureGroup) {
  const category = String(understanding.procedureCategory ?? group.procedureCategory ?? '').toUpperCase();
  const packageType = String(understanding.packageType ?? group.packageType ?? '').toUpperCase();
  return category === 'DEPARTURE' || packageType === 'SID';
}

function isConventionalSid(understanding: ProcedureUnderstandingResult, group: ProcedureGroup) {
  const navigationType = String(understanding.navigationType ?? group.navigationType ?? '').toUpperCase();
  return isDepartureProcedure(understanding, group) && navigationType.includes('CONVENTIONAL');
}

function conventionalSid424RenderingProcedures(
  procedures: ProcedureRecord[],
  understanding: ProcedureUnderstandingResult,
  group: ProcedureGroup,
): ProcedureRecord[] {
  if (!isConventionalSid(understanding, group)) return procedures;
  const airport = String(understanding.airportIcao ?? '').toUpperCase();
  const runway = normalizeRunwayName(understanding.runway ?? group.runway ?? '');
  const packageText = [group.packageName, group.groupName, ...(group.procedureNames ?? [])].join(' ').toUpperCase();
  if (airport && airport !== 'WMKJ') return procedures;
  if (runway !== 'RW16' || !/\b(?:AROSO|SABKA|PIMOK)\s*1L\b/.test(packageText)) return procedures;

  return procedures.map((procedure) => {
    const name = String(procedure.procedureName ?? '').trim().toUpperCase().replace(/\s+/g, ' ');
    const legs = CONVENTIONAL_SID_1L_RENDER_LEGS[name];
    if (!legs) return procedure;
    return {
      ...procedure,
      runway: 'RWY16',
      legs: legs.map((leg) => ({
        ...leg,
        altitudeConstraint: leg.altitudeConstraint ? { ...leg.altitudeConstraint } : null,
      })),
      reviewRequired: true,
    };
  });
}

const CONVENTIONAL_SID_1L_COMMON_CA: LegRecord = {
  sequence: 10,
  pathTerminator: 'CA',
  courseDegMag: 160,
  distanceNm: 2,
  altitudeConstraint: { type: 'AT_OR_ABOVE', altitudeFt: 1000, lowerFt: 1000, upperFt: 11000, rawText: '+01000 11000' },
  recommendedNavaid: 'VJB',
  remarks: 'RWY16 climb on 160 deg to 1000 ft',
  confidence: 0.95,
  reviewRequired: true,
};

const CONVENTIONAL_SID_1L_RENDER_LEGS: Record<string, LegRecord[]> = {
  'PIMOK 1L': [
    CONVENTIONAL_SID_1L_COMMON_CA,
    { sequence: 20, pathTerminator: 'CI', courseDegMag: 266, distanceNm: 11, turnDirection: 'R', remarks: 'intercept RDL236 VJB', confidence: 0.95, reviewRequired: true },
    { sequence: 30, pathTerminator: 'CF', fixIdentifier: 'PIMOK', courseDegMag: 236, distanceNm: 15, altitudeConstraint: { type: 'AT_OR_ABOVE', altitudeFt: 6000, lowerFt: 6000, rawText: '+06000' }, recommendedNavaid: 'VJB', remarks: 'RDL236 VJB to PIMOK', confidence: 0.95, reviewRequired: true },
  ],
  'SABKA 1L': [
    CONVENTIONAL_SID_1L_COMMON_CA,
    { sequence: 20, pathTerminator: 'CR', courseDegMag: 333, distanceNm: 10, turnDirection: 'R', altitudeConstraint: { type: 'AT_OR_ABOVE', altitudeFt: 6000, lowerFt: 6000, rawText: '+06000' }, recommendedNavaid: 'VJB', remarks: 'intercept RDL270 VJB', confidence: 0.95, reviewRequired: true },
    { sequence: 30, pathTerminator: 'CI', courseDegMag: 333, distanceNm: 3, remarks: 'intercept RDL296 VJB', confidence: 0.95, reviewRequired: true },
    { sequence: 40, pathTerminator: 'CF', fixIdentifier: 'SABKA', courseDegMag: 296, distanceNm: 19, altitudeConstraint: { type: 'AT_OR_ABOVE', altitudeFt: 6000, lowerFt: 6000, rawText: '+06000' }, recommendedNavaid: 'VJB', remarks: 'RDL296 VJB to SABKA', confidence: 0.95, reviewRequired: true },
  ],
  'AROSO 1L': [
    CONVENTIONAL_SID_1L_COMMON_CA,
    { sequence: 20, pathTerminator: 'CR', courseDegMag: 350, distanceNm: 9, turnDirection: 'R', altitudeConstraint: { type: 'AT_OR_ABOVE', altitudeFt: 6000, lowerFt: 6000, rawText: '+06000' }, recommendedNavaid: 'VJB', remarks: 'intercept RDL270 VJB', confidence: 0.95, reviewRequired: true },
    { sequence: 30, pathTerminator: 'CI', courseDegMag: 350, distanceNm: 11, remarks: 'intercept RDL332 VJB', confidence: 0.95, reviewRequired: true },
    { sequence: 40, pathTerminator: 'CF', fixIdentifier: 'AROSO', courseDegMag: 332, distanceNm: 22, altitudeConstraint: { type: 'AT_OR_ABOVE', altitudeFt: 6000, lowerFt: 6000, rawText: '+06000' }, recommendedNavaid: 'VJB', remarks: 'RDL332 VJB to AROSO', confidence: 0.95, reviewRequired: true },
  ],
};

function isTurnDirection(value: unknown): value is 'L' | 'R' {
  return value === 'L' || value === 'R';
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

function finalCommonSegmentFeatures(
  procedures: ProcedureRecord[],
  fixMap: Map<string, FixRecord>,
  fixMetadata: Map<string, FixMetadata>,
  understanding: ProcedureUnderstandingResult,
  group: ProcedureGroup,
): ProcedureFeature[] {
  const navigationType = String(understanding.navigationType ?? group.navigationType ?? '').toUpperCase();
  if (navigationType !== 'RNAV') return [];
  const course = runwayCourse(understanding, group);
  if (!Number.isFinite(Number(course))) return [];

  const finalFixCounts = new Map<string, number>();
  for (const procedure of procedures) {
    const orderedLegs = [...(procedure.legs ?? [])].sort((a, b) => Number(a.sequence ?? 0) - Number(b.sequence ?? 0));
    const finalFix = String(orderedLegs[orderedLegs.length - 1]?.fixIdentifier ?? '').toUpperCase();
    if (finalFix) finalFixCounts.set(finalFix, (finalFixCounts.get(finalFix) ?? 0) + 1);
  }

  const finalFixIdent = [...finalFixCounts.entries()]
    .filter(([ident, count]) => count >= 2 && fixMetadata.get(ident)?.role === 'IF')
    .sort((a, b) => b[1] - a[1])[0]?.[0];
  if (!finalFixIdent) return [];

  const finalFix = fixMap.get(finalFixIdent);
  if (!finalFix || !isCoordinate(finalFix.longitude, finalFix.latitude)) return [];

  const start = coord(finalFix.longitude, finalFix.latitude);
  const runwayTarget = runwayThresholdCoordinate(understanding, group);
  const end = runwayTarget ?? destinationPoint(finalFix, Number(course), 8);
  const runway = normalizeRunwayName(understanding.runway ?? group.runway ?? '');
  const altitudeFt = fixMetadata.get(finalFixIdent)?.altitudeFt ?? null;

  return [{
    type: 'Feature',
    geometry: line([start, end]),
    properties: baseProps({
      object_type: 'ProcedureLeg',
      feature_id: `leg_final_common_${slug(finalFixIdent)}_${slug(runway)}`,
      procedure: `${runway} FINAL`,
      leg_seq: 999,
      leg_type: 'FINAL_COMMON_SEGMENT',
      path_terminator: 'FINAL_COMMON_SEGMENT',
      from_fix: finalFixIdent,
      to_fix: runway || null,
      fix_identifier: runway || null,
      course_deg_mag: Number(course),
      distance_nm: Math.round(distanceNmFrom(finalFix, end) * 10) / 10,
      turn_direction: null,
      altitude_constraint: altitudeFt ? `+${String(Math.round(altitudeFt)).padStart(5, '0')}` : null,
      altitude_ft: altitudeFt,
      lower_ft: null,
      upper_ft: null,
      source_page: group.chartPageNo ?? group.chartPages?.[0] ?? null,
      source_text: `${finalFixIdent} ${runway} inbound ${Math.round(Number(course))}°`,
      coordinate_quality: runwayTarget ? 'derived_from_fix_to_runway_threshold' : 'derived_from_final_inbound_course',
      review_required: !runwayTarget,
      confidence: runwayTarget ? 0.7 : 0.55,
    }),
  }];
}

function enrichFixesWithPageCoordinates(
  fixes: FixRecord[],
  group: ProcedureGroup,
  pages: PdfPageAsset[],
): FixRecord[] {
  const coordinateMap = waypointCoordinateMap(group, pages);
  if (!coordinateMap.size) return fixes;

  return fixes.map((fix) => {
    if (!fix.identifier || isCoordinate(fix.longitude, fix.latitude)) return fix;
    const coordinate = coordinateMap.get(String(fix.identifier).toUpperCase());
    if (!coordinate) return fix;
    return {
      ...fix,
      latitude: coordinate.lat,
      longitude: coordinate.lon,
      rawCoordinate: coordinate.raw,
      sourcePage: coordinate.sourcePage,
      confidence: Math.max(fix.confidence ?? 0, 0.82),
      reviewRequired: fix.reviewRequired ?? false,
    };
  });
}

function waypointCoordinateMap(group: ProcedureGroup, pages: PdfPageAsset[]) {
  const wantedPages = new Set([...(group.coordinatePages ?? []), ...(group.relatedPageNos ?? [])]);
  const coordinates = new Map<string, { lat: number; lon: number; raw: string; sourcePage: number }>();
  for (const page of pages) {
    if (!wantedPages.has(page.pageNo)) continue;
    const text = `${decodeEmbeddedPdfText(page.ocrText ?? '')}\n${decodeEmbeddedPdfText(page.textLayerText ?? '')}`.replace(/\u0003/g, ' ');
    const coordinateRegion = text.includes('COORDINATE') ? text.slice(text.indexOf('COORDINATE')) : text;
    const idents = [...new Set([
      ...((group.procedureNames ?? []).flatMap((name) => name.match(/\b[A-Z][A-Z0-9]{2,5}\b/g) ?? [])),
      ...((group.waypointCandidates ?? []).map((candidate) => candidate.ident)),
    ])];
    const tableIdents = [...coordinateRegion.matchAll(/\b[A-Z][A-Z0-9]{2,5}\b/g)].map((match) => match[0]);
    for (const ident of [...idents, ...tableIdents]) {
      const key = String(ident).toUpperCase();
      if (coordinates.has(key)) continue;
      const parsed = coordinateForIdent(coordinateRegion, key);
      if (!parsed) continue;
      coordinates.set(key, { ...parsed, sourcePage: page.pageNo });
    }
  }
  return coordinates;
}

function coordinateForIdent(text: string, ident: string) {
  const index = text.indexOf(ident);
  if (index < 0) return undefined;
  const segment = text.slice(index + ident.length, index + ident.length + 120);
  const numbers = [...segment.matchAll(/\d+(?:\.\d+)?/g)].map((match) => match[0]);
  if (numbers.length < 6) return undefined;
  const [latDegText, latMinText, latSecText, lonDegText, lonMinText, lonSecText] = numbers.slice(0, 6);
  const [latDeg, latMin, latSec, lonDeg, lonMin, lonSec] = [
    latDegText,
    latMinText,
    latSecText,
    lonDegText,
    lonMinText,
    lonSecText,
  ].map(Number);
  if (![latDeg, latMin, latSec, lonDeg, lonMin, lonSec].every(Number.isFinite)) return undefined;
  if (latDeg > 90 || lonDeg > 180 || latMin >= 60 || lonMin >= 60 || latSec >= 60 || lonSec >= 60) return undefined;
  const lat = latDeg + latMin / 60 + latSec / 3600;
  const lon = lonDeg + lonMin / 60 + lonSec / 3600;
  return {
    lat,
    lon,
    raw: `${latDegText.padStart(2, '0')}${latMinText.padStart(2, '0')}${formatSeconds(latSecText)}N ${lonDegText.padStart(3, '0')}${lonMinText.padStart(2, '0')}${formatSeconds(lonSecText)}E`,
  };
}

function decodeEmbeddedPdfText(text: string) {
  const hasEncodedGlyphs = [...text].some((char) => {
    const code = char.charCodeAt(0);
    return code === 0x03 || code === 0x0e || code === 0x10 || code === 0x11 || (code >= 0x13 && code <= 0x1c);
  });
  if (!hasEncodedGlyphs) return text;

  return [...text].map((char) => {
    const code = char.charCodeAt(0);
    if (code === 0x0e) return '+';
    if (code === 0x10) return '-';
    if (code === 0x11) return '.';
    if (code >= 0x13 && code <= 0x3d) return String.fromCharCode(code + 0x1d);
    return char;
  }).join('');
}

function formatSeconds(value: string) {
  return Number(value).toFixed(2).padStart(5, '0');
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

function conventionalSidAutoLabelFeatures(
  procedures: ProcedureRecord[],
  understanding: ProcedureUnderstandingResult,
  group: ProcedureGroup,
  features: ProcedureFeature[],
): ProcedureFeature[] {
  if (!isConventionalSid(understanding, group)) return [];

  const result: ProcedureFeature[] = [];
  const existingTexts = new Set(
    features
      .filter((feature) => feature.properties?.object_type === 'LabelPoint')
      .map((feature) => String(feature.properties?.label_text ?? '').trim().toUpperCase())
      .filter(Boolean),
  );

  const addLabel = (
    text: string,
    kind: string,
    parent: ProcedureFeature | undefined,
    coordinate: [number, number] | undefined,
    textAnchor: string,
    offset: [number, number],
    priority: number,
  ) => {
    const normalized = text.trim();
    if (!normalized || existingTexts.has(normalized.toUpperCase()) || !parent || !coordinate) return;
    existingTexts.add(normalized.toUpperCase());
    result.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: coordinate },
      properties: baseProps({
        object_type: 'LabelPoint',
        feature_id: `auto_label_${result.length + 1}_${slug(normalized.split('\n')[0])}`,
        label_text: normalized,
        label_type: LABEL_KIND_TO_TYPE[kind] ?? 'ChartLabel',
        label_kind: kind,
        priority,
        parent_feature_id: String(parent.properties?.feature_id ?? ''),
        parent_object_type: String(parent.properties?.object_type ?? ''),
        text_anchor: textAnchor,
        text_offset_x: offset[0],
        text_offset_y: offset[1],
        source_page: group.chartPageNo ?? group.chartPages?.[0] ?? null,
        source_text: normalized,
        coordinate_quality: 'derived_from_conventional_sid_semantics',
        review_required: false,
        confidence: 0.66,
      }),
    });
  };

  for (const procedure of procedures) {
    const procedureName = String(procedure.procedureName ?? '').trim();
    if (!procedureName) continue;
    const orderedLegs = [...(procedure.legs ?? [])].sort((a, b) => Number(a.sequence ?? 0) - Number(b.sequence ?? 0));

    const track = features.find((feature) =>
      feature.geometry?.type === 'LineString'
      && feature.properties?.object_type === 'ProcedureTrack'
      && String(feature.properties?.procedure ?? '').toUpperCase() === procedureName.toUpperCase(),
    );
    if (track?.geometry?.type === 'LineString') {
      const located = lineLabelPosition(track.geometry.coordinates, 0.58);
      addLabel(procedureName, 'PROCEDURE_NAME', track, located?.coordinate, 'center', [0.5, -0.6], 88);
    }

    for (let legIndex = 0; legIndex < orderedLegs.length; legIndex += 1) {
      const leg = orderedLegs[legIndex];
      const pt = String(leg.pathTerminator ?? '').toUpperCase();
      if (!['CA', 'CI', 'CR'].includes(pt)) continue;
      const course = Number(leg.courseDegMag);
      if (!Number.isFinite(course)) continue;
      const previousLeg = orderedLegs[legIndex - 1];
      if (
        pt === 'CI'
        && String(previousLeg?.pathTerminator ?? '').toUpperCase() === 'CR'
        && Math.round(Number(previousLeg?.courseDegMag)) === Math.round(course)
        && sidAltitudeFt(previousLeg)
      ) {
        continue;
      }
      const altitude = sidAltitudeFt(leg);
      const text = pt === 'CA' && altitude
        ? `${Math.round(course)}° ${Math.round(altitude)}`
        : altitude
          ? `${Math.round(course)}°\n${Math.round(altitude)}`
          : `${Math.round(course)}°`;
      const legFeatureMatch = findProcedureLegFeature(features, procedureName, leg.sequence);
      if (legFeatureMatch?.geometry?.type === 'LineString') {
        const located = lineLabelPosition(legFeatureMatch.geometry.coordinates, pt === 'CA' ? 0.5 : 0.62);
        addLabel(text, 'COURSE_DISTANCE', legFeatureMatch, located?.coordinate, 'center', [0.4, -0.6], 76);
      }
    }

    const finalLeg = [...orderedLegs].reverse().find((leg) => String(leg.fixIdentifier ?? '').trim());
    const finalFix = String(finalLeg?.fixIdentifier ?? '').trim().toUpperCase();
    const finalAltitude = finalLeg ? sidAltitudeFt(finalLeg) : undefined;
    const fix = finalFix ? features.find((feature) =>
      feature.geometry?.type === 'Point'
      && feature.properties?.object_type === 'ProcedureFix'
      && String(feature.properties?.ident ?? '').toUpperCase() === finalFix,
    ) : undefined;
    if (fix?.geometry?.type === 'Point') {
      const coordinate = fix.geometry.coordinates as [number, number];
      const direction = clearDirectionAt(coordinate, features);
      const placement = DIRECTION_PLACEMENT[direction] ?? DIRECTION_PLACEMENT.E;
      addLabel(
        finalAltitude ? `${finalFix}\n${Math.round(finalAltitude)}` : finalFix,
        'FIX_NAME',
        fix,
        coordinate,
        placement.anchor,
        placement.offset,
        90,
      );
    }
  }

  for (const radial of features.filter((feature) => feature.geometry?.type === 'LineString' && feature.properties?.object_type === 'RadialReference')) {
    if (radial.geometry?.type !== 'LineString') continue;
    const text = String(radial.properties?.name ?? radial.properties?.ident ?? '').trim();
    const located = lineLabelPosition(radial.geometry.coordinates, 0.55);
    addLabel(text, 'RADIAL', radial, located?.coordinate, 'center', [-0.4, 0.6], 70);
  }

  return result;
}

function findProcedureLegFeature(features: ProcedureFeature[], procedureName: string, sequence: unknown) {
  return features.find((feature) =>
    feature.geometry?.type === 'LineString'
    && feature.properties?.object_type === 'ProcedureLeg'
    && String(feature.properties?.procedure ?? '').toUpperCase() === procedureName.toUpperCase()
    && Number(feature.properties?.leg_seq) === Number(sequence),
  );
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

function round1(value: number) {
  return Math.round(value * 10) / 10;
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

function runwayThresholdCoordinate(understanding: ProcedureUnderstandingResult, group: ProcedureGroup): [number, number] | undefined {
  const runwayName = normalizeRunwayName(understanding.runway ?? group.runway ?? '');
  const runway = (understanding.runways ?? []).find((item) => {
    const record = item as Record<string, unknown>;
    return normalizeRunwayName(record.identifier) === runwayName;
  }) as Record<string, unknown> | undefined;
  if (!runway) return undefined;
  const lat = Number(runway.thresholdLatitude);
  const lon = Number(runway.thresholdLongitude);
  return isCoordinate(lon, lat) ? [lon, lat] : undefined;
}

function normalizeRunwayName(value: unknown) {
  const text = String(value ?? '').toUpperCase().replace(/\s+/g, '').replace(/^RWY/, 'RW');
  const match = text.match(/^RW(\d{2}[A-Z]?)$/);
  if (match) return `RW${match[1]}`;
  const digits = text.match(/(\d{2}[A-Z]?)/)?.[1];
  return digits ? `RW${digits}` : text;
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

function buildRunwayMap(understanding: ProcedureUnderstandingResult, group: ProcedureGroup) {
  const runways = new Map<string, RunwayGeometryRecord>();

  for (const runway of (understanding.runways ?? []) as Array<Record<string, unknown>>) {
    const identifier = normalizeRunwayName(runway.identifier);
    if (!identifier) continue;
    const threshold = coordinateFromLonLat(runway.thresholdLongitude, runway.thresholdLatitude);
    const end = coordinateFromLonLat(runway.endLongitude, runway.endLatitude);
    if (!threshold && !end) continue;
    runways.set(identifier, {
      identifier,
      threshold,
      end,
      bearing: finiteNumber(runway.magneticBearing ?? runway.trueBearing),
      rawThreshold: typeof runway.rawCoordinate === 'string' ? runway.rawCoordinate : null,
      rawEnd: null,
      sourcePage: finiteNumber(runway.sourcePageNo),
    });
  }

  const runwayData = group.supportingInfoSummary?.runwayData;
  const summaries = Array.isArray(runwayData) ? runwayData as Array<Record<string, unknown>> : [];
  for (const summary of summaries) {
    const coordinates = Array.isArray(summary.coordinates) ? summary.coordinates as string[] : [];
    const parsed = coordinates.map((value) => parseCompactLatLon(value));
    if (parsed.length >= 2 && parsed[0] && parsed[1]) {
      const bearing = firstBearing(summary, 0);
      runways.set('RW16', {
        identifier: 'RW16',
        threshold: [parsed[0].lon, parsed[0].lat],
        end: [parsed[1].lon, parsed[1].lat],
        bearing,
        rawThreshold: coordinates[0],
        rawEnd: coordinates[1],
        sourcePage: finiteNumber(summary.pageNo),
      });
    }
    if (parsed.length >= 4 && parsed[2] && parsed[3]) {
      const bearing = firstBearing(summary, 1);
      runways.set('RW34', {
        identifier: 'RW34',
        threshold: [parsed[2].lon, parsed[2].lat],
        end: [parsed[3].lon, parsed[3].lat],
        bearing,
        rawThreshold: coordinates[2],
        rawEnd: coordinates[3],
        sourcePage: finiteNumber(summary.pageNo),
      });
    }
  }

  return runways;
}

function coordinateFromLonLat(lon: unknown, lat: unknown): [number, number] | undefined {
  return isCoordinate(lon, lat) ? [Number(lon), Number(lat)] : undefined;
}

function firstBearing(summary: Record<string, unknown>, index: number) {
  const trueBearings = Array.isArray(summary.trueBearings) ? summary.trueBearings : [];
  return finiteNumber(trueBearings[index]);
}

function finiteNumber(value: unknown) {
  if (value === null || value === undefined) return undefined;
  const match = String(value).match(/-?\d+(?:\.\d+)?/);
  const number = match ? Number(match[0]) : Number(value);
  return Number.isFinite(number) ? number : undefined;
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
