import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifyPage } from '../pageClassifier';
import { groupProcedurePackages } from '../procedurePackageGrouper';
import { parseJeppesen424Text } from '../jeppesen424/jeppesen424TextParser';
import { buildGraphsFromJeppesenLegs, buildGraphsFromUnderstanding, detectMergePoints } from '../procedureGraph/buildProcedureGraph';
import { materializeRoute } from '../procedureGraph/materializeRoute';
import { compareProcedureGraphs, findMatchingJeppesenGraph } from '../procedureGraph/graphComparator';
import { graphToTableLegs, tableLegsToGraph } from '../procedureGraph/tableLegsAdapter';
import { normalizeProcedureName, normalizeTransitionId, procedureIdsMatch } from '../procedureGraph/procedureNames';
import type { ProcedureUnderstandingResult, SidProcedureGraph } from '../../types/procedure';

// 所有测试用通用规则驱动：构图/物化/对比逻辑不含任何机场或程序的硬编码；
// VAMOS FOUR / RUTAS FOUR 只作为验收 fixture 数据出现（十三、十四节验收）。

// ---------- 定宽 424 记录构造器（列位与 jeppesen424TextParser 一致） ----------

interface Record424Spec {
  airport?: string;
  code: string;
  routeType: string;
  qualifier: string;
  seq: string;
  fix?: string;
  fixRegion?: string;
  fixSection?: string;
  continuation: '1' | '2';
  wpDesc?: string;
  turn?: string;
  pathTerminator?: string;
  courseTimes10?: string;
  distanceTimes10?: string;
  altDesc?: string;
  altitude?: string;
}

function record424(spec: Record424Spec) {
  const chars: string[] = new Array(132).fill(' ');
  const put = (start: number, text: string) => {
    for (let index = 0; index < text.length; index += 1) chars[start + index] = text[index];
  };
  put(0, 'SPACP');
  put(6, spec.airport ?? 'RJTT');
  put(10, 'RJ');
  put(12, 'D');
  put(13, spec.code.padEnd(6));
  put(19, spec.routeType);
  put(20, spec.qualifier.padEnd(5));
  put(26, spec.seq);
  put(29, (spec.fix ?? '').padEnd(5));
  if (spec.fix) {
    put(34, spec.fixRegion ?? 'RJ');
    put(36, spec.fixSection ?? 'PC');
  }
  put(38, spec.continuation);
  if (spec.continuation === '2') put(39, 'P');
  else if (spec.wpDesc) put(39, spec.wpDesc);
  if (spec.turn) put(43, spec.turn);
  if (spec.pathTerminator) put(47, spec.pathTerminator);
  if (spec.courseTimes10) put(70, spec.courseTimes10);
  if (spec.distanceTimes10) put(74, spec.distanceTimes10);
  if (spec.altDesc) put(82, spec.altDesc);
  if (spec.altitude) put(84, spec.altitude);
  put(123, '590322411');
  return chars.join('');
}

