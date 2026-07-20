import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import express from "express";
import multer from "multer";
import type {
  AgentTask,
  AipDocument,
  BusinessProcedurePackage,
  ProductionBatch,
  ProductionWorkflow,
} from "./domain";
import {
  cancelAgentTask,
  startPackagePlanning,
  startPackageRecognition,
  startPackagesRecognition,
  startTaskAnalysis,
} from "./orchestrator";
import { compile424Candidate, compileGeoJson, validatePir } from "./compiler";
import { applyQualityGate } from "./validation";
import { parseJeppesen424Text } from "../../../server/src/services/jeppesen424/jeppesen424TextParser";
import {
  alignJeppesenProcedureNames,
  compareSimpleProcedureLegs,
} from "../../../server/src/services/jeppesen424/simpleProcedureComparator";
import {
  agentDataRoot,
  ensureAgentStorage,
  listAgentTasks,
  listProductionBatches,
  readAgentTask,
  readProductionBatch,
  saveAgentTask,
  saveProductionBatch,
  taskDir,
  writeArtifact,
  TaskRunConflictError,
} from "./storage";
import { assessTaskForProduction } from "./productionControl";
import {
  pauseProductionBatch,
  productionBatchSummary,
  startProductionBatch,
} from "./batchProduction";

export const agentRouter = express.Router();
const upload = multer({
  storage: multer.diskStorage({
    destination: async (_r, _f, cb) => {
      const dir = path.join(agentDataRoot(), "uploads");
      await fs.mkdir(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (_r, f, cb) =>
      cb(
        null,
        `${Date.now()}-${crypto.randomUUID().slice(0, 8)}-${f.originalname.replace(/[^\w.() -]+/g, "_")}`,
      ),
  }),
  limits: { fileSize: 300 * 1024 * 1024, files: 200 },
  fileFilter: (_r, file, cb) =>
    cb(
      null,
      file.mimetype === "application/pdf" ||
        file.originalname.toLowerCase().endsWith(".pdf"),
    ),
});

agentRouter.post("/tasks", upload.any(), async (req, res) => {
  const files = (req.files as Express.Multer.File[] | undefined) || [];
  if (!files.length)
    return res.status(400).json({ error: "请至少上传一个 PDF。" });
  const now = new Date().toISOString();
  const task: AgentTask = {
    taskId: crypto.randomUUID(),
    taskType: "AGENT_AD2_RECOGNITION",
    taskName: String(
      req.body.taskName || `${guessAirport(files)} AIP AD-2 自主识别`,
    ),
    airportIcao: req.body.airportIcao || null,
    airportName: null,
    documents: files.map((file) => documentFromUpload(file, now)),
    status: "CREATED",
    stage: "UPLOAD",
    progress: 0,
    completedProcedures: 0,
    totalProcedures: 0,
    warningCount: 0,
    errorCount: 0,
    createdAt: now,
    updatedAt: now,
    pages: [],
    packages: [],
    procedures: [],
    steps: [],
    modelCalls: [],
    production: { exceptionDecisions: [], fieldEdits: [], releases: [] },
  };
  await ensureAgentStorage();
  await saveAgentTask(task);
  if (req.body.autoAnalyze === "true") await startTaskAnalysis(task);
  res.status(202).json(taskSummary(task));
});
agentRouter.post("/production-batches", upload.any(), async (req, res) => {
  const files = (req.files as Express.Multer.File[] | undefined) || [];
  if (!files.length) return res.status(400).json({ error: "请至少上传一个 PDF。" });
  let manifest: Array<{ relativePath?: string }> = [];
  try {
    manifest = JSON.parse(String(req.body?.fileManifest || "[]"));
  } catch {
    return res.status(400).json({ error: "文件夹清单格式无效。" });
  }
  const grouped = new Map<string, { country?: string; files: Express.Multer.File[] }>();
  const unassignedFiles: string[] = [];
  files.forEach((file, index) => {
    const relativePath = String(manifest[index]?.relativePath || file.originalname).replace(/\\/g, "/");
    const segments = relativePath.split("/").filter(Boolean);
    const icaoIndex = segments.findIndex((segment) => /^[A-Z]{4}$/.test(segment));
    const fileMatch = file.originalname.toUpperCase().match(/(?:^|[^A-Z])([A-Z]{4})(?:[^A-Z]|$)/)?.[1];
    const icao = (icaoIndex >= 0 ? segments[icaoIndex] : fileMatch)?.toUpperCase();
    if (!icao) {
      unassignedFiles.push(relativePath);
      return;
    }
    const country = icaoIndex > 0 ? segments[icaoIndex - 1] : segments.length > 1 ? segments[0] : undefined;
    const entry = grouped.get(icao) || { country, files: [] };
    entry.files.push(file);
    entry.country ||= country;
    grouped.set(icao, entry);
  });
  if (!grouped.size)
    return res.status(422).json({ error: "未从文件夹路径或文件名识别出 ICAO 四字码。", unassignedFiles });
  const batchId = crypto.randomUUID();
  const now = new Date().toISOString();
  const tasks: AgentTask[] = [];
  await ensureAgentStorage();
  for (const [icao, group] of grouped) {
    const task: AgentTask = {
      taskId: crypto.randomUUID(),
      taskType: "AGENT_AD2_RECOGNITION",
      taskName: `${icao} 完整机场生产`,
      airportIcao: icao,
      airportName: null,
      documents: group.files.map((file) => documentFromUpload(file, now)),
      status: "CREATED",
      stage: "UPLOAD",
      progress: 0,
      completedProcedures: 0,
      totalProcedures: 0,
      warningCount: 0,
      errorCount: 0,
      createdAt: now,
      updatedAt: now,
      pages: [],
      packages: [],
      procedures: [],
      steps: [],
      modelCalls: [],
      production: {
        exceptionDecisions: [],
        fieldEdits: [],
        releases: [],
        batchId,
        sourceCountry: group.country,
      },
    };
    await saveAgentTask(task);
    tasks.push(task);
  }
  const batch: ProductionBatch = {
    batchId,
    name: String(req.body?.batchName || [...new Set(tasks.map((task) => task.production?.sourceCountry).filter(Boolean))].join("、") || "国家资料批次"),
    taskIds: tasks.map((task) => task.taskId),
    status: "CREATED",
    mode: "ANALYZE",
    concurrency: 2,
    createdAt: now,
    updatedAt: now,
  };
  await saveProductionBatch(batch);
  res.status(202).json({
    batchId,
    airportCount: tasks.length,
    documentCount: tasks.reduce((count, task) => count + task.documents.length, 0),
    unassignedFiles,
    tasks: tasks.map(taskSummary),
  });
});
agentRouter.get("/production-batches", async (_req, res) => {
  res.json(await Promise.all((await listProductionBatches()).map(productionBatchSummary)));
});
agentRouter.get("/production-batches/:id", async (req, res) => {
  try { res.json(await productionBatchSummary(await readProductionBatch(req.params.id))); }
  catch { res.status(404).json({ error: "生产批次不存在。" }); }
});
agentRouter.post("/production-batches/:id/start", async (req, res) => {
  try {
    const mode = req.body?.mode === "FULL_PRODUCTION" ? "FULL_PRODUCTION" : "ANALYZE";
    res.status(202).json(await startProductionBatch(req.params.id, {
      mode,
      concurrency: Number(req.body?.concurrency || 2),
      retryFailed: req.body?.retryFailed === true,
    }));
  } catch { res.status(404).json({ error: "生产批次不存在。" }); }
});
agentRouter.post("/production-batches/:id/pause", async (req, res) => {
  try { res.json(await pauseProductionBatch(req.params.id)); }
  catch { res.status(404).json({ error: "生产批次不存在。" }); }
});
agentRouter.get("/production/exceptions", async (req, res) => {
  const batchId = String(req.query.batchId || "");
  const tasks = (await listAgentTasks()).filter((task) => !batchId || task.production?.batchId === batchId);
  const items = tasks.flatMap((task) => assessTaskForProduction(task).assessments.flatMap((assessment) =>
    assessment.exceptions
      .filter((issue) => issue.severity === "BLOCKER" || (issue.severity === "REVIEW" && issue.decision?.decision !== "CONFIRMED_CORRECT"))
      .map((issue) => ({
        ...issue,
        taskId: task.taskId,
        airportIcao: task.airportIcao ?? task.airportAnalysis?.airport.icao ?? null,
        batchId: task.production?.batchId,
        disposition: assessment.disposition,
      })),
  ));
  res.json({
    total: items.length,
    blockerCount: items.filter((item) => item.severity === "BLOCKER").length,
    reviewCount: items.filter((item) => item.severity === "REVIEW").length,
    items: items.slice(0, Math.max(1, Math.min(500, Number(req.query.limit || 100)))),
  });
});
agentRouter.get("/production/metrics", async (_req, res) => {
  const tasks = await listAgentTasks();
  const productionBatches = await listProductionBatches();
  const summaries = tasks.map((task) => ({ task, production: assessTaskForProduction(task) }));
  const assessments = summaries.flatMap((item) => item.production.assessments.map((assessment) => ({
    task: item.task,
    assessment,
  })));
  const completed = assessments.filter((item) => item.assessment.disposition !== "PENDING");
  const autoPassed = completed.filter((item) => item.assessment.disposition === "AUTO_PASS");
  const humanConfirmed = completed.filter((item) => item.assessment.disposition === "HUMAN_CONFIRMED");
  const firstPass = autoPassed.filter(({ task, assessment }) => {
    const procedure = task.procedures.find((item) => item.procedureId === assessment.procedureId);
    return procedure?.version === 1;
  });
  const released = summaries.filter((item) => item.production.releaseCurrent);
  const releaseMinutes = released.map(({ task, production }) =>
    (new Date(production.latestRelease!.releasedAt).getTime() - new Date(task.createdAt).getTime()) / 60000,
  ).filter((value) => value >= 0);
  res.json({
    airportCount: tasks.length,
    programCount: assessments.length,
    completedProgramCount: completed.length,
    autoPassProgramCount: autoPassed.length,
    humanConfirmedProgramCount: humanConfirmed.length,
    reviewProgramCount: completed.filter((item) => item.assessment.disposition === "REVIEW_REQUIRED").length,
    blockedProgramCount: completed.filter((item) => item.assessment.disposition === "BLOCKED").length,
    pendingProgramCount: assessments.length - completed.length,
    autoPassRate: completed.length ? Number((autoPassed.length / completed.length * 100).toFixed(1)) : null,
    firstPassYield: completed.length ? Number((firstPass.length / completed.length * 100).toFixed(1)) : null,
    currentReleasedAirportCount: released.length,
    manualDecisionCount: tasks.reduce((count, task) => count + (task.production?.exceptionDecisions.length ?? 0), 0),
    manualFieldEditCount: tasks.reduce((count, task) => count + (task.production?.fieldEdits.length ?? 0), 0),
    modelCallCount: tasks.reduce((count, task) => count + task.modelCalls.length, 0),
    averageReleaseCycleMinutes: releaseMinutes.length
      ? Number((releaseMinutes.reduce((sum, value) => sum + value, 0) / releaseMinutes.length).toFixed(1))
      : null,
    batches: productionBatches.length,
    runningBatchCount: productionBatches.filter((batch) => batch.status === "RUNNING").length,
    pausedBatchCount: productionBatches.filter((batch) => batch.status === "PAUSED").length,
  });
});
agentRouter.get("/tasks", async (_req, res) =>
  res.json((await listAgentTasks()).map(taskSummary)),
);
agentRouter.get("/tasks/:id", async (req, res) => {
  try {
    const task = await readAgentTask(req.params.id);
    res.json(req.query.view === "workspace" ? workspaceTask(task) : task);
  } catch {
    res.status(404).json({ error: "任务不存在。" });
  }
});
agentRouter.get("/tasks/:id/production-summary", async (req, res) => {
  try {
    res.json(assessTaskForProduction(await readAgentTask(req.params.id)));
  } catch {
    res.status(404).json({ error: "任务不存在。" });
  }
});
agentRouter.get("/tasks/:id/exceptions", async (req, res) => {
  try {
    const summary = assessTaskForProduction(await readAgentTask(req.params.id));
    res.json(summary.assessments.flatMap((item) => item.exceptions));
  } catch {
    res.status(404).json({ error: "任务不存在。" });
  }
});
agentRouter.post("/tasks/:id/exception-decisions", async (req, res) => {
  const task = await readAgentTask(req.params.id);
  const reviewer = String(req.body?.reviewer || "").trim();
  const decision = String(req.body?.decision || "");
  if (!reviewer) return res.status(400).json({ error: "必须填写确认人。" });
  if (!['CONFIRMED_CORRECT', 'CORRECTION_REQUIRED'].includes(decision))
    return res.status(400).json({ error: "无效的人工处理结论。" });
  const summary = assessTaskForProduction(task);
  const issue = summary.assessments
    .flatMap((item) => item.exceptions)
    .find((item) => item.exceptionId === req.body?.exceptionId);
  if (!issue) return res.status(404).json({ error: "例外已不存在，请刷新后重新确认。" });
  if (issue.severity === "BLOCKER" && decision === "CONFIRMED_CORRECT")
    return res.status(409).json({ error: "确定性阻断项不能由人工豁免，必须修正后重新编译。" });
  if (issue.severity === "WARNING")
    return res.status(409).json({ error: "警告不需要生产确认。" });
  const workflow = productionWorkflow(task);
  workflow.exceptionDecisions.push({
    decisionId: crypto.randomUUID(),
    exceptionId: issue.exceptionId,
    packageId: issue.packageId,
    procedureId: issue.procedureId,
    procedureVersion: issue.procedureId
      ? task.procedures.find((item) => item.procedureId === issue.procedureId)?.version
      : undefined,
    decision: decision as "CONFIRMED_CORRECT" | "CORRECTION_REQUIRED",
    reviewer,
    note: String(req.body?.note || "").trim() || undefined,
    decidedAt: new Date().toISOString(),
  });
  await saveAgentTask(task);
  res.json(assessTaskForProduction(task));
});
agentRouter.post("/tasks/:id/release", async (req, res) => {
  const task = await readAgentTask(req.params.id);
  const reviewer = String(req.body?.reviewer || "").trim();
  if (!reviewer) return res.status(400).json({ error: "必须填写放行人。" });
  if (task.activeRun) return res.status(409).json({ error: "机场任务仍在运行，不能放行。" });
  const summary = assessTaskForProduction(task);
  if (!summary.releaseReady)
    return res.status(409).json({ error: "仍有未关闭的阻断项或复核项，不能放行。", production: summary });
  const procedures = summary.assessments.map((assessment) => {
    const procedure = assessment.procedureId
      ? task.procedures.find((item) => item.procedureId === assessment.procedureId)
      : undefined;
    if (!procedure?.candidate424?.text?.trim()) throw new Error(`程序 ${assessment.procedureName} 缺少424产物。`);
    return { assessment, procedure };
  });
  const releasedAt = new Date().toISOString();
  const releaseId = `${releasedAt.replace(/[-:.TZ]/g, "").slice(0, 14)}-${crypto.randomUUID().slice(0, 8)}`;
  const arinc424 = `${procedures.map(({ procedure }) => procedure.candidate424!.text.trimEnd()).join("\n")}\n`;
  const recordCount = arinc424.split(/\r?\n/).filter((line) => line.trim()).length;
  const relativeRoot = `production/releases/${releaseId}`;
  const manifest = {
    releaseId,
    taskId: task.taskId,
    airportIcao: summary.airportIcao,
    reviewer,
    note: String(req.body?.note || "").trim() || undefined,
    releasedAt,
    fingerprint: summary.fingerprint,
    programCount: procedures.length,
    recordCount,
    programs: procedures.map(({ assessment, procedure }) => ({
      packageId: assessment.packageId,
      procedureId: procedure.procedureId,
      version: procedure.version,
      procedureName: assessment.procedureName,
      disposition: assessment.disposition,
      outputProfile: procedure.candidate424?.profile,
    })),
  };
  const manifestPath = await writeArtifact(task.taskId, `${relativeRoot}/manifest.json`, manifest);
  const arinc424Path = await writeArtifact(task.taskId, `${relativeRoot}/${summary.airportIcao || "airport"}.424`, arinc424);
  const release = {
    releaseId,
    reviewer,
    note: manifest.note,
    releasedAt,
    fingerprint: summary.fingerprint,
    manifestPath,
    arinc424Path,
    programCount: procedures.length,
    recordCount,
  };
  productionWorkflow(task).releases.push(release);
  await saveAgentTask(task);
  res.status(201).json({ release, production: assessTaskForProduction(task) });
});
agentRouter.get("/tasks/:id/releases/:releaseId/:artifact", async (req, res) => {
  const task = await readAgentTask(req.params.id);
  const release = task.production?.releases.find((item) => item.releaseId === req.params.releaseId);
  if (!release) return res.status(404).json({ error: "放行版本不存在。" });
  const file = req.params.artifact === "manifest" ? release.manifestPath
    : req.params.artifact === "424" ? release.arinc424Path : undefined;
  if (!file) return res.status(400).json({ error: "无效的放行产物。" });
  res.download(path.resolve(file));
});
agentRouter.post("/tasks/:id/documents", upload.any(), async (req, res) => {
  const task = await readAgentTask(String(req.params.id));
  if (!["UPLOAD", "PACKAGES_READY"].includes(task.stage))
    return res.status(409).json({ error: "当前阶段不能追加文件。" });
  const files = (req.files as Express.Multer.File[] | undefined) || [];
  const now = new Date().toISOString();
  task.documents.push(...files.map((file) => documentFromUpload(file, now)));
  task.stage = "UPLOAD";
  task.status = "CREATED";
  await saveAgentTask(task);
  res.status(201).json(task.documents);
});
agentRouter.get("/tasks/:id/documents", async (req, res) =>
  res.json((await readAgentTask(req.params.id)).documents.map(publicDocument)),
);
agentRouter.get("/tasks/:id/documents/:documentId/file", async (req, res) => {
  const task = await readAgentTask(req.params.id);
  const document = task.documents.find(
    (item) => item.documentId === req.params.documentId,
  );
  if (!document) return res.status(404).json({ error: "PDF 文件不存在。" });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `inline; filename*=UTF-8''${encodeURIComponent(document.fileName)}`,
  );
  res.sendFile(path.resolve(document.filePath));
});
agentRouter.get(
  "/tasks/:id/documents/:documentId/pages/:pageNumber/image",
  async (req, res) => {
    const task = await readAgentTask(req.params.id);
    const page = task.pages.find(
      (item) =>
        item.documentId === req.params.documentId &&
        item.pageNumber === Number(req.params.pageNumber),
    );
    if (!page?.renderedImagePath)
      return res.status(404).json({ error: "页面图像不存在。" });
    res.sendFile(path.resolve(page.renderedImagePath));
  },
);
agentRouter.delete("/tasks/:id/documents/:documentId", async (req, res) => {
  const task = await readAgentTask(req.params.id);
  if (task.stage !== "UPLOAD")
    return res.status(409).json({ error: "只能在开始分析前删除文件。" });
  const index = task.documents.findIndex(
    (d) => d.documentId === req.params.documentId,
  );
  if (index < 0) return res.status(404).json({ error: "文件不存在。" });
  const [document] = task.documents.splice(index, 1);
  await fs.unlink(document.filePath).catch(() => undefined);
  await saveAgentTask(task);
  res.status(204).end();
});
agentRouter.post("/tasks/:id/analyze", async (req, res) => {
  const task = await readAgentTask(req.params.id);
  await startTaskAnalysis(task);
  res.status(202).json({ taskId: task.taskId, status: "ANALYZING" });
});
agentRouter.post("/tasks/:id/start", async (req, res) => {
  const task = await readAgentTask(req.params.id);
  await startTaskAnalysis(task);
  res.status(202).json(taskSummary(task));
});
agentRouter.post("/tasks/:id/cancel", async (req, res) => {
  const task = await readAgentTask(req.params.id);
  task.cancelRequested = true;
  cancelAgentTask(task.taskId);
  await saveAgentTask(task);
  res.status(202).json(taskSummary(task));
});
agentRouter.post("/tasks/:id/retry", async (req, res) => {
  const task = await readAgentTask(req.params.id);
  task.cancelRequested = false;
  await startTaskAnalysis(task);
  res.status(202).json(taskSummary(task));
});
agentRouter.get("/tasks/:id/packages", async (req, res) =>
  res.json((await readAgentTask(req.params.id)).packages),
);
agentRouter.post("/tasks/:id/packages", async (req, res) => {
  const task = await readAgentTask(req.params.id);
  const pkg = newPackage(task, req.body);
  task.packages.push(pkg);
  task.totalProcedures = task.packages.length;
  await saveAgentTask(task);
  res.status(201).json(pkg);
});
agentRouter.post("/tasks/:id/packages/reanalyze", async (req, res) => {
  const task = await readAgentTask(req.params.id);
  await startTaskAnalysis(task);
  res.status(202).json({ taskId: task.taskId, status: "ANALYZING" });
});
agentRouter.post("/tasks/:id/packages/recognize", async (req, res) => {
  const task = await readAgentTask(req.params.id);
  const ids: string[] = Array.isArray(req.body.packageIds)
    ? req.body.packageIds
    : [];
  const packages = ids.length
    ? task.packages.filter((p) => ids.includes(p.packageId))
    : task.packages;
  if (!packages.length)
    return res.status(400).json({ error: "没有可识别的程序包。" });
  await startPackagesRecognition(task, packages);
  res.status(202).json({
    taskId: task.taskId,
    packageIds: packages.map((p) => p.packageId),
    status: "RECOGNIZING",
  });
});

agentRouter.get("/packages/:id", async (req, res) => {
  const found = await findPackage(req.params.id);
  found
    ? res.json(found.pkg)
    : res.status(404).json({ error: "程序包不存在。" });
});
agentRouter.patch("/packages/:id", async (req, res) => {
  const found = await findPackage(req.params.id);
  if (!found) return res.status(404).json({ error: "程序包不存在。" });
  const allowed = [
    "procedureName",
    "procedureCategory",
    "runways",
    "navigationType",
    "packagePages",
    "groupingReason",
  ] as const;
  for (const key of allowed)
    if (req.body[key] !== undefined) (found.pkg as any)[key] = req.body[key];
  found.pkg.category = found.pkg.procedureCategory === "SID" ? "SID" : "STAR";
  found.pkg.manualRevision = (found.pkg.manualRevision || 0) + 1;
  found.pkg.recognitionPlan = undefined;
  found.pkg.status = "GROUPED";
  await saveAgentTask(found.task);
  res.json(found.pkg);
});
/**
 * 删除任务及其全部产物。此前只能删文件、删程序包，任务本身没有出口——
 * 界面能列出却删不掉，于是历史任务连同每份 PDF 的整套渲染页一直堆积（实测攒到 1.2GB）。
 * 上传的 PDF 若没有别的任务在引用，一并删除，避免留下没人认领的文件。
 */
agentRouter.delete("/tasks/:id", async (req, res) => {
  const task = await readAgentTask(req.params.id).catch(() => undefined);
  if (!task) return res.status(404).json({ error: "任务不存在。" });
  if (task.activeRun) {
    return res.status(409).json({ error: "任务正在运行，请先取消再删除。", code: "TASK_RUN_ACTIVE" });
  }
  const others = (await listAgentTasks()).filter((item) => item.taskId !== task.taskId);
  const stillReferenced = new Set(others.flatMap((item) => item.documents.map((doc) => path.resolve(doc.filePath))));
  for (const document of task.documents) {
    const file = path.resolve(document.filePath);
    if (!stillReferenced.has(file)) await fs.unlink(file).catch(() => undefined);
  }
  await fs.rm(taskDir(task.taskId), { recursive: true, force: true });
  res.status(204).end();
});
agentRouter.delete("/packages/:id", async (req, res) => {
  const found = await findPackage(req.params.id);
  if (!found) return res.status(404).json({ error: "程序包不存在。" });
  found.task.packages = found.task.packages.filter(
    (p) => p.packageId !== found.pkg.packageId,
  );
  found.task.totalProcedures = found.task.packages.length;
  await saveAgentTask(found.task);
  res.status(204).end();
});
agentRouter.post("/packages/:id/merge", async (req, res) => {
  const found = await findPackage(req.params.id);
  if (!found) return res.status(404).json({ error: "程序包不存在。" });
  const mergeIds: string[] = req.body.packageIds || [];
  const merging = found.task.packages.filter((p) =>
    mergeIds.includes(p.packageId),
  );
  found.pkg.packagePages = uniquePages([
    ...found.pkg.packagePages,
    ...merging.flatMap((p) => p.packagePages),
  ]);
  found.pkg.groupingReason = `${found.pkg.groupingReason}；用户合并 ${merging.map((p) => p.procedureName).join("、")}`;
  found.pkg.manualRevision = (found.pkg.manualRevision || 0) + 1;
  found.pkg.recognitionPlan = undefined;
  found.pkg.status = "GROUPED";
  found.task.packages = found.task.packages.filter(
    (p) => !mergeIds.includes(p.packageId),
  );
  found.task.totalProcedures = found.task.packages.length;
  await saveAgentTask(found.task);
  res.json(found.pkg);
});
agentRouter.post("/packages/:id/split", async (req, res) => {
  const found = await findPackage(req.params.id);
  if (!found) return res.status(404).json({ error: "程序包不存在。" });
  const pageGroups: any[][] = req.body.pageGroups || [];
  if (pageGroups.length < 2)
    return res.status(400).json({ error: "拆分至少需要两个页面组。" });
  found.task.packages = found.task.packages.filter(
    (p) => p.packageId !== found.pkg.packageId,
  );
  const created = pageGroups.map((pages, index) => ({
    ...found.pkg,
    packageId: crypto.randomUUID(),
    procedureKey: `${found.pkg.procedureKey}-S${index + 1}`,
    procedureName:
      req.body.names?.[index] || `${found.pkg.procedureName} ${index + 1}`,
    packagePages: pages,
    groupingReason: "用户拆分程序包",
    manualRevision: (found.pkg.manualRevision || 0) + 1,
    recognitionPlan: undefined,
    status: "GROUPED" as const,
  }));
  found.task.packages.push(...created);
  found.task.totalProcedures = found.task.packages.length;
  await saveAgentTask(found.task);
  res.status(201).json(created);
});
agentRouter.post("/packages/:id/plan", async (req, res) => {
  const found = await findPackage(req.params.id);
  if (!found) return res.status(404).json({ error: "程序包不存在。" });
  startPackagePlanning(found.task, found.pkg);
  res.status(202).json({
    taskId: found.task.taskId,
    packageId: found.pkg.packageId,
    status: "PLANNING",
  });
});
agentRouter.post("/packages/:id/recognize", async (req, res) => {
  const found = await findPackage(req.params.id);
  if (!found) return res.status(404).json({ error: "程序包不存在。" });
  startPackageRecognition(found.task, found.pkg);
  res.status(202).json({
    taskId: found.task.taskId,
    packageId: found.pkg.packageId,
    status: "RECOGNIZING",
  });
});
agentRouter.post("/packages/:id/retry", async (req, res) => {
  const found = await findPackage(req.params.id);
  if (!found) return res.status(404).json({ error: "程序包不存在。" });
  startPackageRecognition(found.task, found.pkg);
  res.status(202).json({
    taskId: found.task.taskId,
    packageId: found.pkg.packageId,
    status: "RECOGNIZING",
  });
});
agentRouter.get("/packages/:id/result", async (req, res) => {
  const found = await findPackage(req.params.id);
  if (!found) return res.status(404).json({ error: "程序包不存在。" });
  const result = latestProcedure(found.task, found.pkg.packageId);
  res.json({ package: found.pkg, result: result || null });
});
agentRouter.get("/packages/:id/geojson", async (req, res) =>
  packageArtifact(req.params.id, res, "geojson"),
);
agentRouter.get("/packages/:id/424", async (req, res) =>
  packageArtifact(req.params.id, res, "candidate424"),
);

agentRouter.get("/procedures/:id", async (req, res) =>
  respondProcedure(req.params.id, res, (p) => p),
);
agentRouter.get("/procedures/:id/pir", async (req, res) =>
  respondProcedure(req.params.id, res, (p) => p.pir),
);
agentRouter.get("/procedures/:id/geojson", async (req, res) =>
  respondProcedure(req.params.id, res, (p) => p.geojson),
);
agentRouter.get("/procedures/:id/424", async (req, res) =>
  respondProcedure(req.params.id, res, (p) => p.candidate424),
);
agentRouter.get("/procedures/:id/evidence", async (req, res) =>
  respondProcedure(req.params.id, res, (p) => p.pir?.sourceEvidence),
);
agentRouter.get("/procedures/:id/validations", async (req, res) =>
  respondProcedure(req.params.id, res, (p) => p.validations),
);
agentRouter.post("/procedures/:id/retry", async (req, res) => {
  const found = await findProcedure(req.params.id);
  if (!found) return res.status(404).json({ error: "程序不存在。" });
  const pkg = found.task.packages.find(
    (p) => p.packageId === found.procedure.packageId,
  );
  if (!pkg) return res.status(404).json({ error: "程序包不存在。" });
  startPackageRecognition(found.task, pkg);
  res.status(202).json({
    taskId: found.task.taskId,
    packageId: pkg.packageId,
    status: "RECOGNIZING",
  });
});
agentRouter.post("/procedures/:id/compile-geojson", async (req, res) =>
  recompile(req.params.id, res, "geojson"),
);
agentRouter.post("/procedures/:id/compile-424", async (req, res) =>
  recompile(req.params.id, res, "424"),
);
// —— 原图叠加图片 / 证据裁剪图 / Plan 执行记录 ——
agentRouter.get("/procedures/:id/overlays", async (req, res) => {
  const found = await findProcedure(req.params.id);
  if (!found) return res.status(404).json({ error: "程序不存在。" });
  const dir = path.join(
    agentDataRoot(),
    found.task.taskId,
    "procedures",
    found.procedure.procedureId,
  );
  let entries: string[] = [];
  try {
    entries = await fs.readdir(dir);
  } catch {
    /* no artifacts yet */
  }
  const overlays = entries.filter((f) => /^overlay-p\d+\.png$/.test(f));
  const verifications = [];
  for (const file of entries
    .filter((f) => /^overlay-verification-r\d+\.json$/.test(f))
    .sort()) {
    try {
      verifications.push(
        JSON.parse(await fs.readFile(path.join(dir, file), "utf8")),
      );
    } catch {
      /* skip corrupt round file */
    }
  }
  res.json({ overlays, verifications });
});
agentRouter.get("/procedures/:id/files/:name", async (req, res) => {
  const found = await findProcedure(req.params.id);
  if (!found) return res.status(404).json({ error: "程序不存在。" });
  const name = String(req.params.name);
  if (!/^[\w.-]+$/.test(name) || name.includes(".."))
    return res.status(400).json({ error: "非法文件名。" });
  const file = path.join(
    agentDataRoot(),
    found.task.taskId,
    "procedures",
    found.procedure.procedureId,
    name,
  );
  try {
    await fs.access(file);
  } catch {
    return res.status(404).json({ error: "文件不存在。" });
  }
  res.sendFile(path.resolve(file));
});
agentRouter.get(
  "/procedures/:id/evidence/:evidenceId/image",
  async (req, res) => {
    const found = await findProcedure(req.params.id);
    const evidence = found?.procedure.pir?.sourceEvidence.find(
      (e) => e.evidenceId === req.params.evidenceId,
    );
    if (!evidence?.imageCropPath)
      return res.status(404).json({ error: "证据裁剪图不存在。" });
    res.sendFile(path.resolve(evidence.imageCropPath));
  },
);
// —— Jeppesen 424 参考对比 ——
agentRouter.post("/procedures/:id/compare-424", async (req, res) => {
  const found = await findProcedure(req.params.id);
  if (!found?.procedure.candidate424?.text)
    return res
      .status(409)
      .json({ error: "该程序尚无 424 Candidate，无法对比。" });
  const referenceText = String(req.body?.referenceText || "");
  if (!referenceText.trim())
    return res.status(400).json({ error: "请提供参考 424 文本。" });
  const jeppesenLegs = parseJeppesen424Text(referenceText);
  if (!jeppesenLegs.length)
    return res
      .status(422)
      .json({ error: "参考文本未解析出任何 424 腿段记录。" });
  const aiLegs = parseJeppesen424Text(found.procedure.candidate424.text);
  const aligned = alignJeppesenProcedureNames(aiLegs, jeppesenLegs);
  const procedureResults = compareSimpleProcedureLegs(aiLegs, aligned);
  const totals = procedureResults.reduce(
    (acc, item) => ({
      totalLegs: acc.totalLegs + item.totalLegs,
      matchedLegs: acc.matchedLegs + item.matchedLegs,
      partialLegs: acc.partialLegs + item.partialLegs,
      mismatchedLegs: acc.mismatchedLegs + item.mismatchedLegs,
    }),
    { totalLegs: 0, matchedLegs: 0, partialLegs: 0, mismatchedLegs: 0 },
  );
  const report = {
    comparedAt: new Date().toISOString(),
    procedureId: found.procedure.procedureId,
    matchRate: totals.totalLegs
      ? Number((totals.matchedLegs / totals.totalLegs).toFixed(3))
      : null,
    ...totals,
    procedureResults,
    referenceLegCount: jeppesenLegs.length,
    aiLegCount: aiLegs.length,
  };
  await writeArtifact(
    found.task.taskId,
    `procedures/${found.procedure.procedureId}/compare-424-${Date.now()}.json`,
    report,
  );
  res.json(report);
});
agentRouter.patch("/procedures/:id/fields", async (req, res) => {
  const found = await findProcedure(req.params.id);
  if (!found?.procedure.pir)
    return res.status(404).json({ error: "程序不存在。" });
  const reviewer = String(req.body?.reviewer || "").trim();
  const edits = Array.isArray(req.body?.edits) ? req.body.edits : [];
  if (!reviewer) return res.status(400).json({ error: "必须填写修改人。" });
  if (!edits.length) return res.status(400).json({ error: "至少需要一项字段修改。" });
  const workflow = productionWorkflow(found.task);
  try {
    for (const edit of edits) {
      const editPath = String(edit.path || "");
      const previousValue = readManualValue(found.procedure.pir as any, editPath);
      applyManualEdit(found.procedure.pir as any, editPath, edit.value);
      workflow.fieldEdits.push({
        editId: crypto.randomUUID(),
        procedureId: found.procedure.procedureId,
        packageId: found.procedure.packageId,
        path: editPath,
        previousValue,
        value: edit.value,
        reviewer,
        note: String(req.body?.note || edit.note || "").trim() || undefined,
        editedAt: new Date().toISOString(),
      });
    }
  } catch (error) {
    return res.status(400).json({ error: error instanceof Error ? error.message : "字段路径无效。" });
  }
  found.procedure.version += 1;
  const pkg = found.task.packages.find(
    (p) => p.packageId === found.procedure.packageId,
  );
  const validations = validatePir(found.procedure.pir, pkg?.recognitionPlan);
  found.procedure.validations = validations;
  found.procedure.pir.validation.results = validations;
  found.procedure.geojson = compileGeoJson(found.procedure.pir);
  found.procedure.candidate424 = compile424Candidate(
    found.procedure.pir,
    validations,
  );
  if (pkg) pkg.status = applyQualityGate(found.procedure.pir, validations);
  await saveAgentTask(found.task);
  res.json({ procedure: found.procedure, production: assessTaskForProduction(found.task) });
});

function documentFromUpload(
  file: Express.Multer.File,
  createdAt: string,
): AipDocument {
  return {
    documentId: crypto.randomUUID(),
    fileName: file.originalname,
    filePath: file.path,
    sizeBytes: file.size,
    pageCount: 0,
    parseStatus: "UPLOADED",
    createdAt,
  };
}
function publicDocument(document: AipDocument) {
  const { filePath: _hidden, ...publicValue } = document;
  return publicValue;
}
function workspaceTask(task: AgentTask) {
  return {
    ...task,
    // procedures 被剥离以控制体积，前端因此无法自行判断某个包有没有识别结果。
    // 显式给出，避免前端退回用 status 猜——REQUIRES_REVIEW 只说明校验有问题，不等于有结果。
    packages: task.packages.map((pkg) => ({
      ...pkg,
      hasResult: task.procedures.some(
        (procedure) => procedure.packageId === pkg.packageId,
      ),
    })),
    documents: task.documents.map(publicDocument),
    pages: task.pages.map((page) => ({
      pageNumber: page.pageNumber,
      globalPageNumber: page.globalPageNumber,
      documentId: page.documentId,
      fileName: page.fileName,
      title: page.title,
    })),
    procedures: [],
    modelCalls: task.modelCalls.map(
      ({ rawResponsePath: _hidden, ...call }) => call,
    ),
  };
}
function guessAirport(files: Express.Multer.File[]) {
  return (
    files.map((f) => f.originalname.match(/\b[A-Z]{4}\b/)?.[0]).find(Boolean) ||
    "机场"
  );
}
function taskSummary(task: AgentTask) {
  const production = assessTaskForProduction(task);
  return {
    taskId: task.taskId,
    taskName: task.taskName,
    airport: task.airportIcao
      ? { icao: task.airportIcao, name: task.airportName }
      : task.airportAnalysis?.airport,
    fileCount: task.documents.length,
    documentCount: task.documents.length,
    batchId: task.production?.batchId,
    sourceCountry: task.production?.sourceCountry,
    packageCount: task.packages.length,
    recognizedCount: task.packages.filter((p) =>
      ["COMPLETED", "COMPLETED_WITH_WARNINGS"].includes(p.status),
    ).length,
    production: {
      pendingPackages: production.pendingPackages,
      autoPassPackages: production.autoPassPackages,
      humanConfirmedPackages: production.humanConfirmedPackages,
      reviewPackages: production.reviewPackages,
      blockedPackages: production.blockedPackages,
      autoPassRate: production.autoPassRate,
      releaseReady: production.releaseReady,
      openExceptionCount: production.openExceptionCount,
      releaseCurrent: production.releaseCurrent,
      latestRelease: production.latestRelease,
    },
    status: task.status,
    stage: task.stage,
    progress: task.progress,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    error: task.error,
  };
}
function productionWorkflow(task: AgentTask): ProductionWorkflow {
  task.production ||= { exceptionDecisions: [], fieldEdits: [], releases: [] };
  task.production.exceptionDecisions ||= [];
  task.production.fieldEdits ||= [];
  task.production.releases ||= [];
  return task.production;
}
function newPackage(task: AgentTask, body: any): BusinessProcedurePackage {
  const category = ["SID", "STAR", "APPROACH"].includes(body.procedureCategory)
    ? body.procedureCategory
    : "SID";
  return {
    packageId: crypto.randomUUID(),
    procedureKey: body.procedureKey || crypto.randomUUID(),
    category: category === "SID" ? "SID" : "STAR",
    procedureCategory: category,
    procedureName: body.procedureName || "未命名程序",
    runways: body.runways || [],
    navigationType: body.navigationType || null,
    packagePages: body.packagePages || [],
    groupingConfidence: 1,
    groupingReason: "用户新建程序包",
    status: "GROUPED",
    sources: {
      primaryCharts: [],
      procedureTables: [],
      coordinateTables: [],
      runwayPages: [],
      navaidPages: [],
      sharedNotes: [],
      profilePages: [],
      minimaPages: [],
      relatedPages: [],
    },
    confidence: 1,
    warnings: [],
  };
}
function uniquePages(pages: any[]) {
  const seen = new Set<string>();
  return pages.filter((p) => {
    const key = `${p.documentId}:${p.pageNumber}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
async function findPackage(id: string) {
  for (const task of await listAgentTasks()) {
    const pkg = task.packages.find((p) => p.packageId === id);
    if (pkg) return { task, pkg };
  }
}
async function findProcedure(id: string) {
  for (const task of await listAgentTasks()) {
    const procedure = task.procedures.find((p) => p.procedureId === id);
    if (procedure) return { task, procedure };
  }
}
function latestProcedure(task: AgentTask, packageId: string) {
  return task.procedures
    .filter((p) => p.packageId === packageId)
    .sort((a, b) => b.version - a.version)[0];
}
async function packageArtifact(
  id: string,
  res: express.Response,
  field: "geojson" | "candidate424",
) {
  const found = await findPackage(id);
  if (!found) return res.status(404).json({ error: "程序包不存在。" });
  const result = latestProcedure(found.task, id);
  if (!result) return res.status(404).json({ error: "程序包尚无识别结果。" });
  res.json(result[field] || null);
}
async function respondProcedure(
  id: string,
  res: express.Response,
  pick: (p: any) => unknown,
) {
  const found = await findProcedure(id);
  if (!found) return res.status(404).json({ error: "程序不存在。" });
  res.json(pick(found.procedure));
}
async function recompile(
  id: string,
  res: express.Response,
  kind: "geojson" | "424",
) {
  const found = await findProcedure(id);
  if (!found?.procedure.pir)
    return res.status(404).json({ error: "程序不存在。" });
  const value =
    kind === "geojson"
      ? compileGeoJson(found.procedure.pir)
      : compile424Candidate(found.procedure.pir);
  if (kind === "geojson") found.procedure.geojson = value as any;
  else {
    found.procedure.candidate424 = value as any;
    if ((value as any).status === "424_CANDIDATE") {
      const pkg = found.task.packages.find(
        (item) => item.packageId === found.procedure.packageId,
      );
      if (pkg)
        pkg.warnings = pkg.warnings.filter(
          (warning) => !warning.includes("后端服务重启导致识别中断"),
        );
    }
  }
  found.task.stage = "RESULTS_READY";
  found.task.status = "COMPLETED";
  await saveAgentTask(found.task);
  res.json(value);
}
function applyManualEdit(root: any, pathText: string, value: unknown) {
  const parts = pathText
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter(Boolean);
  let node = root;
  for (let i = 0; i < parts.length - 1; i++) {
    if (node[parts[i]] == null)
      throw new Error(`Invalid field path: ${pathText}`);
    node = node[parts[i]];
  }
  node[parts.at(-1)!] = value;
  if (parts[0] === "legs" && /^\d+$/.test(parts[1] || ""))
    root.legs[+parts[1]].fieldStatus[parts.slice(2).join(".")] =
      "MANUALLY_EDITED";
}
function readManualValue(root: any, pathText: string) {
  const parts = pathText
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter(Boolean);
  if (!parts.length) throw new Error("字段路径不能为空。");
  let node = root;
  for (const part of parts) {
    if (node == null || !(part in node)) throw new Error(`Invalid field path: ${pathText}`);
    node = node[part];
  }
  return structuredClone(node);
}

// 放在所有路由之后：saveAgentTask 现在会在任务被别的运行者持有时抛错（此前它从不抛）。
// 不接住的话，一次并发编辑会变成挂死的请求；409 才说得清"没写进去，且原因是什么"。
agentRouter.use(
  (
    error: unknown,
    _req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    if (error instanceof TaskRunConflictError) {
      return res.status(409).json({
        error: error.message,
        code: "TASK_RUN_CONFLICT",
        holder: error.holder,
      });
    }
    return next(error);
  },
);
