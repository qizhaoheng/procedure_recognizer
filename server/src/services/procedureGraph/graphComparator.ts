import type {
  ProcedureGraphLeg,
  ProcedureSegmentType,
  ProcedureTransition,
  SidProcedureGraph,
} from '../../types/procedure';
import { procedureIdsMatch } from './procedureNames';

// ==================== 四阶段程序图对比器 ====================
// 阶段 0：程序身份门槛 —— 身份不通过时禁止计算总体准确率（score = null）。
// 阶段 1：程序拓扑比较 —— 跑道过渡/公共航路/航路过渡/汇合点集合差异，独立统计覆盖率。
// 阶段 2：腿段序列比较 —— 按分支配对，序号跳号合法，IF 锚点语义合并。
// 阶段 3：字段比较 —— A 类（AIP 可识别）计分；B 类（可计算）容差单独统计；
//         C 类（Jeppesen 独有）不进分母并明确标记原因。

export type GraphCompareStatus = 'MATCHED' | 'PARTIALLY_IDENTIFIED' | 'NOT_COMPARABLE' | 'SOURCE_MISMATCH';
export type GraphOverallStatus = 'MATCHED' | 'PARTIAL_COMPARISON' | 'FULL_COMPARISON' | 'SOURCE_MISMATCH' | 'NOT_COMPARABLE';
export type FieldCategory = 'AIP_RECOGNIZABLE' | 'COMPUTED' | 'VENDOR_ONLY';

const DISTANCE_ABS_TOLERANCE_NM = 0.2;
const DISTANCE_REL_TOLERANCE = 0.02;
const COURSE_TOLERANCE_DEG = 1;
/** 无固定终点的腿：供应商 2P 距离不能倒推为 AIP 应识别字段 */
const NO_FIXED_ENDPOINT_TERMINATORS = new Set(['VA', 'CA', 'VI', 'VM', 'VD', 'VR', 'FM', 'HM']);

export interface GraphIdentitySummary {
  airportIcao?: string;
  procedureType?: string;
  procedureId?: string;
  procedureName?: string;
  runwayTransitionIds: string[];
  enrouteTransitionIds: string[];
}

export interface GraphFieldCompareResult {
  field: string;
  aiValue: unknown;
  jeppesenValue: unknown;
  category: FieldCategory;
  comparable: boolean;
  /** 不可比较时为 null */
  matched: boolean | null;
  toleranceApplied?: boolean;
  reason?: string;
}

export type GraphLegStatus = 'MATCH' | 'PARTIAL' | 'MISMATCH' | 'MISSING_AI' | 'MISSING_JEPPESEN' | 'MERGED_ANCHOR';

export interface GraphLegCompareResult {
  aiSequence?: number;
  jeppesenSequence?: number;
  pathTerminator?: string;
  toFix?: string | null;
  status: GraphLegStatus;
  fields: GraphFieldCompareResult[];
  ai?: ProcedureGraphLeg;
  jeppesen?: ProcedureGraphLeg;
}

export interface GraphBranchCompareResult {
  transitionId: string;
  displayName?: string;
  segmentType: ProcedureSegmentType;
  status: 'COMPARED' | 'MISSING_AI' | 'MISSING_JEPPESEN';
  legResults: GraphLegCompareResult[];
}

export interface GraphTopologyDiff {
  runwayTransitions: { matched: string[]; missingInAi: string[]; extraInAi: string[] };
  enrouteTransitions: { matched: string[]; missingInAi: string[]; extraInAi: string[] };
  commonRoute: { ai: boolean; jeppesen: boolean; matched: boolean };
  mergePoints: { ai: string[]; jeppesen: string[]; missingInAi: string[]; extraInAi: string[] };
  entryExitDiffs: Array<{ transitionId: string; field: 'entryFix' | 'exitFix'; aiValue?: string; jeppesenValue?: string }>;
}

export interface GraphCompareCoverage {
  comparedRunwayTransitions: string[];
  totalRunwayTransitions: number;
  comparedEnrouteTransitions: string[];
  totalEnrouteTransitions: number;
  commonRouteCompared: boolean;
  coveragePercent: number | null;
}

export interface GraphCompareScores {
  identityScore: number;
  topologyScore: number | null;
  legSequenceScore: number | null;
  comparableFieldScore: number | null;
  geometryValidationScore: number | null;
  /** 身份未通过时必须为 null */
  overallScore: number | null;
}

