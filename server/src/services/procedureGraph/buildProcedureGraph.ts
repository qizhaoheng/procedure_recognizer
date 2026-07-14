import type {
  GraphAltitudeConstraint,
  GraphSourceEvidence,
  ProcedureGraphLeg,
  ProcedureMergePoint,
  ProcedureRoute,
  ProcedureTransition,
  ProcedureUnderstandingProcedure,
  ProcedureUnderstandingResult,
  SidProcedureGraph,
} from '../../types/procedure';
import type { SimpleProcedureLeg } from '../jeppesen424/types';
import { cleanDisplayName, normalizeProcedureName, normalizeTransitionId } from './procedureNames';

// 有向程序图构建：节点 = runway / waypoint / merge point / transition entry / exit，边 = ProcedureGraphLeg。
// 支持：多跑道过渡汇合同一 waypoint、汇合后公共航路、公共航路后分流 enroute transition、
// 无独立 common route、runway transition 直连 enroute transition、IF 记录重复公共入口点。

export function buildGraphsFromJeppesenLegs(legs: SimpleProcedureLeg[], airportIcao = ''): SidProcedureGraph[] {
  const byProcedure = new Map<string, SimpleProcedureLeg[]>();
  for (const leg of legs) {
    const id = normalizeProcedureName(leg.procedureName) ?? leg.routeKey?.trim().toUpperCase() ?? leg.procedureName;
    if (!id) continue;
    const list = byProcedure.get(id) ?? [];
    list.push(leg);
    byProcedure.set(id, list);
  }

  return [...byProcedure.entries()].map(([procedureId, procedureLegs]) => {
    const warnings: string[] = [];
    const runwayTransitions: ProcedureTransition[] = [];
    const enrouteTransitions: ProcedureTransition[] = [];
    const commonRoutes: ProcedureRoute[] = [];

    const byBranch = new Map<string, SimpleProcedureLeg[]>();
    for (const leg of procedureLegs) {
      // 424 分支键：跑道过渡用 RWxx，航路过渡用过渡名，公共航路两者皆空
      const branchKey = leg.transitionName
        ? `ENROUTE|${leg.transitionName.trim().toUpperCase()}`
        : leg.runway
          ? `RUNWAY|${leg.runway.trim().toUpperCase()}`
          : 'COMMON|';
      const list = byBranch.get(branchKey) ?? [];
      list.push(leg);
      byBranch.set(branchKey, list);
    }

    for (const [branchKey, branchLegs] of byBranch) {
      const [branchType, branchName] = branchKey.split('|');
      const ordered = [...branchLegs].sort((a, b) => Number(a.sequence) - Number(b.sequence));
      const graphLegs = ordered.map((leg, index) => jeppesenLegToGraphLeg(leg, ordered[index - 1]));
      const entryFix = firstNamedFix(graphLegs);
      const exitFix = lastNamedFix(graphLegs);

      if (branchType === 'RUNWAY') {
        runwayTransitions.push({
          id: branchName,
          type: 'RUNWAY',
          displayName: branchName,
          runway: branchName,
          entryFix,
          exitFix,
          legs: graphLegs,
          sourceEvidence: branchEvidence(ordered),
        });
      } else if (branchType === 'ENROUTE') {
        enrouteTransitions.push({
          id: branchName,
          type: 'ENROUTE',
          displayName: `${branchName} TRANSITION`,
          entryFix,
          exitFix,
          legs: graphLegs,
          sourceEvidence: branchEvidence(ordered),
        });
      } else {
        commonRoutes.push({
          id: `${procedureId}-COMMON`,
          type: 'COMMON',
          entryFix,
          exitFix,
          legs: graphLegs,
          sourceEvidence: branchEvidence(ordered),
        });
      }
    }

    sortTransitions(runwayTransitions);
    sortTransitions(enrouteTransitions);

    return {
      airportIcao,
      procedureType: 'SID' as const,
      procedureId,
      procedureName: procedureLegs[0]?.procedureName ?? procedureId,
      sourcePages: [],
      runwayTransitions,
      commonRoutes,
      enrouteTransitions,
      mergePoints: detectMergePoints(runwayTransitions, commonRoutes, enrouteTransitions),
      builtFrom: 'JEPPESEN_424' as const,
      warnings,
    };
  });
}

