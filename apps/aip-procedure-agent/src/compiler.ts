import { geodesicForward, geodesicInverse } from "./coordinate";
import type { PirFix, PirLeg, PirRoute, ProcedurePIR, ValidationResult } from "./domain";
import { simpleLegsTo424Text } from "../../../server/src/services/jeppesen424/simpleLegsTo424Text";
import { parseJeppesen424Text } from "../../../server/src/services/jeppesen424/jeppesen424TextParser";
import { deriveRouteCode } from "../../../server/src/services/jeppesen424/routeCode";
import { deriveApproachCode } from "../../../server/src/services/jeppesen424/encodingProfile";
import type { SimpleProcedureLeg } from "../../../server/src/services/jeppesen424/types";
import { validatePir } from "./validation";

export { validatePir } from "./validation";
export { applyQualityGate } from "./validation";

// 直线即可视为精确几何的 PT。DF 实际含转弯段，直线只算 DERIVED。
const exactStraight = new Set(["IF", "TF", "CF"]);
const HOLDING_PTS = new Set(["HA", "HF", "HM"]);
const HEADING_PTS = new Set(["VA", "CA", "FA", "VI", "CI", "VM", "FM", "VD", "CD", "VR", "CR", "FC", "FD"]);

// ============================== GeoJSON ==============================

export function compileGeoJson(pir: ProcedurePIR) {
  const fixes = new Map(pir.fixes.map((fix) => [fix.fixId, fix]));
  const features: any[] = [];
  const warnings: string[] = [];
  const ident = (id?: string | null) => (id ? fixes.get(id)?.identifier || id : null);

  // —— 程序要素（无几何，承载程序级属性） ——
  features.push({
    type: "Feature",
    geometry: null,
    properties: {
      featureType: "PROCEDURE",
      procedureName: pir.procedure.name,
      identifier: pir.procedure.identifier,
      category: pir.procedure.category,
      approachType: pir.procedure.approachType ?? null,
      runways: pir.procedure.runways,
      navigationSpecification: pir.procedure.navigationSpecification ?? null,
      airport: pir.airport.icao,
      confidence: pir.quality.confidence,
      reviewRequired: pir.quality.reviewRequired,
    },
  });

  // —— 跑道 / 跑道端 / DER ——
  for (const runway of pir.runwayData || []) {
    const threshold = coord(runway.thresholdLongitude, runway.thresholdLatitude);
    const der = coord(runway.derLongitude, runway.derLatitude);
    if (threshold && der) {
      features.push({
        type: "Feature",
        geometry: lineGeometry([threshold, der]),
        properties: { featureType: "RUNWAY", runwayId: runway.runwayId, designator: runway.designator, elevationFt: runway.elevationFt ?? null, tchFt: runway.thresholdCrossingHeightFt ?? null, geometryQuality: "EXACT", evidence: runway.evidence, status: runway.status },
      });
    }
    if (threshold) features.push({ type: "Feature", geometry: { type: "Point", coordinates: threshold }, properties: { featureType: "RUNWAY_END", kind: "THRESHOLD", runwayId: runway.runwayId, designator: runway.designator, name: `THR ${runway.designator}`, evidence: runway.evidence } });
    if (der) features.push({ type: "Feature", geometry: { type: "Point", coordinates: der }, properties: { featureType: "RUNWAY_END", kind: "DER", runwayId: runway.runwayId, designator: runway.designator, name: `DER ${runway.designator}`, evidence: runway.evidence } });
  }

  // —— Fix ——
  for (const fix of pir.fixes)
    if (hasCoordinate(fix))
      features.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: [fix.longitude, fix.latitude] },
        properties: { featureType: "FIX", fixId: fix.fixId, identifier: fix.identifier, name: fix.identifier, fixType: fix.type, role: fix.role ?? null, coordinateSourceType: fix.coordinateSourceType, confidence: fix.confidence, status: fix.status, evidence: fix.evidence },
      });

  // —— Leg ——
  const legFeatureById = new Map<string, any>();
  const routeById = new Map(pir.routes.map((r) => [r.routeId, r]));
  for (const leg of pir.legs) {
    const route = routeById.get(leg.routeId);
    const geometry = legGeometry(leg, fixes, pir, warnings);
    if (geometry.warning) warnings.push(`${leg.legId}: ${geometry.warning}`);
    const routeLegs = route?.legIds || [];
    const feature = {
      type: "Feature",
      geometry: geometry.coordinates ? lineGeometry(geometry.coordinates) : null,
      properties: {
        featureType: "LEG",
        legId: leg.legId,
        routeId: leg.routeId,
        routeType: route?.routeType ?? null,
        routeIdentifier: route?.identifier ?? null,
        procedureName: pir.procedure.name,
        sequence: leg.sequence,
        pathTerminator: leg.pathTerminator,
        fromFix: ident(leg.fromFixId),
        toFix: ident(leg.toFixId),
        centerFix: ident(leg.centerFixId),
        recommendedNavaid: ident(leg.recommendedNavaidId),
        course: leg.course ?? null,
        courseReference: leg.courseReference,
        distanceNm: leg.distanceNm ?? null,
        radiusNm: leg.radiusNm ?? null,
        turnDirection: leg.turnDirection ?? null,
        altitudeConstraint: leg.altitudeConstraint ?? null,
        altitudeText: constraintText(leg.altitudeConstraint),
        speedConstraint: leg.speedConstraint ?? null,
        speedText: leg.speedConstraint?.valueKias ? `${leg.speedConstraint.type === "AT_OR_BELOW" ? "≤" : leg.speedConstraint.type === "AT_OR_ABOVE" ? "≥" : ""}${leg.speedConstraint.valueKias}K` : null,
        verticalAngle: leg.verticalAngle ?? null,
        holding: leg.holding ?? null,
        geometryQuality: geometry.quality,
        openEnded: leg.openEnded,
        isStart: routeLegs[0] === leg.legId,
        isEnd: routeLegs.at(-1) === leg.legId,
        fieldStatus: leg.fieldStatus,
        evidence: leg.evidence,
        warnings: [...leg.warnings, ...(geometry.warning ? [geometry.warning] : [])],
      },
    };
    legFeatureById.set(leg.legId, feature);
    features.push(feature);
  }

  // —— Route 聚合 ——
  for (const route of pir.routes) {
    const coords = route.legIds.flatMap((id, index) => {
      const line = flattenLine(legFeatureById.get(id)?.geometry);
      return index ? line.slice(1) : line;
    });
    features.push({
      type: "Feature",
      geometry: coords.length > 1 ? lineGeometry(coords) : null,
      properties: { featureType: "ROUTE", routeId: route.routeId, routeType: route.routeType, identifier: route.identifier, name: route.identifier, runway: route.runway ?? null, procedureName: pir.procedure.name, legCount: route.legIds.length },
    });
  }

  // —— 标注要素 ——
  features.push(...labelFeatures(pir, fixes, legFeatureById));

  return {
    type: "FeatureCollection",
    features,
    metadata: {
      airport: pir.airport.icao,
      procedure: pir.procedure.name,
      category: pir.procedure.category,
      approachType: pir.procedure.approachType ?? null,
      schemaVersion: pir.schemaVersion,
      quality: pir.quality,
      warnings,
    },
  };
}

