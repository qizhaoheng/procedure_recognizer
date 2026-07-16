import path from 'node:path';
import cors from 'cors';
import express from 'express';
import { loadServerEnv } from './env';
import { getLlmRuntimeConfig } from './services/llm/llmClient';
import { recognitionV2Store } from './services/recognition-v2/persistence/recognitionV2Store';
import llmRouter from './routes/llm';
import procedureTasksRouter from './routes/procedureTasks';
import recognitionV2Router from './routes/recognitionV2';
import { ensureStorage, recoverInterruptedRecognitionTasks, updateTask } from './storage/taskStore';

loadServerEnv();

const app = express();
const port = Number(process.env.PORT || 3317);

await ensureStorage();
const recoveredRecognitionRuns = await recoverInterruptedRecognitionTasks();
if (recoveredRecognitionRuns.recoveredGroupCount) {
  console.warn(`Recovered ${recoveredRecognitionRuns.recoveredGroupCount} interrupted AI recognition run(s).`);
}
const recoveredV2Runs = await recognitionV2Store.recoverInterruptedRuns();
if (recoveredV2Runs.recovered.length) {
  console.warn(`Recovered ${recoveredV2Runs.recovered.length} interrupted Recognition V2 stage(s).`);
  for (const recovered of recoveredV2Runs.recovered) {
    await updateTask(recovered.taskId, (task) => {
      const group = task.groups.find((item) => item.groupId === recovered.packageId || item.packageId === recovered.packageId);
      if (!group || group.recognitionV2?.activeRunId !== recovered.runId) return;
      group.recognitionV2 = {
        activeRunId: recovered.runId,
        status: 'FAILED',
        sourcePackageHash: recovered.sourcePackageHash,
        runRef: recognitionV2Store.runReference(recovered.taskId, recovered.packageId, recovered.runId),
        updatedAt: recovered.updatedAt,
      };
    }).catch((error) => console.warn(`Failed to update V2 recovery summary for ${recovered.runId}:`, error));
  }
}
if (recoveredV2Runs.errors.length) {
  console.warn(`Failed to inspect ${recoveredV2Runs.errors.length} Recognition V2 run(s) during startup recovery.`);
}

app.use(cors());
app.use(express.json({ limit: '25mb' }));
app.use('/uploads', express.static(path.resolve(process.cwd(), 'server', 'data')));
app.use('/api/llm', llmRouter);
app.use('/api/procedure-tasks', recognitionV2Router);
app.use('/api/procedure-tasks', procedureTasksRouter);

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const message = error instanceof Error ? error.message : 'Server error';
  res.status(500).json({ error: message });
});

const server = app.listen(port, () => {
  console.log(`Procedure recognizer API listening on http://127.0.0.1:${port}`);
});

const llmConfig = getLlmRuntimeConfig();
const retryDelayBudgetMs = 500 * (llmConfig.maxRetries * (llmConfig.maxRetries + 1)) / 2;
const longRequestBudgetMs = (llmConfig.timeoutMs * (llmConfig.maxRetries + 1)) + retryDelayBudgetMs + 60000;
server.requestTimeout = longRequestBudgetMs;
server.timeout = longRequestBudgetMs;
