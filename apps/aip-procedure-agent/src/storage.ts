import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import type { AgentTask } from "./domain";

const root = path.resolve(
  process.cwd(),
  "server",
  "data",
  "aip-procedure-agent",
);
const fileOperations = new Map<string, Promise<unknown>>();
export const agentDataRoot = () => root;
export const taskDir = (taskId: string) => path.join(root, taskId);
export async function ensureAgentStorage() {
  await fs.mkdir(root, { recursive: true });
}
export async function saveAgentTask(task: AgentTask) {
  task.updatedAt = new Date().toISOString();
  await fs.mkdir(taskDir(task.taskId), { recursive: true });
  await atomicJson(path.join(taskDir(task.taskId), "task.json"), task);
}
export async function readAgentTask(id: string): Promise<AgentTask> {
  const file = path.join(taskDir(id), "task.json");
  return serialized(file, async () =>
    normalizeStoredTask(JSON.parse(await fs.readFile(file, "utf8"))),
  );
}
export async function listAgentTasks(): Promise<AgentTask[]> {
  await ensureAgentStorage();
  const entries = await fs.readdir(root, { withFileTypes: true });
  const tasks = await Promise.all(
    entries
      .filter((e) => e.isDirectory())
      .map(async (e) => {
        try {
          return await readAgentTask(e.name);
        } catch {
          return undefined;
        }
      }),
  );
  return tasks
    .filter((t): t is AgentTask => !!t)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function recoverInterruptedAgentTasks() {
  const tasks = await listAgentTasks();
  let recoveredTaskCount = 0;
  let recoveredPackageCount = 0;
  for (const task of tasks) {
    const interruptedPackages = task.packages.filter((pkg) =>
      ["PLANNING", "RECOGNIZING", "VALIDATING"].includes(pkg.status),
    );
    if (task.status !== "RUNNING" && !interruptedPackages.length) continue;
    const message = "后端服务重启导致识别中断，请重新识别该程序包。";
    for (const pkg of interruptedPackages) {
      pkg.status = "FAILED";
      pkg.warnings = [...new Set([...(pkg.warnings || []), message])];
    }
    for (const procedure of task.procedures.filter(
      (item) => item.status === "RUNNING",
    )) {
      procedure.status = "FAILED";
      procedure.validations.push({
        ruleCode: "AGENT_PROCESS_INTERRUPTED",
        severity: "ERROR",
        fieldPath: "",
        message,
        evidence: [],
        autoRepairable: true,
      });
    }
    const completed = task.packages.filter((pkg) =>
      ["COMPLETED", "COMPLETED_WITH_WARNINGS"].includes(pkg.status),
    ).length;
    task.completedProcedures = completed;
    task.status = completed ? "PARTIALLY_COMPLETED" : "FAILED";
    task.stage = completed ? "RESULTS_READY" : "FAILED";
    task.currentProcedure = undefined;
    task.error = message;
    task.errorCount += interruptedPackages.length || 1;
    await saveAgentTask(task);
    recoveredTaskCount += 1;
    recoveredPackageCount += interruptedPackages.length;
  }
  return { recoveredTaskCount, recoveredPackageCount };
}
export async function writeArtifact(
  taskId: string,
  relative: string,
  value: string | Buffer | unknown,
) {
  const file = path.join(taskDir(taskId), relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  if (Buffer.isBuffer(value) || typeof value === "string")
    await fs.writeFile(file, value);
  else await atomicJson(file, value);
  return file;
}
async function atomicJson(file: string, value: unknown) {
  // Snapshot before queueing so saves retain call order even though AgentTask
  // remains mutable while a long model operation is running.
  const json = JSON.stringify(value, null, 2);
  await serialized(file, async () => {
    const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temp, json, "utf8");
    try {
      await renameWithRetry(temp, file);
    } finally {
      await fs.unlink(temp).catch(() => undefined);
    }
  });
}

async function serialized<T>(
  file: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = fileOperations.get(file) || Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  fileOperations.set(file, current);
  try {
    return await current;
  } finally {
    if (fileOperations.get(file) === current) fileOperations.delete(file);
  }
}

async function renameWithRetry(source: string, destination: string) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await fs.rename(source, destination);
      return;
    } catch (error: any) {
      lastError = error;
      if (!["EPERM", "EACCES", "EBUSY", "EEXIST"].includes(error?.code))
        throw error;
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
  // Antivirus/indexer locks can outlive the normal retry window on Windows.
  // copyFile overwrites the existing file without requiring a rename/delete.
  try {
    await fs.copyFile(source, destination);
  } catch {
    throw lastError;
  }
}
function normalizeStoredTask(raw: AgentTask): AgentTask {
  raw.taskName ||= raw.fileName || "AIP AD-2 自主识别任务";
  // PIR 1.0.0 → 1.1.0 兼容：补齐新集合字段，历史 conflicts（自由对象）转为带候选的规范结构
  for (const procedure of raw.procedures || []) {
    const pir: any = procedure.pir;
    if (!pir) continue;
    pir.runwayData ||= [];
    pir.minima ||= [];
    pir.conflicts = (pir.conflicts || []).map((conflict: any, index: number) =>
      conflict && typeof conflict.fieldPath === "string" && Array.isArray(conflict.candidates)
        ? conflict
        : { conflictId: conflict?.conflictId || `LEGACY-${index}`, fieldPath: conflict?.fieldPath || "", reason: conflict?.reason || JSON.stringify(conflict).slice(0, 200), status: "OPEN", candidates: [] },
    );
    if (pir.procedure && pir.procedure.approachType === undefined) pir.procedure.approachType = null;
  }
  raw.documents ||= raw.filePath
    ? [
        {
          documentId: "LEGACY-DOC",
          fileName: raw.fileName || "legacy.pdf",
          filePath: raw.filePath,
          sizeBytes: 0,
          pageCount: raw.pages?.length || 0,
          parseStatus: raw.pages?.length ? "PARSED" : "UPLOADED",
          createdAt: raw.createdAt,
        },
      ]
    : [];
  raw.airportIcao ??= raw.airportAnalysis?.airport.icao || null;
  raw.airportName ??= raw.airportAnalysis?.airport.name || null;
  raw.packages = (raw.packages || []).map((pkg: any) => ({
    ...pkg,
    procedureCategory: pkg.procedureCategory || pkg.category,
    navigationType: pkg.navigationType || null,
    packagePages: pkg.packagePages || legacyPackagePages(pkg, raw),
    groupingConfidence: pkg.groupingConfidence ?? pkg.confidence ?? 0,
    groupingReason: pkg.groupingReason || pkg.warnings?.[0] || "旧版任务迁移",
    status: pkg.status || "GROUPED",
  }));
  return raw;
}
function legacyPackagePages(pkg: any, task: AgentTask) {
  const doc = task.documents[0];
  if (!doc) return [];
  const pages = [
    ...new Set(
      Object.values(pkg.sources || {})
        .flat()
        .filter((n): n is number => typeof n === "number"),
    ),
  ];
  return pages.map((pageNumber) => ({
    documentId: doc.documentId,
    fileName: doc.fileName,
    pageNumber,
    pageRole: pkg.sources?.primaryCharts?.includes(pageNumber)
      ? "PROCEDURE_CHART"
      : "RELATED",
    isShared: false,
    confidence: pkg.confidence || 0,
  }));
}
