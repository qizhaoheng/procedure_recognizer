import path from "node:path";
import cors from "cors";
import express from "express";
import { loadServerEnv } from "./env";
import { getLlmRuntimeConfig } from "./services/llm/llmClient";
import llmRouter from "./routes/llm";
import procedureTasksRouter from "./routes/procedureTasks";
import {
  ensureStorage,
  recoverInterruptedRecognitionTasks,
} from "./storage/taskStore";
import { agentRouter } from "../../apps/aip-procedure-agent/src/router";
import {
  ensureAgentStorage,
  recoverInterruptedAgentTasks,
} from "../../apps/aip-procedure-agent/src/storage";

loadServerEnv();

const app = express();
const port = Number(process.env.PORT || 3317);

await ensureStorage();
await ensureAgentStorage();
const recoveredAgentRuns = await recoverInterruptedAgentTasks();
if (recoveredAgentRuns.recoveredPackageCount) {
  console.warn(
    `Recovered ${recoveredAgentRuns.recoveredPackageCount} interrupted AIP agent package(s).`,
  );
}
const recoveredRecognitionRuns = await recoverInterruptedRecognitionTasks();
if (recoveredRecognitionRuns.recoveredGroupCount) {
  console.warn(
    `Recovered ${recoveredRecognitionRuns.recoveredGroupCount} interrupted AI recognition run(s).`,
  );
}

app.use(cors());
app.use(express.json({ limit: "25mb" }));
app.use(
  "/uploads",
  express.static(path.resolve(process.cwd(), "server", "data")),
);
app.use("/api/llm", llmRouter);
app.use("/api/procedure-tasks", procedureTasksRouter);
app.use("/api/agent", agentRouter);

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.use(
  (
    error: unknown,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    const message = error instanceof Error ? error.message : "Server error";
    res.status(500).json({ error: message });
  },
);

const server = app.listen(port, () => {
  console.log(`Procedure recognizer API listening on http://127.0.0.1:${port}`);
});

const llmConfig = getLlmRuntimeConfig();
const retryDelayBudgetMs =
  (500 * (llmConfig.maxRetries * (llmConfig.maxRetries + 1))) / 2;
const longRequestBudgetMs =
  llmConfig.timeoutMs * (llmConfig.maxRetries + 1) + retryDelayBudgetMs + 60000;
server.requestTimeout = longRequestBudgetMs;
server.timeout = longRequestBudgetMs;
