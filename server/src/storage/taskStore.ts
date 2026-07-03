import fs from 'node:fs/promises';
import path from 'node:path';
import type { ProcedureTask } from '../types/procedure';

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

export async function createTask(fileName: string, filePath: string): Promise<ProcedureTask> {
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

export async function readTask(taskId: string): Promise<ProcedureTask> {
  const filePath = path.join(getTaskDir(taskId), 'task.json');
  const text = await fs.readFile(filePath, 'utf-8');
  return JSON.parse(text) as ProcedureTask;
}

export async function saveTask(task: ProcedureTask): Promise<ProcedureTask> {
  task.updatedAt = new Date().toISOString();
  await fs.mkdir(getTaskDir(task.taskId), { recursive: true });
  await fs.writeFile(path.join(getTaskDir(task.taskId), 'task.json'), JSON.stringify(task, null, 2), 'utf-8');
  return task;
}

export async function updateTask(taskId: string, updater: (task: ProcedureTask) => void | Promise<void>) {
  const task = await readTask(taskId);
  await updater(task);
  return saveTask(task);
}