export function buildGraphsFromUnderstanding(understanding: ProcedureUnderstandingResult): SidProcedureGraph[] {
  const procedures = understanding.procedures ?? [];
  if (!procedures.length) return [];
  const procedureType = String(understanding.packageType ?? 'SID').toUpperCase() === 'STAR' ? 'STAR' : 'SID';

  // 按标准化程序标识聚合：跑道分支和过渡在 AI 输出中是并列的 procedures[] 条目
  const byId = new Map<string, ProcedureUnderstandingProcedure[]>();
  const displayNames = new Map<string, string>();
  for (const procedure of procedures) {
    const displayName = cleanDisplayName(procedure.procedureName);
    const id = normalizeProcedureName(stripTransitionSuffix(displayName)) ?? stripTransitionSuffix(displayName);
    if (!id) continue;
    const list = byId.get(id) ?? [];
    list.push(procedure);
    byId.set(id, list);
    if (!displayNames.has(id) && !procedure.transitionName) displayNames.set(id, displayName);
  }

  // 模型的分支拓扑声明（procedureStructure）优先于按 runway/transitionName 猜测
  const structure = understanding.procedureStructure;
  const declaredRole = new Map<string, { role: 'RUNWAY' | 'COMMON' | 'ENROUTE'; id: string; displayName?: string | null; entryFix?: string | null; exitFix?: string | null }>();
  if (structure) {
    for (const branch of structure.runwayTransitions ?? []) {
      if (branch.procedureRef) declaredRole.set(cleanDisplayName(branch.procedureRef), { role: 'RUNWAY', id: branch.id, displayName: branch.displayName, entryFix: branch.entryFix, exitFix: branch.exitFix });
    }
    for (const branch of structure.commonRoutes ?? []) {
      if (branch.procedureRef) declaredRole.set(cleanDisplayName(branch.procedureRef), { role: 'COMMON', id: branch.id, displayName: branch.displayName, entryFix: branch.entryFix, exitFix: branch.exitFix });
    }
    for (const branch of structure.enrouteTransitions ?? []) {
      if (branch.procedureRef) declaredRole.set(cleanDisplayName(branch.procedureRef), { role: 'ENROUTE', id: branch.id, displayName: branch.displayName, entryFix: branch.entryFix, exitFix: branch.exitFix });
    }
  }

  return [...byId.entries()].map(([procedureId, entries]) => {
    const warnings: string[] = [];
    const runwayTransitions: ProcedureTransition[] = [];
    const enrouteTransitions: ProcedureTransition[] = [];
    const commonRoutes: ProcedureRoute[] = [];

    for (const entry of entries) {
      const legs = (entry.legs ?? []).map((leg) => aiLegToGraphLeg(leg as Record<string, unknown>));
      const declared = declaredRole.get(cleanDisplayName(entry.procedureName));
      const entryFix = declared?.entryFix?.toUpperCase() ?? firstNamedFix(legs);
      const exitFix = declared?.exitFix?.toUpperCase() ?? lastNamedFix(legs);
      const transitionId = declared?.role === 'ENROUTE'
        ? declared.id
        : declared?.role === 'RUNWAY' || declared?.role === 'COMMON'
          ? undefined
          : normalizeTransitionId(entry.transitionName);

      if (declared?.role === 'COMMON') {
        commonRoutes.push({
          id: declared.id || `${procedureId}-COMMON`,
          type: 'COMMON',
          entryFix,
          exitFix,
          legs,
        });
        continue;
      }
      if (declared?.role === 'RUNWAY') {
        const runway = normalizeRunwayId(declared.id || entry.runway);
        runwayTransitions.push({
          id: runway,
          type: 'RUNWAY',
          displayName: declared.displayName ?? runway,
          runway,
          entryFix,
          exitFix,
          legs,
          sourceEvidence: [],
          confidence: entry.confidence,
        });
        continue;
      }
      if (transitionId) {
        const printedName = declared?.displayName ?? entry.transitionName ?? transitionId;
        enrouteTransitions.push({
          id: transitionId,
          type: 'ENROUTE',
          displayName: `${cleanDisplayName(printedName)} TRANSITION`.replace(/\s+TRANSITION TRANSITION$/, ' TRANSITION'),
          entryFix,
          exitFix,
          legs,
          sourceEvidence: [],
          confidence: entry.confidence,
        });
      } else if (entry.runway) {
        const runway = normalizeRunwayId(entry.runway);
        runwayTransitions.push({
          id: runway,
          type: 'RUNWAY',
          displayName: runway,
          runway,
          entryFix,
          exitFix,
          legs,
          sourceEvidence: [],
          confidence: entry.confidence,
        });
      } else if (legs.length) {
        commonRoutes.push({
          id: `${procedureId}-COMMON`,
          type: 'COMMON',
          entryFix,
          exitFix,
          legs,
        });
      }
    }

    sortTransitions(runwayTransitions);
    sortTransitions(enrouteTransitions);

    return {
      airportIcao: String(understanding.airportIcao ?? ''),
      procedureType,
      procedureId,
      procedureName: displayNames.get(procedureId) ?? procedureId,
      navigationSpecification: firstNavigationSpec(entries),
      sourcePages: [],
      runwayTransitions,
      commonRoutes,
      enrouteTransitions,
      mergePoints: detectMergePoints(runwayTransitions, commonRoutes, enrouteTransitions),
      builtFrom: 'AI_UNDERSTANDING' as const,
      warnings,
    };
  });
}

