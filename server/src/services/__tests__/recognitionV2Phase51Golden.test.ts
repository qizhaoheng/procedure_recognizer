import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  evaluateTopologyGoldenCase,
  loadPhase5TopologyGoldenCases,
  topologyActualFromExtraction,
  verifyGoldenSourceFingerprint,
  type TopologyGoldenActual,
  type TopologyGoldenCase,
} from '../recognition-v2/evaluation/topologyGoldenEvaluator';
import {
  RECOGNITION_V2_CONTRACT_VERSION,
  RECOGNITION_V2_SCHEMA_IDS,
  type ExtractionStageResult,
} from '../recognition-v2/contracts/index';
import { assertValidModelChartTopology } from '../recognition-v2/contracts/schemaValidation';

const expectedCategories = ['DME_ARC', 'HOLDING', 'MISSED_APPROACH', 'MULTI_BRANCH_MERGE', 'RF', 'VECTOR'];
const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../');

describe('Recognition V2 Phase 5.1 real topology golden cases', () => {
  it('covers every Phase 5 complex topology category with reviewed evidence from three airports', async () => {
    const cases = await loadPhase5TopologyGoldenCases();
    assert.deepEqual(cases.map((item) => item.category).sort(), expectedCategories);
    assert.deepEqual([...new Set(cases.map((item) => item.airportIcao))].sort(), ['VHHH', 'WMKJ', 'WSSS']);
    assert.ok(cases.every((item) => item.source.documentSha256.length === 64));
    assert.ok(cases.every((item) => item.source.pages.every((page) => page.evidence.length > 0)));
  });

  it('matches the checked-in source fingerprints whenever the ignored source PDFs are locally available', async () => {
    const cases = await loadPhase5TopologyGoldenCases();
    const audits = await Promise.all(cases.map((item) => verifyGoldenSourceFingerprint(item, workspaceRoot)));
    const available = audits.filter((item) => item.available);
    assert.ok(available.every((item) => item.matches), `Golden source fingerprint drift: ${JSON.stringify(available.filter((item) => !item.matches))}`);
  });

  it('scores a complete reviewed topology at 100% for every real case', async () => {
    const cases = await loadPhase5TopologyGoldenCases();
    for (const golden of cases) {
      const result = evaluateTopologyGoldenCase(actualFromGolden(golden), golden);
      assert.equal(result.passed, true, `${golden.caseId}: ${JSON.stringify(result.failures)}`);
      assert.equal(result.score, 1);
    }
  });

  it('fails the anti-hallucination check when a radar-vector endpoint is invented', async () => {
    const golden = (await loadPhase5TopologyGoldenCases()).find((item) => item.category === 'VECTOR')!;
    const actual = actualFromGolden(golden);
    actual.edges[0].toIdentifier = 'RW20R';
    const result = evaluateTopologyGoldenCase(actual, golden);
    assert.equal(result.passed, false);
    assert.ok(result.failures.some((item) => item.code === 'INVENTED_VALUE' && item.path === 'vector.toIdentifier'));
  });

  it('allows an explicitly open-ended vector in the model contract', async () => {
    await assertValidModelChartTopology({
      pageNo: 210,
      regionId: 'asuna-diagram',
      nodes: [{ identifier: 'NYLON', nodeType: 'FIX', confidence: 0.98 }],
      edges: [{ fromIdentifier: 'NYLON', toIdentifier: null, relation: 'VECTOR', turnDirection: null, openEnded: true, confidence: 0.96 }],
      warnings: ['ATC-assigned downstream endpoint is not printed.'],
    });
  });

  it('adapts auditable topology candidates without dropping special geometry or merge sources', () => {
    const extraction: ExtractionStageResult = {
      contractVersion: RECOGNITION_V2_CONTRACT_VERSION,
      schemaId: RECOGNITION_V2_SCHEMA_IDS.extractionStageResult,
      taskType: 'CHART_TOPOLOGY',
      pageNos: [5],
      regionIds: ['table'],
      evidence: [],
      candidates: [
        {
          candidateId: 'edge-rf', entityType: 'TOPOLOGY', entityKey: 'TOPOLOGY:BEKOL:EDGE:PORPA:HH341', fieldName: 'edge',
          value: { from: 'PORPA', to: 'HH341', relation: 'ARC', pathTerminator: 'RF', centerIdentifier: 'HH941', radiusNm: 2.656, turnDirection: 'R' },
          normalizedValue: { from: 'PORPA', to: 'HH341', relation: 'ARC' }, status: 'OBSERVED', sourceEvidenceIds: ['ev'], confidence: 1, reviewRequired: false,
        },
        {
          candidateId: 'merge', entityType: 'TOPOLOGY', entityKey: 'TOPOLOGY:WMKJ:NODE:RDL340_11DME_VJB', fieldName: 'mergeSources',
          value: ['RDL016_11DME_VJB', 'RDL275_11DME_VJB'], normalizedValue: ['RDL016_11DME_VJB', 'RDL275_11DME_VJB'], status: 'DERIVED', sourceEvidenceIds: ['ev'], confidence: 1, reviewRequired: false,
        },
      ],
      warnings: [],
      completedAt: '2026-07-16T00:00:00.000Z',
    };
    const actual = topologyActualFromExtraction(extraction);
    assert.equal(actual.edges[0].centerIdentifier, 'HH941');
    assert.equal(actual.edges[0].radiusNm, 2.656);
    assert.deepEqual(actual.mergePoints[0], { identifier: 'RDL340_11DME_VJB', connectedIdentifiers: ['RDL016_11DME_VJB', 'RDL275_11DME_VJB'] });
  });
});

function actualFromGolden(golden: TopologyGoldenCase): TopologyGoldenActual {
  return {
    nodes: golden.expectations.nodes.map((item) => item.identifier),
    edges: golden.expectations.edges.map(({ edgeId: _edgeId, evidenceIds: _evidenceIds, ...edge }) => ({ ...edge })),
    branchPoints: golden.expectations.branchPoints.map(({ evidenceIds: _evidenceIds, ...point }) => ({ ...point, connectedIdentifiers: [...point.connectedIdentifiers] })),
    mergePoints: golden.expectations.mergePoints.map(({ evidenceIds: _evidenceIds, ...point }) => ({ ...point, connectedIdentifiers: [...point.connectedIdentifiers] })),
  };
}
