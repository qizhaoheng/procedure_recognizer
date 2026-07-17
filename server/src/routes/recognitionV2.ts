import express from 'express';
import crypto from 'node:crypto';
import { readTask, updateTask } from '../storage/taskStore';
import type { ProcedureGroup, ProcedureTask } from '../types/procedure';
import type {
  ExtractionStageResult,
  FusionStageResult,
  HumanReviewStageResult,
  CanonicalPreviewArtifact,
  PublicationLedger,
  PublicationWorkspace,
  PageLayoutStageResult,
  ProcedureTableStageResult,
  RecognitionV2RunManifest,
  RecognitionV2Stage,
  ValidationStageResult,
} from '../services/recognition-v2/contracts/index';
import { RECOGNITION_V2_CONTRACT_VERSION, RECOGNITION_V2_SCHEMA_IDS } from '../services/recognition-v2/contracts/index';
import type { ProcedureUnderstandingResult } from '../types/procedure';
import { RecognitionV2Store, recognitionV2Store } from '../services/recognition-v2/persistence/recognitionV2Store';
import {
  RecognitionV2StateError,
  assertStageCanStart,
  cancelRun,
  completeStage,
  failStage,
  isRecognitionV2Stage,
  skipStage,
  STAGE_DEPENDENCIES,
  startStage,
} from '../services/recognition-v2/orchestration/stateMachine';
import { buildSourcePackageHash } from '../services/recognition-v2/orchestration/sourcePackageHash';
import { executePageLayout } from '../services/recognition-v2/layout/pageLayoutExecutor';
import { executeProcedureIdentity } from '../services/recognition-v2/identity/procedureIdentityExecutor';
import { executeProcedureTable } from '../services/recognition-v2/tables/procedureTableExecutor';
import { executeWaypointNavaid } from '../services/recognition-v2/coordinates/waypointNavaidExecutor';
import { executeNotesConstraints } from '../services/recognition-v2/notes/notesConstraintsExecutor';
import { executeChartTopology } from '../services/recognition-v2/topology/chartTopologyExecutor';
import { executeEvidenceFusion } from '../services/recognition-v2/fusion/evidenceFusionExecutor';
import { executeSemanticValidation } from '../services/recognition-v2/validation/semanticValidationExecutor';
import {
  applyCompletedHumanReview,
  applyReusableReviewDecisions,
  buildHumanReviewWorkspace,
  recordHumanReviewDecision,
  recordHumanReviewDecisions,
  updateReuseLedger,
  type HumanReviewReuseLedger,
} from '../services/recognition-v2/review/humanReviewExecutor';
import { buildCanonicalPreview } from '../services/recognition-v2/adapters/canonicalPreviewAdapter';
import type { VisionStageClient } from '../services/recognition-v2/orchestration/visionStageClient';
import { getLlmRuntimeConfig } from '../services/llm/llmClient';
import { buildGeoJsonFromProcedureUnderstanding } from '../services/procedureUnderstandingGeojson';
import { buildProcedureRenderPlan } from '../services/rendering/procedureRenderPlan';
import { validateProcedureGeoJson } from '../services/geojsonValidator';
import { compareArinc424Fields } from '../services/jeppesen424/arinc424FieldComparator';
import { aggregateAirport424, type Airport424PackageReleaseInput } from '../services/jeppesen424/airport424Aggregator';
import { extractAirportMasterData } from '../services/jeppesen424/airportMasterDataExtractor';
import { buildAirportBatchStatus } from '../services/recognition-v2/orchestration/airportBatchStatus';
import {
  assertValidExtractionStageResult,
  assertValidFusionStageResult,
  assertValidHumanReviewStageResult,
  assertValidPageLayoutStageResult,
  assertValidProcedureTableStageResult,
  assertValidPublicationWorkspace,
} from '../services/recognition-v2/contracts/schemaValidation';
import {
  acceptDryRunDiff,
  assertPublishable,
  contentHash,
  createDryRun,
  createPublicationLock,
  inspectDryRunDiff,
  runPublicationPreflight,
  addPublishedRelease,
  markReleaseRolledBack,
  exportCanonical424Text,
} from '../services/recognition-v2/publication/publicationService';
import {
  addAirportPublicationRelease,
  airportTextHash,
  createAirportPublicationSnapshot,
  rollbackAirportPublication,
  type AirportPublicationLedger,
  type AirportPublicationSnapshot,
} from '../services/recognition-v2/publication/airportPublicationService';

interface RecognitionV2RouterDependencies {
  store: RecognitionV2Store;
  readTask: typeof readTask;
  updateTask: typeof updateTask;
  visionClient?: VisionStageClient;
}

const defaultDependencies: RecognitionV2RouterDependencies = {
  store: recognitionV2Store,
  readTask,
  updateTask,
};

const PUBLICATION_WORKSPACE_FILE = 'publication-workspace.json';
const PUBLICATION_LEDGER_FILE = 'publication-ledger.json';
const AIRPORT_PUBLICATION_PACKAGE_ID = '_airport';
const AIRPORT_PUBLICATION_LEDGER_FILE = 'airport-publication-ledger.json';