export interface GraphCompareResult {
  comparisonStatus: GraphCompareStatus;
  overallStatus: GraphOverallStatus;
  reason?: string;
  aiProcedure?: GraphIdentitySummary;
  jeppesenProcedure?: GraphIdentitySummary;
  topology?: GraphTopologyDiff;
  coverage?: GraphCompareCoverage;
  branches: GraphBranchCompareResult[];
  scores: GraphCompareScores;
  warnings: string[];
}

// ==================== 阶段 0：程序身份门槛 ====================

export function compareProcedureGraphs(aiGraph: SidProcedureGraph, jeppesenGraph: SidProcedureGraph | undefined): GraphCompareResult {
  const aiSummary = identitySummary(aiGraph);
  if (!jeppesenGraph) {
    return notComparable(aiSummary, undefined, `No Jeppesen 424 procedure matches AIP procedure ${aiGraph.procedureId}.`, 'SOURCE_MISMATCH');
  }
  const jeppesenSummary = identitySummary(jeppesenGraph);

  if (!procedureIdsMatch(aiGraph.procedureId, jeppesenGraph.procedureId)
    && !procedureIdsMatch(aiGraph.procedureName, jeppesenGraph.procedureName)) {
    return notComparable(
      aiSummary,
      jeppesenSummary,
      `AIP procedure ${aiGraph.procedureId} does not match Jeppesen procedure ${jeppesenGraph.procedureId}`,
      'SOURCE_MISMATCH',
    );
  }
  if (aiGraph.procedureType !== jeppesenGraph.procedureType) {
    return notComparable(
      aiSummary,
      jeppesenSummary,
      `Procedure type mismatch: AIP ${aiGraph.procedureType} vs Jeppesen ${jeppesenGraph.procedureType}.`,
      'NOT_COMPARABLE',
    );
  }
  if (aiGraph.airportIcao && jeppesenGraph.airportIcao && aiGraph.airportIcao !== jeppesenGraph.airportIcao) {
    return notComparable(
      aiSummary,
      jeppesenSummary,
      `Airport mismatch: AIP ${aiGraph.airportIcao} vs Jeppesen ${jeppesenGraph.airportIcao}.`,
      'NOT_COMPARABLE',
    );
  }
  // 跑道集合完全不相交且双方都声明了跑道 → 无明确映射，不可比较
  const aiRunways = aiGraph.runwayTransitions.map((item) => item.id);
  const jeppRunways = jeppesenGraph.runwayTransitions.map((item) => item.id);
  if (aiRunways.length && jeppRunways.length && !aiRunways.some((runway) => jeppRunways.some((other) => runwaysCompatible(runway, other)))) {
    return notComparable(
      aiSummary,
      jeppesenSummary,
      `Runway sets do not overlap: AIP [${aiRunways.join(', ')}] vs Jeppesen [${jeppRunways.join(', ')}].`,
      'NOT_COMPARABLE',
    );
  }

  const identityStatus: GraphCompareStatus = 'MATCHED';
  const identityScore = 100;
  const warnings: string[] = [];

  // ==================== 阶段 1：程序拓扑比较 ====================
  const topology = compareTopology(aiGraph, jeppesenGraph);
  const branches = compareBranches(aiGraph, jeppesenGraph);
  const coverage = buildCoverage(jeppesenGraph, branches);

  // ==================== 评分 ====================
  const topologyScore = scoreTopology(topology);
  const comparedLegResults = branches
    .filter((branch) => branch.status === 'COMPARED')
    .flatMap((branch) => branch.legResults);
  const legSequenceScore = scoreLegSequence(comparedLegResults);
  const { comparableFieldScore, geometryValidationScore } = scoreFields(comparedLegResults);

  const missingTransitions = topology.runwayTransitions.missingInAi.length + topology.enrouteTransitions.missingInAi.length;
  const partialComparison = coverage.coveragePercent !== null && coverage.coveragePercent < 100;
  let overallScore: number | null = weightedOverall(topologyScore, legSequenceScore, comparableFieldScore);
  // 拓扑缺少完整 Transition：总分封顶 80
  if (overallScore !== null && missingTransitions > 0) overallScore = Math.min(overallScore, 80);

  const overallStatus: GraphOverallStatus = partialComparison ? 'PARTIAL_COMPARISON' : 'FULL_COMPARISON';
  if (partialComparison) {
    warnings.push(
      `Only ${coverage.comparedRunwayTransitions.length}/${coverage.totalRunwayTransitions} runway transitions and `
      + `${coverage.comparedEnrouteTransitions.length}/${coverage.totalEnrouteTransitions} enroute transitions were compared.`,
    );
  }

  return {
    comparisonStatus: identityStatus,
    overallStatus,
    aiProcedure: aiSummary,
    jeppesenProcedure: jeppesenSummary,
    topology,
    coverage,
    branches,
    scores: {
      identityScore,
      topologyScore,
      legSequenceScore,
      comparableFieldScore,
      geometryValidationScore,
      overallScore,
    },
    warnings,
  };
}

