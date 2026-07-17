import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PdfPageAsset, ProcedureGroup, ProcedureTask } from '../../types/procedure';
import {
  RECOGNITION_V2_CONTRACT_VERSION,
  RECOGNITION_V2_SCHEMA_IDS,
  type PageLayoutStageResult,
  type PageRegion,
} from '../recognition-v2/contracts/index';
import { executeProcedureIdentity } from '../recognition-v2/identity/procedureIdentityExecutor';
import { executeWaypointNavaid } from '../recognition-v2/coordinates/waypointNavaidExecutor';
import { executeProcedureTable } from '../recognition-v2/tables/procedureTableExecutor';
import { executeChartTopology, normalizeModelChartTopology } from '../recognition-v2/topology/chartTopologyExecutor';
import { executeEvidenceFusion } from '../recognition-v2/fusion/evidenceFusionExecutor';
import { executeSemanticValidation } from '../recognition-v2/validation/semanticValidationExecutor';

describe('Recognition V2 Phase 5 evidence scope and topology', () => {
  it('restores missing topology envelope fields without inventing nodes or edges', () => {
    assert.deepEqual(normalizeModelChartTopology({ nodes: [], edges: [] }, 79, 'p79-diagram'), {
      pageNo: 79,
      regionId: 'p79-diagram',
      nodes: [],
      edges: [],
      warnings: [],
    });
  });

  it('keeps chart-index and supporting pages from redefining package identity', async () => {
    const { task, group, layout } = fixture();
    const result = await executeProcedureIdentity({ task, group, layout, model: 'none', useModel: false, stageInputHash: 'sha256:identity' });
    const packageTypes = result.output.candidates.filter((item) => item.fieldName === 'packageType').map((item) => item.normalizedValue);
    const categories = result.output.candidates.filter((item) => item.fieldName === 'procedureCategory').map((item) => item.normalizedValue);
    assert.deepEqual([...new Set(packageTypes)], ['SID']);
    assert.deepEqual([...new Set(categories)], ['DEPARTURE']);
    assert.ok(!result.output.pageNos.includes(3), 'supporting chart index must not be an identity source');
  });

  it('recovers a strict nine-column tabular description and derives auditable row sequence', async () => {
    const { task, group, layout } = fixture();
    const result = await executeProcedureTable({ task, group, layout, model: 'none', useModel: false, stageInputHash: 'sha256:table' });
    assert.equal(result.output.tables[0].columnCount, 9);
    assert.equal(result.output.tables[0].rows.filter((row) => row.rowType === 'DATA').length, 2);
    assert.ok(result.output.extraction.candidates.some((item) => item.fieldName === 'toFix' && item.normalizedValue === 'MOXIB'));
    const sequences = result.output.extraction.candidates.filter((item) => item.fieldName === 'sequence');
    assert.deepEqual(sequences.map((item) => item.normalizedValue), [10, 20]);
    assert.ok(sequences.every((item) => item.status === 'DERIVED' && item.derivation?.ruleId === 'PHYSICAL_TABLE_ROW_ORDER_TO_SEQUENCE'));
  });

  it('uses printed chart coordinates and table order to build a connected auditable graph', async () => {
    const { task, group, layout } = fixture();
    const table = await executeProcedureTable({ task, group, layout, model: 'none', useModel: false, stageInputHash: 'sha256:table' });
    const coordinates = await executeWaypointNavaid({ task, group, layout, model: 'none', useModel: false, stageInputHash: 'sha256:coordinates' });
    assert.ok(coordinates.output.candidates.some((item) => item.entityKey === 'FIX:MOXIB' && item.fieldName === 'latitude' && item.status === 'DERIVED'));
    assert.ok(coordinates.output.candidates.some((item) => item.entityKey === 'FIX:EMRIX' && item.fieldName === 'longitude' && item.status === 'DERIVED'));

    const topology = await executeChartTopology({
      task,
      group,
      layout,
      table: table.output,
      model: 'none',
      useModel: false,
      stageInputHash: 'sha256:topology',
    });
    const edges = topology.output.candidates.filter((item) => item.fieldName === 'edge');
    assert.equal(edges.length, 2);
    assert.deepEqual(edges.map((item) => item.normalizedValue), [
      { from: null, to: 'MOXIB', relation: 'TRACK' },
      { from: 'MOXIB', to: 'EMRIX', relation: 'TRACK' },
    ]);
    assert.ok(edges.every((item) => item.status === 'DERIVED' && item.derivation?.inputCandidateIds.length));
    assert.equal(topology.output.candidates.filter((item) => item.fieldName === 'presentOnChart').length, 2);

    const identity = await executeProcedureIdentity({ task, group, layout, model: 'none', useModel: false, stageInputHash: 'sha256:identity' });
    const fusion = await executeEvidenceFusion({
      packageId: group.packageId!,
      extractions: [identity.output, table.output.extraction, coordinates.output, topology.output],
      now: '2026-07-16T00:00:00.000Z',
    });
    const validation = await executeSemanticValidation({ fusion: fusion.output, now: '2026-07-16T00:00:00.000Z' });
    assert.ok(!validation.output.issues.some((item) => item.ruleId === 'TOPOLOGY_LEG_EDGE_MISMATCH'));
    assert.ok(!validation.output.issues.some((item) => item.ruleId === 'TOPOLOGY_NODE_NOT_CONFIRMED_ON_CHART'));
  });

  it('materializes two procedure-table sections from a page that is also classified as a coordinate table', async () => {
    const { task, group, layout } = fixture();
    const tablePage = task.pages.find((item) => item.pageNo === 2)!;
    tablePage.chartRole = 'WAYPOINT_COORDINATES';
    tablePage.textLayerText = [
      'SINGAPORE CHANGI RNP-APCH RWY 02L – Approach from SAMKO',
      'Path Terminator', 'Waypoint', 'Fly-Over', 'Course', 'Magnetic Variation', 'Distance (NM)', 'Turn Direction', 'Altitude', 'Speed Limit', 'VPA/TCH(FT)', 'Navigation Specification',
      'IF', 'SAMKO', '-', '-', '-0.4', '-', '-', 'A040+', '220', '-', 'RNP APCH',
      'TF', 'ERVOT', '-', '016 (016.4)', '-0.4', '6.1', 'R', 'A028+', '-', '-', 'RNP APCH',
      'SINGAPORE CHANGI RNP-APCH RWY 02L – Approach from SANAT',
      'Path Terminator', 'Waypoint', 'Fly-Over', 'Course', 'Magnetic Variation', 'Distance (NM)', 'Turn Direction', 'Altitude', 'Speed Limit', 'VPA/TCH(FT)', 'Navigation Specification',
      'IF', 'SANAT', '-', '-', '-0.4', '-', '-', 'A040+', '220', '-', 'RNP APCH',
      'TF', 'ERVOT', '-', '305 (305.4)', '-0.4', '6.0', 'R', 'A028+', '-', '-', 'RNP APCH',
      'Waypoint Coordinates',
    ].join('\n');
    group.packageType = 'APPROACH';
    group.procedureCategory = 'APPROACH';
    group.navigationType = 'RNP';
    group.runway = 'RWY02L';
    group.procedureNames = ['RNP RWY02L'];
    group.coordinatePages = [2];
    layout.pages[1] = layoutPage(2, [region(2, 'p2-coordinates', 'WAYPOINT_COORDINATE_TABLE', [0, 0, 1, 1])]);

    const table = await executeProcedureTable({ task, group, layout, model: 'none', useModel: false, stageInputHash: 'sha256:multi-role-table' });
    assert.equal(table.output.tables.length, 2);
    assert.equal(table.output.tables.flatMap((item) => item.rows).filter((item) => item.rowType === 'DATA').length, 4);
    assert.deepEqual([...new Set(table.output.extraction.candidates.filter((item) => item.fieldName === 'transitionName').map((item) => item.normalizedValue))], ['SAMKO', 'SANAT']);

    const topology = await executeChartTopology({ task, group, layout, table: table.output, model: 'none', useModel: false, stageInputHash: 'sha256:multi-role-topology' });
    const edges = topology.output.candidates.filter((item) => item.fieldName === 'edge').map((item) => item.normalizedValue as { from: string | null; to: string });
    assert.ok(edges.some((edge) => edge.from === null && edge.to === 'SAMKO'));
    assert.ok(edges.some((edge) => edge.from === null && edge.to === 'SANAT'));
    assert.ok(!edges.some((edge) => edge.from === 'ERVOT' && edge.to === 'SANAT'), 'transition scopes must not be chained together');
  });
});