// 多个跑道分支结束于同一 waypoint → merge point；公共航路入口、enroute transition 入口同样参与。
// 只按端点检测，不因 IF 记录重复出现生成重复飞行腿（去重交给 materializer）。
export function detectMergePoints(
  runwayTransitions: ProcedureTransition[],
  commonRoutes: ProcedureRoute[],
  enrouteTransitions: ProcedureTransition[],
): ProcedureMergePoint[] {
  const inbound = new Map<string, Set<string>>();
  const outbound = new Map<string, Set<string>>();
  const add = (map: Map<string, Set<string>>, fix: string | undefined, id: string) => {
    const key = String(fix ?? '').trim().toUpperCase();
    if (!key) return;
    const set = map.get(key) ?? new Set<string>();
    set.add(id);
    map.set(key, set);
  };

  for (const transition of runwayTransitions) add(inbound, transition.exitFix, transition.id);
  for (const route of commonRoutes) {
    add(outbound, route.entryFix, route.id);
    add(inbound, route.exitFix, route.id);
  }
  for (const transition of enrouteTransitions) add(outbound, transition.entryFix, transition.id);

  const fixes = new Set([...inbound.keys(), ...outbound.keys()]);
  const mergePoints: ProcedureMergePoint[] = [];
  for (const fix of fixes) {
    const inboundIds = [...(inbound.get(fix) ?? [])];
    const outboundIds = [...(outbound.get(fix) ?? [])];
    // 汇合点定义：≥2 分支汇入，或有分支汇入且有分支自此分流
    if (inboundIds.length >= 2 || (inboundIds.length >= 1 && outboundIds.length >= 1)) {
      mergePoints.push({ fix, inboundTransitionIds: inboundIds.sort(), outboundTransitionIds: outboundIds.sort() });
    }
  }
  return mergePoints.sort((a, b) => a.fix.localeCompare(b.fix));
}

function jeppesenLegToGraphLeg(leg: SimpleProcedureLeg, previous: SimpleProcedureLeg | undefined): ProcedureGraphLeg {
  const altitudeConstraint: GraphAltitudeConstraint | undefined = leg.altitudeValue === undefined && leg.altitudeUpperFt === undefined
    ? undefined
    : {
      type: leg.altitudeUpperFt !== undefined && leg.altitudeValue !== undefined
        ? 'BETWEEN'
        : leg.altitudeSign === '+'
          ? 'AT_OR_ABOVE'
          : leg.altitudeSign === '-'
            ? 'AT_OR_BELOW'
            : 'AT',
      lowerFt: leg.altitudeValue ?? null,
      upperFt: leg.altitudeUpperFt ?? (leg.altitudeSign === '-' ? leg.altitudeValue ?? null : null),
      rawText: leg.altitudeRaw ?? null,
    };

  return {
    sequence: Number(leg.sequence) || undefined,
    pathTerminator: String(leg.pathTerminator ?? '').toUpperCase(),
    fromFix: previous?.fix || null,
    toFix: leg.fix || null,
    courseMagneticDeg: leg.courseDegMag ?? null,
    turnDirection: leg.turnDirection === 'L' || leg.turnDirection === 'R' ? leg.turnDirection : null,
    altitudeConstraint,
    speedConstraint: leg.speedLimitKias ? { type: 'AT_OR_BELOW', valueKias: leg.speedLimitKias } : undefined,
    // 2P 数值不是 AIP 发布距离：只进 jeppesenDistanceNm，publishedDistanceNm 保持空
    publishedDistanceNm: null,
    jeppesenDistanceNm: leg.distanceNm ?? null,
    distanceSource: leg.distanceNm !== undefined ? 'JEPPESEN_EXTENSION' : 'UNKNOWN',
    recommendedNavaid: leg.recommendedNavaid ?? null,
    extensions: leg.extensions,
    sourceEvidence: leg.rawRecord
      ? [{ sourceType: 'JEPPESEN_424', rawText: leg.rawRecord, recordNumber: leg.sequence }]
      : [],
  };
}

