import { geodesicInverse } from './coordinate';
import type { PirFix, PirLeg, ProcedurePIR, RecognitionPlan, ValidationResult } from './domain';

const HOLDING_PTS = new Set(['HA', 'HF', 'HM']);
const COURSE_PTS = new Set(['CF', 'CA', 'CD', 'CI', 'CR', 'VA', 'VD', 'VI', 'VR', 'FA', 'FC', 'FD']);

export function validatePir(pir: ProcedurePIR, plan?: RecognitionPlan): ValidationResult[] {
  const out: ValidationResult[] = [];
  const fixes = new Map(pir.fixes.map((f) => [f.fixId, f]));
  const push = (ruleCode: string, severity: ValidationResult['severity'], fieldPath: string, message: string, evidence: string[] = [], autoRepairable = false) =>
    out.push({ ruleCode, severity, fieldPath, message, evidence, autoRepairable });

  // —— 结构 ——
  if (!pir.routes.length) push('PIR_ROUTE_REQUIRED', 'BLOCKER', 'routes', 'Procedure has no route.');
  pir.routes.forEach((route, ri) => { if (!route.legIds.length) push('ROUTE_LEG_REQUIRED', 'ERROR', `routes[${ri}].legIds`, `Route ${route.identifier} has no legs.`); });
  const sequences = new Set<string>();
  const legIndex = new Map(pir.legs.map((l, i) => [l.legId, i]));

  pir.legs.forEach((leg, i) => {
    const path = (f: string) => `legs[${i}].${f}`;
    const key = `${leg.routeId}:${leg.sequence}`;
    if (sequences.has(key)) push('LEG_SEQUENCE_DUPLICATE', 'ERROR', path('sequence'), 'Leg sequence is duplicated within route.');
    sequences.add(key);
    if (leg.course != null && (leg.course < 0 || leg.course >= 360)) push('COURSE_RANGE', 'ERROR', path('course'), 'Course must be in [0, 360).');
    if (leg.distanceNm != null && (leg.distanceNm <= 0 || leg.distanceNm > 500)) push('DISTANCE_RANGE', 'ERROR', path('distanceNm'), 'Distance is outside plausible terminal range.');
    if (leg.fromFixId && !fixes.has(leg.fromFixId)) push('FIX_REFERENCE', 'BLOCKER', path('fromFixId'), 'Referenced from-fix does not exist.');
    if (leg.toFixId && !fixes.has(leg.toFixId)) push('FIX_REFERENCE', 'BLOCKER', path('toFixId'), 'Referenced to-fix does not exist.');
    if (leg.centerFixId && !fixes.has(leg.centerFixId)) push('FIX_REFERENCE', 'BLOCKER', path('centerFixId'), 'Referenced center-fix does not exist.');

    // —— 高度：值域 + 符号语义 ——
    const alt = leg.altitudeConstraint;
    if (alt && alt.type !== 'NONE') {
      for (const [field, value] of [['lowerFt', alt.lowerFt], ['upperFt', alt.upperFt]] as const) {
        if (value == null) continue;
        if (value < 0) push('ALT_NEGATIVE', 'BLOCKER', path(`altitudeConstraint.${field}`), `Altitude ${value}ft is negative — AIP "-N" means AT_OR_BELOW N, not a negative altitude.`, leg.evidence, true);
        else if (value > 60000) push('ALT_RANGE', 'ERROR', path(`altitudeConstraint.${field}`), `Altitude ${value}ft is outside plausible range.`);
      }
      if (alt.lowerFt != null && alt.upperFt != null && alt.lowerFt > alt.upperFt) push('ALTITUDE_ORDER', 'ERROR', path('altitudeConstraint'), 'Lower altitude exceeds upper altitude.');
      const raw = (alt.rawText || '').trim();
      if (raw.startsWith('-') && alt.type === 'AT_OR_ABOVE') push('ALT_SIGN_SEMANTICS', 'ERROR', path('altitudeConstraint.type'), `rawText "${raw}" indicates AT_OR_BELOW but constraint type is AT_OR_ABOVE.`, leg.evidence, true);
      if (raw.startsWith('+') && alt.type === 'AT_OR_BELOW') push('ALT_SIGN_SEMANTICS', 'ERROR', path('altitudeConstraint.type'), `rawText "${raw}" indicates AT_OR_ABOVE but constraint type is AT_OR_BELOW.`, leg.evidence, true);
    }
    // —— 速度值域 ——
    const speed = leg.speedConstraint;
    if (speed && speed.type !== 'NONE' && speed.valueKias != null && (speed.valueKias < 90 || speed.valueKias > 350))
      push('SPEED_RANGE', 'ERROR', path('speedConstraint.valueKias'), `Speed ${speed.valueKias} KIAS is outside plausible range [90, 350].`);

    // —— 航向 / 距离反算 ——
    const from = leg.fromFixId ? fixes.get(leg.fromFixId) : undefined;
    const to = leg.toFixId ? fixes.get(leg.toFixId) : undefined;
    if (hasCoord(from) && hasCoord(to)) {
      const inv = geodesicInverse([from.longitude!, from.latitude!], [to.longitude!, to.latitude!]);
      if (leg.course != null && !HOLDING_PTS.has(leg.pathTerminator) && leg.pathTerminator !== 'RF' && leg.pathTerminator !== 'AF') {
        const diff = angleDiff(inv.initialBearing, leg.course);
        if (diff > 45) push('COURSE_BACKCHECK', 'ERROR', path('course'), `Charted course ${leg.course}° differs from computed bearing ${inv.initialBearing.toFixed(1)}° by ${diff.toFixed(1)}° (beyond magnetic-variation tolerance).`, leg.evidence);
        else if (diff > 20) push('COURSE_BACKCHECK', 'WARNING', path('course'), `Charted course ${leg.course}° vs computed bearing ${inv.initialBearing.toFixed(1)}° differs by ${diff.toFixed(1)}°; verify magnetic variation.`, leg.evidence);
      }
      if (leg.distanceNm != null && !HOLDING_PTS.has(leg.pathTerminator) && leg.pathTerminator !== 'RF' && leg.pathTerminator !== 'AF') {
        const delta = Math.abs(inv.distanceNm - leg.distanceNm);
        if (delta > Math.max(0.5, leg.distanceNm * 0.25)) push('DIST_BACKCHECK', 'ERROR', path('distanceNm'), `Charted distance ${leg.distanceNm}NM differs from computed ${inv.distanceNm.toFixed(2)}NM.`, leg.evidence);
        else if (delta > Math.max(0.5, leg.distanceNm * 0.08)) push('DIST_BACKCHECK', 'WARNING', path('distanceNm'), `Charted distance ${leg.distanceNm}NM vs computed ${inv.distanceNm.toFixed(2)}NM.`, leg.evidence);
      }
    }
    // —— RF 圆弧参数 ——
    if (leg.pathTerminator === 'RF') {
      const center = leg.centerFixId ? fixes.get(leg.centerFixId) : undefined;
      if (!leg.centerFixId) push('RF_FIELDS', 'ERROR', path('centerFixId'), 'RF leg requires a center fix.');
      if (!leg.turnDirection) push('RF_FIELDS', 'ERROR', path('turnDirection'), 'RF leg requires a turn direction.');
      if (hasCoord(center) && hasCoord(from) && hasCoord(to)) {
        const r1 = geodesicInverse([center.longitude!, center.latitude!], [from.longitude!, from.latitude!]).distanceNm;
        const r2 = geodesicInverse([center.longitude!, center.latitude!], [to.longitude!, to.latitude!]).distanceNm;
        if (Math.abs(r1 - r2) > 0.2) push('RF_RADIUS_CONSISTENCY', 'ERROR', path('centerFixId'), `RF start/end radii differ: ${r1.toFixed(2)}NM vs ${r2.toFixed(2)}NM.`);
        if (leg.radiusNm != null && Math.abs(leg.radiusNm - (r1 + r2) / 2) > Math.max(0.1, leg.radiusNm * 0.1)) push('RF_RADIUS_VALUE', 'WARNING', path('radiusNm'), `Charted radius ${leg.radiusNm}NM differs from computed ${(0.5 * (r1 + r2)).toFixed(2)}NM.`);
      }
    }
    // —— AF 导航台 + DME 半径 ——
    if (leg.pathTerminator === 'AF') {
      if (!leg.recommendedNavaidId && !leg.centerFixId) push('AF_FIELDS', 'ERROR', path('recommendedNavaidId'), 'AF leg requires a recommended navaid (arc centre).');
      if (leg.radiusNm == null) push('AF_FIELDS', 'ERROR', path('radiusNm'), 'AF leg requires the DME arc radius.');
    }
    // —— Holding 必要字段 ——
    if (HOLDING_PTS.has(leg.pathTerminator)) {
      if (!leg.holding) push('HOLDING_FIELDS', 'ERROR', path('holding'), `${leg.pathTerminator} leg has no holding definition.`);
      else {
        if (leg.holding.inboundCourse == null) push('HOLDING_FIELDS', 'ERROR', path('holding.inboundCourse'), 'Holding requires an inbound course.');
        if (!leg.holding.turnDirection) push('HOLDING_FIELDS', 'ERROR', path('holding.turnDirection'), 'Holding requires a turn direction.');
        if (leg.holding.legTimeMin == null && leg.holding.legDistanceNm == null) push('HOLDING_FIELDS', 'WARNING', path('holding'), 'Holding has neither leg time nor leg distance; 1 min standard will be assumed for geometry.');
      }
    }
    // —— PT 必要字段 ——
    if (COURSE_PTS.has(leg.pathTerminator) && leg.course == null) push('PT_REQUIRED_FIELDS', 'ERROR', path('course'), `${leg.pathTerminator} leg requires a course.`);
    if (['TF', 'DF', 'CF', 'IF', 'RF', 'AF', 'HF', 'HA', 'HM'].includes(leg.pathTerminator) && !leg.toFixId && !leg.fromFixId)
      push('PT_REQUIRED_FIELDS', 'ERROR', path('toFixId'), `${leg.pathTerminator} leg requires a fix reference.`);
    if (['VA', 'CA', 'FA', 'HA'].includes(leg.pathTerminator) && (!leg.altitudeConstraint || leg.altitudeConstraint.type === 'NONE'))
      push('PT_REQUIRED_FIELDS', 'WARNING', path('altitudeConstraint'), `${leg.pathTerminator} leg terminates at an altitude but has no altitude constraint.`);
  });

  // —— Fix 坐标 ——
  pir.fixes.forEach((fix, i) => {
    if (fix.latitude != null && (fix.latitude < -90 || fix.latitude > 90)) push('LATITUDE_RANGE', 'BLOCKER', `fixes[${i}].latitude`, 'Latitude is invalid.');
    if (fix.longitude != null && (fix.longitude < -180 || fix.longitude > 180)) push('LONGITUDE_RANGE', 'BLOCKER', `fixes[${i}].longitude`, 'Longitude is invalid.');
    if ((fix.latitude == null) !== (fix.longitude == null)) push('FIX_COORD_INCOMPLETE', 'ERROR', `fixes[${i}]`, `Fix ${fix.identifier} has only one coordinate component.`);
  });

  // —— Route 连续性 + Transition 连接 ——
  for (const [ri, route] of pir.routes.entries()) {
    const legs = route.legIds.map((id) => pir.legs[legIndex.get(id) ?? -1]).filter(Boolean);
    for (let i = 0; i + 1 < legs.length; i++) {
      const a = legs[i]; const b = legs[i + 1];
      if (a.toFixId && b.fromFixId && a.toFixId !== b.fromFixId)
        push('ROUTE_CONTINUITY', 'WARNING', `routes[${ri}]`, `Route ${route.identifier}: leg ${a.legId} ends at ${fixes.get(a.toFixId)?.identifier || a.toFixId} but next leg starts at ${fixes.get(b.fromFixId)?.identifier || b.fromFixId}.`);
    }
  }
  const terminalFixOf = (routeId: string) => { const route = pir.routes.find((r) => r.routeId === routeId); const last = route?.legIds.length ? pir.legs[legIndex.get(route.legIds.at(-1)!) ?? -1] : undefined; return last?.toFixId ? fixes.get(last.toFixId) : undefined; };
  const startFixesOf = (types: string[]) => pir.routes.filter((r) => types.includes(r.routeType)).flatMap((r) => { const first = r.legIds.length ? pir.legs[legIndex.get(r.legIds[0]) ?? -1] : undefined; return first ? [first.fromFixId, first.toFixId].filter(Boolean) as string[] : []; });
  for (const route of pir.routes.filter((r) => ['ENROUTE_TRANSITION', 'APPROACH_TRANSITION'].includes(r.routeType))) {
    const isStar = pir.procedure.category !== 'SID';
    if (!isStar) continue; // SID 的离场过渡从公共段流出，不检入口
    const terminal = terminalFixOf(route.routeId);
    const targets = startFixesOf(['COMMON_ROUTE', 'FINAL_APPROACH', 'RUNWAY_TRANSITION']);
    if (terminal && targets.length && !targets.includes(terminal.fixId))
      push('TRANSITION_CONNECTION', 'WARNING', `routes[${pir.routes.indexOf(route)}]`, `Transition ${route.identifier} ends at ${terminal.identifier} which is not the entry fix of any downstream route.`);
  }

  // —— APPROACH 结构 ——
  if (pir.procedure.category === 'APPROACH') {
    const routeTypes = new Set(pir.routes.map((r) => r.routeType));
    if (!routeTypes.has('FINAL_APPROACH')) push('APPROACH_STRUCTURE', 'ERROR', 'routes', 'Approach has no FINAL_APPROACH route (final segment must not be COMMON_ROUTE).');
    if (!routeTypes.has('MISSED_APPROACH')) push('APPROACH_STRUCTURE', 'ERROR', 'routes', 'Approach has no MISSED_APPROACH route.');
    if (routeTypes.has('COMMON_ROUTE')) push('APPROACH_STRUCTURE', 'WARNING', 'routes', 'Approach uses COMMON_ROUTE; approach segments should be APPROACH_TRANSITION / FINAL_APPROACH / MISSED_APPROACH.');
    const roles = new Set(pir.fixes.map((f) => f.role).filter(Boolean));
    if (!roles.has('FAF') && !roles.has('FAP')) push('APPROACH_STRUCTURE', 'ERROR', 'fixes', 'No FAF/FAP fix is tagged.');
    if (!roles.has('MAPT')) push('APPROACH_STRUCTURE', 'ERROR', 'fixes', 'No MAPT fix is tagged.');
    if (!pir.minima.length) push('APPROACH_MINIMA', 'WARNING', 'minima', 'No minima (DA/MDA/OCA/OCH) were extracted.');
    const final = pir.routes.find((r) => r.routeType === 'FINAL_APPROACH');
    const missed = pir.routes.find((r) => r.routeType === 'MISSED_APPROACH');
    if (final && missed && final.legIds.some((id) => missed.legIds.includes(id)))
      push('FINAL_MISSED_SEPARATION', 'ERROR', 'routes', 'Final approach and missed approach share legs; they must be separate.');
  }

  // —— Plan 与结果一致性 ——
  if (plan) {
    const structure = plan.detectedStructure || ({} as RecognitionPlan['detectedStructure']);
    const routeTypes = new Set(pir.routes.map((r) => r.routeType));
    if (structure.hasMissedApproach && !routeTypes.has('MISSED_APPROACH')) push('PLAN_CONSISTENCY', 'ERROR', 'routes', 'Recognition plan detected a missed approach but the result has none.');
    if (structure.hasRunwayTransition && !routeTypes.has('RUNWAY_TRANSITION')) push('PLAN_CONSISTENCY', 'WARNING', 'routes', 'Plan detected runway transitions but the result has none.');
    if (structure.hasEnrouteTransitions && !routeTypes.has('ENROUTE_TRANSITION') && !routeTypes.has('APPROACH_TRANSITION')) push('PLAN_CONSISTENCY', 'WARNING', 'routes', 'Plan detected enroute/approach transitions but the result has none.');
    const planText = `${plan.geometryStrategy || ''} ${plan.arinc424Strategy || ''}`;
    const planHasHoldings = /hold/i.test(planText) || (plan.recognitionPlan || []).some((s) => s.action === 'EXTRACT_HOLDING');
    if (planHasHoldings && !pir.legs.some((l) => l.holding)) push('PLAN_CONSISTENCY', 'ERROR', 'legs', 'Recognition plan expected holding patterns but none were recognized.');
  }

  // —— 开放冲突必须可见 ——
  for (const conflict of pir.conflicts.filter((c) => c.status === 'OPEN'))
    push('OPEN_CONFLICT', 'WARNING', conflict.fieldPath, conflict.reason || 'Unresolved extraction conflict.', conflict.candidates.flatMap((c) => c.evidence));

  return out;
}

