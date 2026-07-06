import path from 'node:path';
import cors from 'cors';
import express from 'express';
import { loadServerEnv } from './env';
import llmRouter from './routes/llm';
import procedureTasksRouter from './routes/procedureTasks';
import { ensureStorage } from './storage/taskStore';

loadServerEnv();

const app = express();
const port = Number(process.env.PORT || 3317);

await ensureStorage();

app.use(cors());
app.use(express.json({ limit: '25mb' }));
app.use('/uploads', express.static(path.resolve(process.cwd(), 'server', 'data')));
app.use('/api/llm', llmRouter);
app.use('/api/procedure-tasks', procedureTasksRouter);

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const message = error instanceof Error ? error.message : '服务端错误';
  res.status(500).json({ error: message });
});

app.listen(port, () => {
  console.log(`Procedure recognizer API listening on http://127.0.0.1:${port}`);
});