// VAMOS4：RW16R 跑道过渡（VA→DF→TF）+ DRAKY / TATEY 两条航路过渡（验收数据，十三节）
const vamos4Text = [
  // RW16R runway transition (RNAV SID route type 4)
  record424({ code: 'VAMOS4', routeType: '4', qualifier: 'RW16R', seq: '010', continuation: '1', wpDesc: 'E', pathTerminator: 'VA', courseTimes10: '1580', altDesc: '+', altitude: '00500' }),
  record424({ code: 'VAMOS4', routeType: '4', qualifier: 'RW16R', seq: '010', continuation: '2', distanceTimes10: '0010' }),
  record424({ code: 'VAMOS4', routeType: '4', qualifier: 'RW16R', seq: '020', fix: 'T6R11', continuation: '1', wpDesc: 'E', pathTerminator: 'DF' }),
  record424({ code: 'VAMOS4', routeType: '4', qualifier: 'RW16R', seq: '020', fix: 'T6R11', continuation: '2', distanceTimes10: '0080' }),
  record424({ code: 'VAMOS4', routeType: '4', qualifier: 'RW16R', seq: '030', fix: 'VAMOS', fixSection: 'EA', continuation: '1', wpDesc: 'EE', pathTerminator: 'TF', altDesc: '+', altitude: '09000' }),
  record424({ code: 'VAMOS4', routeType: '4', qualifier: 'RW16R', seq: '030', fix: 'VAMOS', continuation: '2', distanceTimes10: '0145' }),
  // DRAKY enroute transition (route type 3): IF 锚点重复公共入口 VAMOS
  record424({ code: 'VAMOS4', routeType: '3', qualifier: 'DRAKY', seq: '010', fix: 'VAMOS', fixSection: 'EA', continuation: '1', wpDesc: 'E', pathTerminator: 'IF' }),
  record424({ code: 'VAMOS4', routeType: '3', qualifier: 'DRAKY', seq: '015', fix: 'DRAKY', fixSection: 'EA', continuation: '1', wpDesc: 'E', pathTerminator: 'TF' }),
  record424({ code: 'VAMOS4', routeType: '3', qualifier: 'DRAKY', seq: '015', fix: 'DRAKY', continuation: '2', distanceTimes10: '0222' }),
  record424({ code: 'VAMOS4', routeType: '3', qualifier: 'DRAKY', seq: '020', fix: 'XAC', fixSection: 'D ', continuation: '1', wpDesc: 'VE', pathTerminator: 'TF' }),
  record424({ code: 'VAMOS4', routeType: '3', qualifier: 'DRAKY', seq: '020', fix: 'XAC', continuation: '2', distanceTimes10: '0119' }),
  // TATEYAMA transition：424 标识截断为 TATEY，不存在 TATEYAMA waypoint
  record424({ code: 'VAMOS4', routeType: '3', qualifier: 'TATEY', seq: '010', fix: 'VAMOS', fixSection: 'EA', continuation: '1', wpDesc: 'E', pathTerminator: 'IF' }),
  record424({ code: 'VAMOS4', routeType: '3', qualifier: 'TATEY', seq: '020', fix: 'UTIBO', fixSection: 'EA', continuation: '1', wpDesc: 'EE', pathTerminator: 'TF' }),
].join('\n');

function parseVamos4Graph(): SidProcedureGraph {
  const legs = parseJeppesen424Text(vamos4Text);
  const graphs = buildGraphsFromJeppesenLegs(legs, 'RJTT');
  assert.equal(graphs.length, 1);
  return graphs[0];
}

// ==================== 1. 程序名称标准化 ====================

describe('procedure name normalization', () => {
  it('normalizes word-form and compact designators', () => {
    assert.equal(normalizeProcedureName('VAMOS FOUR DEPARTURE'), 'VAMOS4');
    assert.equal(normalizeProcedureName('RUTAS FOUR DEPARTURE'), 'RUTAS4');
    assert.equal(normalizeProcedureName('TIARA TWO A DEPARTURE'), 'TIARA2A');
    assert.equal(normalizeProcedureName('LARIT 1T RWY 07C'), 'LARIT1T');
    assert.equal(normalizeProcedureName('GUKDO 1A'), 'GUKDO1A');
  });

  it('returns undefined instead of guessing when no designator structure exists', () => {
    assert.equal(normalizeProcedureName('VAMOS'), undefined);
    assert.equal(normalizeProcedureName('SOME RANDOM NOTE'), undefined);
  });

  it('normalizes transition names to 5-char identifiers and never treats them as waypoints', () => {
    assert.equal(normalizeTransitionId('TATEYAMA TRANSITION'), 'TATEY');
    assert.equal(normalizeTransitionId('DRAKY TRANSITION'), 'DRAKY');
  });

  it('matches truncated 424 identifiers against full display identifiers', () => {
    assert.ok(procedureIdsMatch('TIARA TWO A DEPARTURE', 'TIAR2A'));
    assert.ok(procedureIdsMatch('VAMOS FOUR DEPARTURE', 'VAMOS4'));
    assert.ok(!procedureIdsMatch('RUTAS FOUR DEPARTURE', 'VAMOS4'));
  });
});

