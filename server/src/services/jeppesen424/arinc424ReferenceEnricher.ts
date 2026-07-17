import type { ProcedureUnderstandingResult } from '../../types/procedure';
import type { SimpleProcedureLeg } from './types';

interface PositionedEntity {
  identifier: string;
  latitude: number;
  longitude: number;
  type?: string;
}

export interface Arinc424ReferenceEnrichment {
  legs: SimpleProcedureLeg[];
  unresolvedCfLegs: Array<{ procedureName: string; sequence: string; fix: string; reason: string }>;
}

/** Complete CF reference geometry from AIP coordinates without consulting comparison data. */
export function enrichArinc424References(
  canonical: ProcedureUnderstandingResult | undefined,
  sourceLegs: SimpleProcedureLeg[],
): Arinc424ReferenceEnrichment {
  const fixes = positionedEntities(canonical?.fixes);
  const navaids = positionedEntities(canonical?.navaids).filter(isBearingDistanceNavaid);
  const fixByIdentifier = new Map(fixes.map((item) => [item.identifier, item]));
  const navaidByIdentifier = new Map(navaids.map((item) => [item.identifier, item]));
  const unresolvedCfLegs: Arinc424ReferenceEnrichment['unresolvedCfLegs'] = [];

  const legs = sourceLegs.map((leg) => {
    if (String(leg.pathTerminator ?? '').toUpperCase() !== 'CF') return leg;
    const fix = fixByIdentifier.get(leg.fix.toUpperCase());
    if (!fix) {
      unresolvedCfLegs.push(referenceIssue(leg, '目标航路点缺少有效坐标'));
      return leg;
    }

    const explicit = leg.recommendedNavaid
      ? navaidByIdentifier.get(leg.recommendedNavaid.toUpperCase())
      : undefined;
    const selected = explicit ?? (navaids.length === 1 ? navaids[0] : undefined);
    if (!selected) {
      const reason = leg.recommendedNavaid
        ? `推荐导航台 ${leg.recommendedNavaid} 缺少有效坐标或类型不适用`
        : navaids.length === 0
          ? '没有已识别且带坐标的 VOR/DME 导航台'
          : `存在 ${navaids.length} 个可用导航台，AIP 未提供足够依据自动选择`;
      unresolvedCfLegs.push(referenceIssue(leg, reason));
      return leg;
    }

    const geometry = bearingDistance(selected, fix);
    const magneticVariation = leg.magneticVariationDeg ?? numberValue(canonical?.magneticVariationDeg) ?? 0;
    return {
      ...leg,
      recommendedNavaid: selected.identifier,
      thetaDegMag: leg.thetaDegMag ?? roundTenth(normalizeDegrees(geometry.trueBearingDeg + magneticVariation)),
      rhoNm: leg.rhoNm ?? roundTenth(geometry.distanceNm),
      arincReferenceDerivation: leg.arincReferenceDerivation ?? {
        method: 'AIP_COORDINATE_GEOMETRY' as const,
        navaidIdentifier: selected.identifier,
        fixIdentifier: fix.identifier,
      },
    };
  });

  return { legs, unresolvedCfLegs };
}

function referenceIssue(leg: SimpleProcedureLeg, reason: string) {
  return { procedureName: leg.procedureName, sequence: leg.sequence, fix: leg.fix, reason };
}

function positionedEntities(items: unknown): PositionedEntity[] {
  if (!Array.isArray(items)) return [];
  const result: PositionedEntity[] = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const identifier = String(record.identifier ?? record.ident ?? record.fixIdentifier ?? '').trim().toUpperCase();
    const latitude = numberValue(record.latitude ?? record.lat);
    const longitude = numberValue(record.longitude ?? record.lon ?? record.lng);
    if (!/^[A-Z0-9]{2,5}$/.test(identifier) || latitude === undefined || longitude === undefined) continue;
    if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) continue;
    result.push({ identifier, latitude, longitude, type: String(record.navaidType ?? record.type ?? '').trim().toUpperCase() });
  }
  return result;
}