/** 在多个 424 程序图中为 AI 程序图挑选身份匹配者。 */
export function findMatchingJeppesenGraph(aiGraph: SidProcedureGraph, jeppesenGraphs: SidProcedureGraph[]) {
  return jeppesenGraphs.find(
    (candidate) => procedureIdsMatch(aiGraph.procedureId, candidate.procedureId)
      || procedureIdsMatch(aiGraph.procedureName, candidate.procedureName),
  );
}

function notComparable(
  aiProcedure: GraphIdentitySummary | undefined,
  jeppesenProcedure: GraphIdentitySummary | undefined,
  reason: string,
  status: GraphCompareStatus,
): GraphCompareResult {
  return {
    comparisonStatus: status,
    overallStatus: status === 'SOURCE_MISMATCH' ? 'SOURCE_MISMATCH' : 'NOT_COMPARABLE',
    reason,
    aiProcedure,
    jeppesenProcedure,
    branches: [],
    scores: {
      identityScore: 0,
      topologyScore: null,
      legSequenceScore: null,
      comparableFieldScore: null,
      geometryValidationScore: null,
      overallScore: null,
    },
    warnings: [reason],
  };
}

function identitySummary(graph: SidProcedureGraph): GraphIdentitySummary {
  return {
    airportIcao: graph.airportIcao || undefined,
    procedureType: graph.procedureType,
    procedureId: graph.procedureId,
    procedureName: graph.procedureName,
    runwayTransitionIds: graph.runwayTransitions.map((item) => item.id),
    enrouteTransitionIds: graph.enrouteTransitions.map((item) => item.id),
  };
}

// ==================== 阶段 1：拓扑 ====================

function compareTopology(ai: SidProcedureGraph, jeppesen: SidProcedureGraph): GraphTopologyDiff {
  const runwayPairs = pairTransitions(ai.runwayTransitions, jeppesen.runwayTransitions);
  const enroutePairs = pairTransitions(ai.enrouteTransitions, jeppesen.enrouteTransitions);
  const aiMerge = ai.mergePoints.map((item) => item.fix);
  const jeppMerge = jeppesen.mergePoints.map((item) => item.fix);

  const entryExitDiffs: GraphTopologyDiff['entryExitDiffs'] = [];
  for (const pair of [...runwayPairs.matchedPairs, ...enroutePairs.matchedPairs]) {
    for (const field of ['entryFix', 'exitFix'] as const) {
      const aiValue = pair.ai[field]?.toUpperCase();
      const jeppValue = pair.jeppesen[field]?.toUpperCase();
      if (aiValue !== jeppValue) {
        entryExitDiffs.push({ transitionId: pair.jeppesen.id, field, aiValue, jeppesenValue: jeppValue });
      }
    }
  }

  return {
    runwayTransitions: {
      matched: runwayPairs.matchedPairs.map((pair) => pair.jeppesen.id),
      missingInAi: runwayPairs.missingInAi,
      extraInAi: runwayPairs.extraInAi,
    },
    enrouteTransitions: {
      matched: enroutePairs.matchedPairs.map((pair) => pair.jeppesen.id),
      missingInAi: enroutePairs.missingInAi,
      extraInAi: enroutePairs.extraInAi,
    },
    commonRoute: {
      ai: ai.commonRoutes.length > 0,
      jeppesen: jeppesen.commonRoutes.length > 0,
      matched: (ai.commonRoutes.length > 0) === (jeppesen.commonRoutes.length > 0),
    },
    mergePoints: {
      ai: aiMerge,
      jeppesen: jeppMerge,
      missingInAi: jeppMerge.filter((fix) => !aiMerge.includes(fix)),
      extraInAi: aiMerge.filter((fix) => !jeppMerge.includes(fix)),
    },
    entryExitDiffs,
  };
}