// ==================== 2. RUTAS/VAMOS 页面分组（十四节验收） ====================

describe('page grouping keeps waypoint labels out of procedure identity', () => {
  const vamosPageText = [
    'VAMOS',
    'RNAV1',
    'VAMOS FOUR DEPARTURE',
    'STANDARD DEPARTURE CHART-INSTRUMENT',
    'RNAV SID',
    'ZZZZ/TESTVILLE INTL',
    'RWY 16R',
    'AD 2-ZZZZ-6-1',
  ].join('\n');
  // RUTAS FOUR 页面：图面上最大的航路点标签是 VAMOS，但正式标题是 RUTAS FOUR DEPARTURE
  const rutasPageText = [
    'VAMOS',
    'UTIBO',
    'RUTAS',
    'RUTAS FOUR DEPARTURE',
    'STANDARD DEPARTURE CHART-INSTRUMENT',
    'RNAV SID',
    'ZZZZ/TESTVILLE INTL',
    'RWY 16R',
    'AD 2-ZZZZ-6-3',
  ].join('\n');

  const vamosPage = classifyPage(1, vamosPageText);
  const rutasPage = classifyPage(2, rutasPageText);

  it('confirms the procedure name from the title block, not the biggest waypoint', () => {
    assert.equal(vamosPage.pageClassification?.confirmedProcedureName, 'VAMOS FOUR DEPARTURE');
    assert.equal(vamosPage.pageClassification?.procedureIdCandidate, 'VAMOS4');
    assert.equal(rutasPage.pageClassification?.confirmedProcedureName, 'RUTAS FOUR DEPARTURE');
    assert.equal(rutasPage.pageClassification?.procedureIdCandidate, 'RUTAS4');
  });

  it('never groups the RUTAS FOUR page into the VAMOS FOUR package', () => {
    const packages = groupProcedurePackages([vamosPage, rutasPage]);
    assert.equal(packages.length, 2);
    const rutasPackage = packages.find((item) => item.procedureNames.includes('RUTAS FOUR DEPARTURE'));
    const vamosPackage = packages.find((item) => item.procedureNames.includes('VAMOS FOUR DEPARTURE'));
    assert.ok(rutasPackage, 'RUTAS FOUR package missing');
    assert.ok(vamosPackage, 'VAMOS FOUR package missing');
    assert.deepEqual(rutasPackage!.chartPages, [2]);
    assert.deepEqual(vamosPackage!.chartPages, [1]);
  });

  it('collects transition names separately and never confirms them as procedure names', () => {
    const transitionPage = classifyPage(3, [
      'TATEYAMA TRANSITION',
      'DRAKY TRANSITION',
      'VAMOS FOUR DEPARTURE',
      'STANDARD DEPARTURE CHART-INSTRUMENT',
      'AD 2-ZZZZ-6-2',
    ].join('\n'));
    assert.deepEqual([...(transitionPage.pageClassification?.transitionNames ?? [])].sort(), ['DRAKY', 'TATEYAMA']);
    assert.equal(transitionPage.pageClassification?.confirmedProcedureName, 'VAMOS FOUR DEPARTURE');
  });
});

// ==================== 3-6. 424 分组 / continuation / 2P / 图构建 ====================