function coord(lon?: number | null, lat?: number | null): [number, number] | undefined {
  return Number.isFinite(lon) && Number.isFinite(lat) ? [lon as number, lat as number] : undefined;
}
function hasCoordinate(fix?: PirFix): fix is PirFix & { latitude: number; longitude: number } {
  return !!fix && Number.isFinite(fix.latitude) && Number.isFinite(fix.longitude);
}
function constraintText(alt?: PirLeg["altitudeConstraint"]) {
  if (!alt || alt.type === "NONE") return null;
  if (alt.type === "AT") return `${alt.lowerFt ?? alt.upperFt}`;
  if (alt.type === "AT_OR_ABOVE") return `+${alt.lowerFt}`;
  if (alt.type === "AT_OR_BELOW") return `-${alt.upperFt ?? alt.lowerFt}`;
  return `${alt.lowerFt ?? ""}~${alt.upperFt ?? ""}`;
}

interface LegGeometryResult { coordinates: [number, number][] | null; quality: "EXACT" | "DERIVED" | "DISPLAY_ONLY" | "UNRESOLVED"; warning?: string }

function legGeometry(leg: PirLeg, fixes: Map<string, PirFix>, pir: ProcedurePIR, warnings: string[]): LegGeometryResult {
  const from = leg.fromFixId ? fixes.get(leg.fromFixId) : undefined;
  const to = leg.toFixId ? fixes.get(leg.toFixId) : undefined;
  const center = leg.centerFixId ? fixes.get(leg.centerFixId) : undefined;
  const navaid = leg.recommendedNavaidId ? fixes.get(leg.recommendedNavaidId) : undefined;

  // —— Holding 跑马场 ——
  if (HOLDING_PTS.has(leg.pathTerminator)) {
    const anchor = hasCoordinate(to) ? to : hasCoordinate(from) ? from : undefined;
    if (anchor && leg.holding?.inboundCourse != null) {
      return { coordinates: racetrack([anchor.longitude, anchor.latitude], leg.holding.inboundCourse, leg.holding.turnDirection || "R", holdingLegLength(leg), holdingTurnRadius(leg)), quality: "DERIVED" };
    }
    if (anchor) return { coordinates: [[anchor.longitude, anchor.latitude], geodesicForward([anchor.longitude, anchor.latitude], leg.holding?.inboundCourse != null ? (leg.holding.inboundCourse + 180) % 360 : leg.course ?? 0, holdingLegLength(leg))], quality: "DISPLAY_ONLY", warning: "Holding lacks inbound course; rendered as display line." };
    return { coordinates: null, quality: "UNRESOLVED", warning: "Holding fix has no coordinates." };
  }

  // —— RF：圆心 + 起终点 + 半径校验 ——
  if (leg.pathTerminator === "RF") {
    if (hasCoordinate(from) && hasCoordinate(to) && hasCoordinate(center)) {
      const r1 = geodesicInverse([center.longitude, center.latitude], [from.longitude, from.latitude]).distanceNm;
      const r2 = geodesicInverse([center.longitude, center.latitude], [to.longitude, to.latitude]).distanceNm;
      if (Math.abs(r1 - r2) > 0.2) warnings.push(`${leg.legId}: RF start/end radii differ (${r1.toFixed(2)} vs ${r2.toFixed(2)} NM).`);
      if (leg.radiusNm != null && Math.abs(leg.radiusNm - (r1 + r2) / 2) > Math.max(0.1, leg.radiusNm * 0.1)) warnings.push(`${leg.legId}: charted RF radius ${leg.radiusNm}NM differs from computed ${(0.5 * (r1 + r2)).toFixed(2)}NM.`);
      return { coordinates: arc([center.longitude, center.latitude], [from.longitude, from.latitude], [to.longitude, to.latitude], leg.turnDirection || "R"), quality: "DERIVED" };
    }
    // 无命名圆心但有 radius + turn：RF 弧由 (from, to, radius, turn) 唯一确定，确定性派生圆心。
    if (hasCoordinate(from) && hasCoordinate(to) && leg.radiusNm != null && leg.turnDirection) {
      const derived = deriveArcCenter([from.longitude, from.latitude], [to.longitude, to.latitude], leg.radiusNm, leg.turnDirection);
      if (derived) return { coordinates: arc(derived, [from.longitude, from.latitude], [to.longitude, to.latitude], leg.turnDirection), quality: "DERIVED", warning: `${leg.legId}: RF centre derived from radius+turn (no named centre fix).` };
      warnings.push(`${leg.legId}: RF chord ${geodesicInverse([from.longitude, from.latitude], [to.longitude, to.latitude]).distanceNm.toFixed(2)}NM exceeds 2×radius ${leg.radiusNm}NM; cannot derive arc.`);
    }
    return { coordinates: straightFallback(from, to), quality: from && to ? "DISPLAY_ONLY" : "UNRESOLVED", warning: "RF leg lacks centre-fix coordinates and derivable radius; not rendered as an arc." };
  }

  // —— AF：推荐导航台为弧心的 DME 弧 ——
  if (leg.pathTerminator === "AF") {
    const arcCenter = hasCoordinate(navaid) ? navaid : hasCoordinate(center) ? center : undefined;
    if (arcCenter && hasCoordinate(from) && hasCoordinate(to)) {
      const r1 = geodesicInverse([arcCenter.longitude, arcCenter.latitude], [from.longitude, from.latitude]).distanceNm;
      const r2 = geodesicInverse([arcCenter.longitude, arcCenter.latitude], [to.longitude, to.latitude]).distanceNm;
      if (leg.radiusNm != null && Math.abs(leg.radiusNm - (r1 + r2) / 2) > Math.max(0.2, leg.radiusNm * 0.1)) warnings.push(`${leg.legId}: DME arc radius ${leg.radiusNm}NM differs from computed ${(0.5 * (r1 + r2)).toFixed(2)}NM.`);
      return { coordinates: arc([arcCenter.longitude, arcCenter.latitude], [from.longitude, from.latitude], [to.longitude, to.latitude], leg.turnDirection || "R"), quality: "DERIVED" };
    }
    if (arcCenter && leg.radiusNm != null && hasCoordinate(from) && leg.course != null) {
      // 只有起点：从起点沿弧扫掠到边界径向（course 为边界径向方位）
      const start = geodesicInverse([arcCenter.longitude, arcCenter.latitude], [from.longitude, from.latitude]);
      const end = geodesicForward([arcCenter.longitude, arcCenter.latitude], leg.course, leg.radiusNm);
      return { coordinates: arc([arcCenter.longitude, arcCenter.latitude], [from.longitude, from.latitude], end, leg.turnDirection || "R"), quality: "DERIVED", warning: start.distanceNm && Math.abs(start.distanceNm - leg.radiusNm) > 0.3 ? "AF start point is off the charted DME radius." : undefined };
    }
    return { coordinates: straightFallback(from, to), quality: from && to ? "DISPLAY_ONLY" : "UNRESOLVED", warning: "AF leg lacks navaid/radius data; not rendered as an arc." };
  }

  // —— 直线可达的 PT ——
  if (hasCoordinate(from) && hasCoordinate(to)) {
    const quality = exactStraight.has(leg.pathTerminator) ? "EXACT" : leg.pathTerminator === "DF" ? "DERIVED" : "DISPLAY_ONLY";
    return { coordinates: [[from.longitude, from.latitude], [to.longitude, to.latitude]], quality, warning: quality === "DISPLAY_ONLY" ? `${leg.pathTerminator} only has display geometry.` : undefined };
  }

  // —— SID 首腿连接 DER ——
  if (!from && hasCoordinate(to) && pir.procedure.category === "SID") {
    const route = pir.routes.find((r) => r.routeId === leg.routeId);
    const runway = pir.runwayData.find((r) => sameRunway(r.designator, route?.runway || pir.procedure.runways[0]));
    const der = runway ? coord(runway.derLongitude, runway.derLatitude) : undefined;
    if (der) return { coordinates: [der, [to.longitude, to.latitude]], quality: "DERIVED", warning: undefined };
  }

  // —— 航向开放腿：按爬升梯度估算长度 ——
  if (hasCoordinate(from) && leg.course != null) {
    return { coordinates: [[from.longitude, from.latitude], geodesicForward([from.longitude, from.latitude], leg.course, headingLegLength(leg, pir))], quality: "DISPLAY_ONLY", warning: "Open or heading leg rendered with estimated display length." };
  }
  if (!from && leg.course != null && HEADING_PTS.has(leg.pathTerminator) && pir.procedure.category === "SID") {
    const route = pir.routes.find((r) => r.routeId === leg.routeId);
    const runway = pir.runwayData.find((r) => sameRunway(r.designator, route?.runway || pir.procedure.runways[0]));
    const der = runway ? coord(runway.derLongitude, runway.derLatitude) : undefined;
    if (der) return { coordinates: [der, geodesicForward(der, leg.course, headingLegLength(leg, pir))], quality: "DISPLAY_ONLY", warning: "Heading leg anchored at DER with estimated display length." };
  }
  return { coordinates: null, quality: "UNRESOLVED", warning: "Insufficient coordinates for geometry." };
}

