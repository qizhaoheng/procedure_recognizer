import { geodesicForward, geodesicInverse } from "./coordinate";
import type { PirFix, PirLeg, ProcedurePIR, ValidationResult } from "./domain";
import { simpleLegsTo424Text } from "../../../server/src/services/jeppesen424/simpleLegsTo424Text";
import { parseJeppesen424Text } from "../../../server/src/services/jeppesen424/jeppesen424TextParser";
import { deriveRouteCode } from "../../../server/src/services/jeppesen424/routeCode";
import type { SimpleProcedureLeg } from "../../../server/src/services/jeppesen424/types";

const supportedExact = new Set(["IF", "TF", "DF", "CF", "RF", "AF"]);
export function compileGeoJson(pir: ProcedurePIR) {
  const fixes = new Map(pir.fixes.map((fix) => [fix.fixId, fix]));
  const features: any[] = [];
  const warnings: string[] = [];
  for (const fix of pir.fixes)
    if (hasCoordinate(fix))
      features.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: [fix.longitude, fix.latitude] },
        properties: {
          featureType: "FIX",
          fixId: fix.fixId,
          identifier: fix.identifier,
          confidence: fix.confidence,
          status: fix.status,
          evidence: fix.evidence,
        },
      });
  for (const leg of pir.legs) {
    const geometry = legGeometry(leg, fixes);
    const quality = geometry.quality;
    if (geometry.warning) warnings.push(`${leg.legId}: ${geometry.warning}`);
    features.push({
      type: "Feature",
      geometry: geometry.coordinates
        ? { type: "LineString", coordinates: geometry.coordinates }
        : null,
      properties: {
        featureType: "LEG",
        legId: leg.legId,
        routeId: leg.routeId,
        sequence: leg.sequence,
        pathTerminator: leg.pathTerminator,
        geometryQuality: quality,
        openEnded: leg.openEnded,
        evidence: leg.evidence,
        warnings: [
          ...leg.warnings,
          ...(geometry.warning ? [geometry.warning] : []),
        ],
      },
    });
  }
  for (const route of pir.routes) {
    const coords = route.legIds.flatMap((id, index) => {
      const feature = features.find((f) => f.properties?.legId === id);
      const line = feature?.geometry?.coordinates ?? [];
      return index ? line.slice(1) : line;
    });
    features.push({
      type: "Feature",
      geometry:
        coords.length > 1 ? { type: "LineString", coordinates: coords } : null,
      properties: {
        featureType: "ROUTE",
        routeId: route.routeId,
        routeType: route.routeType,
        identifier: route.identifier,
      },
    });
  }
  return {
    type: "FeatureCollection",
    features,
    metadata: {
      airport: pir.airport.icao,
      procedure: pir.procedure.name,
      category: pir.procedure.category,
      schemaVersion: pir.schemaVersion,
      quality: pir.quality,
      warnings,
    },
  };
}
function hasCoordinate(
  fix?: PirFix,
): fix is PirFix & { latitude: number; longitude: number } {
  return (
    !!fix && Number.isFinite(fix.latitude) && Number.isFinite(fix.longitude)
  );
}
function legGeometry(leg: PirLeg, fixes: Map<string, PirFix>) {
  const from = leg.fromFixId ? fixes.get(leg.fromFixId) : undefined;
  const to = leg.toFixId ? fixes.get(leg.toFixId) : undefined;
  const center = leg.centerFixId ? fixes.get(leg.centerFixId) : undefined;
  if (
    (leg.pathTerminator === "RF" || leg.pathTerminator === "AF") &&
    hasCoordinate(from) &&
    hasCoordinate(to) &&
    hasCoordinate(center)
  )
    return {
      coordinates: arc(
        [center.longitude, center.latitude],
        [from.longitude, from.latitude],
        [to.longitude, to.latitude],
        leg.turnDirection || "R",
      ),
      quality: "DERIVED",
      warning: undefined,
    };
  if (hasCoordinate(from) && hasCoordinate(to))
    return {
      coordinates: [
        [from.longitude, from.latitude],
        [to.longitude, to.latitude],
      ],
      quality: supportedExact.has(leg.pathTerminator)
        ? "EXACT"
        : "DISPLAY_ONLY",
      warning: supportedExact.has(leg.pathTerminator)
        ? undefined
        : `${leg.pathTerminator} only has display geometry.`,
    };
  if (hasCoordinate(from) && leg.course != null)
    return {
      coordinates: [
        [from.longitude, from.latitude],
        geodesicForward(
          [from.longitude, from.latitude],
          leg.course,
          leg.distanceNm || 5,
        ),
      ],
      quality: "DISPLAY_ONLY",
      warning: "Open or unresolved leg rendered with finite display length.",
    };
  return {
    coordinates: null,
    quality: "UNRESOLVED",
    warning: "Insufficient coordinates for geometry.",
  };
}
export function arc(
  center: [number, number],
  start: [number, number],
  end: [number, number],
  turn: "L" | "R",
) {
  const s = geodesicInverse(center, start);
  const e = geodesicInverse(center, end);
  let sweep = e.initialBearing - s.initialBearing;
  if (turn === "R" && sweep < 0) sweep += 360;
  if (turn === "L" && sweep > 0) sweep -= 360;
  const steps = Math.max(8, Math.ceil(Math.abs(sweep) / 5));
  return Array.from({ length: steps + 1 }, (_, i) =>
    geodesicForward(
      center,
      s.initialBearing + (sweep * i) / steps,
      s.distanceNm,
    ),
  );
}

