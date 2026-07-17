import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import express from 'express';
import type { PdfPageAsset, ProcedureGroup, ProcedureTask } from '../../types/procedure';
import { createRecognitionV2Router } from '../../routes/recognitionV2';
import { RECOGNITION_V2_SCHEMA_IDS } from '../recognition-v2/contracts/index';
import type { RecognitionV2RunManifest, RecognitionV2Stage } from '../recognition-v2/contracts/index';
import {
  RecognitionV2StateError,
  assertStageCanStart,
  cancelRun,
  completeStage,
  createInitialManifest,
  failStage,
  skipStage,
  stageDescendants,
  startStage,
} from '../recognition-v2/orchestration/stateMachine';
import { buildSourcePackageHash } from '../recognition-v2/orchestration/sourcePackageHash';
import { RecognitionV2Store } from '../recognition-v2/persistence/recognitionV2Store';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('recognition V2 state machine', () => {
  it('enforces dependencies and never starts a second stage while one is running', () => {
    let manifest = initialManifest();
    assert.throws(
      () => startStage(manifest, 'PROCEDURE_TABLE', { inputHash: 'hash:table' }),
      (error: unknown) => error instanceof RecognitionV2StateError && error.code === 'DEPENDENCY_NOT_COMPLETED',
    );

    manifest = startStage(manifest, 'PAGE_LAYOUT', { inputHash: 'hash:layout', now: time(1) });
    assert.equal(manifest.status, 'LAYOUT_RUNNING');
    assert.throws(
      () => startStage(manifest, 'PAGE_LAYOUT', { inputHash: 'hash:layout' }),
      (error: unknown) => error instanceof RecognitionV2StateError && error.code === 'STAGE_ALREADY_RUNNING',
    );
    assert.throws(
      () => startStage(manifest, 'PROCEDURE_IDENTITY', { inputHash: 'hash:identity' }),
      (error: unknown) => error instanceof RecognitionV2StateError && error.code === 'STAGE_ALREADY_RUNNING',
    );

    manifest = completeStage(manifest, 'PAGE_LAYOUT', { outputRef: 'artifacts/layout.json', now: time(2) });
    assert.doesNotThrow(() => assertStageCanStart(manifest, 'PROCEDURE_TABLE'));
  });

  it('allows an inapplicable extractor to be explicitly skipped without fake output', () => {
    let manifest = completeLayout(initialManifest());
    manifest = skipStage(manifest, 'WAYPOINT_NAVAID', { reason: 'No coordinate or navaid region exists.', now: time(3) });
    const stage = record(manifest, 'WAYPOINT_NAVAID');
    assert.equal(stage.status, 'SKIPPED');
    assert.equal(stage.outputRef, undefined);
    assert.match(stage.skipReason ?? '', /No coordinate/);
  });

  it('invalidates every dependent result when an upstream stage is rerun', () => {
    let manifest = completeLayout(initialManifest());
    for (const stage of extractionStages) {
      if (stage === 'WAYPOINT_NAVAID') {
        manifest = skipStage(manifest, stage, { reason: 'Not present in this package.' });
      } else {
        manifest = startAndComplete(manifest, stage);
      }
    }
    manifest = startAndComplete(manifest, 'EVIDENCE_FUSION');
    manifest = startAndComplete(manifest, 'SEMANTIC_VALIDATION');
    assert.equal(record(manifest, 'EVIDENCE_FUSION').status, 'COMPLETED');
    assert.equal(record(manifest, 'SEMANTIC_VALIDATION').status, 'COMPLETED');

    manifest = startStage(manifest, 'PROCEDURE_TABLE', { inputHash: 'hash:table-rerun' });
    assert.equal(record(manifest, 'PROCEDURE_TABLE').attempt, 2);
    assert.equal(record(manifest, 'EVIDENCE_FUSION').status, 'STALE');
    assert.equal(record(manifest, 'SEMANTIC_VALIDATION').status, 'STALE');
    assert.equal(record(manifest, 'PROCEDURE_IDENTITY').status, 'COMPLETED', 'sibling extractor remains valid');
  });

  it('preserves a failed stage for audit and allows an explicit retry', () => {
    let manifest = completeLayout(initialManifest());
    manifest = startStage(manifest, 'PROCEDURE_TABLE', { inputHash: 'hash:first' });
    manifest = failStage(manifest, 'PROCEDURE_TABLE', { code: 'EXTRACT_FAILED', message: 'bad table', retryable: true });
    assert.equal(manifest.status, 'FAILED');
    assert.equal(record(manifest, 'PROCEDURE_TABLE').error?.code, 'EXTRACT_FAILED');
    manifest = startStage(manifest, 'PROCEDURE_TABLE', { inputHash: 'hash:retry' });
    assert.equal(record(manifest, 'PROCEDURE_TABLE').attempt, 2);
    assert.equal(record(manifest, 'PROCEDURE_TABLE').error, undefined);
  });

  it('cancels active work but refuses to rewrite a completed run as cancelled', () => {
    let manifest = startStage(initialManifest(), 'PAGE_LAYOUT', { inputHash: 'hash:layout' });
    manifest = cancelRun(manifest);
    assert.equal(manifest.status, 'CANCELLED');
    assert.equal(record(manifest, 'PAGE_LAYOUT').status, 'CANCELLED');
    assert.throws(
      () => startStage(manifest, 'PAGE_LAYOUT', { inputHash: 'hash:new' }),
      (error: unknown) => error instanceof RecognitionV2StateError && error.code === 'RUN_CANCELLED',
    );

    const completed = { ...initialManifest(), status: 'COMPLETED' as const };
    assert.throws(
      () => cancelRun(completed),
      (error: unknown) => error instanceof RecognitionV2StateError && error.code === 'RUN_COMPLETED',
    );
  });

  it('keeps the dependency graph explicit and transitive', () => {
    assert.deepEqual(stageDescendants('EVIDENCE_FUSION'), ['SEMANTIC_VALIDATION', 'HUMAN_REVIEW', 'PUBLISH_CANONICAL']);
    assert.ok(stageDescendants('PAGE_LAYOUT').includes('PUBLISH_CANONICAL'));
  });
});

