import crypto from 'node:crypto';
import type { ClimbGradient, AltitudeConstraint, PageEvidence, PirConflict, PirFix, PirHolding, PirLeg, PirMinima, PirRoute, PirRunway, ProcedurePIR, SpeedConstraint } from './domain';

// 分步识别的片段形态。routes 片段带 fixSequence（有序 fix 标识），legIds 由 legs 合并时回填。
export interface RouteFragment { routeId: string; routeType: PirRoute['routeType']; identifier: string; runway?: string | null; transitionFix?: string | null; climbGradient?: ClimbGradient | null; fixSequence?: string[]; sequence: number }
export interface LegConstraintFragment { legId: string; altitudeConstraint?: AltitudeConstraint | null; speedConstraint?: SpeedConstraint | null; verticalAngle?: number | null; evidence?: string[] }
export interface HoldingFragment { fixIdentifier: string; legId?: string | null; pathTerminator?: 'HA' | 'HF' | 'HM' | null; holding: PirHolding; evidence?: string[] }
export interface PirFragment {
  procedure?: Partial<ProcedurePIR['procedure']>;
  runwayData?: PirRunway[];
  fixes?: PirFix[];
  routes?: RouteFragment[];
  legs?: PirLeg[];
  legConstraints?: LegConstraintFragment[];
  minima?: PirMinima[];
  holdings?: HoldingFragment[];
  sourceEvidence?: PageEvidence[];
  notes?: Array<{ text: string; evidence: string[] }>;
}
export interface FragmentSource { action: string; modelCallId?: string }

const COORD_TOLERANCE_DEG = 0.0005; // ~55m，超出视为坐标冲突

export function createEmptyPir(airport: { icao: string; name?: string }, procedure: { category: ProcedurePIR['procedure']['category']; name: string; runways: string[] }): ProcedurePIR {
  return {
    schemaVersion: '1.1.0',
    airport: { icao: airport.icao, name: airport.name },
    procedure: { category: procedure.category, approachType: null, identifier: procedure.name, name: procedure.name, runways: procedure.runways, navigationSpecification: null, effectiveDate: null },
    routes: [], fixes: [], legs: [], runwayData: [], minima: [], notes: [], sourceEvidence: [],
    conflicts: [], validation: { results: [] },
    quality: { confidence: 0, reviewRequired: false, unresolvedFields: [] },
  };
}

export function mergeFragment(pir: ProcedurePIR, fragment: PirFragment, source: FragmentSource): ProcedurePIR {
  mergeEvidence(pir, fragment.sourceEvidence || [], source);
  if (fragment.procedure) mergeProcedure(pir, fragment.procedure, source);
  for (const runway of fragment.runwayData || []) mergeRunway(pir, runway, source);
  for (const fix of fragment.fixes || []) mergeFix(pir, fix, source);
  for (const route of fragment.routes || []) mergeRoute(pir, route, source);
  for (const leg of fragment.legs || []) mergeLeg(pir, leg, source);
  for (const constraint of fragment.legConstraints || []) mergeConstraint(pir, constraint, source);
  for (const minima of fragment.minima || []) mergeMinima(pir, minima, source);
  for (const holding of fragment.holdings || []) mergeHolding(pir, holding, source);
  for (const note of fragment.notes || []) if (!pir.notes.some((n) => n.text === note.text)) pir.notes.push(note);
  return pir;
}