export function validatePir(pir: ProcedurePIR): ValidationResult[] {
  const out: ValidationResult[] = [];
  const fixes = new Map(pir.fixes.map((f) => [f.fixId, f]));
  if (!pir.routes.length)
    out.push(
      issue(
        "PIR_ROUTE_REQUIRED",
        "BLOCKER",
        "routes",
        "Procedure has no route.",
      ),
    );
  for (const [ri, route] of pir.routes.entries())
    if (!route.legIds.length)
      out.push(
        issue(
          "ROUTE_LEG_REQUIRED",
          "ERROR",
          `routes[${ri}].legIds`,
          "Route has no legs.",
        ),
      );
  const sequences = new Set<string>();
  pir.legs.forEach((leg, i) => {
    const key = `${leg.routeId}:${leg.sequence}`;
    if (sequences.has(key))
      out.push(
        issue(
          "LEG_SEQUENCE_DUPLICATE",
          "ERROR",
          `legs[${i}].sequence`,
          "Leg sequence is duplicated within route.",
        ),
      );
    sequences.add(key);
    if (leg.course != null && (leg.course < 0 || leg.course >= 360))
      out.push(
        issue(
          "COURSE_RANGE",
          "ERROR",
          `legs[${i}].course`,
          "Course must be in [0, 360).",
        ),
      );
    if (leg.distanceNm != null && (leg.distanceNm <= 0 || leg.distanceNm > 500))
      out.push(
        issue(
          "DISTANCE_RANGE",
          "ERROR",
          `legs[${i}].distanceNm`,
          "Distance is outside plausible terminal range.",
        ),
      );
    const alt = leg.altitudeConstraint;
    if (
      alt?.lowerFt != null &&
      alt?.upperFt != null &&
      alt.lowerFt > alt.upperFt
    )
      out.push(
        issue(
          "ALTITUDE_ORDER",
          "ERROR",
          `legs[${i}].altitudeConstraint`,
          "Lower altitude exceeds upper altitude.",
        ),
      );
    if (leg.fromFixId && !fixes.has(leg.fromFixId))
      out.push(
        issue(
          "FIX_REFERENCE",
          "BLOCKER",
          `legs[${i}].fromFixId`,
          "Referenced from-fix does not exist.",
        ),
      );
    if (leg.toFixId && !fixes.has(leg.toFixId))
      out.push(
        issue(
          "FIX_REFERENCE",
          "BLOCKER",
          `legs[${i}].toFixId`,
          "Referenced to-fix does not exist.",
        ),
      );
  });
  pir.fixes.forEach((fix, i) => {
    if (fix.latitude != null && (fix.latitude < -90 || fix.latitude > 90))
      out.push(
        issue(
          "LATITUDE_RANGE",
          "BLOCKER",
          `fixes[${i}].latitude`,
          "Latitude is invalid.",
        ),
      );
    if (fix.longitude != null && (fix.longitude < -180 || fix.longitude > 180))
      out.push(
        issue(
          "LONGITUDE_RANGE",
          "BLOCKER",
          `fixes[${i}].longitude`,
          "Longitude is invalid.",
        ),
      );
  });
  return out;
}
function issue(
  ruleCode: string,
  severity: ValidationResult["severity"],
  fieldPath: string,
  message: string,
): ValidationResult {
  return {
    ruleCode,
    severity,
    fieldPath,
    message,
    evidence: [],
    autoRepairable: false,
  };
}

