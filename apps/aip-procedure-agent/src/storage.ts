import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import type { ActiveRun, AgentTask, ProductionBatch } from "./domain";

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
/**
 * 本进程的运行者标识。跨进程唯一——同一台机器上的 dev server 与一次性脚本会拿到不同的值。
 *
 * 之所以需要它：旧实现里"任务是否已在运行"只由 orchestrator 进程内的一个 Map 判断，
 * 跨进程完全不设防；而 saveAgentTask 是整份 JSON 覆盖写，没有归属校验。
 * 实测后果是两个进程各持一份内存态互相覆盖：模型调用成对重复、计数往回退、
 * procedure 记录凭空消失——数据被悄悄写坏，而两边都以为自己跑得好好的。
 */
export const RUN_OWNER = `${process.pid}:${crypto.randomUUID().slice(0, 8)}`;
/** 心跳超过这个时长即视为持有者已死，允许接管。必须大于最长的单次模型调用（LLM_TIMEOUT_MS 默认 10 分钟）。 */
const RUN_STALE_MS = 15 * 60 * 1000;

export class TaskRunConflictError extends Error {
  constructor(readonly taskId: string, readonly holder: string) {
    super(`任务 ${taskId} 正在被另一个运行者执行（${holder}），本次写入已拒绝以免覆盖它的进度。`);
    this.name = "TaskRunConflictError";
  }
}

function runIsLive(run?: ActiveRun | null) {
  return !!run && Date.now() - new Date(run.heartbeatAt).getTime() < RUN_STALE_MS;
}

async function storedTask(taskId: string): Promise<AgentTask | undefined> {
  try {
    return JSON.parse(await fs.readFile(path.join(taskDir(taskId), "task.json"), "utf8")) as AgentTask;
  } catch {
    return undefined;
  }
}

/**
 * 声明对任务的执行权。已被他人持有且心跳新鲜时返回 false——调用方必须据此放弃，
 * 而不是继续跑。心跳过期（进程已死）则允许接管。
 */
export async function claimTaskRun(task: AgentTask, description: string): Promise<boolean> {
  const stored = await storedTask(task.taskId);
  if (runIsLive(stored?.activeRun) && stored!.activeRun!.owner !== RUN_OWNER) return false;
  const now = new Date().toISOString();
  task.activeRun = { owner: RUN_OWNER, startedAt: now, heartbeatAt: now, description };
  await saveAgentTask(task);
  return true;
}

export async function touchTaskRun(task: AgentTask) {
  if (task.activeRun?.owner !== RUN_OWNER) return;
  task.activeRun.heartbeatAt = new Date().toISOString();
  await saveAgentTask(task);
}

export async function releaseTaskRun(task: AgentTask) {
  if (task.activeRun && task.activeRun.owner !== RUN_OWNER) return;
  task.activeRun = null;
  await saveAgentTask(task);
}

export async function saveAgentTask(task: AgentTask) {
  // 落盘前确认执行权仍属自己：别人正持有且心跳新鲜时拒绝写入，
  // 否则就是把对方的进度整份覆盖掉——这正是之前数据被写坏的方式。
  const stored = await storedTask(task.taskId);
  const holder = stored?.activeRun;
  // 只认 RUN_OWNER。不能因为"我手上的 task 也带着同一个 activeRun"就放行——
  // 另一个进程 read 任务时会把持有者的 activeRun 一并读进来，那样恰好放过了
  // 最该拦的路径（路由 read-mutate-save 覆盖正在跑的识别）。
  if (runIsLive(holder) && holder!.owner !== RUN_OWNER) {
    throw new TaskRunConflictError(task.taskId, holder!.owner);
  }
  task.updatedAt = new Date().toISOString();
  if (task.activeRun?.owner === RUN_OWNER) task.activeRun.heartbeatAt = task.updatedAt;
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
export async function saveProductionBatch(batch: ProductionBatch) {
  batch.updatedAt = new Date().toISOString();
  const file = path.join(root, "production-batches", `${batch.batchId}.json`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await atomicJson(file, batch);
}
export async function readProductionBatch(batchId: string): Promise<ProductionBatch> {
  return JSON.parse(await fs.readFile(path.join(root, "production-batches", `${batchId}.json`), "utf8"));
}
export async function listProductionBatches(): Promise<ProductionBatch[]> {
  const dir = path.join(root, "production-batches");
  await fs.mkdir(dir, { recursive: true });
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const batches = await Promise.all(entries.filter((item) => item.isFile() && item.name.endsWith(".json")).map(async (item) => {
    try { return await readProductionBatch(item.name.slice(0, -5)); } catch { return undefined; }
  }));
  return batches.filter((item): item is ProductionBatch => !!item).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
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
  raw.production ||= { exceptionDecisions: [], fieldEdits: [], releases: [] };
  raw.production.exceptionDecisions ||= [];
  raw.production.fieldEdits ||= [];
  raw.production.releases ||= [];
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
