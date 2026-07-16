import express from 'express';
import crypto from 'node:crypto';
import { readTask, updateTask } from '../storage/taskStore';
import type { ProcedureGroup, ProcedureTask } from '../types/procedure';
import type { RecognitionV2RunManifest, RecognitionV2Stage } from '../services/recognition-v2/contracts/index';
import type { PageLayoutStageResult } from '../services/recognition-v2/contracts/index';
import { RecognitionV2Store, recognitionV2Store } from '../services/recognition-v2/persistence/recognitionV2Store';
import {
  RecognitionV2StateError,
  assertStageCanStart,
  cancelRun,
  completeStage,
  failStage,
  isRecognitionV2Stage,
  STAGE_DEPENDENCIES,
  startStage,
} from '../services/recognition-v2/orchestration/stateMachine';
import { buildSourcePackageHash } from '../services/recognition-v2/orchestration/sourcePackageHash';
import { executePageLayout } from '../services/recognition-v2/layout/pageLayoutExecutor';
import { executeProcedureIdentity } from '../services/recognition-v2/identity/procedureIdentityExecutor';
import { executeProcedureTable } from '../services/recognition-v2/tables/procedureTableExecutor';
import { executeWaypointNavaid } from '../services/recognition-v2/coordinates/waypointNavaidExecutor';
import type { VisionStageClient } from '../services/recognition-v2/orchestration/visionStageClient';
import { getLlmRuntimeConfig } from '../services/llm/llmClient';
import { assertValidPageLayoutStageResult } from '../services/recognition-v2/contracts/schemaValidation';

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

export function createRecognitionV2Router(dependencies: RecognitionV2RouterDependencies = defaultDependencies) {
  const router = express.Router();
  const activeExecutions = new Map<string, AbortController>();

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
      executorsAvailable: ['PAGE_LAYOUT', 'PROCEDURE_IDENTITY', 'PROCEDURE_TABLE', 'WAYPOINT_NAVAID'],
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
    if (!['PAGE_LAYOUT', 'PROCEDURE_IDENTITY', 'PROCEDURE_TABLE', 'WAYPOINT_NAVAID'].includes(stage)) {
      return res.status(501).json({
        code: 'V2_STAGE_EXECUTOR_NOT_AVAILABLE',
        error: `Stage ${stage} is ready, but its executor is not implemented yet.`,
        stage,
        ready: true,
        runStatus: run.status,
      });
    }

    const model = String(req.body?.model || getLlmRuntimeConfig().model);
    const useModel = typeof req.body?.useModel === 'boolean' ? req.body.useModel : Boolean(getLlmRuntimeConfig(model).apiKey);
    const dependencyFingerprint = STAGE_DEPENDENCIES[stage].map((dependency) => {
      const record = run.stages.find((item) => item.stage === dependency);
      return {
        stage: dependency,
        inputHash: record?.inputHash,
        outputRef: record?.outputRef,
        completedAt: record?.completedAt,
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
      : await executeExtractionFromStoredLayout(dependencies, {
        task,
        group,
        run: running,
        stage,
        model,
        useModel,
        stageInputHash,
        abortSignal: abortController.signal,
        onAuditArtifact: persistAuditArtifact,
      });

    for (const artifact of execution.auditArtifacts) {
      await persistAuditArtifact(artifact);
    }
    const outputFile = artifactNameForAttempt(
      stageOutputFile(stage),
      attempt,
    );
    const outputRef = await dependencies.store.writeArtifact(task.taskId, packageId, run.runId, outputFile, execution.output);
    const completed = await dependencies.store.updateRun(task.taskId, packageId, run.runId, (current) =>
      completeStage(current, stage!, { outputRef }));
    await updateSummary(dependencies, completed);
    return res.json({
      run: completed,
      stage,
      outputRef,
      auditRefs,
      result: execution.output,
      modelRequested: useModel,
      usedModel: auditRefs.length > 0,
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

  return router;
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
  throw new RecognitionV2StateError('V2_STAGE_EXECUTOR_NOT_AVAILABLE', `Stage ${input.stage} does not have an extraction executor.`);
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