function pairTransitions(aiTransitions: ProcedureTransition[], jeppesenTransitions: ProcedureTransition[]) {
  const matchedPairs: Array<{ ai: ProcedureTransition; jeppesen: ProcedureTransition }> = [];
  const usedAi = new Set<string>();
  const missingInAi: string[] = [];
  for (const jeppesen of jeppesenTransitions) {
    const ai = aiTransitions.find((candidate) => !usedAi.has(candidate.id) && transitionIdsMatch(candidate, jeppesen));
    if (ai) {
      usedAi.add(ai.id);
      matchedPairs.push({ ai, jeppesen });
    } else {
      missingInAi.push(jeppesen.id);
    }
  }
  const extraInAi = aiTransitions.filter((item) => !usedAi.has(item.id)).map((item) => item.id);
  return { matchedPairs, missingInAi, extraInAi };
}

function transitionIdsMatch(a: ProcedureTransition, b: ProcedureTransition) {
  if (a.type !== b.type) return false;
  if (a.type === 'RUNWAY') return runwaysCompatible(a.runway ?? a.id, b.runway ?? b.id);
  const left = a.id.trim().toUpperCase();
  const right = b.id.trim().toUpperCase();
  // 424 过渡标识 5 字符截断：TATEY vs TATEYAMA
  return left === right || left.startsWith(right) || right.startsWith(left);
}

function runwaysCompatible(a: string | undefined, b: string | undefined) {
  const left = normalizeRunwayId(a);
  const right = normalizeRunwayId(b);
  if (!left || !right) return false;
  if (left === right) return true;
  const leftParts = left.match(/^RW(\d{2})([LRCB]?)$/);
  const rightParts = right.match(/^RW(\d{2})([LRCB]?)$/);
  if (!leftParts || !rightParts) return false;
  if (leftParts[1] !== rightParts[1]) return false;
  // B = 全部平行跑道
  return leftParts[2] === 'B' || rightParts[2] === 'B' || leftParts[2] === rightParts[2];
}

function normalizeRunwayId(value: unknown) {
  const text = String(value ?? '').trim().toUpperCase().replace(/\s+/g, '').replace(/^RWY/, 'RW');
  if (!text) return '';
  return text.startsWith('RW') ? text : `RW${text}`;
}

// ==================== 阶段 2：腿段序列 ====================

function compareBranches(ai: SidProcedureGraph, jeppesen: SidProcedureGraph): GraphBranchCompareResult[] {
  const results: GraphBranchCompareResult[] = [];
  const runwayPairs = pairTransitions(ai.runwayTransitions, jeppesen.runwayTransitions);
  const enroutePairs = pairTransitions(ai.enrouteTransitions, jeppesen.enrouteTransitions);

  for (const pair of runwayPairs.matchedPairs) {
    results.push({
      transitionId: pair.jeppesen.id,
      displayName: pair.jeppesen.displayName ?? pair.ai.displayName,
      segmentType: 'RUNWAY_TRANSITION',
      status: 'COMPARED',
      legResults: compareLegSequences(pair.ai.legs, pair.jeppesen.legs, pair.ai.entryFix),
    });
  }
  for (const id of runwayPairs.missingInAi) {
    const branch = jeppesen.runwayTransitions.find((item) => item.id === id)!;
    results.push({
      transitionId: id,
      displayName: branch.displayName,
      segmentType: 'RUNWAY_TRANSITION',
      status: 'MISSING_AI',
      legResults: branch.legs.map((leg) => missingLegResult(leg, 'MISSING_AI')),
    });
  }
  for (const id of runwayPairs.extraInAi) {
    const branch = ai.runwayTransitions.find((item) => item.id === id)!;
    results.push({
      transitionId: id,
      displayName: branch.displayName,
      segmentType: 'RUNWAY_TRANSITION',
      status: 'MISSING_JEPPESEN',
      legResults: branch.legs.map((leg) => missingLegResult(leg, 'MISSING_JEPPESEN')),
    });
  }

  // 公共航路：双方都有才逐腿对比；一方缺失时按拓扑差异呈现
  if (ai.commonRoutes.length && jeppesen.commonRoutes.length) {
    results.push({
      transitionId: jeppesen.commonRoutes[0].id,
      segmentType: 'COMMON_ROUTE',
      status: 'COMPARED',
      legResults: compareLegSequences(ai.commonRoutes[0].legs, jeppesen.commonRoutes[0].legs, ai.commonRoutes[0].entryFix),
    });
  } else if (jeppesen.commonRoutes.length) {
    results.push({
      transitionId: jeppesen.commonRoutes[0].id,
      segmentType: 'COMMON_ROUTE',
      status: 'MISSING_AI',
      legResults: jeppesen.commonRoutes[0].legs.map((leg) => missingLegResult(leg, 'MISSING_AI')),
    });
  } else if (ai.commonRoutes.length) {
    results.push({
      transitionId: ai.commonRoutes[0].id,
      segmentType: 'COMMON_ROUTE',
      status: 'MISSING_JEPPESEN',
      legResults: ai.commonRoutes[0].legs.map((leg) => missingLegResult(leg, 'MISSING_JEPPESEN')),
    });
  }

  for (const pair of enroutePairs.matchedPairs) {
    results.push({
      transitionId: pair.jeppesen.id,
      displayName: pair.jeppesen.displayName ?? pair.ai.displayName,
      segmentType: 'ENROUTE_TRANSITION',
      status: 'COMPARED',
      legResults: compareLegSequences(pair.ai.legs, pair.jeppesen.legs, pair.ai.entryFix),
    });
  }
  for (const id of enroutePairs.missingInAi) {
    const branch = jeppesen.enrouteTransitions.find((item) => item.id === id)!;
    results.push({
      transitionId: id,
      displayName: branch.displayName,
      segmentType: 'ENROUTE_TRANSITION',
      status: 'MISSING_AI',
      legResults: branch.legs.map((leg) => missingLegResult(leg, 'MISSING_AI')),
    });
  }
  for (const id of enroutePairs.extraInAi) {
    const branch = ai.enrouteTransitions.find((item) => item.id === id)!;
    results.push({
      transitionId: id,
      displayName: branch.displayName,
      segmentType: 'ENROUTE_TRANSITION',
      status: 'MISSING_JEPPESEN',
      legResults: branch.legs.map((leg) => missingLegResult(leg, 'MISSING_JEPPESEN')),
    });
  }

  return results;
}