describe('Jeppesen 424 branch grouping and continuation records', () => {
  const legs = parseJeppesen424Text(vamos4Text);

  it('groups runway and enroute transition records by role', () => {
    assert.deepEqual(
      [...new Set(legs.map((leg) => `${leg.branchRole}|${leg.runway || leg.transitionName || ''}`))].sort(),
      ['ENROUTE|DRAKY', 'ENROUTE|TATEY', 'RUNWAY|RW16R'],
    );
  });

  it('merges 1E + 2P continuation records into one leg and keeps the raw extension', () => {
    const dfLeg = legs.find((leg) => leg.pathTerminator === 'DF');
    assert.ok(dfLeg);
    assert.equal(dfLeg!.fix, 'T6R11');
    assert.equal(dfLeg!.distanceNm, 8);
    const extension = dfLeg!.extensions?.find((item) => item.continuationType === '2P');
    assert.ok(extension, '2P extension missing');
    assert.equal(extension!.interpretedAs, 'DISTANCE');
    assert.equal(extension!.comparableToAip, false, '2P value must not be treated as an AIP published distance');
  });

  it('builds a procedure graph with runway transitions, enroute transitions, and merge points', () => {
    const graph = parseVamos4Graph();
    assert.equal(graph.procedureId, 'VAMOS4');
    assert.deepEqual(graph.runwayTransitions.map((item) => item.id), ['RW16R']);
    assert.deepEqual(graph.enrouteTransitions.map((item) => item.id).sort(), ['DRAKY', 'TATEY']);
    assert.equal(graph.runwayTransitions[0].exitFix, 'VAMOS');
    for (const transition of graph.enrouteTransitions) assert.equal(transition.entryFix, 'VAMOS');
    const mergePoint = graph.mergePoints.find((item) => item.fix === 'VAMOS');
    assert.ok(mergePoint, 'VAMOS merge point missing');
    assert.deepEqual(mergePoint!.outboundTransitionIds.sort(), ['DRAKY', 'TATEY']);
  });

  it('keeps 2P vendor values in jeppesenDistanceNm, never in publishedDistanceNm', () => {
    const graph = parseVamos4Graph();
    for (const leg of graph.runwayTransitions[0].legs) {
      assert.equal(leg.publishedDistanceNm, null, `${leg.pathTerminator} publishedDistanceNm must stay null for 424-sourced legs`);
      if (leg.jeppesenDistanceNm !== null) assert.equal(leg.distanceSource, 'JEPPESEN_EXTENSION');
    }
  });
});

// ==================== 7-9. 跳号 / IF 锚点 / route materializer（十三节验收） ====================

describe('route materializer', () => {
  const graph = parseVamos4Graph();

  it('materializes RW16R + first transition into one continuous route without duplicating the merge fix', () => {
    const route = materializeRoute(graph, { runway: 'RW16R', enrouteTransition: 'DRAKY' });
    assert.deepEqual(
      route.legs.map((leg) => `${leg.pathTerminator}:${leg.toFix ?? ''}`),
      ['VA:', 'DF:T6R11', 'TF:VAMOS', 'TF:DRAKY', 'TF:XAC'],
    );
    const vamosCount = route.legs.filter((leg) => leg.toFix === 'VAMOS').length;
    assert.equal(vamosCount, 1, 'merge fix must not be duplicated by the IF anchor');
    assert.deepEqual(route.legs.map((leg) => leg.displaySequence), [10, 20, 30, 40, 50]);
    assert.deepEqual(route.legs.map((leg) => leg.segmentType), [
      'RUNWAY_TRANSITION',
      'RUNWAY_TRANSITION',
      'RUNWAY_TRANSITION',
      'ENROUTE_TRANSITION',
      'ENROUTE_TRANSITION',
    ]);
    assert.deepEqual([...new Set(route.legs.map((leg) => leg.sourceTransitionId))], ['RW16R', 'DRAKY']);
    // 原始 sequence 保留（424 跳号 010/015/020 合法）
    assert.deepEqual(route.legs.map((leg) => leg.sequence), [10, 20, 30, 15, 20]);
    assert.equal(route.warnings.length, 0, route.warnings.join('; '));
  });

  it('materializes RW16R + second transition', () => {
    const route = materializeRoute(graph, { runway: 'RW16R', enrouteTransition: 'TATEY' });
    assert.deepEqual(
      route.legs.map((leg) => `${leg.pathTerminator}:${leg.toFix ?? ''}`),
      ['VA:', 'DF:T6R11', 'TF:VAMOS', 'TF:UTIBO'],
    );
  });

  it('keeps the runway VA leg semantics (course + at-or-above altitude)', () => {
    const route = materializeRoute(graph, { runway: 'RW16R', enrouteTransition: 'DRAKY' });
    const va = route.legs[0];
    assert.equal(va.courseMagneticDeg, 158);
    assert.equal(va.altitudeConstraint?.type, 'AT_OR_ABOVE');
    assert.equal(va.altitudeConstraint?.lowerFt, 500);
  });

  it('reports unknown runway/transition inputs instead of guessing', () => {
    const route = materializeRoute(graph, { runway: 'RW99', enrouteTransition: 'NOPEX' });
    assert.equal(route.legs.length, 0);
    assert.equal(route.warnings.length, 2);
  });
});