function straightFallback(from?: PirFix, to?: PirFix): [number, number][] | null {
  return hasCoordinate(from) && hasCoordinate(to) ? [[from.longitude, from.latitude], [to.longitude, to.latitude]] : null;
}
function sameRunway(a?: string | null, b?: string | null) {
  const norm = (v?: string | null) => String(v ?? "").toUpperCase().replace(/^RWY?\s*/, "").replace(/^RW/, "");
  return !!a && !!b && norm(a) === norm(b);
}

/** 航向腿显示长度：有跑道标高与目标高度按 300ft/NM 爬升梯度估算，否则 5NM。 */
function headingLegLength(leg: PirLeg, pir: ProcedurePIR) {
  const target = leg.altitudeConstraint?.lowerFt ?? leg.altitudeConstraint?.upperFt;
  const elevation = pir.runwayData.find((r) => r.elevationFt != null)?.elevationFt;
  if (target != null && elevation != null && target > elevation) return Math.min(30, Math.max(2, (target - elevation) / 300));
  if (leg.distanceNm) return leg.distanceNm;
  return 5;
}
function holdingLegLength(leg: PirLeg) {
  if (leg.holding?.legDistanceNm) return leg.holding.legDistanceNm;
  const minutes = leg.holding?.legTimeMin ?? 1;
  const tas = (leg.holding?.speedLimitKias ?? 210) * 1.05; // 粗略 IAS→TAS
  return Math.max(2, (tas / 60) * minutes);
}
function holdingTurnRadius(leg: PirLeg) {
  const tas = (leg.holding?.speedLimitKias ?? 210) * 1.05;
  return Math.max(0.6, tas / (60 * Math.PI)); // 标准率 2 分钟一整圈
}