export function createRecognitionV2Router(dependencies: RecognitionV2RouterDependencies = defaultDependencies) {
  const router = express.Router();
  const activeExecutions = new Map<string, AbortController>();

router.get('/:taskId/recognition-v2/airport-publication', async (req, res, next) => {
  try {
    const task = await dependencies.readTask(req.params.taskId);
    const aggregate = await buildAirportAggregate(dependencies, task);
    res.json({ aggregate });
  } catch (error) { next(error); }
});

router.post('/:taskId/recognition-v2/airport-publication/compare-reference', async (req, res, next) => {
  try {
    const task = await dependencies.readTask(req.params.taskId);
    const referenceText = String(req.body?.text ?? '');
    if (!referenceText.trim()) return res.status(400).json({ code: 'REFERENCE_424_REQUIRED', error: 'Paste Jeppesen 424 text before comparison.' });
    if (referenceText.length > 20_000_000) return res.status(413).json({ code: 'REFERENCE_424_TOO_LARGE', error: 'Airport reference 424 text exceeds the 20 MB comparison limit.' });
    const aggregate = await buildAirportAggregate(dependencies, task);
    return res.json({ comparison: compareArinc424Fields(aggregate.text, referenceText), airportComplete: aggregate.airportComplete });
  } catch (error) { next(error); }
});

router.get('/:taskId/recognition-v2/airport-publication/releases', async (req, res, next) => {
  try {
    const task = await dependencies.readTask(req.params.taskId);
    const aggregate = await buildAirportAggregate(dependencies, task);
    const ledger = await readAirportPublicationLedger(dependencies, task.taskId);
    const active = ledger?.releases.find((item) => item.releaseId === ledger.activeReleaseId && item.status === 'ACTIVE');
    const activeSnapshot = active
      ? await dependencies.store.readPackageArtifact<AirportPublicationSnapshot>(task.taskId, AIRPORT_PUBLICATION_PACKAGE_ID, active.artifactFile)
      : undefined;
    res.json({
      ledger,
      activeSnapshot: activeSnapshot ? { ...activeSnapshot, text: undefined } : undefined,
      liveTextHash: airportTextHash(aggregate.text),
      stale: Boolean(activeSnapshot && activeSnapshot.textHash !== airportTextHash(aggregate.text)),
      airportComplete: aggregate.airportComplete,
    });
  } catch (error) { next(error); }
});

router.post('/:taskId/recognition-v2/airport-publication/publish', async (req, res, next) => {
  try {
    const task = await dependencies.readTask(req.params.taskId);
    const aggregate = await buildAirportAggregate(dependencies, task);
    const releaseId = `airport_release_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
    const snapshot = createAirportPublicationSnapshot({ taskId: task.taskId, aggregate, releaseId });
    const confirmation = await buildAirportAggregate(dependencies, await dependencies.readTask(task.taskId));
    if (airportTextHash(confirmation.text) !== snapshot.textHash
      || JSON.stringify(confirmation.packageReleases) !== JSON.stringify(snapshot.packageReleases)) {
      return res.status(409).json({ code: 'AIRPORT_RELEASE_CHANGED', error: '机场程序包版本在发布过程中发生变化，请刷新后重试。' });
    }
    const artifactFile = `${releaseId}.json`;
    await dependencies.store.updatePackageArtifact<AirportPublicationSnapshot>(task.taskId, AIRPORT_PUBLICATION_PACKAGE_ID, artifactFile, () => snapshot);
    const ledger = await dependencies.store.updatePackageArtifact<AirportPublicationLedger>(
      task.taskId, AIRPORT_PUBLICATION_PACKAGE_ID, AIRPORT_PUBLICATION_LEDGER_FILE,
      (current) => addAirportPublicationRelease(current, snapshot, artifactFile),
    );
    res.status(201).json({ release: { ...snapshot, text: undefined }, ledger });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/尚未完整|ICAO 缺失|内容为空|缺包|覆盖尚未完整/.test(message)) return res.status(409).json({ code: 'AIRPORT_NOT_PUBLISHABLE', error: message });
    next(error);
  }
});

router.get('/:taskId/recognition-v2/airport-publication/releases/:releaseId', async (req, res, next) => {
  try {
    const ledger = await readAirportPublicationLedger(dependencies, req.params.taskId);
    const release = ledger?.releases.find((item) => item.releaseId === req.params.releaseId);
    if (!release) return res.status(404).json({ code: 'AIRPORT_RELEASE_NOT_FOUND', error: '机场正式版本不存在。' });
    const snapshot = await dependencies.store.readPackageArtifact<AirportPublicationSnapshot>(req.params.taskId, AIRPORT_PUBLICATION_PACKAGE_ID, release.artifactFile);
    if (airportTextHash(snapshot.text) !== release.textHash || snapshot.textHash !== release.textHash) {
      return res.status(409).json({ code: 'AIRPORT_RELEASE_HASH_MISMATCH', error: '机场正式版本哈希校验失败。' });
    }
    res.json({ release: snapshot });
  } catch (error) { next(error); }
});

router.post('/:taskId/recognition-v2/airport-publication/rollback', async (req, res, next) => {
  try {
    const ledger = await readAirportPublicationLedger(dependencies, req.params.taskId);
    if (!ledger) return res.status(409).json({ code: 'NO_AIRPORT_RELEASE', error: '当前没有机场正式版本。' });
    const targetReleaseId = String(req.body?.targetReleaseId ?? '').trim() || undefined;
    const updated = rollbackAirportPublication(ledger, targetReleaseId);
    await dependencies.store.updatePackageArtifact<AirportPublicationLedger>(
      req.params.taskId, AIRPORT_PUBLICATION_PACKAGE_ID, AIRPORT_PUBLICATION_LEDGER_FILE, () => updated,
    );
    res.json({ ledger: updated });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/没有可回滚|没有可切换/.test(message)) return res.status(409).json({ code: 'AIRPORT_ROLLBACK_UNAVAILABLE', error: message });
    next(error);
  }
});

router.get('/:taskId/recognition-v2/airport-batch-status', async (req, res, next) => {
  try {
    const task = await dependencies.readTask(req.params.taskId);
    const groups = task.groups.filter((group) => group.procedureCategory !== 'UNKNOWN' && group.procedureNames.length > 0);
    const inputs = await Promise.all(groups.map(async (group) => {
      const packageId = packageIdOf(group);
      const runs = await dependencies.store.listRuns(task.taskId, packageId);
      const latest = runs.find((item) => item.status !== 'CANCELLED');
      const review = latest ? await readReviewDraft(dependencies, task.taskId, packageId, latest.runId) : undefined;
      const ledger = await readPublicationLedger(dependencies, task.taskId, packageId);
      const encoding = await inspectActiveReleaseEncoding(dependencies, task.taskId, packageId, ledger);
      return {
        packageId,
        packageName: group.packageName ?? group.groupName,
        runs,
        ledger,
        pendingReviewCount: review?.summary.pending,
        ...encoding,
      };
    }));
    res.json({ status: buildAirportBatchStatus(task.taskId, inputs) });
  } catch (error) { next(error); }
});

router.get('/:taskId/recognition-v2/airport-geojson-preview', async (req, res, next) => {
  try {
    const task = await dependencies.readTask(req.params.taskId);
    const features: Array<Record<string, unknown>> = [];
    const includedPackages: Array<{ packageId: string; packageName: string; releaseId: string; featureCount: number }> = [];
    const warnings: string[] = [];
    for (const group of task.groups.filter((item) => item.procedureCategory !== 'UNKNOWN' && item.procedureNames.length > 0)) {
      const packageId = packageIdOf(group);
      const ledger = await readPublicationLedger(dependencies, task.taskId, packageId);
      const active = ledger?.releases.find((item) => item.releaseId === ledger.activeReleaseId && item.status === 'ACTIVE');
      if (!active) continue;
      const encoding = await inspectActiveReleaseEncoding(dependencies, task.taskId, packageId, ledger);
      if (encoding.activeReleaseStale) {
        warnings.push(`${group.packageName ?? group.groupName}: 活动 424 版本已不符合当前编码器，重新识别发布前不进入机场 GeoJSON。`);
        continue;
      }
      const artifact = await dependencies.store.readArtifact<{ canonical: ProcedureUnderstandingResult }>(task.taskId, packageId, active.runId, active.artifactRef);
      const renderPlan = buildProcedureRenderPlan(artifact.canonical, group, [], 'AI');
      const geojson = buildGeoJsonFromProcedureUnderstanding(artifact.canonical, group, task.pages, { renderPlan, viewMode: 'TOPOLOGY' });
      const packageFeatures = geojson.features.map((feature) => ({
        ...feature,
        properties: { ...(feature.properties ?? {}), v2PackageId: packageId, v2PackageName: group.packageName ?? group.groupName, v2ReleaseId: active.releaseId },
      }));
      features.push(...packageFeatures);
      includedPackages.push({ packageId, packageName: group.packageName ?? group.groupName, releaseId: active.releaseId, featureCount: packageFeatures.length });
      warnings.push(...renderPlan.warnings.map((warning) => `${group.packageName ?? group.groupName}: ${warning}`));
    }
    const master = extractAirportMasterData(task.pages);
    const geojson = {
      type: 'FeatureCollection',
      features,
      metadata: {
        releaseScope: 'AIRPORT', airportIcao: master.airport?.icao, airportComplete: false,
        packageCount: task.groups.filter((item) => item.procedureCategory !== 'UNKNOWN' && item.procedureNames.length > 0).length,
        includedPackageCount: includedPackages.length, includedPackages, warnings,
        generatedAt: new Date().toISOString(),
      },
    };
    if (String(req.query.download ?? '') === '1') {
      res.type('application/geo+json').setHeader('Content-Disposition', `attachment; filename="${master.airport?.icao ?? task.taskId}-v2-airport-preview.geojson"`);
    }
    res.json(geojson);
  } catch (error) { next(error); }
});

router.post('/:taskId/packages/:packageId/recognition-v2/runs', async (req, res, next) => {
  try {
    const { task, group } = await loadPackage(dependencies, req.params.taskId, req.params.packageId);
    const sourcePackageHash = buildSourcePackageHash(task, group);
    const manifest = await dependencies.store.createRun({
      taskId: task.taskId,
      packageId: packageIdOf(group),
      sourcePackageHash,
    });
    await updateSummary(dependencies, manifest);
    res.status(201).json({
      run: manifest,
      runRef: dependencies.store.runReference(manifest.taskId, manifest.packageId, manifest.runId),
      executorsAvailable: ['PAGE_LAYOUT', 'PROCEDURE_IDENTITY', 'PROCEDURE_TABLE', 'WAYPOINT_NAVAID', 'NOTES_CONSTRAINTS', 'CHART_TOPOLOGY', 'EVIDENCE_FUSION', 'SEMANTIC_VALIDATION'],
    });
  } catch (error) {
    next(error);
  }
});

router.get('/:taskId/packages/:packageId/recognition-v2/runs', async (req, res, next) => {
  try {
    const { group } = await loadPackage(dependencies, req.params.taskId, req.params.packageId);
    const runs = await dependencies.store.listRuns(req.params.taskId, packageIdOf(group));
    res.json({ runs });
  } catch (error) {
    next(error);
  }
});

router.get('/:taskId/packages/:packageId/recognition-v2/runs/:runId', async (req, res, next) => {
  try {
    const { group } = await loadPackage(dependencies, req.params.taskId, req.params.packageId);
    const run = await dependencies.store.readRun(req.params.taskId, packageIdOf(group), req.params.runId);
    res.json({ run });
  } catch (error) {
    next(error);
  }
});

router.post('/:taskId/packages/:packageId/recognition-v2/runs/:runId/cancel', async (req, res, next) => {
  try {
    const { group } = await loadPackage(dependencies, req.params.taskId, req.params.packageId);
    const packageId = packageIdOf(group);
    activeExecutions.get(executionKey(req.params.taskId, packageId, req.params.runId))?.abort(new Error('Recognition V2 run cancelled.'));
    const run = await dependencies.store.updateRun(req.params.taskId, packageId, req.params.runId, (current) => cancelRun(current));
    await updateSummary(dependencies, run);
    res.json({ run });
  } catch (error) {
    sendStateError(error, res, next);
  }
});

router.post('/:taskId/packages/:packageId/recognition-v2/runs/:runId/stages/:stage/skip', async (req, res, next) => {
  try {
    const stageValue = String(req.params.stage ?? '').toUpperCase();
    if (!isRecognitionV2Stage(stageValue)) {
      return res.status(400).json({ code: 'UNKNOWN_V2_STAGE', error: `Unknown Recognition V2 stage: ${req.params.stage}` });
    }
    if (!['CHART_TOPOLOGY'].includes(stageValue)) {
      return res.status(400).json({ code: 'V2_STAGE_NOT_SKIPPABLE', error: `Stage ${stageValue} cannot be skipped through this API.` });
    }
    const reason = String(req.body?.reason ?? '').trim();
    if (!reason) return res.status(400).json({ code: 'SKIP_REASON_REQUIRED', error: `Stage ${stageValue} requires a non-empty skip reason.` });
    const { task, group } = await loadPackage(dependencies, req.params.taskId, req.params.packageId);
    const packageId = packageIdOf(group);
    const current = await dependencies.store.readRun(task.taskId, packageId, req.params.runId);
    const currentSourceHash = buildSourcePackageHash(task, group);
    if (currentSourceHash !== current.sourcePackageHash) {
      return res.status(409).json({ code: 'SOURCE_PACKAGE_CHANGED', error: 'The procedure package changed after this V2 run was created. Create a new run.' });
    }
    const run = await dependencies.store.updateRun(task.taskId, packageId, current.runId, (manifest) => skipStage(manifest, stageValue, { reason }));
    await updateSummary(dependencies, run);
    return res.json({ run, stage: stageValue, skipped: true, reason });
  } catch (error) {
    sendStateError(error, res, next);
  }
});

router.post('/:taskId/packages/:packageId/recognition-v2/runs/:runId/stages/:stage/run', async (req, res, next) => {
  let started = false;
  let stage: RecognitionV2Stage | undefined;
  let packageId: string | undefined;
  const abortController = new AbortController();
  try {
    const stageValue = String(req.params.stage ?? '').toUpperCase();
    if (!isRecognitionV2Stage(stageValue)) {
      return res.status(400).json({ code: 'UNKNOWN_V2_STAGE', error: `Unknown Recognition V2 stage: ${req.params.stage}` });
    }
    stage = stageValue;
    const { task, group } = await loadPackage(dependencies, req.params.taskId, req.params.packageId);
    packageId = packageIdOf(group);
    const run = await dependencies.store.readRun(task.taskId, packageId, req.params.runId);
    const currentSourceHash = buildSourcePackageHash(task, group);
    if (currentSourceHash !== run.sourcePackageHash) {
      return res.status(409).json({
        code: 'SOURCE_PACKAGE_CHANGED',
        error: 'The procedure package changed after this V2 run was created. Create a new run.',
        runSourcePackageHash: run.sourcePackageHash,
        currentSourcePackageHash: currentSourceHash,
      });
    }
    assertStageCanStart(run, stage);
    if (!['PAGE_LAYOUT', 'PROCEDURE_IDENTITY', 'PROCEDURE_TABLE', 'WAYPOINT_NAVAID', 'NOTES_CONSTRAINTS', 'CHART_TOPOLOGY', 'EVIDENCE_FUSION', 'SEMANTIC_VALIDATION'].includes(stage)) {
      return res.status(501).json({
        code: 'V2_STAGE_EXECUTOR_NOT_AVAILABLE',
        error: `Stage ${stage} is ready, but its executor is not implemented yet.`,
        stage,
        ready: true,
        runStatus: run.status,
      });
    }

    const deterministicStage = stage === 'EVIDENCE_FUSION' || stage === 'SEMANTIC_VALIDATION';
    const model = deterministicStage ? 'deterministic-rules' : String(req.body?.model || getLlmRuntimeConfig().model);
    const useModel = deterministicStage ? false : typeof req.body?.useModel === 'boolean' ? req.body.useModel : Boolean(getLlmRuntimeConfig(model).apiKey);
    const dependencyFingerprint = STAGE_DEPENDENCIES[stage].map((dependency) => {
      const record = run.stages.find((item) => item.stage === dependency);
      return {
        stage: dependency,
        inputHash: record?.inputHash,
        outputRef: record?.outputRef,
        completedAt: record?.completedAt,
        status: record?.status,
        skipReason: record?.skipReason,
      };
    });
    const stageInputHash = hashStageInput(run.sourcePackageHash, stage, model, useModel, dependencyFingerprint);
    const running = await dependencies.store.updateRun(task.taskId, packageId, run.runId, (current) =>
      startStage(current, stage!, { inputHash: stageInputHash }));
    const key = executionKey(task.taskId, packageId, run.runId);
    activeExecutions.set(key, abortController);
    started = true;
    await updateSummary(dependencies, running);
    const attempt = running.stages.find((item) => item.stage === stage)?.attempt ?? 1;
    const auditRefs: string[] = [];
    const persistAuditArtifact = async (artifact: { fileName: string; value: unknown }) => {
      auditRefs.push(await dependencies.store.writeArtifact(
        task.taskId,
        packageId!,
        run.runId,
        artifactNameForAttempt(artifact.fileName, attempt),
        artifact.value,
      ));
    };

    const execution = stage === 'PAGE_LAYOUT'
      ? await executePageLayout({
        task,
        group,
        model,
        useModel,
        stageInputHash,
        abortSignal: abortController.signal,
        visionClient: dependencies.visionClient,
        onAuditArtifact: persistAuditArtifact,
      })
      : ['PROCEDURE_IDENTITY', 'PROCEDURE_TABLE', 'WAYPOINT_NAVAID', 'NOTES_CONSTRAINTS', 'CHART_TOPOLOGY'].includes(stage)
        ? await executeExtractionFromStoredLayout(dependencies, {
        task,
        group,
        run: running,
        stage,
        model,
        useModel,
        stageInputHash,
        abortSignal: abortController.signal,
        onAuditArtifact: persistAuditArtifact,
      })
        : stage === 'EVIDENCE_FUSION'
          ? await executeFusionFromStoredExtractions(dependencies, { task, group, run: running })
          : await executeValidationFromStoredFusion(dependencies, { task, group, run: running });

    for (const artifact of execution.auditArtifacts) {
      await persistAuditArtifact(artifact);
    }
    const outputFile = artifactNameForAttempt(
      stageOutputFile(stage),
      attempt,
    );
    const outputRef = await dependencies.store.writeArtifact(task.taskId, packageId, run.runId, outputFile, execution.output);
    const validation = stage === 'SEMANTIC_VALIDATION' ? execution.output as ValidationStageResult : undefined;
    const fusion = stage === 'EVIDENCE_FUSION' ? execution.output as FusionStageResult : undefined;
    const completed = await dependencies.store.updateRun(task.taskId, packageId, run.runId, (current) =>
      completeStage(current, stage!, {
        outputRef,
        releaseDecision: validation?.releaseDecision,
        ruleVersions: validation?.ruleVersions ?? fusion?.policyVersions,
      }));
    await updateSummary(dependencies, completed);
    return res.json({
      run: completed,
      stage,
      outputRef,
      auditRefs,
      result: execution.output,
      modelRequested: useModel,
      usedModel: useModel && auditRefs.some((ref) => ref.includes('model')),
    });
  } catch (error) {
    if (started && stage && packageId) {
      try {
        const current = await dependencies.store.readRun(req.params.taskId, packageId, req.params.runId);
        const record = current.stages.find((item) => item.stage === stage);
        if (record?.status === 'RUNNING') {
          const failed = await dependencies.store.updateRun(req.params.taskId, packageId, req.params.runId, (value) =>
            failStage(value, stage!, {
              code: abortController.signal.aborted ? 'STAGE_CANCELLED' : 'STAGE_EXECUTION_FAILED',
              message: error instanceof Error ? error.message : String(error),
              retryable: true,
            }));
          await updateSummary(dependencies, failed);
        }
      } catch {
        // Preserve the original stage error.
      }
    }
    if (abortController.signal.aborted) return res.status(499).json({ code: 'V2_STAGE_CANCELLED', error: 'Recognition V2 stage was cancelled.' });
    sendStateError(error, res, next);
  } finally {
    if (packageId) {
      const key = executionKey(req.params.taskId, packageId, req.params.runId);
      if (activeExecutions.get(key) === abortController) activeExecutions.delete(key);
    }
  }
});

router.get('/:taskId/packages/:packageId/recognition-v2/runs/:runId/review', async (req, res, next) => {
  try {
    const { group } = await loadPackage(dependencies, req.params.taskId, req.params.packageId);
    const packageId = packageIdOf(group);
    const run = await dependencies.store.readRun(req.params.taskId, packageId, req.params.runId);
    const completedRef = run.stages.find((item) => item.stage === 'HUMAN_REVIEW' && item.status === 'COMPLETED')?.outputRef;
    const review = completedRef
      ? await dependencies.store.readArtifact<HumanReviewStageResult>(req.params.taskId, packageId, run.runId, completedRef)
      : await readReviewDraft(dependencies, req.params.taskId, packageId, run.runId);
    if (!review) return res.status(404).json({ code: 'HUMAN_REVIEW_NOT_INITIALIZED', error: 'Human review has not been initialized.' });
    await assertValidHumanReviewStageResult(review);
    return res.json({ review });
  } catch (error) {
    next(error);
  }
});

router.post('/:taskId/packages/:packageId/recognition-v2/runs/:runId/review/initialize', async (req, res, next) => {
  try {
    const { task, group } = await loadPackage(dependencies, req.params.taskId, req.params.packageId);
    const packageId = packageIdOf(group);
    const run = await dependencies.store.readRun(task.taskId, packageId, req.params.runId);
    const completedRef = run.stages.find((item) => item.stage === 'HUMAN_REVIEW' && item.status === 'COMPLETED')?.outputRef;
    if (completedRef) {
      const review = await dependencies.store.readArtifact<HumanReviewStageResult>(task.taskId, packageId, run.runId, completedRef);
      return res.json({ review, run });
    }
    assertStageCanStart(run, 'HUMAN_REVIEW');
    const inputs = await loadHumanReviewInputs(dependencies, task.taskId, packageId, run);
    const existing = await readReviewDraft(dependencies, task.taskId, packageId, run.runId);
    const reusable = existing?.baselineFusionRef === inputs.fusionRef && existing.baselineValidationRef === inputs.validationRef ? existing : undefined;
    const builtReview = await buildHumanReviewWorkspace({
      runId: run.runId,
      packageId,
      baselineFusionRef: inputs.fusionRef,
      baselineValidationRef: inputs.validationRef,
      fusion: inputs.fusion,
      validation: inputs.validation,
      extractions: inputs.extractions,
      existing: req.body?.reset === true ? undefined : reusable,
    });
    const ledger = req.body?.reuseDecisions === false ? undefined : await readReviewReuseLedger(dependencies, task.taskId, packageId);
    const review = await applyReusableReviewDecisions({ workspace: builtReview, ledger, sourcePackageHash: run.sourcePackageHash });
    await dependencies.store.writeArtifact(task.taskId, packageId, run.runId, 'human-review-draft.json', review);
    return res.status(existing ? 200 : 201).json({ review, run });
  } catch (error) {
    sendStateError(error, res, next);
  }
});

router.patch('/:taskId/packages/:packageId/recognition-v2/runs/:runId/review/items/:reviewItemId', async (req, res, next) => {
  try {
    const { task, group } = await loadPackage(dependencies, req.params.taskId, req.params.packageId);
    const packageId = packageIdOf(group);
    const run = await dependencies.store.readRun(task.taskId, packageId, req.params.runId);
    if (run.stages.find((item) => item.stage === 'HUMAN_REVIEW')?.status === 'COMPLETED') {
      return res.status(409).json({ code: 'HUMAN_REVIEW_COMPLETED', error: 'Completed human review cannot be edited.' });
    }
    const current = await readReviewDraft(dependencies, task.taskId, packageId, run.runId);
    if (!current) return res.status(409).json({ code: 'HUMAN_REVIEW_NOT_INITIALIZED', error: 'Initialize human review before recording decisions.' });
    if (req.body?.expectedUpdatedAt && req.body.expectedUpdatedAt !== current.updatedAt) {
      return res.status(409).json({ code: 'HUMAN_REVIEW_CHANGED', error: 'The review queue changed; refresh before saving.', review: current });
    }
    const status = String(req.body?.status ?? '').toUpperCase();
    if (status !== 'CONFIRMED' && status !== 'CORRECTED') {
      return res.status(400).json({ code: 'INVALID_REVIEW_DECISION', error: 'Review status must be CONFIRMED or CORRECTED.' });
    }
    const review = await recordHumanReviewDecision({
      workspace: current,
      reviewItemId: req.params.reviewItemId,
      status,
      correctedValue: req.body?.correctedValue,
      reviewer: String(req.body?.reviewer ?? '').trim() || 'REVIEW_UI',
      note: typeof req.body?.note === 'string' ? req.body.note : undefined,
    });
    await dependencies.store.writeArtifact(task.taskId, packageId, run.runId, 'human-review-draft.json', review);
    await persistReviewReuseLedger(dependencies, task.taskId, packageId, run.sourcePackageHash, review);
    return res.json({ review });
  } catch (error) {
    if (error instanceof Error && /Reviewer|required|correction|selected value|source evidence|not found/i.test(error.message)) {
      return res.status(400).json({ code: 'INVALID_REVIEW_DECISION', error: error.message });
    }
    next(error);
  }
});

router.patch('/:taskId/packages/:packageId/recognition-v2/runs/:runId/review/batch', async (req, res, next) => {
  try {
    const { task, group } = await loadPackage(dependencies, req.params.taskId, req.params.packageId);
    const packageId = packageIdOf(group);
    const run = await dependencies.store.readRun(task.taskId, packageId, req.params.runId);
    if (run.stages.find((item) => item.stage === 'HUMAN_REVIEW')?.status === 'COMPLETED') {
      return res.status(409).json({ code: 'HUMAN_REVIEW_COMPLETED', error: 'Completed human review cannot be edited.' });
    }
    const current = await readReviewDraft(dependencies, task.taskId, packageId, run.runId);
    if (!current) return res.status(409).json({ code: 'HUMAN_REVIEW_NOT_INITIALIZED', error: 'Initialize human review before recording decisions.' });
    if (req.body?.expectedUpdatedAt && req.body.expectedUpdatedAt !== current.updatedAt) {
      return res.status(409).json({ code: 'HUMAN_REVIEW_CHANGED', error: 'The review queue changed; refresh before saving.', review: current });
    }
    const rawDecisions = Array.isArray(req.body?.decisions) ? req.body.decisions : [];
    if (!rawDecisions.length) return res.status(400).json({ code: 'REVIEW_BATCH_REQUIRED', error: 'At least one review decision is required.' });
    const decisions = rawDecisions.map((item: Record<string, unknown>) => ({
      reviewItemId: String(item.reviewItemId ?? ''),
      status: String(item.status ?? '').toUpperCase() as 'CONFIRMED' | 'CORRECTED',
      correctedValue: item.correctedValue,
      note: typeof item.note === 'string' ? item.note : undefined,
    }));
    if (decisions.some((item) => !item.reviewItemId || !['CONFIRMED', 'CORRECTED'].includes(item.status))) {
      return res.status(400).json({ code: 'INVALID_REVIEW_DECISION', error: 'Every batch item requires an id and CONFIRMED or CORRECTED status.' });
    }
    const review = await recordHumanReviewDecisions({
      workspace: current,
      decisions,
      reviewer: String(req.body?.reviewer ?? '').trim() || 'REVIEW_UI',
    });
    await dependencies.store.writeArtifact(task.taskId, packageId, run.runId, 'human-review-draft.json', review);
    await persistReviewReuseLedger(dependencies, task.taskId, packageId, run.sourcePackageHash, review);
    return res.json({ review, updatedItemCount: decisions.length });
  } catch (error) {
    if (error instanceof Error && /Reviewer|required|correction|selected value|source evidence|not found|duplicate items/i.test(error.message)) {
      return res.status(400).json({ code: 'INVALID_REVIEW_BATCH', error: error.message });
    }
    next(error);
  }
});

router.post('/:taskId/packages/:packageId/recognition-v2/runs/:runId/review/complete', async (req, res, next) => {
  let started = false;
  let packageId = '';
  try {
    const { task, group } = await loadPackage(dependencies, req.params.taskId, req.params.packageId);
    packageId = packageIdOf(group);
    const run = await dependencies.store.readRun(task.taskId, packageId, req.params.runId);
    assertStageCanStart(run, 'HUMAN_REVIEW');
    const review = await readReviewDraft(dependencies, task.taskId, packageId, run.runId);
    if (!review) return res.status(409).json({ code: 'HUMAN_REVIEW_NOT_INITIALIZED', error: 'Initialize human review before completion.' });
    if (req.body?.expectedUpdatedAt && req.body.expectedUpdatedAt !== review.updatedAt) {
      return res.status(409).json({ code: 'HUMAN_REVIEW_CHANGED', error: 'The review queue changed; refresh before completion.', review });
    }
    const inputs = await loadHumanReviewInputs(dependencies, task.taskId, packageId, run);
    if (review.baselineFusionRef !== inputs.fusionRef || review.baselineValidationRef !== inputs.validationRef) {
      return res.status(409).json({ code: 'HUMAN_REVIEW_BASELINE_CHANGED', error: 'Fusion or validation was rerun. Reinitialize human review.' });
    }
    let result;
    try {
      result = await applyCompletedHumanReview({ workspace: review, fusion: inputs.fusion });
    } catch (error) {
      return res.status(409).json({ code: 'HUMAN_REVIEW_PENDING', error: error instanceof Error ? error.message : String(error), review });
    }
    if (result.validation.releaseDecision !== 'READY') {
      const refreshed = await buildHumanReviewWorkspace({
        runId: run.runId,
        packageId,
        baselineFusionRef: inputs.fusionRef,
        baselineValidationRef: inputs.validationRef,
        fusion: result.fusion,
        validation: result.validation,
        extractions: inputs.extractions,
        existing: result.workspace,
      });
      refreshed.reviewedValidation = result.validation;
      await dependencies.store.writeArtifact(task.taskId, packageId, run.runId, 'human-review-draft.json', refreshed);
      return res.status(409).json({ code: 'HUMAN_REVIEW_NEW_ISSUES', error: 'Corrections produced unresolved validation issues. Review the refreshed queue.', review: refreshed, validation: result.validation });
    }

    const inputHash = hashStageInput(run.sourcePackageHash, 'HUMAN_REVIEW', 'human-review', false, {
      baselineFusionRef: inputs.fusionRef,
      baselineValidationRef: inputs.validationRef,
      reviewUpdatedAt: result.workspace.updatedAt,
      auditEventCount: result.workspace.auditTrail.length,
    });
    const running = await dependencies.store.updateRun(task.taskId, packageId, run.runId, (current) => startStage(current, 'HUMAN_REVIEW', { inputHash }));
    started = true;
    const attempt = running.stages.find((item) => item.stage === 'HUMAN_REVIEW')?.attempt ?? 1;
    const reviewedFusionRef = await dependencies.store.writeArtifact(task.taskId, packageId, run.runId, artifactNameForAttempt('reviewed-fusion.json', attempt), result.fusion);
    const reviewedValidationRef = await dependencies.store.writeArtifact(task.taskId, packageId, run.runId, artifactNameForAttempt('reviewed-validation.json', attempt), result.validation);
    const { preview, diff } = await buildCanonicalPreview({ fusion: result.fusion, releaseDecision: 'READY', v1: group.procedureUnderstanding, now: result.workspace.completedAt });
    const canonicalPreviewRef = await dependencies.store.writeArtifact(task.taskId, packageId, run.runId, artifactNameForAttempt('canonical-preview-reviewed.json', attempt), preview);
    const diffRef = await dependencies.store.writeArtifact(task.taskId, packageId, run.runId, artifactNameForAttempt('v1-v2-diff-reviewed.json', attempt), diff);
    const finalReview: HumanReviewStageResult = {
      ...result.workspace,
      reviewedFusionRef,
      reviewedValidationRef,
      canonicalPreviewRef,
      diffRef,
    };
    await assertValidHumanReviewStageResult(finalReview);
    const outputRef = await dependencies.store.writeArtifact(task.taskId, packageId, run.runId, artifactNameForAttempt('human-review-stage.json', attempt), finalReview);
    const completed = await dependencies.store.updateRun(task.taskId, packageId, run.runId, (current) => completeStage(current, 'HUMAN_REVIEW', {
      outputRef,
      releaseDecision: 'READY',
      ruleVersions: result.validation.ruleVersions,
    }));
    await updateSummary(dependencies, completed);
    return res.json({ run: completed, review: finalReview, validation: result.validation, preview, diff });
  } catch (error) {
    if (started && packageId) {
      try {
        await dependencies.store.updateRun(req.params.taskId, packageId, req.params.runId, (current) => failStage(current, 'HUMAN_REVIEW', {
          code: 'HUMAN_REVIEW_COMPLETION_FAILED',
          message: error instanceof Error ? error.message : String(error),
          retryable: true,
        }));
      } catch {
        // Preserve the original completion error.
      }
    }
    sendStateError(error, res, next);
  }
});

router.get('/:taskId/packages/:packageId/recognition-v2/runs/:runId/artifacts/:fileName', async (req, res, next) => {
  try {
    const { group } = await loadPackage(dependencies, req.params.taskId, req.params.packageId);
    const value = await dependencies.store.readArtifact(
      req.params.taskId,
      packageIdOf(group),
      req.params.runId,
      `artifacts/${req.params.fileName}`,
    );
    res.json(value);
  } catch (error) {
    next(error);
  }
});

router.get('/:taskId/packages/:packageId/recognition-v2/runs/:runId/publication', async (req, res, next) => {
  try {
    const { group } = await loadPackage(dependencies, req.params.taskId, req.params.packageId);
    const packageId = packageIdOf(group);
    const run = await dependencies.store.readRun(req.params.taskId, packageId, req.params.runId);
    const storedWorkspace = await readPublicationWorkspace(dependencies, req.params.taskId, packageId, req.params.runId);
    const currentReviewRef = run.stages.find((item) => item.stage === 'HUMAN_REVIEW' && item.status === 'COMPLETED')?.outputRef;
    const workspace = storedWorkspace && (run.status === 'APPROVED' || run.status === 'COMPLETED') && currentReviewRef === storedWorkspace.lock.reviewOutputRef
      ? storedWorkspace
      : storedWorkspace ? { ...storedWorkspace, status: 'STALE' as const } : undefined;
    const ledger = await readPublicationLedger(dependencies, req.params.taskId, packageId);
    const encoding = await inspectActiveReleaseEncoding(dependencies, req.params.taskId, packageId, ledger);
    res.json({ workspace, ledger, ...encoding });
  } catch (error) { next(error); }
});

router.post('/:taskId/packages/:packageId/recognition-v2/runs/:runId/publication/lock', async (req, res, next) => {
  try {
    const { task, group } = await loadPackage(dependencies, req.params.taskId, req.params.packageId);
    const packageId = packageIdOf(group);
    const run = await dependencies.store.readRun(task.taskId, packageId, req.params.runId);
    if (run.status !== 'APPROVED') return res.status(409).json({ code: 'RUN_NOT_APPROVED', error: '只有 APPROVED 的 V2 Run 可以进入发布锁定。' });
    const reviewRecord = run.stages.find((item) => item.stage === 'HUMAN_REVIEW');
    if (reviewRecord?.status !== 'COMPLETED' || !reviewRecord.outputRef) return res.status(409).json({ code: 'REVIEW_NOT_COMPLETED', error: '人工发布审核尚未完成。' });
    const review = await dependencies.store.readArtifact<HumanReviewStageResult>(task.taskId, packageId, run.runId, reviewRecord.outputRef);
    if (!review.canonicalPreviewRef) return res.status(409).json({ code: 'READY_PREVIEW_MISSING', error: '审核结果缺少 READY canonical 快照。' });
    const currentHash = buildSourcePackageHash(task, group);
    if (currentHash !== run.sourcePackageHash) return res.status(409).json({ code: 'SOURCE_CHANGED', error: '源文件在审核后已变化，请重新运行 V2。' });
    const preview = await dependencies.store.readArtifact<CanonicalPreviewArtifact>(task.taskId, packageId, run.runId, review.canonicalPreviewRef);
    const existing = await readPublicationWorkspace(dependencies, task.taskId, packageId, run.runId);
    if (existing && existing.lock.canonicalHash === contentHash(preview.procedureUnderstanding) && existing.lock.sourcePackageHash === currentHash) return res.json({ workspace: existing, reused: true });
    const workspace = createPublicationLock({ taskId: task.taskId, packageId, runId: run.runId, sourcePackageHash: currentHash, canonicalPreviewRef: review.canonicalPreviewRef, reviewOutputRef: reviewRecord.outputRef, preview });
    await assertValidPublicationWorkspace(workspace);
    await dependencies.store.writeArtifact(task.taskId, packageId, run.runId, PUBLICATION_WORKSPACE_FILE, workspace);
    res.status(201).json({ workspace, reused: false });
  } catch (error) { sendPublicationError(error, res, next); }
});

router.post('/:taskId/packages/:packageId/recognition-v2/runs/:runId/publication/preflight', async (req, res, next) => {
  try {
    const context = await loadPublicationContext(dependencies, req.params.taskId, req.params.packageId, req.params.runId);
    const workspace = runPublicationPreflight({ workspace: context.workspace, preview: context.preview, currentSourcePackageHash: buildSourcePackageHash(context.task, context.group), runApproved: context.run.status === 'APPROVED' });
    await savePublicationWorkspace(dependencies, workspace);
    res.json({ workspace });
  } catch (error) { sendPublicationError(error, res, next); }
});

router.post('/:taskId/packages/:packageId/recognition-v2/runs/:runId/publication/dry-run', async (req, res, next) => {
  try {
    const context = await loadPublicationContext(dependencies, req.params.taskId, req.params.packageId, req.params.runId);
    const workspace = createDryRun(context.workspace, context.preview);
    await savePublicationWorkspace(dependencies, workspace);
    res.json({ workspace });
  } catch (error) { sendPublicationError(error, res, next); }
});

router.post('/:taskId/packages/:packageId/recognition-v2/runs/:runId/publication/diff', async (req, res, next) => {
  try {
    const context = await loadPublicationContext(dependencies, req.params.taskId, req.params.packageId, req.params.runId);
    const workspace = inspectDryRunDiff(context.workspace, context.preview);
    await savePublicationWorkspace(dependencies, workspace);
    res.json({ workspace });
  } catch (error) { sendPublicationError(error, res, next); }
});

router.post('/:taskId/packages/:packageId/recognition-v2/runs/:runId/publication/diff/accept', async (req, res, next) => {
  try {
    const context = await loadPublicationContext(dependencies, req.params.taskId, req.params.packageId, req.params.runId);
    const workspace = acceptDryRunDiff(context.workspace);
    await savePublicationWorkspace(dependencies, workspace);
    res.json({ workspace });
  } catch (error) { sendPublicationError(error, res, next); }
});

router.get('/:taskId/packages/:packageId/recognition-v2/runs/:runId/publication/dry-run.txt', async (req, res, next) => {
  try {
    const { group } = await loadPackage(dependencies, req.params.taskId, req.params.packageId);
    const workspace = await readPublicationWorkspace(dependencies, req.params.taskId, packageIdOf(group), req.params.runId);
    if (!workspace?.dryRun) return res.status(404).json({ code: 'DRY_RUN_MISSING', error: '尚未生成 dry-run。' });
    res.type('text/plain').setHeader('Content-Disposition', `attachment; filename="${packageIdOf(group)}-dry-run.424.txt"`);
    res.send(workspace.dryRun.text);
  } catch (error) { next(error); }
});

router.post('/:taskId/packages/:packageId/recognition-v2/runs/:runId/publication/compare-reference', async (req, res, next) => {
  try {
    const { group } = await loadPackage(dependencies, req.params.taskId, req.params.packageId);
    const workspace = await readPublicationWorkspace(dependencies, req.params.taskId, packageIdOf(group), req.params.runId);
    if (!workspace?.dryRun) return res.status(409).json({ code: 'DRY_RUN_MISSING', error: 'Generate the V2 424 dry-run before comparing a reference file.' });
    const referenceText = String(req.body?.text ?? '');
    if (!referenceText.trim()) return res.status(400).json({ code: 'REFERENCE_424_REQUIRED', error: 'Paste Jeppesen 424 text before comparison.' });
    if (referenceText.length > 5_000_000) return res.status(413).json({ code: 'REFERENCE_424_TOO_LARGE', error: 'Reference 424 text exceeds the 5 MB comparison limit.' });
    return res.json({ comparison: compareArinc424Fields(workspace.dryRun.text, referenceText) });
  } catch (error) { sendPublicationError(error, res, next); }
});

router.get('/:taskId/packages/:packageId/recognition-v2/runs/:runId/geojson-preview', async (req, res, next) => {
  try {
    const { task, group } = await loadPackage(dependencies, req.params.taskId, req.params.packageId);
    const packageId = packageIdOf(group);
    const run = await dependencies.store.readRun(task.taskId, packageId, req.params.runId);
    if (!['APPROVED', 'COMPLETED'].includes(run.status)) {
      return res.status(409).json({ code: 'READY_REQUIRED', error: '只有完成关键字段审核并达到 READY 的 V2 Run 才能生成发布前 GeoJSON 预览。' });
    }
    const reviewRecord = run.stages.find((item) => item.stage === 'HUMAN_REVIEW' && item.status === 'COMPLETED');
    if (!reviewRecord?.outputRef) return res.status(409).json({ code: 'REVIEW_NOT_COMPLETED', error: '人工审核尚未完成。' });
    const review = await dependencies.store.readArtifact<HumanReviewStageResult>(task.taskId, packageId, run.runId, reviewRecord.outputRef);
    if (!review.canonicalPreviewRef) return res.status(409).json({ code: 'READY_PREVIEW_MISSING', error: '审核结果缺少 READY canonical 快照。' });
    const preview = await dependencies.store.readArtifact<CanonicalPreviewArtifact>(task.taskId, packageId, run.runId, review.canonicalPreviewRef);
    const canonical = preview.procedureUnderstanding as ProcedureUnderstandingResult;
    const renderPlan = buildProcedureRenderPlan(canonical, group, [], 'AI');
    const geojson = buildGeoJsonFromProcedureUnderstanding(canonical, group, task.pages, { renderPlan, viewMode: 'TOPOLOGY' });
    const expectedLegCount = canonical.tableLegs?.length ?? canonical.procedures?.reduce((sum, procedure) => sum + (procedure.legs?.length ?? 0), 0) ?? 0;
    const validation = validateProcedureGeoJson(geojson, group, {
      airportIcao: canonical.airportIcao ?? undefined,
      runway: canonical.runway ?? undefined,
      minimumProcedureLegCount: Math.max(1, expectedLegCount - 1),
      requireProcedureTrack: expectedLegCount > 1,
    });
    if (!validation.valid) return res.status(422).json({ code: 'INVALID_GEOJSON_PREVIEW', error: validation.errors.join('; '), validation });
    if (String(req.query.download ?? '') === '1') {
      res.type('application/geo+json').setHeader('Content-Disposition', `attachment; filename="${packageId}-${run.runId}-preview.geojson"`);
    }
    res.json(geojson);
  } catch (error) { next(error); }
});

router.get('/:taskId/packages/:packageId/recognition-v2/publication/releases/:releaseId/file', async (req, res, next) => {
  try {
    const { task, group } = await loadPackage(dependencies, req.params.taskId, req.params.packageId);
    const packageId = packageIdOf(group);
    const ledger = await readPublicationLedger(dependencies, task.taskId, packageId);
    const release = ledger?.releases.find((item) => item.releaseId === req.params.releaseId);
    if (!release) return res.status(404).json({ code: 'RELEASE_NOT_FOUND', error: '正式发布版本不存在。' });
    const artifact = await dependencies.store.readArtifact<{ text: string; textHash: string }>(task.taskId, packageId, release.runId, release.artifactRef);
    if (contentHash(artifact.text) !== release.textHash || artifact.textHash !== release.textHash) {
      return res.status(409).json({ code: 'RELEASE_HASH_MISMATCH', error: '正式 424 文件哈希校验失败。' });
    }
    res.type('text/plain').setHeader('Content-Disposition', `attachment; filename="${release.releaseId}.424.txt"`);
    res.send(artifact.text);
  } catch (error) { next(error); }
});

router.post('/:taskId/packages/:packageId/recognition-v2/runs/:runId/publication/publish', async (req, res, next) => {
  try {
    const context = await loadPublicationContext(dependencies, req.params.taskId, req.params.packageId, req.params.runId);
    const currentSourceHash = buildSourcePackageHash(context.task, context.group);
    assertPublishable(context.workspace, context.preview, currentSourceHash);
    if (context.run.status !== 'APPROVED') throw new Error('V2 Run 当前不是 APPROVED，不能正式发布。');
    const releaseId = `release_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
    const previousCanonical = context.group.procedureUnderstanding;
    const canonical = context.preview.procedureUnderstanding as ProcedureUnderstandingResult;
    const releaseArtifact = { releaseId, taskId: context.task.taskId, packageId: context.packageId, runId: context.run.runId, lockId: context.workspace.lock.lockId, canonicalHash: context.workspace.lock.canonicalHash, textHash: context.workspace.dryRun!.textHash, canonical, previousCanonical, text: context.workspace.dryRun!.text, publishedAt: new Date().toISOString() };
    const artifactRef = await dependencies.store.writeArtifact(context.task.taskId, context.packageId, context.run.runId, `${releaseId}.json`, releaseArtifact);
    await dependencies.updateTask(context.task.taskId, (task) => {
      const group = task.groups.find((item) => item.groupId === context.packageId || item.packageId === context.packageId);
      if (!group) throw new Error('分组不存在。');
      group.procedureUnderstanding = canonical;
      const renderPlan = buildProcedureRenderPlan(canonical, group, [], 'AI');
      const geojson = buildGeoJsonFromProcedureUnderstanding(canonical, group, context.task.pages, { renderPlan, viewMode: 'TOPOLOGY' });
      const expectedLegCount = canonical.tableLegs?.length ?? canonical.procedures?.reduce((sum, procedure) => sum + (procedure.legs?.length ?? 0), 0) ?? 0;
      const geojsonValidation = validateProcedureGeoJson(geojson, group, {
        airportIcao: canonical.airportIcao ?? undefined,
        runway: canonical.runway ?? undefined,
        minimumProcedureLegCount: Math.max(1, expectedLegCount - 1),
        requireProcedureTrack: expectedLegCount > 1,
      });
      if (!geojsonValidation.valid) throw new Error(`V2 GeoJSON 发布预览无效：${geojsonValidation.errors.join('; ')}`);
      group.geojson = geojson;
      group.geojsonStatus = 'GENERATED';
      group.geojsonGeneratedAt = releaseArtifact.publishedAt;
      group.geojsonRenderMode = 'AI';
      group.geojsonRenderSummary = {
        requestedMode: renderPlan.requestedMode,
        source: renderPlan.source,
        canonicalProcedureCount: renderPlan.canonicalProcedureCount,
        canonicalLegCount: renderPlan.canonicalLegCount,
        aiProcedureCount: renderPlan.aiProcedureCount,
        warnings: renderPlan.warnings,
      };
    });
    const ledger = await dependencies.store.updatePackageArtifact<PublicationLedger>(context.task.taskId, context.packageId, PUBLICATION_LEDGER_FILE, (current) => addPublishedRelease(current, { releaseId, runId: context.run.runId, artifactRef, canonicalHash: releaseArtifact.canonicalHash, textHash: releaseArtifact.textHash, status: 'ACTIVE', publishedAt: releaseArtifact.publishedAt }));
    const running = await dependencies.store.updateRun(context.task.taskId, context.packageId, context.run.runId, (run) => startStage(run, 'PUBLISH_CANONICAL', { inputHash: contentHash({ lockId: context.workspace.lock.lockId, textHash: releaseArtifact.textHash }) }));
    const completed = await dependencies.store.updateRun(context.task.taskId, context.packageId, context.run.runId, (run) => completeStage(run, 'PUBLISH_CANONICAL', { outputRef: artifactRef, canonicalRef: artifactRef, releaseDecision: 'READY', ruleVersions: { 'phase6.release-gate': '1.0.0' } }));
    const workspace: PublicationWorkspace = { ...context.workspace, status: 'PUBLISHED', publishedReleaseId: releaseId, updatedAt: completed.updatedAt };
    await savePublicationWorkspace(dependencies, workspace);
    await updateSummary(dependencies, completed);
    res.json({ run: completed, workspace, ledger, release: releaseArtifact });
  } catch (error) { sendPublicationError(error, res, next); }
});

router.post('/:taskId/packages/:packageId/recognition-v2/runs/:runId/publication/reencode', async (req, res, next) => {
  try {
    const { task, group } = await loadPackage(dependencies, req.params.taskId, req.params.packageId);
    const packageId = packageIdOf(group);
    const ledger = await readPublicationLedger(dependencies, task.taskId, packageId);
    const active = ledger?.releases.find((item) => item.releaseId === ledger.activeReleaseId && item.status === 'ACTIVE');
    if (!ledger || !active) return res.status(409).json({ code: 'NO_ACTIVE_RELEASE', error: '当前没有可重新编码的活动版本。' });
    if (active.runId !== req.params.runId) return res.status(409).json({ code: 'ACTIVE_RELEASE_RUN_MISMATCH', error: '活动版本不属于当前识别任务。' });
    const run = await dependencies.store.readRun(task.taskId, packageId, active.runId);
    if (run.status !== 'COMPLETED') return res.status(409).json({ code: 'RELEASE_NOT_COMPLETED', error: '只有已完成发布审核的活动版本可以重新编码。' });
    if (buildSourcePackageHash(task, group) !== run.sourcePackageHash) return res.status(409).json({ code: 'SOURCE_CHANGED', error: '源文件已变化，不能沿用旧审核结果重新编码。' });
    const activeArtifact = await dependencies.store.readArtifact<{ text: string; canonical: ProcedureUnderstandingResult }>(task.taskId, packageId, active.runId, active.artifactRef);
    const sourceHash = buildSourcePackageHash(task, group);
    const now = new Date().toISOString();
    const preview: CanonicalPreviewArtifact = {
      contractVersion: RECOGNITION_V2_CONTRACT_VERSION,
      schemaId: RECOGNITION_V2_SCHEMA_IDS.canonicalPreview,
      procedureUnderstanding: activeArtifact.canonical,
      releaseDecision: 'READY', warnings: [], generatedAt: now,
    };
    const lock = createPublicationLock({
      taskId: task.taskId, packageId, runId: run.runId, sourcePackageHash: sourceHash,
      canonicalPreviewRef: active.artifactRef, reviewOutputRef: active.artifactRef, preview, now,
    });
    const preflight = runPublicationPreflight({ workspace: lock, preview, currentSourcePackageHash: sourceHash, runApproved: true, now });
    if (!preflight.preflight?.passed) {
      const blockers = preflight.preflight?.checks.filter((item) => item.status === 'BLOCK').map((item) => `${item.code}: ${item.message}`) ?? [];
      return res.status(409).json({ code: 'REENCODE_PREFLIGHT_BLOCKED', error: `旧发布不能只靠重新编码修复：${blockers.join('；')}`, blockers });
    }
    const dryRun = createDryRun(preflight, preview, now);
    const inspected = inspectDryRunDiff(dryRun, preview, now);
    if ((inspected.diff?.blockingDifferenceCount ?? 1) > 0) return res.status(409).json({ code: 'REENCODE_ROUNDTRIP_BLOCKED', error: '重新编码后的 424 回读存在阻断差异，必须重新识别。' });
    const text = dryRun.dryRun!.text;
    const textHash = contentHash(text);
    if (textHash === active.textHash) return res.json({ ledger, release: active, changed: false });
    const publishedAt = now;
    const releaseId = `release_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
    const releaseArtifact = {
      releaseId, taskId: task.taskId, packageId, runId: run.runId,
      lockId: `encoder-upgrade:${active.releaseId}`,
      canonicalHash: active.canonicalHash, textHash, canonical: activeArtifact.canonical,
      previousCanonical: activeArtifact.canonical, text, publishedAt,
      reencodedFromReleaseId: active.releaseId,
    };
    const artifactRef = await dependencies.store.writeArtifact(task.taskId, packageId, run.runId, `${releaseId}.json`, releaseArtifact);
    const updated = await dependencies.store.updatePackageArtifact<PublicationLedger>(task.taskId, packageId, PUBLICATION_LEDGER_FILE, (current) => addPublishedRelease(current, {
      releaseId, runId: run.runId, artifactRef, canonicalHash: active.canonicalHash, textHash, status: 'ACTIVE', publishedAt,
    }));
    res.status(201).json({ ledger: updated, release: releaseArtifact, changed: true });
  } catch (error) { sendPublicationError(error, res, next); }
});

router.post('/:taskId/packages/:packageId/recognition-v2/publication/rollback', async (req, res, next) => {
  try {
    const { task, group } = await loadPackage(dependencies, req.params.taskId, req.params.packageId);
    const packageId = packageIdOf(group);
    const ledger = await readPublicationLedger(dependencies, task.taskId, packageId);
    const active = ledger?.releases.find((item) => item.releaseId === ledger.activeReleaseId);
    if (!ledger || !active) return res.status(409).json({ code: 'NO_ACTIVE_RELEASE', error: '当前没有可回滚的正式发布。' });
    const requested = String(req.body?.targetReleaseId ?? '').trim();
    const target = requested ? ledger.releases.find((item) => item.releaseId === requested && item.releaseId !== active.releaseId) : [...ledger.releases].reverse().find((item) => item.releaseId !== active.releaseId && item.status !== 'ROLLED_BACK');
    const activeArtifact = await dependencies.store.readArtifact<{ previousCanonical?: ProcedureUnderstandingResult }>(task.taskId, packageId, active.runId, active.artifactRef);
    const targetCanonical = target
      ? (await dependencies.store.readArtifact<{ canonical: ProcedureUnderstandingResult }>(task.taskId, packageId, target.runId, target.artifactRef)).canonical
      : activeArtifact.previousCanonical;
    await dependencies.updateTask(task.taskId, (currentTask) => {
      const currentGroup = currentTask.groups.find((item) => item.groupId === packageId || item.packageId === packageId);
      if (!currentGroup) throw new Error('分组不存在。');
      currentGroup.procedureUnderstanding = targetCanonical;
    });
    const now = new Date().toISOString();
    const updated = await dependencies.store.updatePackageArtifact<PublicationLedger>(task.taskId, packageId, PUBLICATION_LEDGER_FILE, (current) => markReleaseRolledBack(current ?? ledger, active.releaseId, target?.releaseId, now));
    const workspace = await readPublicationWorkspace(dependencies, task.taskId, packageId, active.runId);
    if (workspace) await savePublicationWorkspace(dependencies, { ...workspace, status: 'ROLLED_BACK', updatedAt: now });
    res.json({ ledger: updated, rolledBackReleaseId: active.releaseId, activeReleaseId: target?.releaseId });
  } catch (error) { sendPublicationError(error, res, next); }
});

  return router;
}

async function readPublicationWorkspace(dependencies: RecognitionV2RouterDependencies, taskId: string, packageId: string, runId: string) {
  try {
    const value = await dependencies.store.readArtifact<PublicationWorkspace>(taskId, packageId, runId, `artifacts/${PUBLICATION_WORKSPACE_FILE}`);
    await assertValidPublicationWorkspace(value);
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function buildAirportAggregate(dependencies: RecognitionV2RouterDependencies, task: ProcedureTask) {
  const groups = task.groups.filter((group) => group.procedureCategory !== 'UNKNOWN' && group.procedureNames.length > 0);
  const releases = (await Promise.all(groups.map(async (group): Promise<Airport424PackageReleaseInput | undefined> => {
    const packageId = packageIdOf(group);
    const ledger = await readPublicationLedger(dependencies, task.taskId, packageId);
    const active = ledger?.releases.find((item) => item.releaseId === ledger.activeReleaseId && item.status === 'ACTIVE');
    if (!active) return undefined;
    const artifact = await dependencies.store.readArtifact<{ text: string; canonical: ProcedureUnderstandingResult }>(
      task.taskId, packageId, active.runId, active.artifactRef,
    );
    try {
      if (contentHash(exportCanonical424Text(artifact.canonical)) !== contentHash(artifact.text)) return undefined;
    } catch {
      return undefined;
    }
    return {
      packageId,
      packageName: group.packageName ?? group.groupName,
      releaseId: active.releaseId,
      runId: active.runId,
      text: artifact.text,
      canonical: artifact.canonical,
    };
  }))).filter((item): item is Airport424PackageReleaseInput => Boolean(item));
  return aggregateAirport424({
    packages: groups.map((group) => ({ packageId: packageIdOf(group), packageName: group.packageName ?? group.groupName })),
    releases,
    masterData: extractAirportMasterData(task.pages),
  });
}

async function readPublicationLedger(dependencies: RecognitionV2RouterDependencies, taskId: string, packageId: string) {
  try {
    return await dependencies.store.readPackageArtifact<PublicationLedger>(taskId, packageId, PUBLICATION_LEDGER_FILE);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function inspectActiveReleaseEncoding(
  dependencies: RecognitionV2RouterDependencies,
  taskId: string,
  packageId: string,
  ledger: PublicationLedger | undefined,
) {
  const active = ledger?.releases.find((item) => item.releaseId === ledger.activeReleaseId && item.status === 'ACTIVE');
  if (!active) return { activeReleaseStale: false as const };
  try {
    const artifact = await dependencies.store.readArtifact<{ text: string; canonical: ProcedureUnderstandingResult }>(taskId, packageId, active.runId, active.artifactRef);
    const currentText = exportCanonical424Text(artifact.canonical);
    return {
      activeReleaseStale: contentHash(currentText) !== contentHash(artifact.text),
      activeReleaseCurrentTextHash: contentHash(currentText),
    };
  } catch (error) {
    return {
      activeReleaseStale: true as const,
      activeReleaseStaleReason: `当前编码器无法安全重建活动版本：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function readAirportPublicationLedger(dependencies: RecognitionV2RouterDependencies, taskId: string) {
  try {
    return await dependencies.store.readPackageArtifact<AirportPublicationLedger>(taskId, AIRPORT_PUBLICATION_PACKAGE_ID, AIRPORT_PUBLICATION_LEDGER_FILE);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function savePublicationWorkspace(dependencies: RecognitionV2RouterDependencies, workspace: PublicationWorkspace) {
  await assertValidPublicationWorkspace(workspace);
  await dependencies.store.writeArtifact(workspace.taskId, workspace.packageId, workspace.runId, PUBLICATION_WORKSPACE_FILE, workspace);
}

async function loadPublicationContext(dependencies: RecognitionV2RouterDependencies, taskId: string, packageIdValue: string, runId: string) {
  const { task, group } = await loadPackage(dependencies, taskId, packageIdValue);
  const packageId = packageIdOf(group);
  const run = await dependencies.store.readRun(task.taskId, packageId, runId);
  const workspace = await readPublicationWorkspace(dependencies, task.taskId, packageId, run.runId);
  if (!workspace) throw new Error('请先锁定 READY 数据。');
  const preview = await dependencies.store.readArtifact<CanonicalPreviewArtifact>(task.taskId, packageId, run.runId, workspace.lock.canonicalPreviewRef);
  return { task, group, packageId, run, workspace, preview };
}

function sendPublicationError(error: unknown, res: express.Response, next: express.NextFunction) {
  if (error instanceof Error && /READY|APPROVED|锁|预检|dry-run|差异|门禁|哈希|变化|发布|程序|424|ICAO|canonical/i.test(error.message)) {
    res.status(409).json({ code: 'PUBLICATION_GATE_BLOCKED', error: error.message });
    return;
  }
  sendStateError(error, res, next);
}

async function readReviewDraft(
  dependencies: RecognitionV2RouterDependencies,
  taskId: string,
  packageId: string,
  runId: string,
) {
  try {
    return await dependencies.store.readArtifact<HumanReviewStageResult>(taskId, packageId, runId, 'artifacts/human-review-draft.json');
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function loadHumanReviewInputs(
  dependencies: RecognitionV2RouterDependencies,
  taskId: string,
  packageId: string,
  run: RecognitionV2RunManifest,
) {
  const fusionRef = run.stages.find((item) => item.stage === 'EVIDENCE_FUSION')?.outputRef;
  const validationRef = run.stages.find((item) => item.stage === 'SEMANTIC_VALIDATION')?.outputRef;
  if (!fusionRef || !validationRef) throw new RecognitionV2StateError('REVIEW_BASELINE_MISSING', 'Fusion and semantic validation artifacts are required before human review.');
  const fusion = await dependencies.store.readArtifact<FusionStageResult>(taskId, packageId, run.runId, fusionRef);
  const validation = await dependencies.store.readArtifact<ValidationStageResult>(taskId, packageId, run.runId, validationRef);
  await assertValidFusionStageResult(fusion);
  const extractions: ExtractionStageResult[] = [];
  for (const stage of ['PROCEDURE_IDENTITY', 'PROCEDURE_TABLE', 'WAYPOINT_NAVAID', 'NOTES_CONSTRAINTS', 'CHART_TOPOLOGY'] as const) {
    const record = run.stages.find((item) => item.stage === stage);
    if (record?.status !== 'COMPLETED' || !record.outputRef) continue;
    if (stage === 'PROCEDURE_TABLE') {
      const table = await dependencies.store.readArtifact<ProcedureTableStageResult>(taskId, packageId, run.runId, record.outputRef);
      extractions.push(table.extraction);
    } else {
      extractions.push(await dependencies.store.readArtifact<ExtractionStageResult>(taskId, packageId, run.runId, record.outputRef));
    }
  }
  return { fusionRef, validationRef, fusion, validation, extractions };
}

const REVIEW_REUSE_FILE = 'shared-review-decisions.json';

async function readReviewReuseLedger(dependencies: RecognitionV2RouterDependencies, taskId: string, packageId: string) {
  try {
    return await dependencies.store.readPackageArtifact<HumanReviewReuseLedger>(taskId, packageId, REVIEW_REUSE_FILE);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function persistReviewReuseLedger(
  dependencies: RecognitionV2RouterDependencies,
  taskId: string,
  packageId: string,
  sourcePackageHash: string,
  review: HumanReviewStageResult,
) {
  return dependencies.store.updatePackageArtifact<HumanReviewReuseLedger>(taskId, packageId, REVIEW_REUSE_FILE, (ledger) =>
    updateReuseLedger({ ledger, workspace: review, sourcePackageHash }));
}

async function loadPackage(dependencies: RecognitionV2RouterDependencies, taskId: string, packageId: string): Promise<{ task: ProcedureTask; group: ProcedureGroup }> {
  const task = await dependencies.readTask(taskId);
  const group = task.groups.find((item) => item.groupId === packageId || item.packageId === packageId);
  if (!group) throw new Error('分组不存在。');
  return { task, group };
}

function packageIdOf(group: ProcedureGroup) {
  return group.packageId || group.groupId;
}

async function executeExtractionFromStoredLayout(
  dependencies: RecognitionV2RouterDependencies,
  input: {
    task: ProcedureTask;
    group: ProcedureGroup;
    run: RecognitionV2RunManifest;
    stage: Exclude<RecognitionV2Stage, 'PAGE_LAYOUT'>;
    model: string;
    useModel: boolean;
    stageInputHash: string;
    abortSignal: AbortSignal;
    onAuditArtifact: (artifact: { fileName: string; value: unknown }) => void | Promise<void>;
  },
) {
  const layoutRef = input.run.stages.find((stage) => stage.stage === 'PAGE_LAYOUT')?.outputRef;
  if (!layoutRef) throw new RecognitionV2StateError('LAYOUT_ARTIFACT_MISSING', 'PAGE_LAYOUT completed without an output artifact.');
  const layout = await dependencies.store.readArtifact<PageLayoutStageResult>(input.task.taskId, packageIdOf(input.group), input.run.runId, layoutRef);
  await assertValidPageLayoutStageResult(layout);
  const common = {
    task: input.task,
    group: input.group,
    layout,
    model: input.model,
    useModel: input.useModel,
    stageInputHash: input.stageInputHash,
    abortSignal: input.abortSignal,
    visionClient: dependencies.visionClient,
    onAuditArtifact: input.onAuditArtifact,
  };
  if (input.stage === 'PROCEDURE_IDENTITY') return executeProcedureIdentity(common);
  if (input.stage === 'PROCEDURE_TABLE') return executeProcedureTable(common);
  if (input.stage === 'WAYPOINT_NAVAID') return executeWaypointNavaid(common);
  if (input.stage === 'NOTES_CONSTRAINTS') return executeNotesConstraints(common);
  if (input.stage === 'CHART_TOPOLOGY') {
    const tableRef = input.run.stages.find((stage) => stage.stage === 'PROCEDURE_TABLE')?.outputRef;
    if (!tableRef) throw new RecognitionV2StateError('TABLE_ARTIFACT_MISSING', 'PROCEDURE_TABLE completed without an output artifact.');
    const table = await dependencies.store.readArtifact<ProcedureTableStageResult>(input.task.taskId, packageIdOf(input.group), input.run.runId, tableRef);
    await assertValidProcedureTableStageResult(table);
    return executeChartTopology({ ...common, table });
  }
  throw new RecognitionV2StateError('V2_STAGE_EXECUTOR_NOT_AVAILABLE', `Stage ${input.stage} does not have an extraction executor.`);
}

async function executeFusionFromStoredExtractions(
  dependencies: RecognitionV2RouterDependencies,
  input: { task: ProcedureTask; group: ProcedureGroup; run: RecognitionV2RunManifest },
) {
  const extractions: ExtractionStageResult[] = [];
  for (const stage of STAGE_DEPENDENCIES.EVIDENCE_FUSION) {
    const record = input.run.stages.find((item) => item.stage === stage);
    if (record?.status === 'SKIPPED') continue;
    if (record?.status !== 'COMPLETED' || !record.outputRef) {
      throw new RecognitionV2StateError('EXTRACTION_ARTIFACT_MISSING', `${stage} did not provide a completed extraction artifact.`);
    }
    if (stage === 'PROCEDURE_TABLE') {
      const result = await dependencies.store.readArtifact<ProcedureTableStageResult>(input.task.taskId, packageIdOf(input.group), input.run.runId, record.outputRef);
      await assertValidProcedureTableStageResult(result);
      extractions.push(result.extraction);
      continue;
    }
    const result = await dependencies.store.readArtifact<ExtractionStageResult>(input.task.taskId, packageIdOf(input.group), input.run.runId, record.outputRef);
    await assertValidExtractionStageResult(result);
    extractions.push(result);
  }
  return executeEvidenceFusion({ packageId: packageIdOf(input.group), extractions });
}

async function executeValidationFromStoredFusion(
  dependencies: RecognitionV2RouterDependencies,
  input: { task: ProcedureTask; group: ProcedureGroup; run: RecognitionV2RunManifest },
) {
  const fusionRef = input.run.stages.find((item) => item.stage === 'EVIDENCE_FUSION')?.outputRef;
  if (!fusionRef) throw new RecognitionV2StateError('FUSION_ARTIFACT_MISSING', 'EVIDENCE_FUSION completed without an output artifact.');
  const fusion = await dependencies.store.readArtifact<FusionStageResult>(input.task.taskId, packageIdOf(input.group), input.run.runId, fusionRef);
  await assertValidFusionStageResult(fusion);
  const execution = await executeSemanticValidation({ fusion });
  const { preview, diff } = await buildCanonicalPreview({
    fusion,
    releaseDecision: execution.output.releaseDecision,
    v1: input.group.procedureUnderstanding,
    now: execution.output.completedAt,
  });
  return {
    output: execution.output,
    auditArtifacts: [
      ...execution.auditArtifacts,
      { fileName: 'canonical-preview.json', value: preview },
      { fileName: 'v1-v2-diff.json', value: diff },
    ],
  };
}

function stageOutputFile(stage: RecognitionV2Stage) {
  if (stage === 'PAGE_LAYOUT') return 'page-layout-stage.json';
  if (stage === 'PROCEDURE_IDENTITY') return 'procedure-identity-stage.json';
  if (stage === 'PROCEDURE_TABLE') return 'procedure-table-stage.json';
  if (stage === 'WAYPOINT_NAVAID') return 'waypoint-navaid-stage.json';
  return `${stage.toLowerCase().replace(/_/g, '-')}-stage.json`;
}

function hashStageInput(
  sourcePackageHash: string,
  stage: RecognitionV2Stage,
  model: string,
  useModel: boolean,
  dependencies: unknown,
) {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify({ sourcePackageHash, stage, model, useModel, dependencies })).digest('hex')}`;
}

function artifactNameForAttempt(fileName: string, attempt: number) {
  const extensionIndex = fileName.lastIndexOf('.');
  if (extensionIndex < 0) return `${fileName}-attempt-${attempt}`;
  return `${fileName.slice(0, extensionIndex)}-attempt-${attempt}${fileName.slice(extensionIndex)}`;
}

function executionKey(taskId: string, packageId: string, runId: string) {
  return `${taskId}\u0000${packageId}\u0000${runId}`;
}

async function updateSummary(dependencies: RecognitionV2RouterDependencies, manifest: RecognitionV2RunManifest) {
  await dependencies.updateTask(manifest.taskId, (task) => {
    const group = task.groups.find((item) => item.groupId === manifest.packageId || item.packageId === manifest.packageId);
    if (!group) throw new Error('分组不存在。');
    group.recognitionV2 = {
      activeRunId: manifest.runId,
      status: manifest.status,
      sourcePackageHash: manifest.sourcePackageHash,
      runRef: dependencies.store.runReference(manifest.taskId, manifest.packageId, manifest.runId),
      updatedAt: manifest.updatedAt,
    };
  });
}

function sendStateError(error: unknown, res: express.Response, next: express.NextFunction) {
  if (error instanceof RecognitionV2StateError) {
    res.status(409).json({ code: error.code, error: error.message });
    return;
  }
  next(error);
}

export default createRecognitionV2Router();