function isBearingDistanceNavaid(item: PositionedEntity) {
  // Plain DME/LOC-DME facilities support landing systems but are not a
  // course/radial reference for a CF leg. A legacy untyped navaid remains
  // eligible only for backward compatibility with already reviewed data.
  return !item.type || /(?:VOR|TACAN)/.test(item.type);
}

function bearingDistance(from: PositionedEntity, to: PositionedEntity) {
  // Vincenty's inverse solution on WGS-84. A spherical bearing differs by up
  // to several tenths here, which is visible in ARINC's one-decimal theta.
  const major = 6378137;
  const flattening = 1 / 298.257223563;
  const minor = (1 - flattening) * major;
  const reduced1 = Math.atan((1 - flattening) * Math.tan(radians(from.latitude)));
  const reduced2 = Math.atan((1 - flattening) * Math.tan(radians(to.latitude)));
  const longitudeDifference = radians(to.longitude - from.longitude);
  let lambda = longitudeDifference;
  let previous = Number.POSITIVE_INFINITY;
  let sigma = 0;
  let sinSigma = 0;
  let cosSigma = 0;
  let sinAlpha = 0;
  let cosSqAlpha = 0;
  let cos2SigmaM = 0;
  for (let iteration = 0; iteration < 100 && Math.abs(lambda - previous) > 1e-12; iteration += 1) {
    const sinLambda = Math.sin(lambda);
    const cosLambda = Math.cos(lambda);
    sinSigma = Math.sqrt(
      (Math.cos(reduced2) * sinLambda) ** 2
      + (Math.cos(reduced1) * Math.sin(reduced2) - Math.sin(reduced1) * Math.cos(reduced2) * cosLambda) ** 2,
    );
    if (sinSigma === 0) return { trueBearingDeg: 0, distanceNm: 0 };
    cosSigma = Math.sin(reduced1) * Math.sin(reduced2) + Math.cos(reduced1) * Math.cos(reduced2) * cosLambda;
    sigma = Math.atan2(sinSigma, cosSigma);
    sinAlpha = Math.cos(reduced1) * Math.cos(reduced2) * sinLambda / sinSigma;
    cosSqAlpha = 1 - sinAlpha ** 2;
    cos2SigmaM = cosSqAlpha === 0 ? 0 : cosSigma - 2 * Math.sin(reduced1) * Math.sin(reduced2) / cosSqAlpha;
    const correction = flattening / 16 * cosSqAlpha * (4 + flattening * (4 - 3 * cosSqAlpha));
    previous = lambda;
    lambda = longitudeDifference + (1 - correction) * flattening * sinAlpha
      * (sigma + correction * sinSigma * (cos2SigmaM + correction * cosSigma * (-1 + 2 * cos2SigmaM ** 2)));
  }
  const uSq = cosSqAlpha * (major ** 2 - minor ** 2) / minor ** 2;
  const coefficientA = 1 + uSq / 16384 * (4096 + uSq * (-768 + uSq * (320 - 175 * uSq)));
  const coefficientB = uSq / 1024 * (256 + uSq * (-128 + uSq * (74 - 47 * uSq)));
  const deltaSigma = coefficientB * sinSigma * (cos2SigmaM + coefficientB / 4
    * (cosSigma * (-1 + 2 * cos2SigmaM ** 2)
      - coefficientB / 6 * cos2SigmaM * (-3 + 4 * sinSigma ** 2) * (-3 + 4 * cos2SigmaM ** 2)));
  const trueBearingDeg = normalizeDegrees(Math.atan2(
    Math.cos(reduced2) * Math.sin(lambda),
    Math.cos(reduced1) * Math.sin(reduced2) - Math.sin(reduced1) * Math.cos(reduced2) * Math.cos(lambda),
  ) * 180 / Math.PI);
  return { trueBearingDeg, distanceNm: minor * coefficientA * (sigma - deltaSigma) / 1852 };
}

function radians(value: number) { return value * Math.PI / 180; }
function normalizeDegrees(value: number) { return ((value % 360) + 360) % 360; }
function roundTenth(value: number) { return Math.round(value * 10) / 10; }
function numberValue(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