function missingLegResult(leg: ProcedureGraphLeg, status: 'MISSING_AI' | 'MISSING_JEPPESEN'): GraphLegCompareResult {
  return {
    aiSequence: status === 'MISSING_JEPPESEN' ? leg.sequence : undefined,
    jeppesenSequence: status === 'MISSING_AI' ? leg.sequence : undefined,
    pathTerminator: leg.pathTerminator,
    toFix: leg.toFix,
    status,
    fields: [],
    ai: status === 'MISSING_JEPPESEN' ? leg : undefined,
    jeppesen: status === 'MISSING_AI' ? leg : undefined,
  };
}

// 腿段对齐优先级：pathTerminator + toFix 语义配对（Needleman-Wunsch），
// sequence 只作平分决胜——序号跳号（010→020→070）不产生缺腿。
function compareLegSequences(
  aiLegs: ProcedureGraphLeg[],
  jeppesenLegs: ProcedureGraphLeg[],
  branchEntryFix: string | undefined,
): GraphLegCompareResult[] {
  const aligned = alignLegs(aiLegs, jeppesenLegs);
  const results: GraphLegCompareResult[] = [];

  for (const { ai, jeppesen } of aligned) {
    if (ai && jeppesen) {
      results.push(compareLegFields(ai, jeppesen));
      continue;
    }
    // IF 锚点语义合并：分段开头的 IF 只是重复上一分段末端 fix 的锚点。
    // 一侧编了 IF 锚点、另一侧直接从首飞行腿开始时，不判缺腿。
    const only = (ai ?? jeppesen)!;
    const isAnchor = only.pathTerminator === 'IF'
      && fixKey(only.toFix) !== ''
      && (fixKey(only.toFix) === fixKey(branchEntryFix) || results.length === 0);
    if (isAnchor) {
      results.push({
        aiSequence: ai?.sequence,
        jeppesenSequence: jeppesen?.sequence,
        pathTerminator: only.pathTerminator,
        toFix: only.toFix,
        status: 'MERGED_ANCHOR',
        fields: [],
        ai,
        jeppesen,
      });
      continue;
    }
    results.push(missingLegResult(only, ai ? 'MISSING_JEPPESEN' : 'MISSING_AI'));
  }
  return results;
}

