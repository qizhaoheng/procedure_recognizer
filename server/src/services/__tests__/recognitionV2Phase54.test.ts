import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  RECOGNITION_V2_CONTRACT_VERSION,
  RECOGNITION_V2_SCHEMA_IDS,
  type CanonicalEntity,
  type ExtractionStageResult,
  type FusionStageResult,
} from '../recognition-v2/contracts/index';
import { executeSemanticValidation } from '../recognition-v2/validation/semanticValidationExecutor';
import {
  applyCompletedHumanReview,
  applyReusableReviewDecisions,
  buildHumanReviewWorkspace,
  recordHumanReviewDecision,
  recordHumanReviewDecisions,
  updateReuseLedger,
} from '../recognition-v2/review/humanReviewExecutor';

describe('Recognition V2 Phase 5.4 human review closure', () => {
  it('merges duplicate review signals by entity and field, preserves image evidence, and promotes confirmed data to READY', async () => {
    const fusion = reviewableFusion(22.31);
    const validation = (await executeSemanticValidation({ fusion, now: NOW })).output;
    assert.equal(validation.releaseDecision, 'REVIEW_REQUIRED');

    const workspace = await buildHumanReviewWorkspace({
      runId: 'v2_run_review', packageId: 'P1', baselineFusionRef: 'artifacts/fusion.json', baselineValidationRef: 'artifacts/validation.json',
      fusion, validation, extractions: [extraction()], now: NOW,
    });
    assert.equal(workspace.summary.total, 1);
    assert.equal(workspace.summary.mergedSignalCount, 2);
    assert.deepEqual(workspace.items[0].evidenceIds, ['e_lat']);
    assert.deepEqual(workspace.evidence[0].bbox, [0.1, 0.2, 0.4, 0.3]);

    const confirmed = await recordHumanReviewDecision({
      workspace, reviewItemId: workspace.items[0].reviewItemId, status: 'CONFIRMED', reviewer: 'tester-01', note: 'Compared with printed coordinate table.', now: LATER,
    });
    const result = await applyCompletedHumanReview({ workspace: confirmed, fusion, now: LATER });
    assert.equal(result.validation.releaseDecision, 'READY');
    assert.equal(result.workspace.status, 'COMPLETED');
    assert.equal(result.workspace.auditTrail[0].reviewer, 'tester-01');
    assert.equal(result.fusion.unresolvedItems.length, 0);
  });

  it('applies a typed correction before deterministic revalidation', async () => {
    const fusion = reviewableFusion(91);
    const validation = (await executeSemanticValidation({ fusion, now: NOW })).output;
    assert.equal(validation.releaseDecision, 'BLOCKED');
    const workspace = await buildHumanReviewWorkspace({
      runId: 'v2_run_correction', packageId: 'P1', baselineFusionRef: 'artifacts/fusion.json', baselineValidationRef: 'artifacts/validation.json',
      fusion, validation, extractions: [extraction()], now: NOW,
    });
    assert.equal(workspace.items.length, 1);
    assert.ok(workspace.items[0].duplicateCount >= 2);
    const corrected = await recordHumanReviewDecision({
      workspace, reviewItemId: workspace.items[0].reviewItemId, status: 'CORRECTED', correctedValue: 22.31, reviewer: 'tester-02', now: LATER,
    });
    const result = await applyCompletedHumanReview({ workspace: corrected, fusion, now: LATER });
    assert.equal(result.fusion.entities.find((item) => item.entityKey === 'FIX:ABCDE')?.fields.latitude, 22.31);
    assert.equal(result.validation.releaseDecision, 'READY');
    assert.equal(result.workspace.summary.corrected, 1);
  });

  it('refuses completion while a critical field is still pending', async () => {
    const fusion = reviewableFusion(22.31);
    const validation = (await executeSemanticValidation({ fusion, now: NOW })).output;
    const workspace = await buildHumanReviewWorkspace({
      runId: 'v2_run_pending', packageId: 'P1', baselineFusionRef: 'artifacts/fusion.json', baselineValidationRef: 'artifacts/validation.json',
      fusion, validation, extractions: [extraction()], now: NOW,
    });
    await assert.rejects(() => applyCompletedHumanReview({ workspace, fusion }), /critical review fields still pending/);
  });

  it('auto-confirms a critical transcription only when deterministic source evidence is exceptionally strong', async () => {
    const fusion = reviewableFusion(22.31);
    const validation = (await executeSemanticValidation({ fusion, now: NOW })).output;
    const strongExtraction = extraction();
    strongExtraction.candidates[0].confidence = 0.99;
    strongExtraction.evidence[0].confidence = 0.99;
    const workspace = await buildHumanReviewWorkspace({
      runId: 'v2_run_strong_source', packageId: 'P1', baselineFusionRef: 'artifacts/fusion.json', baselineValidationRef: 'artifacts/validation.json',
      fusion, validation, extractions: [strongExtraction], now: NOW,
    });
    assert.equal(workspace.items[0].critical, true);
    assert.equal(workspace.items[0].status, 'CONFIRMED');
    assert.equal(workspace.items[0].reviewer, 'AUTO_DETERMINISTIC');
    const result = await applyCompletedHumanReview({ workspace, fusion, now: LATER });
    assert.equal(result.validation.releaseDecision, 'READY');
  });

  it('never allows a reviewer to waive the structural requirement for procedure legs', async () => {
    const fusion = reviewableFusion(22.31);
    fusion.entities = fusion.entities.filter((item) => item.entityType !== 'LEG');
    fusion.unresolvedItems = [];
    const validation = (await executeSemanticValidation({ fusion, now: NOW })).output;
    assert.equal(validation.releaseDecision, 'BLOCKED');
    const workspace = await buildHumanReviewWorkspace({
      runId: 'v2_run_no_legs', packageId: 'P1', baselineFusionRef: 'artifacts/fusion.json', baselineValidationRef: 'artifacts/validation.json',
      fusion, validation, extractions: [extraction()], now: NOW,
    });
    const item = workspace.items.find((value) => value.ruleIds.includes('PROCEDURE_LEGS_REQUIRED'));
    assert.ok(item);
    await assert.rejects(() => recordHumanReviewDecision({ workspace, reviewItemId: item.reviewItemId, status: 'CONFIRMED', reviewer: 'tester-04' }), /cannot be confirmed/);
    const legacyConfirmed = structuredClone(workspace);
    legacyConfirmed.items.forEach((value) => { value.status = 'CONFIRMED'; value.reviewer = 'legacy'; value.decidedAt = LATER; });
    legacyConfirmed.summary.pending = 0;
    legacyConfirmed.summary.criticalPending = 0;
    legacyConfirmed.summary.confirmed = legacyConfirmed.items.length;
    const result = await applyCompletedHumanReview({ workspace: legacyConfirmed, fusion, now: LATER });
    assert.equal(result.validation.releaseDecision, 'BLOCKED');
    assert.equal(result.validation.issues.find((value) => value.ruleId === 'PROCEDURE_LEGS_REQUIRED')?.status, 'OPEN');
  });

  it('allows a reviewer to acknowledge an evidence-backed validation warning that has no canonical field value', async () => {
    const fusion = reviewableFusion(22.31);
    fusion.unresolvedItems = [];
    fusion.entities.push(entity('TOPOLOGY', 'TOPOLOGY:EDGE:START:ABCDE', { edge: { from: null, to: 'ABCDE', relation: 'TRACK' } }));
    const validation = (await executeSemanticValidation({ fusion, now: NOW })).output;
    assert.equal(validation.releaseDecision, 'REVIEW_REQUIRED');
    const workspace = await buildHumanReviewWorkspace({
      runId: 'v2_run_warning', packageId: 'P1', baselineFusionRef: 'artifacts/fusion.json', baselineValidationRef: 'artifacts/validation.json',
      fusion, validation, extractions: [extraction()], now: NOW,
    });
    assert.equal(workspace.items[0].fieldName, 'presentOnChart');
    assert.equal(workspace.items[0].currentValue, undefined);
    assert.ok(workspace.items[0].evidenceIds.length > 0);
    const confirmed = await recordHumanReviewDecision({
      workspace, reviewItemId: workspace.items[0].reviewItemId, status: 'CONFIRMED', reviewer: 'tester-03', now: LATER,
    });
    const result = await applyCompletedHumanReview({ workspace: confirmed, fusion, now: LATER });
    assert.equal(result.validation.releaseDecision, 'READY');
    assert.ok(result.validation.issues.some((item) => item.ruleId === 'TOPOLOGY_NODE_NOT_CONFIRMED_ON_CHART' && item.status === 'HUMAN_RESOLVED'));
  });

  it('records a batch atomically and reuses it only for an identical source and review fingerprint', async () => {
    const fusion = reviewableFusion(22.31);
    const validation = (await executeSemanticValidation({ fusion, now: NOW })).output;
    const first = await buildHumanReviewWorkspace({
      runId: 'v2_run_source', packageId: 'P1', baselineFusionRef: 'artifacts/fusion.json', baselineValidationRef: 'artifacts/validation.json',
      fusion, validation, extractions: [extraction()], now: NOW,
    });
    const decided = await recordHumanReviewDecisions({
      workspace: first,
      decisions: [{ reviewItemId: first.items[0].reviewItemId, status: 'CONFIRMED' }],
      reviewer: 'reviewer-batch', now: LATER,
    });
    assert.equal(decided.auditTrail.length, 1);
    const ledger = updateReuseLedger({ workspace: decided, sourcePackageHash: 'sha256:same', now: LATER });

    const second = await buildHumanReviewWorkspace({
      runId: 'v2_run_target', packageId: 'P1', baselineFusionRef: 'artifacts/fusion.json', baselineValidationRef: 'artifacts/validation.json',
      fusion, validation, extractions: [extraction()], now: LATER,
    });
    const reused = await applyReusableReviewDecisions({ workspace: second, ledger, sourcePackageHash: 'sha256:same', now: LATER });
    assert.equal(reused.items[0].status, 'CONFIRMED');
    assert.equal(reused.summary.reusedDecisionCount, 1);
    assert.equal(reused.auditTrail[0].reusedFromRunId, 'v2_run_source');

    const rejected = await applyReusableReviewDecisions({ workspace: second, ledger, sourcePackageHash: 'sha256:different', now: LATER });
    assert.equal(rejected.items[0].status, 'PENDING');
    assert.equal(rejected.summary.reusedDecisionCount, 0);
  });
});