function fixture(): { task: ProcedureTask; group: ProcedureGroup; layout: PageLayoutStageResult } {
  const chart: PdfPageAsset = page(1, 'CHART', [
    'STANDARD DEPARTURE CHART',
    'RNAV (GNSS) - INSTRUMENT (SID)',
    'SINGAPORE/Singapore Changi',
    'RWY 02C',
    'ANITO DEPARTURES',
    'ANITO 7A',
    'MOXIB',
    `01° 29' 33'' N`,
    `104° 03' 15'' E`,
    'EMRIX',
    `01° 26' 06'' N`,
    `104° 10' 40'' E`,
    'AD-2-WSSS-SID-1',
  ].join('\n'));
  const table: PdfPageAsset = page(2, 'TABULAR_DESCRIPTION', [
    'ANITO 7A (SID) RNAV GNSS RWY 02C - DESCRIPTIONS',
    'Tabular Descriptions',
    'CF', 'MOXIB', '-', '023(023.4)', '8.0', 'R', 'A020+', '-', 'RNAV1',
    'TF', 'EMRIX', '-', '114(114.4)', '8.0', '-', 'A040+', '-', 'RNAV1',
    'Radio Communications Failure Procedure',
  ].join('\n'));
  const supporting: PdfPageAsset = page(3, 'CHART_INDEX', [
    'WSSS AD 2.24 CHARTS RELATED TO AN AERODROME',
    'Instrument Approach Chart - ICAO - RWY 20R - RNP',
    'AD-2-WSSS-IAC-11',
  ].join('\n'));
  const group: ProcedureGroup = {
    groupId: 'pkg_anito7a', packageId: 'pkg_anito7a', groupName: 'ANITO 7A', packageName: 'ANITO 7A',
    packageType: 'SID', procedureCategory: 'DEPARTURE', navigationType: 'RNAV', runway: 'RWY02C', chartNo: 'AD 2-WSSS-SID-1',
    chartPages: [1], tabularPages: [2], coordinatePages: [], minimaPages: [], textSupplementPages: [2], supportingPages: [3], otherPages: [],
    procedureNames: ['ANITO 7A'], status: 'GROUPED',
  };
  const task: ProcedureTask = {
    taskId: 'task_phase5', fileName: 'WSSS-AD2.pdf', filePath: 'WSSS-AD2.pdf', status: 'GROUPED',
    pages: [chart, table, supporting], groups: [group], createdAt: '2026-07-16T00:00:00.000Z', updatedAt: '2026-07-16T00:00:00.000Z',
  };
  return { task, group, layout: layoutResult() };
}