function alignLegs(aiLegs: ProcedureGraphLeg[], jeppesenLegs: ProcedureGraphLeg[]) {
  const rows = aiLegs.length + 1;
  const cols = jeppesenLegs.length + 1;
  const score = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
  const move = Array.from({ length: rows }, () => new Array<'PAIR' | 'AI' | 'JEPP'>(cols).fill('PAIR'));
  const gapPenalty = -2;
  for (let i = 1; i < rows; i += 1) { score[i][0] = i * gapPenalty; move[i][0] = 'AI'; }
  for (let j = 1; j < cols; j += 1) { score[0][j] = j * gapPenalty; move[0][j] = 'JEPP'; }
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const pair = score[i - 1][j - 1] + legAffinity(aiLegs[i - 1], jeppesenLegs[j - 1]);
      const skipAi = score[i - 1][j] + gapPenalty;
      const skipJepp = score[i][j - 1] + gapPenalty;
      if (pair >= skipAi && pair >= skipJepp) { score[i][j] = pair; move[i][j] = 'PAIR'; }
      else if (skipAi >= skipJepp) { score[i][j] = skipAi; move[i][j] = 'AI'; }
      else { score[i][j] = skipJepp; move[i][j] = 'JEPP'; }
    }
  }
  const aligned: Array<{ ai?: ProcedureGraphLeg; jeppesen?: ProcedureGraphLeg }> = [];
  let i = aiLegs.length;
  let j = jeppesenLegs.length;
  while (i > 0 || j > 0) {
    const selected = move[i][j];
    if (i > 0 && j > 0 && selected === 'PAIR') { aligned.push({ ai: aiLegs[i - 1], jeppesen: jeppesenLegs[j - 1] }); i -= 1; j -= 1; }
    else if (i > 0 && (j === 0 || selected === 'AI')) { aligned.push({ ai: aiLegs[i - 1] }); i -= 1; }
    else { aligned.push({ jeppesen: jeppesenLegs[j - 1] }); j -= 1; }
  }
  return aligned.reverse();
}

function legAffinity(ai: ProcedureGraphLeg, jeppesen: ProcedureGraphLeg) {
  const aiFix = fixKey(ai.toFix);
  const jeppFix = fixKey(jeppesen.toFix);
  let score = aiFix && aiFix === jeppFix ? 4 : (!aiFix && !jeppFix ? 1 : -3);
  score += ai.pathTerminator && ai.pathTerminator === jeppesen.pathTerminator ? 2 : -1;
  if (ai.sequence !== undefined && ai.sequence === jeppesen.sequence) score += 1;
  return score;
}

// ==================== 阶段 3：字段比较 ====================

function compareLegFields(ai: ProcedureGraphLeg, jeppesen: ProcedureGraphLeg): GraphLegCompareResult {
  const fields: GraphFieldCompareResult[] = [];
  const pathTerminator = jeppesen.pathTerminator || ai.pathTerminator;

  fields.push(fieldResult('pathTerminator', ai.pathTerminator, jeppesen.pathTerminator, 'AIP_RECOGNIZABLE', sameText(ai.pathTerminator, jeppesen.pathTerminator)));
  fields.push(fieldResult('toFix', ai.toFix, jeppesen.toFix, 'AIP_RECOGNIZABLE', sameOptionalText(ai.toFix, jeppesen.toFix)));

  // course：424 只在编码了航向的腿（VA/CA/CI/CF/FM 等）上有值；424 空值时 AI 有值不判错
  if (jeppesen.courseMagneticDeg != null) {
    fields.push(fieldResult(
      'courseMagneticDeg',
      ai.courseMagneticDeg,
      jeppesen.courseMagneticDeg,
      'AIP_RECOGNIZABLE',
      courseClose(ai.courseMagneticDeg, jeppesen.courseMagneticDeg),
    ));
  } else if (ai.courseMagneticDeg != null) {
    fields.push(uncomparableField('courseMagneticDeg', ai.courseMagneticDeg, null, 'Jeppesen does not code a course on this leg type.'));
  }

  fields.push(fieldResult('turnDirection', ai.turnDirection ?? null, jeppesen.turnDirection ?? null, 'AIP_RECOGNIZABLE', sameOptionalText(ai.turnDirection, jeppesen.turnDirection)));
  fields.push(compareAltitude(ai, jeppesen));
  if (jeppesen.speedConstraint?.valueKias != null || ai.speedConstraint?.valueKias != null) {
    fields.push(fieldResult(
      'speedLimitKias',
      ai.speedConstraint?.valueKias ?? null,
      jeppesen.speedConstraint?.valueKias ?? null,
      'AIP_RECOGNIZABLE',
      (ai.speedConstraint?.valueKias ?? null) === (jeppesen.speedConstraint?.valueKias ?? null),
    ));
  }
  fields.push(compareDistance(ai, jeppesen, String(pathTerminator ?? '').toUpperCase()));

  const comparableFields = fields.filter((field) => field.comparable);
  const matchedCount = comparableFields.filter((field) => field.matched === true).length;
  const status: GraphLegStatus = comparableFields.length === 0
    ? 'MATCH'
    : matchedCount === comparableFields.length
      ? 'MATCH'
      : matchedCount > 0
        ? 'PARTIAL'
        : 'MISMATCH';

  return {
    aiSequence: ai.sequence,
    jeppesenSequence: jeppesen.sequence,
    pathTerminator: pathTerminator,
    toFix: jeppesen.toFix ?? ai.toFix,
    status,
    fields,
    ai,
    jeppesen,
  };
}

