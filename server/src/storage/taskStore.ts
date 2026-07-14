import fs from 'node:fs/promises';
import path from 'node:path';
import type { ProcedureTask, TaskSourceFile } from '../types/procedure';

const dataRoot = path.resolve(process.cwd(), 'server', 'data');
const taskRoot = path.join(dataRoot, 'procedure-tasks');

export function getTaskRoot() {
  return taskRoot;
}

export function getTaskDir(taskId: string) {
  return path.join(taskRoot, taskId);
}

export function getUploadDir() {
  return path.join(dataRoot, 'uploads');
}

export async function ensureStorage() {
  await fs.mkdir(taskRoot, { recursive: true });
  await fs.mkdir(getUploadDir(), { recursive: true });
}

export async function createTask(fileName: string, filePath: string, sourceFiles?: TaskSourceFile[]): Promise<ProcedureTask> {
  await ensureStorage();
  const now = new Date().toISOString();
  const task: ProcedureTask = {
    taskId: `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    fileName,
    filePath,
    status: 'UPLOADED',
    pages: [],
    groups: [],
    createdAt: now,
    updatedAt: now,
    ...(sourceFiles?.length ? { sourceFiles } : {}),
  };
  await fs.mkdir(getTaskDir(task.taskId), { recursive: true });
  await saveTask(task);
  return task;
}

export async function listTasks(): Promise<ProcedureTask[]> {
  await ensureStorage();
  const entries = await fs.readdir(taskRoot, { withFileTypes: true });
  const tasks = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => readTask(entry.name).catch(() => undefined)),
  );
  return tasks.filter(Boolean).sort((a, b) => b!.createdAt.localeCompare(a!.createdAt)) as ProcedureTask[];
}

export async function recoverInterruptedRecognitionTasks() {
  const tasks = await listTasks();
  let recoveredTaskCount = 0;
  let recoveredGroupCount = 0;
  for (const task of tasks) {
    const interruptedGroups = task.groups.filter((group) => group.status === 'AI_RUNNING');
    if (!interruptedGroups.length) continue;
    const recoveredAt = new Date().toISOString();
    for (const group of interruptedGroups) {
      const message = group.recognitionStartedAt
        ? `AI 识别在服务重启前未完成（开始于 ${group.recognitionStartedAt}），请重新发送识别。`
        : 'AI 识别因服务重启而中断，请重新发送识别。';
      group.status = 'ERROR';
      group.aiResponse = {
        rawText: message,
        errors: [message],
        createdAt: recoveredAt,
      };
    }
    task.status = 'ERROR';
    task.error = `已恢复 ${interruptedGroups.length} 个因服务重启而中断的 AI 识别任务，请重新发送识别。`;
    await saveTask(task);
    recoveredTaskCount += 1;
    recoveredGroupCount += interruptedGroups.length;
  }
  return { recoveredTaskCount, recoveredGroupCount };
}

export async function readTask(taskId: string): Promise<ProcedureTask> {
  const filePath = path.join(getTaskDir(taskId), 'task.json');
  const text = await fs.readFile(filePath, 'utf-8');
  return JSON.parse(text) as ProcedureTask;
}

export async function saveTask(task: ProcedureTask): Promise<ProcedureTask> {
  task.updatedAt = new Date().toISOString();
  const taskDir = getTaskDir(task.taskId);
  const taskPath = path.join(taskDir, 'task.json');
  const temporaryPath = path.join(
    taskDir,
    `.task-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`,
  );
  await fs.mkdir(taskDir, { recursive: true });

  // A parsed task can be tens of megabytes. Writing task.json in place exposes a
  // truncated file to polling readers and makes JSON.parse fail intermittently.
  // Write the complete snapshot first, then publish it with one rename.
  try {
    await fs.writeFile(temporaryPath, JSON.stringify(task, null, 2), 'utf-8');
    await fs.rename(temporaryPath, taskPath);
  } catch (error) {
    await fs.unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
  return task;
}

export async function updateTask(taskId: string, updater: (task: ProcedureTask) => void | Promise<void>) {
  const task = await readTask(taskId);
  await updater(task);
  return saveTask(task);
}