// ==================== 阶段0-3 对比器（11/12/13 + 十三、十四节验收） ====================

describe('graph comparator identity gate and scoring', () => {
  const jeppesenGraph = parseVamos4Graph();

  it('returns SOURCE_MISMATCH with null score when procedure identities differ', () => {
    const aiGraph = aiGraphFromProcedures('RUTAS FOUR DEPARTURE', [
      { runway: 'RW16R', legs: [tfLeg(10, 'T6R11', 'VAMOS', 14.5)] },
    ]);
    const matched = findMatchingJeppesenGraph(aiGraph, [jeppesenGraph]);
    assert.equal(matched, undefined);
    const result = compareProcedureGraphs(aiGraph, matched ?? jeppesenGraph);
    assert.equal(result.comparisonStatus, 'SOURCE_MISMATCH');
    assert.equal(result.overallStatus, 'SOURCE_MISMATCH');
    assert.equal(result.scores.overallScore, null, 'identity failure must not produce an overall score');
    assert.match(result.reason ?? '', /RUTAS4/);
    assert.match(result.reason ?? '', /VAMOS4/);
  });

  it('reports PARTIAL_COMPARISON with coverage when AI misses whole transitions', () => {
    const aiGraph = aiGraphFromProcedures('VAMOS FOUR DEPARTURE', [
      {
        runway: 'RW16R',
        legs: [
          vaLeg(10, 158, 500),
          dfLeg(20, 'T6R11'),
          tfLeg(30, 'T6R11', 'VAMOS', 14.4, 9000),
        ],
      },
      { transitionName: 'DRAKY', legs: [tfLeg(10, 'VAMOS', 'DRAKY', null), tfLeg(20, 'DRAKY', 'XAC', null)] },
      // TATEY 过渡缺失：拓扑必须暴露，总分封顶 80，状态 PARTIAL_COMPARISON
    ]);
    const result = compareProcedureGraphs(aiGraph, findMatchingJeppesenGraph(aiGraph, [jeppesenGraph]));
    assert.equal(result.comparisonStatus, 'MATCHED');
    assert.equal(result.overallStatus, 'PARTIAL_COMPARISON');
    assert.deepEqual(result.topology?.enrouteTransitions.missingInAi, ['TATEY']);
    assert.ok(result.coverage);
    assert.deepEqual(result.coverage!.comparedEnrouteTransitions, ['DRAKY']);
    assert.equal(result.coverage!.totalEnrouteTransitions, 2);
    assert.ok((result.scores.overallScore ?? 100) <= 80, `score capped at 80 when transitions are missing, got ${result.scores.overallScore}`);
  });

  it('applies distance tolerance (14.4 vs 14.5) and never penalizes null AI distance on VA/DF legs', () => {
    const aiGraph = fullVamosAiGraph();
    const result = compareProcedureGraphs(aiGraph, findMatchingJeppesenGraph(aiGraph, [jeppesenGraph]));
    const runwayBranch = result.branches.find((branch) => branch.segmentType === 'RUNWAY_TRANSITION');
    assert.ok(runwayBranch);

    const tfResult = runwayBranch!.legResults.find((leg) => leg.toFix === 'VAMOS');
    const tfDistance = tfResult?.fields.find((field) => field.field === 'distanceNm');
    assert.equal(tfDistance?.matched, true, 'AIP 14.4 vs Jeppesen 14.5 must be a tolerance match');
    assert.equal(tfDistance?.toleranceApplied, true);

    const vaResult = runwayBranch!.legResults.find((leg) => leg.pathTerminator === 'VA');
    const vaDistance = vaResult?.fields.find((field) => field.field === 'distanceNm');
    assert.equal(vaDistance?.comparable, false, 'VA 2P distance is vendor-only, not an AIP field');

    const dfResult = runwayBranch!.legResults.find((leg) => leg.pathTerminator === 'DF');
    const dfDistance = dfResult?.fields.find((field) => field.field === 'distanceNm');
    assert.equal(dfDistance?.comparable, false, 'DF with unpublished AIP distance must not count against AI');
    assert.match(dfDistance?.reason ?? '', /Jeppesen extension/);
  });

  it('merges IF anchors semantically instead of reporting missing legs, and tolerates sequence gaps', () => {
    const aiGraph = fullVamosAiGraph();
    const result = compareProcedureGraphs(aiGraph, findMatchingJeppesenGraph(aiGraph, [jeppesenGraph]));
    const drakyBranch = result.branches.find((branch) => branch.transitionId === 'DRAKY');
    assert.ok(drakyBranch);
    const anchor = drakyBranch!.legResults.find((leg) => leg.status === 'MERGED_ANCHOR');
    assert.ok(anchor, 'jeppesen IF VAMOS anchor should be merged, not MISSING_AI');
    const missing = drakyBranch!.legResults.filter((leg) => leg.status === 'MISSING_AI' || leg.status === 'MISSING_JEPPESEN');
    assert.equal(missing.length, 0, 'sequence gaps (010/015/020 vs 10/20) must not create missing legs');
    assert.equal(result.scores.legSequenceScore, 100);
  });

  it('scores a complete matching graph without missing-transition caps', () => {
    const aiGraph = fullVamosAiGraph();
    const result = compareProcedureGraphs(aiGraph, findMatchingJeppesenGraph(aiGraph, [jeppesenGraph]));
    assert.equal(result.overallStatus, 'FULL_COMPARISON');
    assert.equal(result.scores.topologyScore, 100);
    assert.ok(result.coverage?.coveragePercent === 100);
  });
});

