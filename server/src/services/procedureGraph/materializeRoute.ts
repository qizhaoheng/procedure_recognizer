import type {
  MaterializedRoute,
  MaterializedRouteLeg,
  ProcedureGraphLeg,
  ProcedureSegmentType,
  SidProcedureGraph,
} from '../../types/procedure';

export interface MaterializeRouteInput {
  runway?: string;
  enrouteTransition?: string;
}

// 确定性航路实例化：runway transition (+ common route) (+ enroute transition) 拼成一条连续可飞航路。
// 拼接规则：
// 1. 上一段 exitFix 与下一段 entryFix 相同时直接续接；
// 2. 下一段开头的 IF 锚点腿（toFix == 已到达的 fix）只作锚点，不重复生成飞行腿；
// 3. 输出连续 displaySequence，同时保留各腿原始 sequence 与来源分段信息。
export function materializeRoute(graph: SidProcedureGraph, input: MaterializeRouteInput): MaterializedRoute {
  const warnings: string[] = [];
  const segments: Array<{ segmentType: ProcedureSegmentType; sourceTransitionId: string; legs: ProcedureGraphLeg[] }> = [];

  const runwayId = normalizeRunwayId(input.runway);
  if (runwayId) {
    const runwayTransition = graph.runwayTransitions.find((item) => runwayMatches(item.runway ?? item.id, runwayId));
    if (runwayTransition) {
      segments.push({ segmentType: 'RUNWAY_TRANSITION', sourceTransitionId: runwayTransition.id, legs: runwayTransition.legs });
    } else if (graph.runwayTransitions.length) {
      warnings.push(`Runway transition ${runwayId} not found in procedure ${graph.procedureId}.`);
    }
  } else if (graph.runwayTransitions.length === 1) {
    const only = graph.runwayTransitions[0];
    segments.push({ segmentType: 'RUNWAY_TRANSITION', sourceTransitionId: only.id, legs: only.legs });
  }

  for (const route of graph.commonRoutes) {
    segments.push({ segmentType: 'COMMON_ROUTE', sourceTransitionId: route.id, legs: route.legs });
  }

  const transitionId = String(input.enrouteTransition ?? '').trim().toUpperCase();
  if (transitionId) {
    const enroute = graph.enrouteTransitions.find((item) => item.id.toUpperCase() === transitionId);
    if (enroute) {
      segments.push({ segmentType: 'ENROUTE_TRANSITION', sourceTransitionId: enroute.id, legs: enroute.legs });
    } else {
      warnings.push(`Enroute transition ${transitionId} not found in procedure ${graph.procedureId}.`);
    }
  }

  const legs: MaterializedRouteLeg[] = [];
  const visitedFixes = new Set<string>();
  let displaySequence = 0;

  for (const segment of segments) {
    for (const leg of segment.legs) {
      const toFix = fixKey(leg.toFix);
      // IF 锚点去重：分段开头重复公共入口点（如 enroute transition 以 IF VAMOS 开头，
      // 而 runway transition 已 TF 到 VAMOS）时，该腿只是锚点，不生成飞行腿
      const isAnchorDuplicate = leg.pathTerminator === 'IF' && toFix !== '' && visitedFixes.has(toFix);
      // 同一 fix 的非 IF 重复腿（数据侧把公共点编两次）同样按语义合并
      const isRepeatedJoinFix = toFix !== ''
        && visitedFixes.has(toFix)
        && legs.length > 0
        && fixKey(legs[legs.length - 1].toFix) === toFix;
      if (isAnchorDuplicate || isRepeatedJoinFix) continue;

      displaySequence += 10;
      legs.push({
        ...leg,
        displaySequence,
        segmentType: segment.segmentType,
        sourceTransitionId: segment.sourceTransitionId,
      });
      if (toFix) visitedFixes.add(toFix);
    }
  }

  // 连续性校验：相邻分段之间 fromFix 应能接上（IF 锚点已合并，容许 DF/VA 无 fromFix）
  for (let index = 1; index < legs.length; index += 1) {
    const previous = legs[index - 1];
    const current = legs[index];
    if (current.segmentType === previous.segmentType) continue;
    const from = fixKey(current.fromFix);
    const joint = fixKey(previous.toFix);
    if (from && joint && from !== joint) {
      warnings.push(
        `Discontinuity between ${previous.sourceTransitionId} (${joint || '?'}) and ${current.sourceTransitionId} (${from}).`,
      );
    }
  }

  return {
    procedureId: graph.procedureId,
    runway: runwayId || undefined,
    enrouteTransition: transitionId || undefined,
    legs,
    warnings,
  };
}

/** 枚举全部可飞实例（跑道 × 过渡组合；无过渡时仅跑道航路）。 */
export function materializeAllRoutes(graph: SidProcedureGraph): MaterializedRoute[] {
  const runways = graph.runwayTransitions.length
    ? graph.runwayTransitions.map((item) => item.runway ?? item.id)
    : [undefined];
  const transitions = graph.enrouteTransitions.length
    ? graph.enrouteTransitions.map((item) => item.id)
    : [undefined];
  const routes: MaterializedRoute[] = [];
  for (const runway of runways) {
    for (const transition of transitions) {
      routes.push(materializeRoute(graph, { runway, enrouteTransition: transition }));
    }
  }
  return routes;
}

function runwayMatches(candidate: string | undefined, wanted: string) {
  const left = normalizeRunwayId(candidate);
  if (!left || !wanted) return false;
  if (left === wanted) return true;
  // RW16B（全部平行跑道）匹配 RW16L/RW16R/RW16C
  const leftNumber = left.match(/^RW(\d{2})B$/)?.[1];
  const wantedNumber = wanted.match(/^RW(\d{2})[LRC]?$/)?.[1];
  if (leftNumber && wantedNumber && leftNumber === wantedNumber) return true;
  const wantedGroup = wanted.match(/^RW(\d{2})B$/)?.[1];
  const leftSingle = left.match(/^RW(\d{2})[LRC]?$/)?.[1];
  return Boolean(wantedGroup && leftSingle && wantedGroup === leftSingle);
}

function normalizeRunwayId(value: unknown) {
  const text = String(value ?? '').trim().toUpperCase().replace(/\s+/g, '').replace(/^RWY/, 'RW');
  if (!text) return '';
  return text.startsWith('RW') ? text : `RW${text}`;
}

function fixKey(value: string | null | undefined) {
  return String(value ?? '').trim().toUpperCase();
}