/** 跑马场：入航航迹指向等待点，按转弯方向在一侧生成两段平行直线 + 两个半圆。 */
export function racetrack(fix: [number, number], inboundCourse: number, turn: "L" | "R", legLengthNm: number, radiusNm: number): [number, number][] {
  const side = turn === "R" ? 90 : -90;
  const outboundCourse = (inboundCourse + 180) % 360;
  const inboundStart = geodesicForward(fix, outboundCourse, legLengthNm);
  const fixAbeam = geodesicForward(fix, (inboundCourse + side + 360) % 360, radiusNm * 2);
  const outboundEnd = geodesicForward(inboundStart, (inboundCourse + side + 360) % 360, radiusNm * 2);
  const turnCenter1 = geodesicForward(fix, (inboundCourse + side + 360) % 360, radiusNm);
  const turnCenter2 = geodesicForward(inboundStart, (inboundCourse + side + 360) % 360, radiusNm);
  return [
    ...arc(turnCenter1, fix, fixAbeam, turn),
    ...arcLineTo(fixAbeam, outboundEnd),
    ...arc(turnCenter2, outboundEnd, inboundStart, turn).slice(1),
    ...arcLineTo(inboundStart, fix).slice(1),
  ];
}
function arcLineTo(from: [number, number], to: [number, number]): [number, number][] { return [from, to]; }