// 距离三源规则：
// - AIP 发布距离（AI publishedDistanceNm）是 A 类可识别字段；
// - Jeppesen 2P 值（jeppesenDistanceNm）是 C 类供应商扩展，默认不计入 AIP 识别准确率；
// - 双方都有值时按容差（0.2NM 或 2%）对比；
// - VA/CA/VI/VM 等无固定终点腿、以及 AIP 未发布距离的 DF：AI 空值不判错。
function compareDistance(ai: ProcedureGraphLeg, jeppesen: ProcedureGraphLeg, pathTerminator: string): GraphFieldCompareResult {
  const aiPublished = ai.publishedDistanceNm ?? null;
  const jeppesenVendor = jeppesen.jeppesenDistanceNm ?? null;

  if (NO_FIXED_ENDPOINT_TERMINATORS.has(pathTerminator)) {
    return uncomparableField(
      'distanceNm',
      aiPublished,
      jeppesenVendor,
      `${pathTerminator} legs have no fixed endpoint; the Jeppesen 2P value is not an AIP published distance.`,
    );
  }
  // A DF leg's endpoint may be published while its along-track distance is not.
  // Treat an absent AIP distance as non-comparable even when a supplier's 2P
  // continuation was omitted during graph normalization.
  if (pathTerminator === 'DF' && aiPublished == null) {
    return uncomparableField(
      'distanceNm',
      null,
      jeppesenVendor,
      'AIP does not publish a distance for this DF leg; any Jeppesen extension is vendor-only.',
    );
  }
  if (aiPublished == null && jeppesenVendor != null) {
    return uncomparableField(
      'distanceNm',
      null,
      jeppesenVendor,
      'Field exists only in Jeppesen extension (2P continuation); AIP does not publish a distance for this leg.',
    );
  }
  if (aiPublished == null && jeppesenVendor == null) {
    return fieldResult('distanceNm', null, null, 'AIP_RECOGNIZABLE', true);
  }
  if (aiPublished != null && jeppesenVendor == null) {
    // AI 输出了 AIP 和 Jeppesen 都不存在的值 → 判错（虚构值）
    return { ...fieldResult('distanceNm', aiPublished, null, 'AIP_RECOGNIZABLE', false), reason: 'AI reported a distance that neither AIP-aligned 424 nor Jeppesen carries.' };
  }
  const matched = distanceClose(aiPublished!, jeppesenVendor!);
  return {
    ...fieldResult('distanceNm', aiPublished, jeppesenVendor, 'AIP_RECOGNIZABLE', matched),
    toleranceApplied: matched && aiPublished !== jeppesenVendor,
  };
}

function compareAltitude(ai: ProcedureGraphLeg, jeppesen: ProcedureGraphLeg): GraphFieldCompareResult {
  const aiAlt = ai.altitudeConstraint;
  const jeppAlt = jeppesen.altitudeConstraint;
  const aiText = aiAlt ? `${aiAlt.type}:${aiAlt.lowerFt ?? ''}:${aiAlt.upperFt ?? ''}` : '';
  const jeppText = jeppAlt ? `${jeppAlt.type}:${jeppAlt.lowerFt ?? ''}:${jeppAlt.upperFt ?? ''}` : '';
  return fieldResult('altitudeConstraint', aiAlt?.rawText ?? (aiText || null), jeppAlt?.rawText ?? (jeppText || null), 'AIP_RECOGNIZABLE', aiText === jeppText);
}

function fieldResult(field: string, aiValue: unknown, jeppesenValue: unknown, category: FieldCategory, matched: boolean): GraphFieldCompareResult {
  return { field, aiValue, jeppesenValue, category, comparable: true, matched };
}

function uncomparableField(field: string, aiValue: unknown, jeppesenValue: unknown, reason: string): GraphFieldCompareResult {
  return { field, aiValue, jeppesenValue, category: 'VENDOR_ONLY', comparable: false, matched: null, reason };
}

// ==================== 评分 ====================