function page(pageNo: number, chartRole: PdfPageAsset['chartRole'], textLayerText: string): PdfPageAsset {
  return {
    pageNo,
    aipPageNo: pageNo === 1 ? 'AD 2-WSSS-SID-1' : pageNo === 2 ? 'AD 2-WSSS-SID-1.1' : 'AD 2-WSSS-INDEX',
    textLayerText,
    chartRole,
    procedureCategory: pageNo === 3 ? 'APPROACH' : 'DEPARTURE',
    navigationType: pageNo === 3 ? 'RNP' : 'RNAV',
    runway: pageNo === 3 ? 'RWY20R' : 'RWY02C',
    packageType: pageNo === 3 ? 'APPROACH' : 'SID',
    procedureNames: pageNo === 3 ? ['OTHER 1'] : ['ANITO 7A'],
  };
}

function layoutResult(): PageLayoutStageResult {
  return {
    contractVersion: RECOGNITION_V2_CONTRACT_VERSION,
    schemaId: RECOGNITION_V2_SCHEMA_IDS.pageLayoutStageResult,
    pages: [
      layoutPage(1, [region(1, 'p1-title', 'PROCEDURE_TITLE', [0, 0, 1, 0.2]), region(1, 'p1-diagram', 'PROCEDURE_DIAGRAM', [0, 0.15, 1, 1])]),
      layoutPage(2, [region(2, 'p2-title', 'PROCEDURE_TITLE', [0, 0, 1, 0.15]), region(2, 'p2-table', 'PROCEDURE_LEG_TABLE', [0, 0.1, 1, 0.8])]),
      layoutPage(3, [region(3, 'p3-support', 'SUPPORTING_INFORMATION', [0, 0, 1, 1])]),
    ],
    warnings: [],
    completedAt: '2026-07-16T00:00:00.000Z',
  };
}

function layoutPage(pageNo: number, regions: PageRegion[]) {
  return {
    contractVersion: RECOGNITION_V2_CONTRACT_VERSION,
    schemaId: RECOGNITION_V2_SCHEMA_IDS.pageLayoutResult,
    pageNo,
    pageRoles: [...new Set(regions.map((item) => item.type))],
    regions,
    missingExpectedRoles: [],
    analysisMethod: 'RULES_ONLY' as const,
    warnings: [],
  };
}

function region(pageNo: number, regionId: string, type: PageRegion['type'], bbox: PageRegion['bbox']): PageRegion {
  return { regionId, pageNo, type, bbox, rotationDeg: 0, readingOrder: 0, confidence: 0.95, reviewRequired: false };
}