/** 把上一版本的人工编辑值带入新 PIR：人工值保留为当前值，自动识别的不同值转为冲突候选。 */
export function carryOverManualEdits(previous: ProcedurePIR | undefined, next: ProcedurePIR): ProcedurePIR {
  if (!previous) return next;
  for (const prevLeg of previous.legs) {
    const manualFields = Object.entries(prevLeg.fieldStatus || {}).filter(([, status]) => status === 'MANUALLY_EDITED');
    if (!manualFields.length) continue;
    const target = next.legs.find((leg) => leg.routeId === prevLeg.routeId && leg.sequence === prevLeg.sequence)
      || next.legs.find((leg) => leg.fromFixId === prevLeg.fromFixId && leg.toFixId === prevLeg.toFixId && leg.pathTerminator === prevLeg.pathTerminator);
    if (!target) continue;
    for (const [field] of manualFields) {
      const manualValue = (prevLeg as any)[field];
      const autoValue = (target as any)[field];
      if (JSON.stringify(manualValue) !== JSON.stringify(autoValue)) {
        addConflict(next, `legs[${next.legs.indexOf(target)}].${field}`, 'Manual edit preserved over re-recognition value.', [
          { value: manualValue, source: 'MANUAL_EDIT', evidence: [] },
          { value: autoValue, source: 'RE_RECOGNITION', evidence: target.evidence },
        ]);
      }
      (target as any)[field] = manualValue;
      target.fieldStatus[field] = 'MANUALLY_EDITED';
    }
  }
  for (const prevFix of previous.fixes.filter((f) => f.status === 'MANUALLY_EDITED')) {
    const target = next.fixes.find((f) => f.identifier.toUpperCase() === prevFix.identifier.toUpperCase());
    if (!target) { next.fixes.push(prevFix); continue; }
    if (differentCoordinate(target, prevFix)) {
      addConflict(next, `fixes[${next.fixes.indexOf(target)}]`, 'Manual fix coordinate preserved over re-recognition value.', [
        { value: { latitude: prevFix.latitude, longitude: prevFix.longitude }, source: 'MANUAL_EDIT', evidence: [] },
        { value: { latitude: target.latitude, longitude: target.longitude }, source: 'RE_RECOGNITION', evidence: target.evidence },
      ]);
    }
    Object.assign(target, prevFix, { fixId: target.fixId });
  }
  return next;
}

function mergeEvidence(pir: ProcedurePIR, items: PageEvidence[], source: FragmentSource) {
  for (const item of items) {
    if (!item?.evidenceId) continue;
    const enriched: PageEvidence = { ...item, modelCallId: item.modelCallId ?? source.modelCallId ?? null, planAction: item.planAction ?? source.action };
    const existing = pir.sourceEvidence.find((e) => e.evidenceId === item.evidenceId);
    if (!existing) pir.sourceEvidence.push(enriched);
    else if (existing.rawText !== item.rawText || existing.pageNumber !== item.pageNumber) {
      enriched.evidenceId = `${item.evidenceId}-${source.action.slice(0, 6)}${pir.sourceEvidence.length}`;
      pir.sourceEvidence.push(enriched);
    }
  }
}

function mergeProcedure(pir: ProcedurePIR, incoming: Partial<ProcedurePIR['procedure']>, source: FragmentSource) {
  for (const key of ['category', 'approachType', 'identifier', 'name', 'navigationSpecification', 'effectiveDate'] as const) {
    const value = incoming[key];
    if (value === undefined || value === null || value === '') continue;
    const current = pir.procedure[key];
    if (current && current !== value && key !== 'identifier' && key !== 'name') {
      addConflict(pir, `procedure.${key}`, `Differing ${key} between steps.`, [
        { value: current, source: 'EXISTING', evidence: [] },
        { value, source: source.action, evidence: [] },
      ]);
      continue;
    }
    (pir.procedure as any)[key] = value;
  }
  if (incoming.runways?.length) pir.procedure.runways = [...new Set([...pir.procedure.runways, ...incoming.runways])];
}