function scoreTopology(topology: GraphTopologyDiff): number | null {
  const total = topology.runwayTransitions.matched.length
    + topology.runwayTransitions.missingInAi.length
    + topology.runwayTransitions.extraInAi.length
    + topology.enrouteTransitions.matched.length
    + topology.enrouteTransitions.missingInAi.length
    + topology.enrouteTransitions.extraInAi.length;
  if (!total) return null;
  const matched = topology.runwayTransitions.matched.length + topology.enrouteTransitions.matched.length;
  return roundScore((matched / total) * 100);
}

function scoreLegSequence(legResults: GraphLegCompareResult[]): number | null {
  const relevant = legResults.filter((result) => result.status !== 'MERGED_ANCHOR');
  if (!relevant.length) return null;
  const aligned = relevant.filter((result) => result.status !== 'MISSING_AI' && result.status !== 'MISSING_JEPPESEN').length;
  return roundScore((aligned / relevant.length) * 100);
}

function scoreFields(legResults: GraphLegCompareResult[]) {
  const allFields = legResults.flatMap((result) => result.fields);
  const comparable = allFields.filter((field) => field.comparable && field.category === 'AIP_RECOGNIZABLE');
  const computed = allFields.filter((field) => field.comparable && field.category === 'COMPUTED');
  return {
    comparableFieldScore: comparable.length
      ? roundScore((comparable.filter((field) => field.matched === true).length / comparable.length) * 100)
      : null,
    geometryValidationScore: computed.length
      ? roundScore((computed.filter((field) => field.matched === true).length / computed.length) * 100)
      : null,
  };
}

function weightedOverall(topologyScore: number | null, legSequenceScore: number | null, comparableFieldScore: number | null) {
  const parts = [
    { score: topologyScore, weight: 0.3 },
    { score: legSequenceScore, weight: 0.3 },
    { score: comparableFieldScore, weight: 0.4 },
  ].filter((part): part is { score: number; weight: number } => part.score !== null);
  if (!parts.length) return null;
  const totalWeight = parts.reduce((sum, part) => sum + part.weight, 0);
  return roundScore(parts.reduce((sum, part) => sum + part.score * part.weight, 0) / totalWeight);
}

function buildCoverage(jeppesen: SidProcedureGraph, branches: GraphBranchCompareResult[]): GraphCompareCoverage {
  const comparedRunway = branches
    .filter((branch) => branch.segmentType === 'RUNWAY_TRANSITION' && branch.status === 'COMPARED')
    .map((branch) => branch.transitionId);
  const comparedEnroute = branches
    .filter((branch) => branch.segmentType === 'ENROUTE_TRANSITION' && branch.status === 'COMPARED')
    .map((branch) => branch.transitionId);
  const totalRunway = jeppesen.runwayTransitions.length;
  const totalEnroute = jeppesen.enrouteTransitions.length;
  const total = totalRunway + totalEnroute;
  return {
    comparedRunwayTransitions: comparedRunway,
    totalRunwayTransitions: totalRunway,
    comparedEnrouteTransitions: comparedEnroute,
    totalEnrouteTransitions: totalEnroute,
    commonRouteCompared: branches.some((branch) => branch.segmentType === 'COMMON_ROUTE' && branch.status === 'COMPARED'),
    coveragePercent: total ? roundScore(((comparedRunway.length + comparedEnroute.length) / total) * 100) : null,
  };
}

// ==================== 工具 ====================

function distanceClose(a: number, b: number) {
  const absDiff = Math.abs(a - b);
  if (absDiff <= DISTANCE_ABS_TOLERANCE_NM) return true;
  const reference = Math.max(Math.abs(a), Math.abs(b));
  return reference > 0 && absDiff / reference <= DISTANCE_REL_TOLERANCE;
}

function courseClose(a: number | null | undefined, b: number | null | undefined) {
  if (a == null || b == null) return a == null && b == null;
  const diff = Math.abs(a - b) % 360;
  return Math.min(diff, 360 - diff) <= COURSE_TOLERANCE_DEG;
}

function sameText(a: unknown, b: unknown) {
  return String(a ?? '').trim().toUpperCase() === String(b ?? '').trim().toUpperCase();
}

function sameOptionalText(a: unknown, b: unknown) {
  const left = String(a ?? '').trim().toUpperCase();
  const right = String(b ?? '').trim().toUpperCase();
  if (!left && !right) return true;
  return left === right;
}

function fixKey(value: string | null | undefined) {
  return String(value ?? '').trim().toUpperCase();
}

function roundScore(value: number) {
  return Math.round(value * 10) / 10;
}
