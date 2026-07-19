import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import express from "express";
import multer from "multer";
import type {
  AgentTask,
  AipDocument,
  BusinessProcedurePackage,
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
  readAgentTask,
  saveAgentTask,
  writeArtifact,
} from "./storage";

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
  };
  await ensureAgentStorage();
  await saveAgentTask(task);
  if (req.body.autoAnalyze === "true") startTaskAnalysis(task);
  res.status(202).json(taskSummary(task));
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
  startTaskAnalysis(task);
  res.status(202).json({ taskId: task.taskId, status: "ANALYZING" });
});
agentRouter.post("/tasks/:id/start", async (req, res) => {
  const task = await readAgentTask(req.params.id);
  startTaskAnalysis(task);
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
  startTaskAnalysis(task);
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
  startTaskAnalysis(task);
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
  startPackagesRecognition(task, packages);
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
  for (const edit of req.body.edits || [])
    applyManualEdit(found.procedure.pir as any, edit.path, edit.value);
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
  res.json(found.procedure);
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
  return {
    taskId: task.taskId,
    taskName: task.taskName,
    airport: task.airportIcao
      ? { icao: task.airportIcao, name: task.airportName }
      : task.airportAnalysis?.airport,
    fileCount: task.documents.length,
    documentCount: task.documents.length,
    packageCount: task.packages.length,
    recognizedCount: task.packages.filter((p) =>
      ["COMPLETED", "COMPLETED_WITH_WARNINGS"].includes(p.status),
    ).length,
    status: task.status,
    stage: task.stage,
    progress: task.progress,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    error: task.error,
  };
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