/** 由弦两端 + 半径 + 转向唯一确定 RF 弧心（次弧 <180°）。弦长 >2r 时返回 undefined。 */
export function deriveArcCenter(from: [number, number], to: [number, number], radiusNm: number, turn: "L" | "R"): [number, number] | undefined {
  const inv = geodesicInverse(from, to);
  const chord = inv.distanceNm;
  if (chord < 1e-6 || chord > 2 * radiusNm + 1e-6) return undefined;
  const half = chord / 2;
  const offset = Math.sqrt(Math.max(0, radiusNm * radiusNm - half * half)); // 中点到圆心的距离
  const mid = geodesicForward(from, inv.initialBearing, half);
  // 右转弧（顺时针）圆心在 from→to 方向的右侧(+90°)，左转在左侧(-90°)
  const side = turn === "R" ? 90 : -90;
  return geodesicForward(mid, (inv.initialBearing + side + 360) % 360, offset);
}

export function arc(center: [number, number], start: [number, number], end: [number, number], turn: "L" | "R") {
  const s = geodesicInverse(center, start);
  const e = geodesicInverse(center, end);
  let sweep = e.initialBearing - s.initialBearing;
  if (turn === "R" && sweep <= 0) sweep += 360;
  if (turn === "L" && sweep >= 0) sweep -= 360;
  const radius = (s.distanceNm + e.distanceNm) / 2;
  const steps = Math.max(8, Math.ceil(Math.abs(sweep) / 5));
  return Array.from({ length: steps + 1 }, (_, i) =>
    geodesicForward(center, s.initialBearing + (sweep * i) / steps, radius),
  );
}

/** 跨 180° 经线：把折线拆成不跨越的段（GeoJSON 用 MultiLineString 表达）。 */
export function lineGeometry(coordinates: [number, number][]): { type: "LineString"; coordinates: [number, number][] } | { type: "MultiLineString"; coordinates: [number, number][][] } {
  const segments: [number, number][][] = [];
  let current: [number, number][] = [coordinates[0]];
  for (let i = 1; i < coordinates.length; i++) {
    const [lon1, lat1] = coordinates[i - 1];
    const [lon2, lat2] = coordinates[i];
    if (Math.abs(lon2 - lon1) > 180) {
      // 在 ±180 处插入交点
      const direction = lon1 > 0 ? 1 : -1;
      const adjustedLon2 = lon2 + direction * 360;
      const t = (direction * 180 - lon1) / (adjustedLon2 - lon1);
      const latCross = lat1 + (lat2 - lat1) * t;
      current.push([direction * 180, latCross]);
      segments.push(current);
      current = [[-direction * 180, latCross], [lon2, lat2]];
    } else current.push([lon2, lat2]);
  }
  segments.push(current);
  return segments.length === 1
    ? { type: "LineString", coordinates: segments[0] }
    : { type: "MultiLineString", coordinates: segments };
}
function flattenLine(geometry: any): [number, number][] {
  if (!geometry) return [];
  if (geometry.type === "LineString") return geometry.coordinates;
  if (geometry.type === "MultiLineString") return geometry.coordinates.flat();
  return [];
}

