import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ProcedureUnderstandingResult } from '../../types/procedure';
import {
  RECOGNITION_V2_CONTRACT_VERSION,
  RECOGNITION_V2_SCHEMA_IDS,
  type CanonicalEntity,
  type ExtractionStageResult,
  type FieldCandidate,
  type FusionStageResult,
  type SourceEvidence,
} from '../recognition-v2/contracts/index';
import { executeEvidenceFusion } from '../recognition-v2/fusion/evidenceFusionExecutor';
import { executeSemanticValidation } from '../recognition-v2/validation/semanticValidationExecutor';
import { buildCanonicalPreview } from '../recognition-v2/adapters/canonicalPreviewAdapter';
import { aiProcedureToSimpleLegs } from '../jeppesen424/aiProcedureToSimpleLegs';

describe('Recognition V2 Phase 4 evidence fusion', () => {
  it('merges agreeing evidence, retains multi-values, and never overwrites a true conflict', async () => {
    const extraction = result([
      evidence('e_fix_text', 1, false), evidence('e_fix_table', 2, false), evidence('e_airport_a', 1, false), evidence('e_airport_b', 2, false),
      evidence('e_proc_a', 1, false), evidence('e_proc_b', 2, false),
    ], [
      candidate('c_lat_text', 'FIX', 'FIX:ABCDE', 'latitude', 1.25, 'e_fix_text', false, 0.9),
      candidate('c_lat_table', 'FIX', 'FIX:ABCDE', 'latitude', 1.25, 'e_fix_table', false, 0.95),
      candidate('c_airport_a', 'AIRPORT', 'AIRPORT:KAAA', 'airportIcao', 'KAAA', 'e_airport_a'),
      candidate('c_airport_b', 'AIRPORT', 'AIRPORT:KBBB', 'airportIcao', 'KBBB', 'e_airport_b'),
      candidate('c_proc_a', 'PROCEDURE', 'PROCEDURE:P1', 'procedureName', 'ALFA1', 'e_proc_a'),
      candidate('c_proc_b', 'PROCEDURE', 'PROCEDURE:P1', 'procedureName', 'BRAVO1', 'e_proc_b'),
    ]);
    const { output } = await executeEvidenceFusion({ packageId: 'P1', extractions: [extraction], now: NOW });
    const fix = output.entities.find((item) => item.entityKey === 'FIX:ABCDE')!;
    assert.equal(fix.fields.latitude, 1.25);
    assert.deepEqual(fix.fieldEvidence.latitude.sourceEvidenceIds, ['e_fix_table', 'e_fix_text']);
    assert.deepEqual(output.entities.find((item) => item.entityType === 'PROCEDURE')?.fields.procedureName, ['ALFA1', 'BRAVO1']);
    const conflict = output.conflicts.find((item) => item.fieldName === 'airportIcao');
    assert.equal(conflict?.resolution, 'OPEN');
    assert.equal(conflict?.severity, 'BLOCKING');
    assert.equal(output.entities.find((item) => item.entityType === 'AIRPORT')?.fields.airportIcao, undefined);
    assert.equal(output.selectedCandidateIds.includes('c_airport_a'), false);
    assert.equal(output.selectedCandidateIds.includes('c_airport_b'), false);
  });

  it('keeps a model-only value in preview but marks it unresolved and blocking', async () => {
    const extraction = result([evidence('e_model', 1, true)], [candidate('c_model', 'AIRPORT', 'AIRPORT:VHHH', 'airportIcao', 'VHHH', 'e_model', true)]);
    const { output } = await executeEvidenceFusion({ packageId: 'P1', extractions: [extraction], now: NOW });
    assert.equal(output.entities[0].fields.airportIcao, 'VHHH');
    assert.equal(output.unresolvedItems[0].reasonCode, 'MODEL_ONLY');
    assert.equal(output.unresolvedItems[0].blockingFor424, true);
  });

  it('does not admit a candidate whose claimed evidence record is missing', async () => {
    const extraction = result([], [candidate('c_orphan', 'AIRPORT', 'AIRPORT:VHHH', 'airportIcao', 'VHHH', 'missing')]);
    const { output } = await executeEvidenceFusion({ packageId: 'P1', extractions: [extraction], now: NOW });
    assert.equal(output.entities[0].fields.airportIcao, undefined);
    assert.ok(output.unresolvedItems.some((item) => item.reasonCode === 'MISSING_SOURCE_EVIDENCE' && item.blockingFor424));
  });
});