function aiLegToGraphLeg(leg: Record<string, unknown>): ProcedureGraphLeg {
  const altitude = leg.altitudeConstraint as Record<string, unknown> | null | undefined;
  const altitudeConstraint: GraphAltitudeConstraint | undefined = altitude
    ? {
      type: normalizeAltitudeType(altitude.type),
      lowerFt: numberOrNull(altitude.lowerFt ?? altitude.altitudeFt),
      upperFt: numberOrNull(altitude.upperFt),
      rawText: altitude.rawText === undefined ? null : String(altitude.rawText ?? '') || null,
    }
    : undefined;
  const distanceNm = numberOrNull(leg.distanceNm);
  const speedLimit = numberOrNull(leg.speedLimitKias);
  const turn = String(leg.turnDirection ?? '');

  return {
    sequence: numberOrNull(leg.sequence) ?? undefined,
    pathTerminator: String(leg.pathTerminator ?? '').toUpperCase(),
    fromFix: leg.fromFix === undefined ? null : (stringOrNull(leg.fromFix)),
    toFix: stringOrNull(leg.fixIdentifier ?? leg.toFix),
    courseMagneticDeg: numberOrNull(leg.courseDegMag),
    turnDirection: turn === 'L' || turn === 'R' ? turn : null,
    altitudeConstraint,
    speedConstraint: speedLimit ? { type: 'AT_OR_BELOW', valueKias: speedLimit } : undefined,
    // AI 从 AIP 表格读出的距离即发布距离
    publishedDistanceNm: distanceNm,
    jeppesenDistanceNm: null,
    distanceSource: distanceNm !== null ? 'AIP_TABLE' : 'UNKNOWN',
    recommendedNavaid: stringOrNull(leg.recommendedNavaid),
    sourceEvidence: [{
      sourceType: 'AIP_LEG_TABLE',
      rawText: stringOrNull(leg.derivationMethod) ?? undefined,
    }],
    confidence: numberOrNull(leg.confidence) ?? undefined,
    inferred: String(leg.derivationMethod ?? '').startsWith('synthesized') || undefined,
  };
}

function normalizeAltitudeType(value: unknown): GraphAltitudeConstraint['type'] {
  const text = String(value ?? '').toUpperCase();
  if (text === 'AT_OR_ABOVE' || text === 'AT_OR_BELOW' || text === 'BETWEEN' || text === 'AT') return text;
  return 'NONE';
}

function branchEvidence(legs: SimpleProcedureLeg[]): GraphSourceEvidence[] {
  return legs
    .filter((leg) => leg.rawRecord)
    .map((leg) => ({ sourceType: 'JEPPESEN_424' as const, rawText: leg.rawRecord, recordNumber: leg.sequence }));
}

function firstNamedFix(legs: ProcedureGraphLeg[]) {
  for (const leg of legs) {
    // 入口锚点：IF 腿的 toFix，或首个具名 fromFix / toFix
    const candidate = leg.pathTerminator === 'IF' ? leg.toFix : (leg.fromFix || leg.toFix);
    if (candidate) return String(candidate).toUpperCase();
  }
  return undefined;
}

function lastNamedFix(legs: ProcedureGraphLeg[]) {
  for (let index = legs.length - 1; index >= 0; index -= 1) {
    const candidate = legs[index].toFix;
    if (candidate) return String(candidate).toUpperCase();
  }
  return undefined;
}

function stripTransitionSuffix(name: string) {
  return name.replace(/\s*\/\s*[A-Z0-9 -]+\s+TRANSITION$/, '').trim();
}

function firstNavigationSpec(entries: ProcedureUnderstandingProcedure[]) {
  for (const entry of entries) {
    const spec = String(entry.navigationSpec ?? '').trim();
    if (spec) return spec;
  }
  return undefined;
}

function normalizeRunwayId(value: unknown) {
  const text = String(value ?? '').trim().toUpperCase().replace(/\s+/g, '').replace(/^RWY/, 'RW');
  return text.startsWith('RW') ? text : `RW${text}`;
}

function sortTransitions(transitions: ProcedureTransition[]) {
  transitions.sort((a, b) => a.id.localeCompare(b.id));
}

function numberOrNull(value: unknown) {
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function stringOrNull(value: unknown) {
  const text = String(value ?? '').trim();
  return text ? text : null;
}