const NOW = '2026-07-16T10:00:00.000Z';
const LATER = '2026-07-16T10:05:00.000Z';

function reviewableFusion(latitude: number): FusionStageResult {
  const entities: CanonicalEntity[] = [
    entity('AIRPORT', 'AIRPORT:P1', { airportIcao: 'VHHH' }),
    entity('PROCEDURE', 'PROCEDURE:P1', { procedureName: ['TEST 1A'], procedureCategory: 'ARRIVAL', packageType: 'STAR', navigationType: 'RNAV' }),
    entity('FIX', 'FIX:ABCDE', { identifier: 'ABCDE', latitude, longitude: 114.2 }, { latitude: 'c_lat' }),
    entity('LEG', 'LEG:1', { procedureName: 'TEST 1A', sequence: 10, pathTerminator: 'IF', toFix: 'ABCDE' }),
  ];
  return {
    contractVersion: RECOGNITION_V2_CONTRACT_VERSION,
    schemaId: RECOGNITION_V2_SCHEMA_IDS.fusionStageResult,
    entities,
    conflicts: [],
    unresolvedItems: [{
      unresolvedId: 'u_lat', entityKey: 'FIX:ABCDE', fieldName: 'latitude', reasonCode: 'REVIEW_REQUIRED', candidateIds: ['c_lat'], requiredEvidence: 'Human-confirmed source evidence.', blockingFor424: false,
    }],
    selectedCandidateIds: ['c_lat'],
    policyVersions: { sourcePriority: '1.1.0', entityMatching: '1.0.0' },
    completedAt: NOW,
  };
}