function mergeRunway(pir: ProcedurePIR, incoming: PirRunway, source: FragmentSource) {
  const key = incoming.designator.toUpperCase().replace(/^RWY?\s*/, '');
  const existing = pir.runwayData.find((r) => r.designator.toUpperCase().replace(/^RWY?\s*/, '') === key);
  if (!existing) { pir.runwayData.push({ ...incoming, runwayId: incoming.runwayId || `RWY-${key}` }); return; }
  for (const field of ['thresholdLatitude', 'thresholdLongitude', 'derLatitude', 'derLongitude', 'elevationFt', 'thresholdCrossingHeightFt', 'trueBearing'] as const) {
    const value = incoming[field];
    if (value == null) continue;
    const current = existing[field];
    if (current == null) { (existing as any)[field] = value; continue; }
    if (Math.abs(Number(current) - Number(value)) > (field.includes('Lat') || field.includes('Lon') ? COORD_TOLERANCE_DEG : 1)) {
      addConflict(pir, `runwayData[${pir.runwayData.indexOf(existing)}].${field}`, 'Differing runway value between steps.', [
        { value: current, source: 'EXISTING', evidence: existing.evidence },
        { value, source: source.action, evidence: incoming.evidence || [] },
      ]);
    }
  }
  existing.evidence = [...new Set([...existing.evidence, ...(incoming.evidence || [])])];
}

function mergeFix(pir: ProcedurePIR, incoming: PirFix, source: FragmentSource) {
  const existing = pir.fixes.find((f) => f.identifier.toUpperCase() === incoming.identifier.toUpperCase());
  if (!existing) { pir.fixes.push(incoming); return; }
  if (existing.status === 'MANUALLY_EDITED') {
    if (differentCoordinate(existing, incoming)) addConflict(pir, `fixes[${pir.fixes.indexOf(existing)}]`, 'Re-recognition differs from manual edit.', [
      { value: coordOf(existing), source: 'MANUAL_EDIT', evidence: existing.evidence },
      { value: coordOf(incoming), source: source.action, evidence: incoming.evidence },
    ]);
    return;
  }
  if (existing.latitude == null && incoming.latitude != null) {
    existing.latitude = incoming.latitude; existing.longitude = incoming.longitude;
    existing.coordinateSourceType = incoming.coordinateSourceType; existing.status = incoming.status; existing.confidence = incoming.confidence;
  } else if (differentCoordinate(existing, incoming)) {
    existing.status = 'CONFLICTED';
    addConflict(pir, `fixes[${pir.fixes.indexOf(existing)}]`, `Fix ${existing.identifier} has differing coordinates between steps.`, [
      { value: coordOf(existing), source: 'EXISTING', evidence: existing.evidence, confidence: existing.confidence },
      { value: coordOf(incoming), source: source.action, evidence: incoming.evidence, confidence: incoming.confidence },
    ]);
  }
  if (incoming.role && incoming.role !== 'NONE' && (!existing.role || existing.role === 'NONE')) existing.role = incoming.role;
  existing.evidence = [...new Set([...existing.evidence, ...incoming.evidence])];
}

function mergeRoute(pir: ProcedurePIR, incoming: RouteFragment, source: FragmentSource) {
  const existing = pir.routes.find((r) => r.routeId === incoming.routeId)
    || pir.routes.find((r) => r.routeType === incoming.routeType && r.identifier.toUpperCase() === incoming.identifier.toUpperCase() && (r.runway || null) === (incoming.runway || null));
  if (existing) {
    existing.transitionFix ||= incoming.transitionFix ?? null;
    // 爬升梯度按程序发布，不同 SID 数值可能不同（实测 3500FT vs 6000FT），
    // 因此只在本路线还没有时补上，不拿后来的片段覆盖已确认的值。
    existing.climbGradient ??= incoming.climbGradient ?? null;
    if ((existing as any).fixSequence == null && incoming.fixSequence) (existing as any).fixSequence = incoming.fixSequence;
    return;
  }
  const route: PirRoute & { fixSequence?: string[] } = { routeId: incoming.routeId, routeType: incoming.routeType, identifier: incoming.identifier, runway: incoming.runway ?? null, transitionFix: incoming.transitionFix ?? null, climbGradient: incoming.climbGradient ?? null, legIds: [], sequence: incoming.sequence };
  if (incoming.fixSequence) route.fixSequence = incoming.fixSequence;
  pir.routes.push(route);
  void source;
}