describe('Recognition V2 Phase 4 deterministic validation', () => {
  it('returns READY for a minimal coherent identity, coordinate and leg set', async () => {
    const fusion = fusionResult([
      entity('AIRPORT', 'AIRPORT:P1', { airportIcao: 'VHHH' }),
      entity('PROCEDURE', 'PROCEDURE:P1', { procedureName: ['ALFA1'], procedureCategory: 'ARRIVAL', packageType: 'STAR', navigationType: 'RNAV' }),
      entity('FIX', 'FIX:ABCDE', { identifier: 'ABCDE', latitude: 22.3, longitude: 114.2 }),
      entity('LEG', 'LEG:1', { sequence: 10, pathTerminator: 'IF', toFix: 'ABCDE' }),
    ]);
    const { output } = await executeSemanticValidation({ fusion, now: NOW });
    assert.equal(output.releaseDecision, 'READY');
    assert.equal(output.blockingIssueCount, 0);
  });

  it('blocks broken references and preserves published geometry values while warning about mismatches', async () => {
    const fusion = fusionResult([
      entity('AIRPORT', 'AIRPORT:P1', { airportIcao: 'VHHH' }),
      entity('PROCEDURE', 'PROCEDURE:P1', { procedureName: ['ALFA1'], procedureCategory: 'ARRIVAL', packageType: 'STAR', navigationType: 'RNAV' }),
      entity('FIX', 'FIX:AAAAA', { identifier: 'AAAAA', latitude: 0, longitude: 0 }),
      entity('FIX', 'FIX:BBBBB', { identifier: 'BBBBB', latitude: 1, longitude: 1 }),
      entity('LEG', 'LEG:1', { sequence: 10, pathTerminator: 'IF', toFix: 'AAAAA' }),
      entity('LEG', 'LEG:2', { sequence: 20, pathTerminator: 'TF', toFix: 'BBBBB', courseDegMag: 270, distanceNm: 2 }),
      entity('LEG', 'LEG:3', { sequence: 30, pathTerminator: 'TF', toFix: 'MISSING' }),
    ]);
    const originalDistance = fusion.entities.find((item) => item.entityKey === 'LEG:2')!.fields.distanceNm;
    const { output } = await executeSemanticValidation({ fusion, now: NOW });
    assert.equal(output.releaseDecision, 'BLOCKED');
    assert.ok(output.issues.some((item) => item.ruleId === 'LEG_FIX_REFERENCE' && item.severity === 'BLOCKING'));
    assert.ok(output.issues.some((item) => item.ruleId === 'GEOMETRY_DISTANCE_MISMATCH' && item.severity === 'WARNING'));
    assert.equal(fusion.entities.find((item) => item.entityKey === 'LEG:2')!.fields.distanceNm, originalDistance);
  });
});

describe('Recognition V2 Phase 4 read-only adapter', () => {
  it('creates a V1-compatible preview and diff without mutating V1', async () => {
    const fusion = fusionResult([
      entity('AIRPORT', 'AIRPORT:P1', { airportIcao: 'VHHH' }),
      entity('PROCEDURE', 'PROCEDURE:P1', { procedureName: ['ALFA1'], procedureCategory: 'ARRIVAL', packageType: 'STAR', navigationType: 'RNAV' }),
      entity('FIX', 'FIX:ABCDE', { identifier: 'ABCDE', latitude: 22.3, longitude: 114.2 }),
      entity('LEG', 'LEG:1', { sequence: 10, pathTerminator: 'IF', toFix: 'ABCDE' }),
    ]);
    const v1: ProcedureUnderstandingResult = { airportIcao: 'OLD1', reviewRequired: false };
    const before = structuredClone(v1);
    const { preview, diff } = await buildCanonicalPreview({ fusion, releaseDecision: 'READY', v1, now: NOW });
    assert.equal(preview.procedureUnderstanding.airportIcao, 'VHHH');
    assert.ok(diff.items.some((item) => item.path === '$.airportIcao' && item.status === 'CHANGED'));
    const simpleLegs = aiProcedureToSimpleLegs(preview.procedureUnderstanding as ProcedureUnderstandingResult);
    assert.equal(simpleLegs.length, 1);
    assert.equal(simpleLegs[0].fix, 'ABCDE');
    assert.deepEqual(v1, before);
  });
});

const NOW = '2026-07-16T00:00:00.000Z';

function evidence(evidenceId: string, pageNo: number, model: boolean): SourceEvidence {
  return {
    evidenceId, fileName: 'AD-2.pdf', pageNo, sourceType: 'TEXT_LAYER', rawText: evidenceId,
    extractionTask: 'PROCEDURE_IDENTITY', confidence: 0.9, status: 'OBSERVED',
    ...(model ? { modelExecution: { model: 'vision', promptId: 'p', promptVersion: '1', schemaId: 's', schemaVersion: '1', inputHash: 'h', runId: `r_${evidenceId}` } } : {}),
  };
}

function candidate(candidateId: string, entityType: FieldCandidate['entityType'], entityKey: string, fieldName: string, value: unknown, evidenceId: string, reviewRequired = false, confidence = 0.9): FieldCandidate {
  return { candidateId, entityType, entityKey, fieldName, value, normalizedValue: value, status: 'OBSERVED', sourceEvidenceIds: [evidenceId], confidence, reviewRequired };
}

function result(evidenceValues: SourceEvidence[], candidates: FieldCandidate[]): ExtractionStageResult {
  return { contractVersion: RECOGNITION_V2_CONTRACT_VERSION, schemaId: RECOGNITION_V2_SCHEMA_IDS.extractionStageResult, taskType: 'PROCEDURE_IDENTITY', pageNos: [1, 2], regionIds: [], evidence: evidenceValues, candidates, warnings: [], completedAt: NOW };
}

function entity(entityType: CanonicalEntity['entityType'], entityKey: string, fields: Record<string, unknown>): CanonicalEntity {
  return {
    entityType, entityKey, fields,
    fieldEvidence: Object.fromEntries(Object.keys(fields).map((field) => [field, { selectedCandidateId: `c_${entityKey}_${field}`, sourceEvidenceIds: [`e_${entityKey}_${field}`], status: 'OBSERVED', confidence: 0.95 }])),
  };
}

function fusionResult(entities: CanonicalEntity[]): FusionStageResult {
  return { contractVersion: RECOGNITION_V2_CONTRACT_VERSION, schemaId: RECOGNITION_V2_SCHEMA_IDS.fusionStageResult, entities, conflicts: [], unresolvedItems: [], selectedCandidateIds: entities.flatMap((item) => Object.values(item.fieldEvidence).flatMap((value) => value.selectedCandidateId ? [value.selectedCandidateId] : [])), policyVersions: { sourcePriority: '1.0.0', entityMatching: '1.0.0' }, completedAt: NOW };
}
