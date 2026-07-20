import type { AgentTask, ProductionBatch, ProductionBatchMode } from "./domain";
import { startPackagesRecognition, startTaskAnalysis } from "./orchestrator";
import {
  listProductionBatches,
  readAgentTask,
  readProductionBatch,
  saveAgentTask,
  saveProductionBatch,
} from "./storage";
import { assessTaskForProduction } from "./productionControl";

const batchRunners = new Set<string>();
export type BatchTaskPhase = "ACTIVE" | "COMPLETE" | "FAILED" | "QUEUED" | "WAITING";

export function classifyBatchTask(task: AgentTask, mode: ProductionBatchMode): BatchTaskPhase {
  if (isActive(task)) return "ACTIVE";
  if (task.stage === "FAILED" || task.status === "FAILED") return "FAILED";
  if (isComplete(task, mode)) return "COMPLETE";
  if (canLaunch(task, mode)) return "QUEUED";
  return "WAITING";
}

export async function startProductionBatch(
  batchId: string,
  options: { mode?: ProductionBatchMode; concurrency?: number; retryFailed?: boolean } = {},
) {
  const batch = await readProductionBatch(batchId);
  batch.mode = options.mode ?? batch.mode;
  batch.concurrency = Math.max(1, Math.min(8, Math.trunc(options.concurrency ?? batch.concurrency ?? 2)));
  if (options.retryFailed) await prepareFailedTasks(batch);
  batch.status = "RUNNING";
  batch.startedAt ||= new Date().toISOString();
  batch.completedAt = undefined;
  batch.pauseReason = undefined;
  await saveProductionBatch(batch);
  if (!batchRunners.has(batchId)) void runBatch(batchId);
  return productionBatchSummary(batch);
}

export async function pauseProductionBatch(batchId: string, reason = "人工暂停") {
  const batch = await readProductionBatch(batchId);
  if (batch.status === "RUNNING") {
    batch.status = "PAUSED";
    batch.pauseReason = reason;
    await saveProductionBatch(batch);
  }
  return productionBatchSummary(batch);
}

export async function recoverProductionBatches() {
  let paused = 0;
  for (const batch of await listProductionBatches()) {
    if (batch.status !== "RUNNING") continue;
    batch.status = "PAUSED";
    batch.pauseReason = "服务重启后暂停，确认任务状态后可继续。";
    await saveProductionBatch(batch);
    paused += 1;
  }
  return { paused };
}

export async function productionBatchSummary(batch: ProductionBatch) {
  const tasks = (await Promise.all(batch.taskIds.map((id) => readAgentTask(id).catch(() => undefined))))
    .filter((item): item is AgentTask => !!item);
  const active = tasks.filter(isActive);
  const failed = tasks.filter((task) => task.stage === "FAILED" || task.status === "FAILED");
  const completed = tasks.filter((task) => isComplete(task, batch.mode));
  const exceptions = tasks.reduce((count, task) => count + assessTaskForProduction(task).openExceptionCount, 0);
  return {
    ...batch,
    airportCount: tasks.length,
    queuedAirportCount: Math.max(0, tasks.length - active.length - completed.length - failed.length),
    activeAirportCount: active.length,
    completedAirportCount: completed.length,
    failedAirportCount: failed.length,
    openExceptionCount: exceptions,
    progress: tasks.length ? Math.round((completed.length + failed.length) / tasks.length * 100) : 0,
    airports: tasks.map((task) => ({
      taskId: task.taskId,
      airportIcao: task.airportIcao ?? task.airportAnalysis?.airport.icao ?? null,
      taskName: task.taskName,
      stage: task.stage,
      status: task.status,
      progress: task.progress,
      openExceptionCount: assessTaskForProduction(task).openExceptionCount,
    })),
  };
}

async function runBatch(batchId: string) {
  batchRunners.add(batchId);
  try {
    while (true) {
      const batch = await readProductionBatch(batchId);
      if (batch.status !== "RUNNING") return;
      const tasks = (await Promise.all(batch.taskIds.map((id) => readAgentTask(id).catch(() => undefined))))
        .filter((item): item is AgentTask => !!item);
      const active = tasks.filter(isActive);
      const candidates = tasks.filter((task) => !isActive(task) && task.stage !== "FAILED" && !isComplete(task, batch.mode) && canLaunch(task, batch.mode));
      const slots = Math.max(0, batch.concurrency - active.length);
      for (const task of candidates.slice(0, slots)) {
        try { await launchNextStage(task, batch.mode); }
        catch { /* task-level state and the next polling pass provide the durable result */ }
      }
      const refreshed = (await Promise.all(batch.taskIds.map((id) => readAgentTask(id).catch(() => undefined))))
        .filter((item): item is AgentTask => !!item);
      const stillActive = refreshed.some(isActive);
      const remaining = refreshed.some((task) => task.stage !== "FAILED" && !isComplete(task, batch.mode) && canLaunch(task, batch.mode));
      if (!stillActive && !remaining) {
        const failed = refreshed.some((task) => task.stage === "FAILED" || task.status === "FAILED");
        batch.status = failed ? "COMPLETED_WITH_ERRORS" : "COMPLETED";
        batch.completedAt = new Date().toISOString();
        await saveProductionBatch(batch);
        return;
      }
      await delay(1200);
    }
  } finally {
    batchRunners.delete(batchId);
  }
}

async function launchNextStage(task: AgentTask, mode: ProductionBatchMode) {
  if (task.stage === "UPLOAD" || (!task.pages.length && !task.packages.length)) {
    await startTaskAnalysis(task);
    return;
  }
  if (mode === "FULL_PRODUCTION" && task.stage === "PACKAGES_READY") {
    await startPackagesRecognition(task, task.packages);
  }
}

async function prepareFailedTasks(batch: ProductionBatch) {
  for (const id of batch.taskIds) {
    const task = await readAgentTask(id).catch(() => undefined);
    if (!task || (task.stage !== "FAILED" && task.status !== "FAILED")) continue;
    task.error = undefined;
    task.cancelRequested = false;
    task.status = "CREATED";
    task.stage = task.pages.length && task.packages.length ? "PACKAGES_READY" : "UPLOAD";
    await saveAgentTask(task);
  }
}

function canLaunch(task: AgentTask, mode: ProductionBatchMode) {
  return task.stage === "UPLOAD" || (mode === "FULL_PRODUCTION" && task.stage === "PACKAGES_READY");
}
function isComplete(task: AgentTask, mode: ProductionBatchMode) {
  return mode === "ANALYZE"
    ? ["PACKAGES_READY", "RESULTS_READY"].includes(task.stage)
    : task.stage === "RESULTS_READY";
}
function isActive(task: AgentTask) {
  return !!task.activeRun || task.status === "RUNNING" || ["ANALYZING", "RECOGNIZING"].includes(task.stage);
}
function delay(ms: number) { return new Promise((resolve) => setTimeout(resolve, ms)); }