function mergeLeg(pir: ProcedurePIR, incoming: PirLeg, source: FragmentSource) {
  const existing = pir.legs.find((l) => l.routeId === incoming.routeId && l.sequence === incoming.sequence)
    || pir.legs.find((l) => l.fromFixId === incoming.fromFixId && l.toFixId === incoming.toFixId && l.pathTerminator === incoming.pathTerminator && l.routeId === incoming.routeId);
  if (!existing) {
    pir.legs.push(incoming);
    const route = pir.routes.find((r) => r.routeId === incoming.routeId);
    if (route && !route.legIds.includes(incoming.legId)) route.legIds.push(incoming.legId);
    return;
  }
  for (const field of ['pathTerminator', 'fromFixId', 'toFixId', 'centerFixId', 'recommendedNavaidId', 'course', 'distanceNm', 'radiusNm', 'turnDirection', 'verticalAngle'] as const) {
    const value = (incoming as any)[field];
    if (value == null) continue;
    if (existing.fieldStatus?.[field] === 'MANUALLY_EDITED') continue;
    const current = (existing as any)[field];
    if (current == null) { (existing as any)[field] = value; continue; }
    const differs = typeof value === 'number' ? Math.abs(current - value) > (field === 'course' ? 2 : 0.15) : current !== value;
    if (differs) {
      existing.fieldStatus[field] = 'CONFLICTED';
      addConflict(pir, `legs[${pir.legs.indexOf(existing)}].${field}`, `Leg ${existing.legId} ${field} differs between steps.`, [
        { value: current, source: 'EXISTING', evidence: existing.evidence },
        { value, source: source.action, evidence: incoming.evidence },
      ]);
    }
  }
  if (incoming.altitudeConstraint && !existing.altitudeConstraint) existing.altitudeConstraint = incoming.altitudeConstraint;
  if (incoming.speedConstraint && !existing.speedConstraint) existing.speedConstraint = incoming.speedConstraint;
  if (incoming.holding && !existing.holding) existing.holding = incoming.holding;
  existing.evidence = [...new Set([...existing.evidence, ...incoming.evidence])];
  existing.warnings = [...new Set([...existing.warnings, ...incoming.warnings])];
}

function mergeConstraint(pir: ProcedurePIR, incoming: LegConstraintFragment, source: FragmentSource) {
  const leg = pir.legs.find((l) => l.legId === incoming.legId);
  if (!leg) { pir.notes.push({ text: `Constraint for unknown leg ${incoming.legId} ignored.`, evidence: incoming.evidence || [] }); return; }
  mergeConstraintField(pir, leg, 'altitudeConstraint', incoming.altitudeConstraint, source, incoming.evidence);
  mergeConstraintField(pir, leg, 'speedConstraint', incoming.speedConstraint, source, incoming.evidence);
  if (incoming.verticalAngle != null && leg.fieldStatus?.verticalAngle !== 'MANUALLY_EDITED') {
    if (leg.verticalAngle != null && Math.abs(leg.verticalAngle - incoming.verticalAngle) > 0.05) {
      addConflict(pir, `legs[${pir.legs.indexOf(leg)}].verticalAngle`, 'Vertical angle differs between steps.', [
        { value: leg.verticalAngle, source: 'EXISTING', evidence: leg.evidence },
        { value: incoming.verticalAngle, source: source.action, evidence: incoming.evidence || [] },
      ]);
    } else leg.verticalAngle = incoming.verticalAngle;
  }
  if (incoming.evidence?.length) leg.evidence = [...new Set([...leg.evidence, ...incoming.evidence])];
}