function entity(
  entityType: CanonicalEntity['entityType'], entityKey: string, fields: Record<string, unknown>, selected: Record<string, string> = {},
): CanonicalEntity {
  return {
    entityType, entityKey, fields,
    fieldEvidence: Object.fromEntries(Object.keys(fields).map((field) => [field, {
      selectedCandidateId: selected[field] ?? `c_${entityKey}_${field}`,
      sourceEvidenceIds: field === 'latitude' && entityKey === 'FIX:ABCDE' ? ['e_lat'] : [`e_${entityKey}_${field}`],
      status: 'OBSERVED', confidence: 0.9,
    }])),
  };
}

function extraction(): ExtractionStageResult {
  return {
    contractVersion: RECOGNITION_V2_CONTRACT_VERSION,
    schemaId: RECOGNITION_V2_SCHEMA_IDS.extractionStageResult,
    taskType: 'WAYPOINT_NAVAID', pageNos: [8], regionIds: ['coords'],
    evidence: [{
      evidenceId: 'e_lat', fileName: 'AD-2.pdf', pageNo: 8, aipPageNo: 'AD 2.13', regionId: 'coords', bbox: [0.1, 0.2, 0.4, 0.3], sourceType: 'WAYPOINT_COORDINATE_TABLE', rawText: 'ABCDE 22°18\'36"N', extractionTask: 'WAYPOINT_NAVAID', confidence: 0.8, status: 'OBSERVED',
    }],
    candidates: [{
      candidateId: 'c_lat', entityType: 'FIX', entityKey: 'FIX:ABCDE', fieldName: 'latitude', value: 22.31, normalizedValue: 22.31,
      status: 'OBSERVED', sourceEvidenceIds: ['e_lat'], confidence: 0.8, reviewRequired: true,
    }],
    warnings: [], completedAt: NOW,
  };
}