export function compile424Candidate(pir: ProcedurePIR) {
  const fixes = new Map(pir.fixes.map((f) => [f.fixId, f]));
  const routes = new Map(pir.routes.map((r) => [r.routeId, r]));
  const missing = new Set<string>();
  const legs: SimpleProcedureLeg[] = [];
  for (const leg of pir.legs) {
    const route = routes.get(leg.routeId);
    const fix = leg.toFixId ? fixes.get(leg.toFixId) : undefined;
    const runway = normalize424Runway(
      route?.runway || pir.procedure.runways[0] || "",
    );
    if (!runway && route?.routeType !== "ENROUTE_TRANSITION")
      missing.add(`${leg.legId}.runway`);
    if (
      !fix?.identifier &&
      !["CA", "VA", "CI", "VI"].includes(leg.pathTerminator)
    )
      missing.add(`${leg.legId}.toFix`);
    legs.push({
      procedureName: procedureNameForRoute(
        pir.procedure.name,
        route?.identifier,
      ),
      runway,
      transitionName:
        route?.routeType === "ENROUTE_TRANSITION"
          ? normalizeTransitionName(route.transitionFix || route.identifier)
          : undefined,
      routeKey: leg.routeId,
      sequence: String(leg.sequence).padStart(3, "0"),
      fix: fix?.identifier || "",
      pathTerminator: leg.pathTerminator,
      turnDirection: leg.turnDirection || "",
      distanceNm: leg.distanceNm ?? undefined,
      courseDegMag: leg.course ?? undefined,
      altitudeValue: leg.altitudeConstraint?.lowerFt ?? undefined,
      altitudeUpperFt: leg.altitudeConstraint?.upperFt ?? undefined,
      altitudeSign:
        leg.altitudeConstraint?.type === "AT_OR_ABOVE"
          ? "+"
          : leg.altitudeConstraint?.type === "AT_OR_BELOW"
            ? "-"
            : "",
      speedLimitKias: leg.speedConstraint?.valueKias ?? undefined,
      recommendedNavaid: leg.recommendedNavaidId
        ? fixes.get(leg.recommendedNavaidId)?.identifier
        : undefined,
      source: "AI",
    });
  }
  if (missing.size)
    return {
      status: "424_INCOMPLETE" as const,
      text: "",
      missingFields: [...missing],
    };
  try {
    const text = simpleLegsTo424Text(legs, { airportIcao: pir.airport.icao });
    const reparsed = parseJeppesen424Text(text);
    return {
      status: "424_CANDIDATE" as const,
      text,
      missingFields: [],
      roundTrip: {
        emittedLegs: legs.length,
        parsedLegs: reparsed.length,
        matched: reparsed.length === legs.length,
      },
    };
  } catch (error) {
    return {
      status: "424_INCOMPLETE" as const,
      text: "",
      missingFields: [error instanceof Error ? error.message : String(error)],
    };
  }
}

function procedureNameForRoute(
  procedureName: string,
  routeIdentifier?: string,
) {
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
  const designator = value.trim().toUpperCase().replace(/^RWY?/, "");
  return designator ? `RW${designator}` : "";
}

function normalizeTransitionName(value: string) {
  const tokens = value.toUpperCase().match(/[A-Z0-9]{2,5}/g) || [];
  return tokens.at(-1)?.slice(0, 5);
}