function mergeConstraintField(pir: ProcedurePIR, leg: PirLeg, field: 'altitudeConstraint' | 'speedConstraint', value: AltitudeConstraint | SpeedConstraint | null | undefined, source: FragmentSource, evidence?: string[]) {
  if (value == null || value.type === 'NONE') return;
  if (leg.fieldStatus?.[field] === 'MANUALLY_EDITED') return;
  const current = leg[field];
  if (current && current.type !== 'NONE' && JSON.stringify(current) !== JSON.stringify(value)) {
    leg.fieldStatus[field] = 'CONFLICTED';
    addConflict(pir, `legs[${pir.legs.indexOf(leg)}].${field}`, `Leg ${leg.legId} ${field} differs between steps.`, [
      { value: current, source: 'EXISTING', evidence: leg.evidence },
      { value, source: source.action, evidence: evidence || [] },
    ]);
    return;
  }
  (leg as any)[field] = value;
}

function mergeMinima(pir: ProcedurePIR, incoming: PirMinima, source: FragmentSource) {
  const key = (m: PirMinima) => [m.type, m.aircraftCategory || '', m.runway || '', m.condition || ''].join('|').toUpperCase();
  const existing = pir.minima.find((m) => key(m) === key(incoming));
  if (!existing) { pir.minima.push({ ...incoming, minimaId: incoming.minimaId || crypto.randomUUID() }); return; }
  const differs = (existing.valueFt != null && incoming.valueFt != null && Math.abs(existing.valueFt - incoming.valueFt) > 1)
    || (existing.valueMeters != null && incoming.valueMeters != null && Math.abs(existing.valueMeters - incoming.valueMeters) > 1);
  if (differs) {
    existing.status = 'CONFLICTED';
    addConflict(pir, `minima[${pir.minima.indexOf(existing)}]`, `Minima ${existing.type} ${existing.aircraftCategory || ''} differs between steps.`, [
      { value: { valueFt: existing.valueFt, valueMeters: existing.valueMeters }, source: 'EXISTING', evidence: existing.evidence },
      { value: { valueFt: incoming.valueFt, valueMeters: incoming.valueMeters }, source: source.action, evidence: incoming.evidence },
    ]);
  } else { existing.valueFt ??= incoming.valueFt; existing.valueMeters ??= incoming.valueMeters; }
  existing.evidence = [...new Set([...existing.evidence, ...incoming.evidence])];
}

function mergeHolding(pir: ProcedurePIR, incoming: HoldingFragment, source: FragmentSource) {
  const fixUpper = incoming.fixIdentifier.toUpperCase();
  const fix = pir.fixes.find((f) => f.identifier.toUpperCase() === fixUpper);
  const holding: PirHolding = { ...incoming.holding, holdingFixId: incoming.holding.holdingFixId ?? fix?.fixId ?? null };
  let leg = incoming.legId ? pir.legs.find((l) => l.legId === incoming.legId) : undefined;
  leg ||= pir.legs.find((l) => ['HA', 'HF', 'HM'].includes(l.pathTerminator) && fixOf(pir, l.toFixId ?? l.fromFixId)?.identifier.toUpperCase() === fixUpper);
  leg ||= pir.legs.filter((l) => fixOf(pir, l.toFixId)?.identifier.toUpperCase() === fixUpper).at(-1);
  if (!leg) {
    pir.notes.push({ text: `Holding at ${incoming.fixIdentifier} has no matching leg; review required.`, evidence: incoming.evidence || [] });
    pir.quality.reviewRequired = true;
    return;
  }
  if (leg.fieldStatus?.holding === 'MANUALLY_EDITED') return;
  if (leg.holding && JSON.stringify(leg.holding) !== JSON.stringify(holding)) {
    addConflict(pir, `legs[${pir.legs.indexOf(leg)}].holding`, `Holding at ${incoming.fixIdentifier} differs between steps.`, [
      { value: leg.holding, source: 'EXISTING', evidence: leg.evidence },
      { value: holding, source: source.action, evidence: incoming.evidence || [] },
    ]);
    return;
  }
  leg.holding = holding;
  if (incoming.pathTerminator && !['HA', 'HF', 'HM'].includes(leg.pathTerminator)) {
    leg.pathTerminator = incoming.pathTerminator;
    leg.fieldStatus.pathTerminator = 'DERIVED';
  }
  if (incoming.evidence?.length) leg.evidence = [...new Set([...leg.evidence, ...incoming.evidence])];
}