// ==================== merge point 检测（六节） ====================

describe('merge point detection', () => {
  it('marks a fix as merge point when multiple runway branches end there', () => {
    const branch = (id: string, exitFix: string) => ({
      id,
      type: 'RUNWAY' as const,
      runway: id,
      exitFix,
      entryFix: undefined,
      legs: [],
      sourceEvidence: [],
    });
    const mergePoints = detectMergePoints([branch('RW16L', 'ALPHA'), branch('RW16R', 'ALPHA'), branch('RW22', 'BRAVO')], [], []);
    assert.deepEqual(mergePoints.map((item) => item.fix), ['ALPHA']);
    assert.deepEqual(mergePoints[0].inboundTransitionIds, ['RW16L', 'RW16R']);
  });
});

// ==================== tableLegs 兼容适配器（deprecated 桥） ====================

describe('deprecated tableLegs adapter', () => {
  it('upgrades legacy flat tableLegs into a degenerate single-branch graph', () => {
    const graph = tableLegsToGraph(
      [
        { procedureName: 'ALPHA 1A', sequence: 10, pathTerminator: 'VA', fromFix: null, toFix: null, courseDeg: 160, distanceNm: null, altitudeConstraint: '+1000', turnDirection: null, remarks: null, sourcePageNo: 1, confidence: 0.8 },
        { procedureName: 'ALPHA 1A', sequence: 20, pathTerminator: 'TF', fromFix: null, toFix: 'ALPHA', courseDeg: null, distanceNm: 5.5, altitudeConstraint: null, turnDirection: null, remarks: null, sourcePageNo: 1, confidence: 0.8 },
      ],
      { airportIcao: 'ZZZZ', procedureName: 'ALPHA 1A', runway: 'RWY16' },
    );
    assert.equal(graph.builtFrom, 'LEGACY_TABLE_LEGS');
    assert.equal(graph.runwayTransitions.length, 1);
    assert.equal(graph.runwayTransitions[0].legs.length, 2);
    assert.equal(graph.runwayTransitions[0].legs[1].publishedDistanceNm, 5.5);
    assert.equal(graph.runwayTransitions[0].legs[1].distanceSource, 'AIP_TABLE');
    assert.ok(graph.warnings.length > 0, 'legacy upgrade must be flagged');
  });

  it('derives flat tableLegs from route instances with published distances only', () => {
    const graph = parseVamos4Graph();
    const tableLegs = graphToTableLegs(graph);
    assert.ok(tableLegs.length > 0);
    // 424 来源的图没有 AIP 发布距离：兼容字段不得用 2P 值冒充
    assert.ok(tableLegs.every((leg) => leg.distanceNm === null));
    assert.ok(tableLegs.every((leg) => /segment=/.test(leg.remarks ?? '')));
  });
});