function labelFeatures(pir: ProcedurePIR, fixes: Map<string, PirFix>, legFeatures: Map<string, any>) {
  const features: any[] = [];
  const located = pir.fixes.filter(hasCoordinate);
  if (located.length) {
    const meanLon = located.reduce((s, f) => s + f.longitude, 0) / located.length;
    const meanLat = located.reduce((s, f) => s + f.latitude, 0) / located.length;
    features.push({ type: "Feature", geometry: { type: "Point", coordinates: [meanLon, meanLat] }, properties: { featureType: "LABEL", labelKind: "PROCEDURE_NAME", text: pir.procedure.name, anchor: "center" } });
  }
  for (const route of pir.routes) {
    const first = route.legIds.map((id) => legFeatures.get(id)).find((f) => f?.geometry);
    const line = flattenLine(first?.geometry);
    if (line.length) features.push({ type: "Feature", geometry: { type: "Point", coordinates: line[0] }, properties: { featureType: "LABEL", labelKind: "ROUTE_NAME", text: route.identifier, routeId: route.routeId, routeType: route.routeType, anchor: "start" } });
  }
  for (const leg of pir.legs) {
    const altText = constraintText(leg.altitudeConstraint);
    const speedText = leg.speedConstraint?.valueKias ? `${leg.speedConstraint.valueKias}K` : null;
    if (!altText && !speedText) continue;
    const line = flattenLine(legFeatures.get(leg.legId)?.geometry);
    if (line.length < 2) continue;
    const mid = line[Math.floor(line.length / 2)];
    features.push({ type: "Feature", geometry: { type: "Point", coordinates: mid }, properties: { featureType: "LABEL", labelKind: "CONSTRAINT", text: [altText, speedText].filter(Boolean).join(" / "), legId: leg.legId, anchor: "midpoint" } });
  }
  void fixes;
  return features;
}

// ============================== ARINC 424 ==============================

export interface Candidate424 {
  status: "424_CONFIRMED" | "424_DERIVED" | "424_CANDIDATE" | "424_INCOMPLETE";
  text: string;
  missingFields: string[];
  roundTrip?: { emittedLegs: number; parsedLegs: number; matched: boolean; fieldMismatches: Array<{ key: string; field: string; emitted: unknown; reparsed: unknown }> };
  blockedBy?: string[];
  profile?: string;
}

export function compile424Candidate(pir: ProcedurePIR, validations?: ValidationResult[]): Candidate424 {
  const results = validations ?? validatePir(pir);
  const blockers = results.filter((v) => v.severity === "BLOCKER");
  if (blockers.length) {
    return { status: "424_INCOMPLETE", text: "", missingFields: blockers.map((b) => `${b.ruleCode}: ${b.message}`), blockedBy: blockers.map((b) => b.ruleCode) };
  }
  const fixes = new Map(pir.fixes.map((f) => [f.fixId, f]));
  const routes = new Map(pir.routes.map((r) => [r.routeId, r]));
  const missing = new Set<string>();
  const legs: SimpleProcedureLeg[] = [];
  const category = pir.procedure.category;
  const approachCode = category === "APPROACH" ? deriveApproachCode(pir.procedure.approachType, pir.procedure.runways[0] || "", pir.procedure.name) : undefined;
  if (category === "APPROACH" && !approachCode) missing.add(`procedure.approachCode: 无法从 approachType=${pir.procedure.approachType} + RWY ${pir.procedure.runways[0] || "?"} 推导进近程序代码。`);

  const orderedLegs = [...pir.legs].sort((a, b) => (routes.get(a.routeId)?.sequence ?? 0) - (routes.get(b.routeId)?.sequence ?? 0) || a.sequence - b.sequence);
  for (const leg of orderedLegs) {
    const route = routes.get(leg.routeId);
    const fix = leg.toFixId ? fixes.get(leg.toFixId) : undefined;
    const runway = normalize424Runway(route?.runway || pir.procedure.runways[0] || "");
    const isNamedTransition = route?.routeType === "ENROUTE_TRANSITION" || route?.routeType === "APPROACH_TRANSITION";
    if (category !== "APPROACH" && !runway && !isNamedTransition) missing.add(`${leg.legId}.runway`);
    if (!fix?.identifier && !HEADING_PTS.has(leg.pathTerminator)) missing.add(`${leg.legId}.toFix`);

    legs.push({
      procedureName: procedureNameForRoute(pir.procedure.name, route?.identifier),
      category,
      procedureCode: approachCode,
      runway: category === "APPROACH" ? "" : runway,
      transitionName: isNamedTransition ? transitionEntryName(pir, route!, fixes) : undefined,
      routeTypeChar: approachRouteTypeChar(category, route, pir.procedure.approachType),
      routeKey: leg.routeId,
      sequence: String(leg.sequence).padStart(3, "0"),
      fix: fix?.identifier || "",
      pathTerminator: leg.pathTerminator,
      turnDirection: leg.turnDirection || "",
      distanceNm: leg.distanceNm ?? undefined,
      courseDegMag: leg.holding?.inboundCourse ?? leg.course ?? undefined,
      altitudeValue: altitudePrimary(leg),
      altitudeUpperFt: leg.altitudeConstraint?.type === "BETWEEN" ? leg.altitudeConstraint.upperFt ?? undefined : undefined,
      altitudeSign: leg.altitudeConstraint?.type === "AT_OR_ABOVE" ? "+" : leg.altitudeConstraint?.type === "AT_OR_BELOW" ? "-" : "",
      speedLimitKias: leg.speedConstraint?.valueKias ?? undefined,
      holdingAtFix: !!leg.holding,
      recommendedNavaid: leg.recommendedNavaidId ? fixes.get(leg.recommendedNavaidId)?.identifier : leg.centerFixId && leg.pathTerminator === "RF" ? fixes.get(leg.centerFixId)?.identifier : undefined,
      source: "AI",
    });
  }
  if (missing.size) return { status: "424_INCOMPLETE", text: "", missingFields: [...missing] };
  renumberDuplicateSequences(legs);
  try {
    const text = simpleLegsTo424Text(legs, { airportIcao: pir.airport.icao });
    const reparsed = parseJeppesen424Text(text);
    const fieldMismatches = fieldLevelRoundTrip(legs, reparsed);
    const matched = reparsed.length === legs.length && fieldMismatches.length === 0;
    return {
      status: matched ? "424_CANDIDATE" : "424_DERIVED",
      text,
      missingFields: [],
      roundTrip: { emittedLegs: legs.length, parsedLegs: reparsed.length, matched, fieldMismatches },
    };
  } catch (error) {
    return { status: "424_INCOMPLETE", text: "", missingFields: [error instanceof Error ? error.message : String(error)] };
  }
}