/** BLOCKER/ERROR 联动质量与状态：返回建议的包状态。 */
export function applyQualityGate(pir: ProcedurePIR, validations: ValidationResult[]): 'COMPLETED' | 'COMPLETED_WITH_WARNINGS' | 'REQUIRES_REVIEW' {
  const hasBlocker = validations.some((v) => v.severity === 'BLOCKER');
  const hasError = validations.some((v) => v.severity === 'ERROR');
  const hasWarning = validations.some((v) => v.severity === 'WARNING');
  const unresolved = pir.quality.unresolvedFields.length > 0 || pir.fixes.some((f) => f.status === 'UNRESOLVED');
  if (hasBlocker) { pir.quality.reviewRequired = true; pir.quality.confidence = Math.min(pir.quality.confidence, 0.6); return 'REQUIRES_REVIEW'; }
  if (hasError) { pir.quality.reviewRequired = true; pir.quality.confidence = Math.min(pir.quality.confidence, 0.75); return 'REQUIRES_REVIEW'; }
  if (hasWarning || unresolved || pir.quality.reviewRequired) return 'COMPLETED_WITH_WARNINGS';
  return 'COMPLETED';
}

function hasCoord(fix?: PirFix): fix is PirFix & { latitude: number; longitude: number } {
  return !!fix && Number.isFinite(fix.latitude) && Number.isFinite(fix.longitude);
}
function angleDiff(a: number, b: number) { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; }