function addConflict(pir: ProcedurePIR, fieldPath: string, reason: string, candidates: PirConflict['candidates']) {
  const existing = pir.conflicts.find((c) => c.fieldPath === fieldPath && c.status === 'OPEN');
  if (existing) {
    for (const candidate of candidates) if (!existing.candidates.some((c) => JSON.stringify(c.value) === JSON.stringify(candidate.value))) existing.candidates.push(candidate);
    return;
  }
  pir.conflicts.push({ conflictId: crypto.randomUUID(), fieldPath, reason, status: 'OPEN', candidates });
}

function differentCoordinate(a: PirFix, b: PirFix) {
  if (a.latitude == null || b.latitude == null || a.longitude == null || b.longitude == null) return false;
  return Math.abs(a.latitude - b.latitude) > COORD_TOLERANCE_DEG || Math.abs(a.longitude - b.longitude) > COORD_TOLERANCE_DEG;
}
function coordOf(fix: PirFix) { return { latitude: fix.latitude, longitude: fix.longitude }; }
function fixOf(pir: ProcedurePIR, fixId?: string | null) { return fixId ? pir.fixes.find((f) => f.fixId === fixId) : undefined; }

/**
 * 用已提取的跑道数据补齐跑道类 fix 的坐标。
 *
 * 识别只把跑道物理数据放进 pir.runwayData，没有任何环节把它接到航段引用的那个
 * 跑道 fix 上——于是 AD 2.12 页里白纸黑字的 "THR coordinates 013919.83N 1033950.29E"
 * 已经进了 PIR，而 RW16 仍是 UNRESOLVED，离场起点锚不住、机场画不出来、
 * 下游一连串腿因此无法绘制。这是纯粹的确定性关联，不该交给模型再猜一遍。
 *
 * DER（离场端）取跑道另一端的坐标，其余取入口坐标：从 16 号跑道起飞，
 * 起点是 16 的入口，离场端是跑道另一头。
 */
export function resolveRunwayFixes(pir: ProcedurePIR): number {
  let resolved = 0;
  for (const fix of pir.fixes) {
    if (Number.isFinite(fix.latitude) && Number.isFinite(fix.longitude)) continue;
    const designator = runwayDesignator(fix.identifier);
    if (!designator) continue;
    const runway = pir.runwayData.find((item) => normalizeRunway(item.designator) === designator);
    if (!runway) continue;
    const useDer = fix.role === 'DER';
    const latitude = useDer ? runway.derLatitude : runway.thresholdLatitude;
    const longitude = useDer ? runway.derLongitude : runway.thresholdLongitude;
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;
    fix.latitude = latitude as number;
    fix.longitude = longitude as number;
    fix.coordinateSourceType = 'RUNWAY_DATABASE';
    fix.status = fix.status === 'MANUALLY_EDITED' ? fix.status : 'DERIVED';
    fix.derivation = `Resolved from runway ${runway.designator} ${useDer ? 'departure end' : 'threshold'} coordinates in the runway physical characteristics table.`;
    fix.evidence = [...new Set([...(fix.evidence || []), ...(runway.evidence || [])])];
    resolved += 1;
  }
  return resolved;
}

function runwayDesignator(identifier: string) {
  const match = String(identifier || '').toUpperCase().match(/^RW?Y?\s*(\d{2}[LCR]?)$/);
  return match ? match[1] : undefined;
}
function normalizeRunway(designator: string) {
  return String(designator || '').toUpperCase().replace(/^RW?Y?\s*/, '').trim();
}