/** 同一 424 记录组（程序代码+跑道+过渡）内序号重复时按发布顺序重编号（复飞续接最后进近）。 */
function renumberDuplicateSequences(legs: SimpleProcedureLeg[]) {
  const groups = new Map<string, SimpleProcedureLeg[]>();
  for (const leg of legs) {
    const key = `${leg.procedureCode || leg.procedureName}|${leg.runway}|${leg.transitionName ?? ""}`;
    const list = groups.get(key) ?? [];
    list.push(leg);
    groups.set(key, list);
  }
  for (const list of groups.values()) {
    const sequences = list.map((l) => l.sequence);
    if (new Set(sequences).size === sequences.length) continue;
    list.forEach((leg, index) => { leg.sequence = String((index + 1) * 10).padStart(3, "0"); });
  }
}

function altitudePrimary(leg: PirLeg) {
  const alt = leg.altitudeConstraint;
  if (!alt || alt.type === "NONE") return undefined;
  if (alt.type === "AT_OR_BELOW") return alt.upperFt ?? alt.lowerFt ?? undefined;
  return alt.lowerFt ?? alt.upperFt ?? undefined;
}

/** 过渡名必须取过渡入口（首腿起点/终点 fix），禁止取汇合点。 */
export function transitionEntryName(pir: ProcedurePIR, route: PirRoute, fixes: Map<string, PirFix>): string | undefined {
  const first = route.legIds.map((id) => pir.legs.find((l) => l.legId === id)).find(Boolean);
  const entryFixId = first?.fromFixId ?? first?.toFixId;
  const entryIdent = entryFixId ? fixes.get(entryFixId)?.identifier : undefined;
  const candidate = entryIdent ?? route.transitionFix ?? route.identifier;
  const tokens = String(candidate).toUpperCase().match(/[A-Z][A-Z0-9]{1,4}/g) || [];
  // 入口 fix 名本身就是 2-5 字符 token；identifier 兜底取第一个像 fix 的 token（如 "OLMEN 3C" → OLMEN）
  return (entryIdent ? entryIdent.slice(0, 5).toUpperCase() : tokens[0]) || undefined;
}

