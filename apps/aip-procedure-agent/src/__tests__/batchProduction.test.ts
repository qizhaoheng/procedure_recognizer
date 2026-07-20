import assert from "node:assert/strict";
import test from "node:test";
import type { AgentTask } from "../domain";
import { classifyBatchTask } from "../batchProduction";

test("batch task phases distinguish analysis completion from full production completion", () => {
  const task = sampleTask();
  assert.equal(classifyBatchTask(task, "ANALYZE"), "QUEUED");
  assert.equal(classifyBatchTask(task, "FULL_PRODUCTION"), "QUEUED");

  task.stage = "PACKAGES_READY";
  task.status = "COMPLETED";
  assert.equal(classifyBatchTask(task, "ANALYZE"), "COMPLETE");
  assert.equal(classifyBatchTask(task, "FULL_PRODUCTION"), "QUEUED");

  task.stage = "RESULTS_READY";
  assert.equal(classifyBatchTask(task, "FULL_PRODUCTION"), "COMPLETE");
});

test("active and failed tasks are never counted as queued", () => {
  const task = sampleTask();
  task.status = "RUNNING";
  task.stage = "ANALYZING";
  assert.equal(classifyBatchTask(task, "FULL_PRODUCTION"), "ACTIVE");
  task.status = "FAILED";
  task.stage = "FAILED";
  assert.equal(classifyBatchTask(task, "FULL_PRODUCTION"), "FAILED");
});

function sampleTask(): AgentTask {
  return {
    taskId: "batch-task", taskType: "AGENT_AD2_RECOGNITION", taskName: "Batch airport",
    status: "CREATED", stage: "UPLOAD", progress: 0, completedProcedures: 0,
    totalProcedures: 0, warningCount: 0, errorCount: 0,
    createdAt: "2026-07-20T00:00:00.000Z", updatedAt: "2026-07-20T00:00:00.000Z",
    documents: [], pages: [], packages: [], procedures: [], steps: [], modelCalls: [],
  };
}
