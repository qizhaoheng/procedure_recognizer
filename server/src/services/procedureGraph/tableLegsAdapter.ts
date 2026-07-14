import type {
  ProcedureGraphLeg,
  SidProcedureGraph,
  TableLegItem,
} from '../../types/procedure';
import { materializeAllRoutes } from './materializeRoute';

// ==================== tableLegs 兼容层 ====================
// tableLegs 是废弃的扁平结构（@deprecated）：它无法表达多跑道分支、公共航路与
// enroute transition 的拓扑。新代码一律以 SidProcedureGraph 为真相来源；
// 本适配器只用于：
// 1. 旧数据（只有 tableLegs 的历史识别结果）升级为程序图；
// 2. 兼容仍读取 tableLegs 的旧展示路径（由 route instance 派生）。

/**
 * @deprecated 由程序图派生扁平 tableLegs，仅供旧展示/导出路径兼容。
 * 每条 route instance 生成一组 legs，procedureName 带上跑道/过渡以避免歧义。
 */
export function graphToTableLegs(graph: SidProcedureGraph): TableLegItem[] {
  return materializeAllRoutes(graph).flatMap((route) => {
    const suffix = [route.runway, route.enrouteTransition].filter(Boolean).join(' / ');
    const procedureName = suffix ? `${graph.procedureName} (${suffix})` : graph.procedureName;
    return route.legs.map((leg) => ({
      procedureName,
      sequence: leg.displaySequence,
      pathTerminator: leg.pathTerminator || null,
      fromFix: leg.fromFix ?? null,
      toFix: leg.toFix ?? null,
      courseDeg: leg.courseMagneticDeg ?? null,
      // 兼容字段只暴露 AIP 发布距离；供应商扩展距离不冒充发布值
      distanceNm: leg.publishedDistanceNm ?? null,
      altitudeConstraint: leg.altitudeConstraint?.rawText ?? altitudeText(leg) ?? null,
      turnDirection: leg.turnDirection ?? null,
      recommendedNavaid: leg.recommendedNavaid ?? null,
      remarks: `segment=${leg.segmentType} source=${leg.sourceTransitionId}`,
      sourcePageNo: null,
      confidence: leg.confidence ?? 0.5,
    }));
  });
}

/**
 * @deprecated 旧数据升级：把扁平 tableLegs 包装为退化的单跑道程序图。
 * 只有一条 RUNWAY_TRANSITION、无 common route、无 enroute transition，
 * builtFrom=LEGACY_TABLE_LEGS 且 warnings 标注升级来源。
 */
export function tableLegsToGraph(
  tableLegs: TableLegItem[],
  context: { airportIcao?: string | null; procedureName?: string | null; runway?: string | null },
): SidProcedureGraph {
  const legs: ProcedureGraphLeg[] = [...tableLegs]
    .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))
    .map((item) => ({
      sequence: item.sequence ?? undefined,
      pathTerminator: String(item.pathTerminator ?? '').toUpperCase(),
      fromFix: item.fromFix ?? null,
      toFix: item.toFix ?? null,
      courseMagneticDeg: item.courseDeg ?? null,
      turnDirection: item.turnDirection === 'L' || item.turnDirection === 'R' ? item.turnDirection : null,
      altitudeConstraint: item.altitudeConstraint
        ? { type: item.altitudeConstraint.trim().startsWith('+') ? 'AT_OR_ABOVE' as const : item.altitudeConstraint.trim().startsWith('-') ? 'AT_OR_BELOW' as const : 'AT' as const, rawText: item.altitudeConstraint }
        : undefined,
      publishedDistanceNm: item.distanceNm ?? null,
      jeppesenDistanceNm: null,
      distanceSource: item.distanceNm !== null && item.distanceNm !== undefined ? 'AIP_TABLE' as const : 'UNKNOWN' as const,
      recommendedNavaid: item.recommendedNavaid ?? null,
      sourceEvidence: [{
        sourceType: 'AIP_LEG_TABLE' as const,
        pageNumber: item.sourcePageNo ?? undefined,
        rawText: item.remarks ?? undefined,
      }],
      confidence: item.confidence,
    }));

  const runway = String(context.runway ?? '').trim().toUpperCase().replace(/^RWY/, 'RW') || 'RW-UNKNOWN';
  const procedureName = String(context.procedureName ?? tableLegs[0]?.procedureName ?? 'UNKNOWN').trim();

  return {
    airportIcao: String(context.airportIcao ?? ''),
    procedureType: 'SID',
    procedureId: procedureName,
    procedureName,
    sourcePages: [],
    runwayTransitions: [{
      id: runway,
      type: 'RUNWAY',
      displayName: runway,
      runway,
      entryFix: undefined,
      exitFix: [...legs].reverse().find((leg) => leg.toFix)?.toFix ?? undefined,
      legs,
      sourceEvidence: [],
    }],
    commonRoutes: [],
    enrouteTransitions: [],
    mergePoints: [],
    builtFrom: 'LEGACY_TABLE_LEGS',
    warnings: ['Upgraded from deprecated flat tableLegs; topology (branches/transitions) is not represented in the source data.'],
  };
}

function altitudeText(leg: ProcedureGraphLeg) {
  const constraint = leg.altitudeConstraint;
  if (!constraint) return null;
  if (constraint.rawText) return constraint.rawText;
  if (constraint.type === 'AT_OR_ABOVE' && constraint.lowerFt != null) return `+${constraint.lowerFt}`;
  if (constraint.type === 'AT_OR_BELOW' && constraint.upperFt != null) return `-${constraint.upperFt}`;
  if (constraint.lowerFt != null) return String(constraint.lowerFt);
  return null;
}