describe('recognition V2 independent store', () => {
  it('stores manifests and artifacts outside task.json using stable relative references', async () => {
    const root = await temporaryRoot();
    const store = new RecognitionV2Store(root);
    const manifest = await store.createRun({
      taskId: 'task_1',
      packageId: 'package/with unsafe chars',
      sourcePackageHash: 'sha256:source',
      runId: 'v2_run_1',
      now: time(0),
    });
    const artifactRef = await store.writeArtifact(manifest.taskId, manifest.packageId, manifest.runId, 'layout.json', { pageNo: 1 });
    const updated = await store.updateRun(manifest.taskId, manifest.packageId, manifest.runId, (current) =>
      completeStage(startStage(current, 'PAGE_LAYOUT', { inputHash: 'sha256:layout' }), 'PAGE_LAYOUT', { outputRef: artifactRef }));

    assert.equal(updated.stages[0].outputRef, 'artifacts/layout.json');
    assert.deepEqual(await store.readArtifact(manifest.taskId, manifest.packageId, manifest.runId, artifactRef), { pageNo: 1 });
    assert.match(store.runReference(manifest.taskId, manifest.packageId, manifest.runId), /^recognition-v2\//);
    assert.equal((await store.listRuns(manifest.taskId, manifest.packageId)).length, 1);
  });

  it('serializes concurrent manifest updates so attempts are not lost', async () => {
    const root = await temporaryRoot();
    const store = new RecognitionV2Store(root);
    const manifest = await store.createRun({ taskId: 'task_1', packageId: 'pkg_1', sourcePackageHash: 'sha256:source', runId: 'run_1' });
    const increment = () => store.updateRun(manifest.taskId, manifest.packageId, manifest.runId, async (current) => {
      await Promise.resolve();
      const next = structuredClone(current);
      next.stages[0].attempt += 1;
      return next;
    });
    await Promise.all([increment(), increment(), increment()]);
    assert.equal((await store.readRun(manifest.taskId, manifest.packageId, manifest.runId)).stages[0].attempt, 3);
  });

  it('rejects path traversal in artifact names and references', async () => {
    const root = await temporaryRoot();
    const store = new RecognitionV2Store(root);
    const manifest = await store.createRun({ taskId: 'task_1', packageId: 'pkg_1', sourcePackageHash: 'sha256:source', runId: 'run_1' });
    await assert.rejects(() => store.writeArtifact(manifest.taskId, manifest.packageId, manifest.runId, '../task.json', {}), /Invalid/);
    await assert.rejects(() => store.readArtifact(manifest.taskId, manifest.packageId, manifest.runId, '../task.json'), /Invalid/);
  });

  it('recovers a stage interrupted by service restart as an auditable retryable failure', async () => {
    const root = await temporaryRoot();
    const store = new RecognitionV2Store(root);
    const manifest = await store.createRun({ taskId: 'task_1', packageId: 'pkg_1', sourcePackageHash: 'sha256:source', runId: 'run_1' });
    await store.updateRun(manifest.taskId, manifest.packageId, manifest.runId, (current) =>
      startStage(current, 'PAGE_LAYOUT', { inputHash: 'sha256:layout' }));
    const result = await store.recoverInterruptedRuns(time(5));
    assert.equal(result.recovered.length, 1);
    assert.equal(result.errors.length, 0);
    const recovered = await store.readRun(manifest.taskId, manifest.packageId, manifest.runId);
    assert.equal(recovered.status, 'FAILED');
    assert.equal(record(recovered, 'PAGE_LAYOUT').error?.code, 'SERVICE_RESTARTED');
    assert.equal(record(recovered, 'PAGE_LAYOUT').error?.retryable, true);
  });
});

describe('recognition V2 source package hash', () => {
  it('changes with source evidence but ignores V1 recognition output', () => {
    const { task, group } = sourceFixture();
    const baseline = buildSourcePackageHash(task, group);
    group.procedureUnderstanding = { procedures: [{ procedureName: 'MODEL OUTPUT' }] };
    assert.equal(buildSourcePackageHash(task, group), baseline, 'V1 output must not invalidate a V2 source run');
    task.pages[0].textLayerText = 'changed source text';
    assert.notEqual(buildSourcePackageHash(task, group), baseline);
  });
});

describe('recognition V2 API skeleton', () => {
  it('runs the Phase 2/3 extractors and the deterministic Phase 4 fusion/validation stages', async () => {
    const root = await temporaryRoot();
    const store = new RecognitionV2Store(root);
    let { task } = sourceFixture();
    const router = createRecognitionV2Router({
      store,
      readTask: async (taskId) => {
        assert.equal(taskId, task.taskId);
        return structuredClone(task);
      },
      updateTask: async (taskId, updater) => {
        assert.equal(taskId, task.taskId);
        const draft = structuredClone(task);
        await updater(draft);
        task = draft;
        return structuredClone(task);
      },
    });
    const app = express();
    app.use(express.json());
    app.use('/api/procedure-tasks', router);
    app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    });
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const base = `http://127.0.0.1:${address.port}/api/procedure-tasks/task_1/packages/package_1/recognition-v2`;

    try {
      const createResponse = await fetch(`${base}/runs`, { method: 'POST' });
      assert.equal(createResponse.status, 201);
      const created = await createResponse.json() as { run: RecognitionV2RunManifest; executorsAvailable: RecognitionV2Stage[] };
      assert.deepEqual(created.executorsAvailable, ['PAGE_LAYOUT', 'PROCEDURE_IDENTITY', 'PROCEDURE_TABLE', 'WAYPOINT_NAVAID', 'NOTES_CONSTRAINTS', 'CHART_TOPOLOGY', 'EVIDENCE_FUSION', 'SEMANTIC_VALIDATION']);
      assert.equal(task.groups[0].recognitionV2?.activeRunId, created.run.runId);

      const stageResponse = await fetch(`${base}/runs/${created.run.runId}/stages/PAGE_LAYOUT/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ useModel: false }),
      });
      assert.equal(stageResponse.status, 200);
      const layoutBody = await stageResponse.json() as { outputRef: string; usedModel: boolean };
      assert.equal(layoutBody.usedModel, false);
      assert.equal(record(await store.readRun('task_1', 'package_1', created.run.runId), 'PAGE_LAYOUT').status, 'COMPLETED');
      assert.ok(layoutBody.outputRef);

      const identityResponse = await fetch(`${base}/runs/${created.run.runId}/stages/PROCEDURE_IDENTITY/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ useModel: false }),
      });
      assert.equal(identityResponse.status, 200);
      assert.equal(record(await store.readRun('task_1', 'package_1', created.run.runId), 'PROCEDURE_IDENTITY').status, 'COMPLETED');

      const rerunLayoutResponse = await fetch(`${base}/runs/${created.run.runId}/stages/PAGE_LAYOUT/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ useModel: false }),
      });
      assert.equal(rerunLayoutResponse.status, 200);
      const rerunLayout = await rerunLayoutResponse.json() as { outputRef: string };
      assert.notEqual(rerunLayout.outputRef, layoutBody.outputRef);
      assert.match(layoutBody.outputRef, /attempt-1\.json$/);
      assert.match(rerunLayout.outputRef, /attempt-2\.json$/);
      await assert.doesNotReject(() => store.readArtifact('task_1', 'package_1', created.run.runId, layoutBody.outputRef));
      const invalidated = await store.readRun('task_1', 'package_1', created.run.runId);
      assert.equal(record(invalidated, 'PAGE_LAYOUT').attempt, 2);
      assert.equal(record(invalidated, 'PROCEDURE_IDENTITY').status, 'STALE');

      const rerunIdentityResponse = await fetch(`${base}/runs/${created.run.runId}/stages/PROCEDURE_IDENTITY/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ useModel: false }),
      });
      assert.equal(rerunIdentityResponse.status, 200);
      const rerunIdentity = await store.readRun('task_1', 'package_1', created.run.runId);
      assert.equal(record(rerunIdentity, 'PROCEDURE_IDENTITY').status, 'COMPLETED');
      assert.equal(record(rerunIdentity, 'PROCEDURE_IDENTITY').attempt, 2);

      const tableResponse = await fetch(`${base}/runs/${created.run.runId}/stages/PROCEDURE_TABLE/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ useModel: false }),
      });
      assert.equal(tableResponse.status, 200);
      const tableBody = await tableResponse.json() as { outputRef: string; result: { schemaId: string; extraction: { taskType: string } } };
      assert.match(tableBody.outputRef, /procedure-table-stage-attempt-1\.json$/);
      assert.equal(tableBody.result.schemaId, RECOGNITION_V2_SCHEMA_IDS.procedureTableStageResult);
      assert.equal(tableBody.result.extraction.taskType, 'PROCEDURE_TABLE');
      const waypointResponse = await fetch(`${base}/runs/${created.run.runId}/stages/WAYPOINT_NAVAID/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ useModel: false }),
      });
      assert.equal(waypointResponse.status, 200);
      const waypointBody = await waypointResponse.json() as { outputRef: string; result: { taskType: string } };
      assert.match(waypointBody.outputRef, /waypoint-navaid-stage-attempt-1\.json$/);
      assert.equal(waypointBody.result.taskType, 'WAYPOINT_NAVAID');

      const notesResponse = await fetch(`${base}/runs/${created.run.runId}/stages/NOTES_CONSTRAINTS/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ useModel: false }),
      });
      assert.equal(notesResponse.status, 200);
      const notesBody = await notesResponse.json() as { outputRef: string; result: { taskType: string } };
      assert.match(notesBody.outputRef, /notes-constraints-stage-attempt-1\.json$/);
      assert.equal(notesBody.result.taskType, 'NOTES_CONSTRAINTS');

      const prematureFusion = await fetch(`${base}/runs/${created.run.runId}/stages/EVIDENCE_FUSION/run`, { method: 'POST' });
      assert.equal(prematureFusion.status, 409);
      assert.equal((await prematureFusion.json() as { code: string }).code, 'DEPENDENCY_NOT_COMPLETED');

      const missingReason = await fetch(`${base}/runs/${created.run.runId}/stages/CHART_TOPOLOGY/skip`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: '' }),
      });
      assert.equal(missingReason.status, 400);
      assert.equal((await missingReason.json() as { code: string }).code, 'SKIP_REASON_REQUIRED');
      for (const optionalStage of ['CHART_TOPOLOGY']) {
        const skipped = await fetch(`${base}/runs/${created.run.runId}/stages/${optionalStage}/skip`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason: 'This extractor is not implemented in Phase 4.' }),
        });
        assert.equal(skipped.status, 200);
      }
      const fusionResponse = await fetch(`${base}/runs/${created.run.runId}/stages/EVIDENCE_FUSION/run`, { method: 'POST' });
      assert.equal(fusionResponse.status, 200);
      const fusionBody = await fusionResponse.json() as { result: { schemaId: string; policyVersions: Record<string, string> }; usedModel: boolean };
      assert.equal(fusionBody.result.schemaId, RECOGNITION_V2_SCHEMA_IDS.fusionStageResult);
      assert.ok(fusionBody.result.policyVersions.sourcePriority);
      assert.equal(fusionBody.usedModel, false);

      const validationResponse = await fetch(`${base}/runs/${created.run.runId}/stages/SEMANTIC_VALIDATION/run`, { method: 'POST' });
      assert.equal(validationResponse.status, 200);
      const validationBody = await validationResponse.json() as { result: { schemaId: string; releaseDecision: string }; auditRefs: string[]; usedModel: boolean };
      assert.equal(validationBody.result.schemaId, RECOGNITION_V2_SCHEMA_IDS.validationStageResult);
      assert.equal(validationBody.result.releaseDecision, 'BLOCKED');
      assert.equal(validationBody.usedModel, false);
      assert.ok(validationBody.auditRefs.some((ref) => ref.includes('canonical-preview')));
      assert.ok(validationBody.auditRefs.some((ref) => ref.includes('v1-v2-diff')));
      assert.equal(task.groups[0].procedureUnderstanding, undefined, 'Phase 4 preview must not overwrite V1 canonical data');

      const initializeReviewResponse = await fetch(`${base}/runs/${created.run.runId}/review/initialize`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      assert.equal(initializeReviewResponse.status, 201);
      const initializedReview = await initializeReviewResponse.json() as { review: { schemaId: string; status: string; updatedAt: string; summary: { total: number; criticalPending: number }; items: Array<{ reviewItemId: string; currentValue?: unknown; evidenceIds: string[] }> } };
      assert.equal(initializedReview.review.schemaId, RECOGNITION_V2_SCHEMA_IDS.humanReviewStageResult);
      assert.equal(initializedReview.review.status, 'IN_PROGRESS');
      assert.ok(initializedReview.review.summary.total > 0);
      assert.equal(initializedReview.review.summary.criticalPending, initializedReview.review.summary.total);
      const getReviewResponse = await fetch(`${base}/runs/${created.run.runId}/review`);
      assert.equal(getReviewResponse.status, 200);
      const batchItem = initializedReview.review.items.find((item) => item.currentValue !== undefined && item.evidenceIds.length > 0);
      assert.ok(batchItem);
      const batchReviewResponse = await fetch(`${base}/runs/${created.run.runId}/review/batch`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedUpdatedAt: initializedReview.review.updatedAt, decisions: [{ reviewItemId: batchItem.reviewItemId, status: 'CONFIRMED' }] }),
      });
      assert.equal(batchReviewResponse.status, 200);
      const batchReview = await batchReviewResponse.json() as { updatedItemCount: number; review: { items: Array<{ reviewItemId: string; reviewer?: string }> } };
      assert.equal(batchReview.updatedItemCount, 1);
      assert.equal(batchReview.review.items.find((item) => item.reviewItemId === batchItem.reviewItemId)?.reviewer, 'REVIEW_UI');

      const getResponse = await fetch(`${base}/runs/${created.run.runId}`);
      assert.equal(getResponse.status, 200);
      const listResponse = await fetch(`${base}/runs`);
      assert.equal(listResponse.status, 200);
      assert.equal((await listResponse.json() as { runs: unknown[] }).runs.length, 1);

      const cancelResponse = await fetch(`${base}/runs/${created.run.runId}/cancel`, { method: 'POST' });
      assert.equal(cancelResponse.status, 200);
      assert.equal((await cancelResponse.json() as { run: RecognitionV2RunManifest }).run.status, 'CANCELLED');
      assert.equal(task.groups[0].recognitionV2?.status, 'CANCELLED');
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});

const extractionStages: RecognitionV2Stage[] = [
  'PROCEDURE_IDENTITY',
  'PROCEDURE_TABLE',
  'WAYPOINT_NAVAID',
  'NOTES_CONSTRAINTS',
  'CHART_TOPOLOGY',
];

function initialManifest() {
  return createInitialManifest({
    runId: 'run_1',
    taskId: 'task_1',
    packageId: 'package_1',
    sourcePackageHash: 'sha256:source',
    now: time(0),
  });
}

function completeLayout(manifest: RecognitionV2RunManifest) {
  return startAndComplete(manifest, 'PAGE_LAYOUT');
}

function startAndComplete(manifest: RecognitionV2RunManifest, stage: RecognitionV2Stage) {
  const started = startStage(manifest, stage, { inputHash: `hash:${stage}` });
  return completeStage(started, stage, { outputRef: `artifacts/${stage.toLowerCase()}.json` });
}

function record(manifest: RecognitionV2RunManifest, stage: RecognitionV2Stage) {
  const found = manifest.stages.find((item) => item.stage === stage);
  assert.ok(found);
  return found;
}

function time(second: number) {
  return `2026-07-16T00:00:${String(second).padStart(2, '0')}.000Z`;
}

async function temporaryRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'recognition-v2-store-'));
  temporaryRoots.push(root);
  return root;
}

function sourceFixture(): { task: ProcedureTask; group: ProcedureGroup } {
  const page: PdfPageAsset = {
    pageNo: 1,
    textLayerText: 'RNAV STAR TABLE',
    imageUrl: '/uploads/task/page-1.png',
    chartRole: 'TABULAR_DESCRIPTION',
    procedureCategory: 'ARRIVAL',
    navigationType: 'RNAV',
  };
  const group: ProcedureGroup = {
    groupId: 'package_1',
    packageId: 'package_1',
    groupName: 'TEST STAR',
    packageName: 'TEST STAR',
    packageType: 'STAR',
    procedureCategory: 'ARRIVAL',
    navigationType: 'RNAV',
    chartPages: [],
    tabularPages: [1],
    coordinatePages: [],
    minimaPages: [],
    otherPages: [],
    procedureNames: ['TEST 1A'],
    status: 'GROUPED',
  };
  const task: ProcedureTask = {
    taskId: 'task_1',
    fileName: 'AD2.pdf',
    filePath: 'AD2.pdf',
    status: 'GROUPED',
    pages: [page],
    groups: [group],
    createdAt: time(0),
    updatedAt: time(0),
  };
  return { task, group };
}