function approachRouteTypeChar(category: string, route: PirRoute | undefined, approachType?: string | null): string | undefined {
  if (category !== "APPROACH" || !route) return undefined;
  if (route.routeType === "APPROACH_TRANSITION") return "A";
  const letter = { ILS: "I", LOC: "L", RNP: "R", RNP_AR: "H", VOR: "V", NDB: "N", GLS: "J", VISUAL: "Q", OTHER: "R" }[String(approachType || "OTHER").toUpperCase()];
  return letter || "R";
}

/** 字段级 Round-trip：重解析结果与导出腿逐字段比对。 */
export function fieldLevelRoundTrip(emitted: SimpleProcedureLeg[], reparsed: SimpleProcedureLeg[]) {
  const mismatches: Array<{ key: string; field: string; emitted: unknown; reparsed: unknown }> = [];
  const keyOf = (leg: SimpleProcedureLeg) => `${(leg.procedureCode || leg.procedureName).replace(/\s+/g, "")}|${leg.transitionName || leg.runway || ""}|${leg.sequence}`;
  const parsedByKey = new Map(reparsed.map((leg) => [`${leg.routeKey}|${leg.transitionName || leg.runway || ""}|${leg.sequence}`, leg]));
  for (const leg of emitted) {
    const emittedCode = leg.procedureCode ?? tryRouteCode(leg.procedureName);
    const key = `${emittedCode || leg.procedureName}|${leg.transitionName || leg.runway || ""}|${leg.sequence}`;
    const parsed = parsedByKey.get(key);
    if (!parsed) { mismatches.push({ key: keyOf(leg), field: "record", emitted: "present", reparsed: "missing" }); continue; }
    const checks: Array<[string, unknown, unknown, (a: any, b: any) => boolean]> = [
      ["fix", leg.fix || "", parsed.fix || "", eq],
      ["pathTerminator", leg.pathTerminator || "", parsed.pathTerminator || "", eq],
      ["turnDirection", leg.turnDirection || "", parsed.turnDirection || "", eq],
      ["distanceNm", leg.distanceNm, parsed.distanceNm, near(0.06)],
      ["altitudeValue", leg.altitudeValue, parsed.altitudeValue, near(1)],
      ["altitudeSign", leg.altitudeSign || "", parsed.altitudeSign || "", eq],
      ["altitudeUpperFt", leg.altitudeUpperFt, parsed.altitudeUpperFt, near(1)],
      ["speedLimitKias", leg.speedLimitKias, parsed.speedLimitKias, near(0.5)],
      ["courseDegMag", shouldEncodeCourse(leg) ? leg.courseDegMag : undefined, parsed.courseDegMag, near(0.06)],
      ["holdingAtFix", !!leg.holdingAtFix, !!parsed.holdingAtFix, eq],
    ];
    for (const [field, a, b, cmp] of checks) {
      if (a === undefined && b === undefined) continue;
      if (!cmp(a, b)) mismatches.push({ key, field, emitted: a, reparsed: b });
    }
  }
  return mismatches;
}
function shouldEncodeCourse(leg: SimpleProcedureLeg) {
  return ["AF", "CA", "CF", "CI", "CR", "VA", "VI", "VM", "FA", "HA", "HF", "HM"].includes(String(leg.pathTerminator || "").toUpperCase());
}
function eq(a: any, b: any) { return a === b; }
function near(tol: number) { return (a: any, b: any) => (a == null && b == null) || (a != null && b != null && Math.abs(Number(a) - Number(b)) <= tol); }
function tryRouteCode(name: string) { try { return deriveRouteCode(name); } catch { return undefined; } }

function procedureNameForRoute(procedureName: string, routeIdentifier?: string) {
  const candidates = procedureName
    .split(/\s*(?:,|\/|&)\s*/)
    .map((name) => name.trim())
    .filter(Boolean);
  if (candidates.length < 2) return procedureName;
  if (!routeIdentifier) return candidates[0];

  // Route identifiers are usually the most precise source for a combined chart
  // (for example "RNAV EGOBA 2C"), while chart titles may spell that designator
  // as "RNAV EGOBA TWO CHARLIE DEPARTURE". Compare their derived 424 codes so
  // both representations select the same procedure. Neutral runway/common
  // routes use the first chart procedure because they have no own designator.
  const routeCode = deriveRouteCode(routeIdentifier);
  if (routeCode) {
    const matchingTitle = candidates.find(
      (candidate) => deriveRouteCode(candidate) === routeCode,
    );
    return matchingTitle || routeIdentifier;
  }

  return candidates[0];
}

function normalize424Runway(value: string) {
  const designator = value.trim().toUpperCase().replace(/^RWY?/, "").replace(/^RW/, "");
  return designator ? `RW${designator}` : "";
}
