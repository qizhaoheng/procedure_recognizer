import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  PHASE52_CASE_ORDER,
  PHASE52_GOLDEN_BINDINGS,
  renderMarkdownReport,
  type Phase52PipelineReport,
} from '../recognition-v2/evaluation/phase52GoldenPipelineRunner';

describe('Recognition V2 Phase 5.2 real-pipeline runner', () => {
  it('locks the requested case order and provides an auditable task/page binding for every case', () => {
    assert.deepEqual([...PHASE52_CASE_ORDER], [
      'vhhh-bekol1x-rf',
      'wsss-rnp02l-akoma-holding',
      'wsss-asuna2b-vector',
      'wsss-rnp02l-missed-approach',
      'wmkj-adlov1g-dme-arc',
      'wmkj-four-star-merge',
    ]);
    for (const caseId of PHASE52_CASE_ORDER) {
      const binding = PHASE52_GOLDEN_BINDINGS[caseId];
      assert.ok(binding.taskId.startsWith('task_'));
      assert.ok(binding.packageId.startsWith('pkg_'));
      assert.ok(Object.keys(binding.pageMap).length > 0);
    }
  });

  it('renders actual scores and layered failure reasons in the human-readable report', () => {
    const report: Phase52PipelineReport = {
      reportVersion: 'phase5.2.1', startedAt: '2026-07-16T00:00:00.000Z', completedAt: '2026-07-16T00:00:01.000Z',
      baseUrl: 'http://127.0.0.1:3317', useModel: false,
      summary: { total: 1, passed: 0, averageScore: 0.4, failureCounts: { SOURCE_TEXT_MISSING: 1 } },
      cases: [{
        caseId: 'vhhh-bekol1x-rf', category: 'RF', airportIcao: 'VHHH', procedureName: 'BEKOL 1X',
        binding: PHASE52_GOLDEN_BINDINGS['vhhh-bekol1x-rf'], runId: 'run_1', runStatus: 'REVIEW_REQUIRED', modelRequested: false, sourceFallbackUsed: false,
        sourcePages: [], stages: [{ stage: 'PROCEDURE_TABLE', status: 'COMPLETED', durationMs: 2, metrics: { rows: 0 } }],
        score: 0.4, topologyPassed: false, passed: false, releaseDecision: 'BLOCKED', releaseReady: false, topologyFailures: [],
        failureReasons: [{ code: 'SOURCE_TEXT_MISSING', stage: 'SOURCE_RESOLUTION', message: 'Raster OCR required.' }],
      }],
    };
    const markdown = renderMarkdownReport(report);
    assert.match(markdown, /vhhh-bekol1x-rf/);
    assert.match(markdown, /0\.4/);
    assert.match(markdown, /SOURCE_TEXT_MISSING@SOURCE_RESOLUTION/);
  });
});