// ---------- AI 侧图构造辅助（模拟识别结果 → 程序图） ----------

function vaLeg(sequence: number, course: number, altitudeFt: number) {
  return {
    sequence,
    pathTerminator: 'VA',
    fromFix: null,
    fixIdentifier: null,
    courseDegMag: course,
    distanceNm: null,
    turnDirection: null,
    altitudeConstraint: { type: 'AT_OR_ABOVE', altitudeFt, lowerFt: altitudeFt, upperFt: null, rawText: `+${altitudeFt}` },
  };
}

function dfLeg(sequence: number, toFix: string) {
  return {
    sequence,
    pathTerminator: 'DF',
    fromFix: null,
    fixIdentifier: toFix,
    courseDegMag: null,
    distanceNm: null,
    turnDirection: null,
    altitudeConstraint: null,
  };
}

function tfLeg(sequence: number, fromFix: string, toFix: string, distanceNm: number | null, altitudeFt?: number) {
  return {
    sequence,
    pathTerminator: 'TF',
    fromFix,
    fixIdentifier: toFix,
    courseDegMag: null,
    distanceNm,
    turnDirection: null,
    altitudeConstraint: altitudeFt
      ? { type: 'AT_OR_ABOVE', altitudeFt, lowerFt: altitudeFt, upperFt: null, rawText: `+${altitudeFt}` }
      : null,
  };
}

function aiGraphFromProcedures(
  procedureName: string,
  entries: Array<{ runway?: string; transitionName?: string; legs: Array<Record<string, unknown>> }>,
): SidProcedureGraph {
  const understanding: ProcedureUnderstandingResult = {
    airportIcao: 'RJTT',
    packageType: 'SID',
    procedures: entries.map((entry) => ({
      procedureName: entry.transitionName ? `${procedureName} / ${entry.transitionName} TRANSITION` : procedureName,
      runway: entry.runway ?? null,
      transitionName: entry.transitionName ?? null,
      legs: entry.legs,
    })),
  };
  const graphs = buildGraphsFromUnderstanding(understanding);
  assert.equal(graphs.length, 1, `expected one AI graph, got ${graphs.map((graph) => graph.procedureId).join(',')}`);
  return graphs[0];
}

function fullVamosAiGraph() {
  return aiGraphFromProcedures('VAMOS FOUR DEPARTURE', [
    {
      runway: 'RW16R',
      legs: [vaLeg(10, 158, 500), dfLeg(20, 'T6R11'), tfLeg(30, 'T6R11', 'VAMOS', 14.4, 9000)],
    },
    // AI 侧不重复 IF 锚点，序号也与 424 不同（跳号合法）
    { transitionName: 'DRAKY', legs: [tfLeg(10, 'VAMOS', 'DRAKY', null), tfLeg(20, 'DRAKY', 'XAC', null)] },
    { transitionName: 'TATEYAMA TRANSITION', legs: [tfLeg(10, 'VAMOS', 'UTIBO', null)] },
  ]);
}
