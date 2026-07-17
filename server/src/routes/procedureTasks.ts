import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020';
import express from 'express';
import multer from 'multer';
import { PDFDocument } from 'pdf-lib';
import { createTask, getUploadDir, listTasks, readTask, saveTask, updateTask } from '../storage/taskStore';
import { extractCandidates } from '../services/candidateExtractor';
import { validateProcedureGeoJson } from '../services/geojsonValidator';
import { LlmApiError, runProcedureRecognition, runProcedureUnderstandingRecognition } from '../services/llmService';
import { parsePdfTask } from '../services/pdfService';
import { buildAiInputPackage } from '../services/aiInputPackageBuilder';
import { evaluateProcedureUnderstanding } from '../services/evaluation/procedureUnderstandingEvaluator';
import { aiProcedureToSimpleLegs } from '../services/jeppesen424/aiProcedureToSimpleLegs';
import { parseJeppesen424Text } from '../services/jeppesen424/jeppesen424TextParser';
import { alignJeppesenProcedureNames, compareSimpleProcedureLegs } from '../services/jeppesen424/simpleProcedureComparator';
import { buildGraphsFromJeppesenLegs, buildGraphsFromUnderstanding } from '../services/procedureGraph/buildProcedureGraph';
import { compareProcedureGraphs, findMatchingJeppesenGraph } from '../services/procedureGraph/graphComparator';
import { materializeAllRoutes } from '../services/procedureGraph/materializeRoute';
import { simpleLegsTo424Text } from '../services/jeppesen424/simpleLegsTo424Text';
import { buildPrompt as buildProcedurePrompt } from '../services/prompt/promptBuilder';
import { savePromptRunRecord } from '../services/prompt/promptRunStore';
import { buildAiRequestPreview } from '../services/promptBuilder';
import { buildGeoJsonFromProcedureUnderstanding } from '../services/procedureUnderstandingGeojson';
import { buildProcedureRenderPlan } from '../services/rendering/procedureRenderPlan';
import { airportIcaoFromGroup, normalizeProcedureUnderstandingResult } from '../services/procedureUnderstandingNormalizer';
import { buildGroupingDebug } from '../services/procedurePackageGrouper';
import { regroupPages } from '../services/procedureGrouper';
import { getLlmRuntimeConfig } from '../services/llm/llmClient';
import { locateLocalRasterEvidence } from '../services/recognition-v2/tables/localRasterTableRecovery';
import type { AiInputPackage, EvaluationResult, GeoJsonRenderMode, ProcedureGroup, ProcedureUnderstandingResult } from '../types/procedure';
import type { BuiltPrompt, PromptRunRecord } from '../services/prompt/promptTypes';

const router = express.Router();
const routeDir = path.dirname(fileURLToPath(import.meta.url));
const activeRecognitionRuns = new Map<string, AbortController>();
const upload = multer({
  storage: multer.diskStorage({
    destination: async (_req, _file, callback) => {
      const uploadDir = getUploadDir();
      await fs.mkdir(uploadDir, { recursive: true });
      callback(null, uploadDir);
    },
    filename: (_req, file, callback) => {
      const safeName = file.originalname.replace(/[^\w.\-() ]+/g, '_');
      callback(null, `${Date.now()}-${safeName}`);
    },
  }),
  fileFilter: (_req, file, callback) => {
    if (file.mimetype === 'application/pdf' || file.originalname.toLowerCase().endsWith('.pdf')) callback(null, true);
    else callback(new Error('请上传 PDF 文件。'));
  },
});

router.get('/', async (_req, res, next) => {
  try {
    res.json(await listTasks());
  } catch (error) {
    next(error);
  }
});

const uploadFields = upload.fields([
  { name: 'file', maxCount: 1 },
  { name: 'files', maxCount: 300 },
]);

router.post('/upload', uploadFields, async (req, res, next) => {
  try {
    const bucket = (req.files ?? {}) as Record<string, Express.Multer.File[]>;
    const files = [...(bucket.file ?? []), ...(bucket.files ?? [])];
    if (!files.length) return res.status(400).json({ error: '缺少 PDF 文件。' });

    if (files.length === 1) {
      const task = await createTask(files[0].originalname, files[0].path);
      return res.json({ taskId: task.taskId, fileName: task.fileName, status: task.status });
    }

    // 日/韩式 AIP 一个机场拆成多份 PDF：按文件名自然序合并成单文件，下游管线保持"一任务一 PDF"
    const merged = await mergeUploadedPdfFiles(files);
    const task = await createTask(merged.fileName, merged.filePath, merged.sourceFiles);
    return res.json({ taskId: task.taskId, fileName: task.fileName, status: task.status, sourceFiles: task.sourceFiles });
  } catch (error) {
    return next(error);
  }
});

async function mergeUploadedPdfFiles(files: Express.Multer.File[]) {
  const ordered = [...files].sort((a, b) =>
    a.originalname.localeCompare(b.originalname, 'en', { numeric: true, sensitivity: 'base' }),
  );
  const mergedDoc = await PDFDocument.create();
  const sourceFiles: Array<{ fileName: string; startPageNo: number; pageCount: number }> = [];

  for (const file of ordered) {
    const source = await PDFDocument.load(await fs.readFile(file.path), { ignoreEncryption: true });
    const copied = await mergedDoc.copyPages(source, source.getPageIndices());
    sourceFiles.push({
      fileName: file.originalname,
      startPageNo: mergedDoc.getPageCount() + 1,
      pageCount: copied.length,
    });
    for (const page of copied) mergedDoc.addPage(page);
  }

  const fileName = `${ordered[0].originalname.replace(/\.pdf$/i, '')} 等${ordered.length}个文件（合并）.pdf`;
  const filePath = path.join(getUploadDir(), `${Date.now()}-merged-${ordered.length}files.pdf`);
  await fs.writeFile(filePath, await mergedDoc.save());
  for (const file of ordered) await fs.unlink(file.path).catch(() => undefined);
  return { fileName, filePath, sourceFiles };
}

router.post('/:taskId/parse', async (req, res, next) => {
  try {
    const task = await updateTask(req.params.taskId, (draft) => {
      draft.status = 'PARSING';
      draft.error = undefined;
    });
    res.json({ taskId: task.taskId, status: task.status });

    try {
      const parsedTask = await readTask(req.params.taskId);
      parsedTask.pages = await parsePdfTask(parsedTask);
      parsedTask.groups = regroupPages(parsedTask.pages);
      parsedTask.status = parsedTask.groups.length ? 'GROUPED' : 'PARSED';
      await saveTask(parsedTask);
    } catch (error) {
      await updateTask(req.params.taskId, (draft) => {
        draft.status = 'ERROR';
        draft.error = error instanceof Error ? error.message : 'PDF 解析失败';
      });
    }
  } catch (error) {
    next(error);
  }
});

router.post('/:taskId/regroup', async (req, res, next) => {
  try {
    const task = await updateTask(req.params.taskId, (draft) => {
      draft.groups = regroupPages(draft.pages);
      draft.status = draft.groups.length ? 'GROUPED' : 'PARSED';
    });
    res.json(task);
  } catch (error) {
    next(error);
  }
});

router.get('/:taskId', async (req, res, next) => {
  try {
    res.json(await readTask(req.params.taskId));
  } catch (error) {
    next(error);
  }
});

router.get('/:taskId/grouping-debug', async (req, res, next) => {
  try {
    const task = await readTask(req.params.taskId);
    res.json(buildGroupingDebug(task.pages));
  } catch (error) {
    next(error);
  }
});

router.get('/:taskId/pdf', async (req, res, next) => {
  try {
    const task = await readTask(req.params.taskId);
    res.sendFile(path.resolve(task.filePath));
  } catch (error) {
    next(error);
  }
});

router.get('/:taskId/groups/:groupId/pdf', async (req, res, next) => {
  try {
    const task = await readTask(req.params.taskId);
    const group = findGroup(task.groups, req.params.groupId);
    const pageNos = Array.from(
      new Set([
        ...group.chartPages,
        ...group.tabularPages,
        ...group.coordinatePages,
        ...group.minimaPages,
        ...(group.textSupplementPages ?? []),
        ...group.otherPages,
      ]),
    ).sort((a, b) => a - b);
    if (!pageNos.length) return res.status(400).json({ error: '该分组没有关联页面。' });

    const source = await PDFDocument.load(await fs.readFile(task.filePath), { ignoreEncryption: true });
    const pageIndices = pageNos.filter((no) => no >= 1 && no <= source.getPageCount()).map((no) => no - 1);
    if (!pageIndices.length) return res.status(400).json({ error: '分组页码超出 PDF 页数范围。' });

    const output = await PDFDocument.create();
    const copiedPages = await output.copyPages(source, pageIndices);
    for (const page of copiedPages) output.addPage(page);
    const bytes = await output.save();

    const baseName = (group.packageName || group.groupName || group.groupId).replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim() || group.groupId;
    const asciiName = baseName.replace(/[^\x20-\x7E]+/g, '').trim() || 'group';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${asciiName}.pdf"; filename*=UTF-8''${encodeURIComponent(`${baseName}.pdf`)}`,
    );
    return res.send(Buffer.from(bytes));
  } catch (error) {
    return next(error);
  }
});

router.get('/:taskId/pages/:pageNo/image', async (req, res, next) => {
  try {
    const task = await readTask(req.params.taskId);
    const page = task.pages.find((item) => item.pageNo === Number(req.params.pageNo));
    if (!page?.imageUrl) return res.status(404).json({ error: '页面图片不存在。' });
    res.sendFile(path.resolve(process.cwd(), 'server', 'data', page.imageUrl.replace(/^\/uploads\//, '')));
  } catch (error) {
    next(error);
  }
});

router.get('/:taskId/pages/:pageNo/evidence-location', async (req, res, next) => {
  try {
    const task = await readTask(req.params.taskId);
    const page = task.pages.find((item) => item.pageNo === Number(req.params.pageNo));
    if (!page) return res.status(404).json({ error: 'PDF 页面不存在。' });
    const rawTerms = Array.isArray(req.query.term) ? req.query.term : [req.query.term];
    const terms = rawTerms.filter((term): term is string => typeof term === 'string').map((term) => term.trim()).filter(Boolean).slice(0, 12);
    if (!terms.length) return res.status(400).json({ error: '缺少证据定位关键词。' });
    const sourceType = typeof req.query.sourceType === 'string' ? req.query.sourceType : undefined;
    const location = await locateLocalRasterEvidence(page, terms, sourceType);
    if (!location) return res.status(404).json({ error: '该证据没有可验证的精确位置。' });
    res.setHeader('Cache-Control', 'private, max-age=300');
    return res.json(location);
  } catch (error) {
    return next(error);
  }
});

router.patch('/:taskId/pages/:pageNo', async (req, res, next) => {
  try {
    const task = await updateTask(req.params.taskId, (draft) => {
      const page = draft.pages.find((item) => item.pageNo === Number(req.params.pageNo));
      if (!page) throw new Error('页面不存在。');
      Object.assign(page, req.body);
      if (req.body.chartNo && !req.body.aipPageNo) page.aipPageNo = req.body.chartNo;
      page.reviewRequired = false;
    });
    res.json(task);
  } catch (error) {
    next(error);
  }
});

router.patch('/:taskId/groups', async (req, res, next) => {
  try {
    const task = await updateTask(req.params.taskId, (draft) => {
      if (!Array.isArray(req.body.groups)) throw new Error('groups 必须是数组。');
      draft.groups = req.body.groups as ProcedureGroup[];
      draft.status = draft.groups.length ? 'GROUPED' : 'PARSED';
    });
    res.json(task);
  } catch (error) {
    next(error);
  }
});

router.post('/:taskId/groups/:groupId/extract-candidates', async (req, res, next) => {
  try {
    let result;
    await updateTask(req.params.taskId, (draft) => {
      const group = findGroup(draft.groups, req.params.groupId);
      result = extractCandidates(group, draft.pages);
      Object.assign(group, result, { status: 'CANDIDATES_EXTRACTED' });
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.get('/:taskId/groups/:groupId/ai-request-preview', async (req, res, next) => {
  try {
    const task = await readTask(req.params.taskId);
    const group = findGroup(task.groups, req.params.groupId);
    res.json(buildAiRequestPreview(group, task.pages, String(req.query.model || process.env.LLM_MODEL || 'mock-procedure-recognizer')));
  } catch (error) {
    next(error);
  }
});

router.get('/:taskId/packages/:packageId/ai-input-package', async (req, res, next) => {
  try {
    const task = await readTask(req.params.taskId);
    const group = findGroup(task.groups, req.params.packageId);
    const preview = buildAiRequestPreview(group, task.pages, String(req.query.model || process.env.LLM_MODEL || 'mock-procedure-recognizer'));
    res.json(preview.aiInputPackage);
  } catch (error) {
    next(error);
  }
});

router.get('/:taskId/packages/:packageId/prompt-preview', async (req, res, next) => {
  try {
    const task = await readTask(req.params.taskId);
    const group = findGroup(task.groups, req.params.packageId);
    const packageId = group.packageId || group.groupId;
    const model = String(req.query.model || getLlmRuntimeConfig().model);
    const aiInputPackage = buildAiInputPackage(group, task.pages, model);
    const builtPrompt = await buildProcedurePrompt({
      taskId: task.taskId,
      packageId,
      procedurePackage: group,
      aiInputPackage,
      templateOverrideId: req.query.templateId ? String(req.query.templateId) : undefined,
    });
    res.json(builtPrompt);
  } catch (error) {
    next(error);
  }
});

router.post('/:taskId/groups/:groupId/run-ai', async (req, res, next) => {
  try {
    await updateTask(req.params.taskId, (draft) => {
      const group = findGroup(draft.groups, req.params.groupId);
      group.status = 'AI_RUNNING';
      draft.status = 'AI_RUNNING';
    });

    const task = await readTask(req.params.taskId);
    const group = findGroup(task.groups, req.params.groupId);
    const model = req.body?.model || process.env.LLM_MODEL || 'mock-procedure-recognizer';
    const preview = buildAiRequestPreview(group, task.pages, model);
    group.aiRequest = {
      model,
      prompt: preview.prompt,
      schemaName: 'ProcedureGeoJsonFeatureCollection',
      inputPageNos: Array.from(new Set([
        ...preview.aiInputPackage.includedImages.map((page) => page.pageNo),
        ...preview.aiInputPackage.includedSummaries.flatMap((item) => item.pageNos),
      ])).sort((a, b) => a - b),
      createdAt: new Date().toISOString(),
    };
    group.aiResponse = await runProcedureRecognition(group, preview);
    group.geojson = group.aiResponse.geojson;
    const validation = group.geojson ? validateProcedureGeoJson(group.geojson, group) : undefined;
    group.geojsonStatus = group.geojson && validation?.valid ? 'GENERATED' : 'ERROR';
    group.geojsonGeneratedAt = group.geojson && validation?.valid ? new Date().toISOString() : undefined;
    group.geojsonError = group.geojson
      ? validation?.errors.join('; ') || group.aiResponse.errors?.join('; ')
      : group.aiResponse.errors?.join('; ') || 'GeoJSON generation failed';
    group.status = group.geojson && validation?.valid ? 'AI_COMPLETED' : 'ERROR';
    task.status = group.status === 'AI_COMPLETED' ? 'AI_COMPLETED' : 'ERROR';
    await saveTask(task);

    res.json({
      groupId: group.groupId,
      status: group.status,
      geojsonResultId: `geojson_${group.groupId}`,
      geojson: group.geojson,
    });
  } catch (error) {
    next(error);
  }
});

router.post('/:taskId/packages/:packageId/generate-geojson', async (req, res, next) => {
  try {
    const requestedRenderMode = normalizeGeoJsonRenderMode(req.body?.renderMode);
    const requestedViewMode = req.body?.viewMode === 'ROUTE_INSTANCE' ? 'ROUTE_INSTANCE' as const
      : req.body?.viewMode === 'TOPOLOGY' ? 'TOPOLOGY' as const
        : undefined;
    const instanceRunway = typeof req.body?.instanceRunway === 'string' ? req.body.instanceRunway.trim().toUpperCase() : undefined;
    const instanceEnrouteTransition = typeof req.body?.instanceEnrouteTransition === 'string'
      ? req.body.instanceEnrouteTransition.trim().toUpperCase()
      : undefined;
    await updateTask(req.params.taskId, (draft) => {
      const group = findGroup(draft.groups, req.params.packageId);
      group.geojsonStatus = 'GENERATING';
      group.geojsonError = undefined;
      if (requestedRenderMode) group.geojsonRenderMode = requestedRenderMode;
      if (requestedViewMode) group.geojsonViewMode = requestedViewMode;
      group.geojsonInstanceRunway = requestedViewMode === 'ROUTE_INSTANCE' ? instanceRunway : undefined;
      group.geojsonInstanceEnrouteTransition = requestedViewMode === 'ROUTE_INSTANCE' ? instanceEnrouteTransition : undefined;
    });

    const task = await readTask(req.params.taskId);
    const group = findGroup(task.groups, req.params.packageId);
    const model = req.body?.model || process.env.LLM_MODEL || 'mock-procedure-recognizer';
    if (group.procedureUnderstanding) {
      const renderMode = requestedRenderMode ?? group.geojsonRenderMode ?? 'AUTO';
      const renderPlan = buildProcedureRenderPlan(
        group.procedureUnderstanding,
        group,
        group.jeppesen424Source?.parsedLegs ?? [],
        renderMode,
      );
      if (renderMode === 'JEPPESEN_424' && renderPlan.source !== 'JEPPESEN_424') {
        throw new Error(renderPlan.warnings.join(' ') || 'The package does not have complete matching Jeppesen 424 data.');
      }
      group.geojsonRenderMode = renderMode;
      group.geojsonRenderSummary = {
        requestedMode: renderPlan.requestedMode,
        source: renderPlan.source,
        canonicalProcedureCount: renderPlan.canonicalProcedureCount,
        canonicalLegCount: renderPlan.canonicalLegCount,
        aiProcedureCount: renderPlan.aiProcedureCount,
        warnings: renderPlan.warnings,
      };
      group.geojson = buildGeoJsonFromProcedureUnderstanding(group.procedureUnderstanding, group, task.pages, {
        renderPlan,
        viewMode: group.geojsonViewMode ?? 'TOPOLOGY',
        instanceRunway: group.geojsonInstanceRunway,
        instanceEnrouteTransition: group.geojsonInstanceEnrouteTransition,
      });
      const validation = validateProcedureGeoJson(group.geojson, group);
      group.geojsonStatus = validation.valid ? 'GENERATED' : 'ERROR';
      group.geojsonGeneratedAt = validation.valid ? new Date().toISOString() : undefined;
      group.geojsonError = validation.valid ? undefined : validation.errors.join('; ');
    } else {
      const preview = buildAiRequestPreview(group, task.pages, model);
      group.aiRequest = {
        model,
        prompt: preview.prompt,
        schemaName: 'ProcedureGeoJsonFeatureCollection',
        inputPageNos: Array.from(new Set([
          ...preview.aiInputPackage.includedImages.map((page) => page.pageNo),
          ...preview.aiInputPackage.includedSummaries.flatMap((item) => item.pageNos),
        ])).sort((a, b) => a - b),
        createdAt: new Date().toISOString(),
      };
      group.aiResponse = await runProcedureRecognition(group, preview);
      group.geojson = group.aiResponse.geojson;
      const validation = group.geojson ? validateProcedureGeoJson(group.geojson, group) : undefined;
      group.geojsonStatus = group.geojson && validation?.valid ? 'GENERATED' : 'ERROR';
      group.geojsonGeneratedAt = group.geojson && validation?.valid ? new Date().toISOString() : undefined;
      group.geojsonError = group.geojson
        ? validation?.errors.join('; ') || group.aiResponse.errors?.join('; ')
        : group.aiResponse.errors?.join('; ') || 'GeoJSON generation failed';
    }
    group.status = group.geojson && group.geojsonStatus !== 'ERROR' ? 'AI_COMPLETED' : 'ERROR';
    task.status = group.status === 'AI_COMPLETED' ? 'AI_COMPLETED' : 'ERROR';
    await saveTask(task);

    if (!group.geojson || group.geojsonStatus === 'ERROR') {
      return res.status(500).json({
        ok: false,
        taskId: task.taskId,
        packageId: group.packageId || group.groupId,
        error: group.geojsonError,
      });
    }

    const packageId = group.packageId || group.groupId;
    return res.json({
      ok: true,
      taskId: task.taskId,
      packageId,
      geojsonId: `geojson_${packageId}`,
      geojsonPreview: group.geojson,
      renderSummary: group.geojsonRenderSummary,
      downloadUrl: `/api/procedure-tasks/${encodeURIComponent(task.taskId)}/packages/${encodeURIComponent(packageId)}/geojson/download`,
    });
  } catch (error) {
    try {
      await updateTask(req.params.taskId, (draft) => {
        const group = findGroup(draft.groups, req.params.packageId);
        group.geojsonStatus = 'ERROR';
        group.geojsonError = error instanceof Error ? error.message : 'GeoJSON generation failed';
      });
    } catch {
      // Keep the original error.
    }
    next(error);
  }
});

router.post('/:taskId/packages/:packageId/cancel-recognition', async (req, res, next) => {
  try {
    const key = recognitionRunKey(req.params.taskId, req.params.packageId);
    const controller = activeRecognitionRuns.get(key);
    controller?.abort(new Error('User cancelled recognition.'));
    const task = await markRecognitionCancelled(req.params.taskId, req.params.packageId);
    const group = findGroup(task.groups, req.params.packageId);
    res.json({
      ok: true,
      taskId: task.taskId,
      packageId: group.packageId || group.groupId,
      cancelled: Boolean(controller),
      status: group.status,
    });
  } catch (error) {
    next(error);
  }
});

router.post('/:taskId/packages/:packageId/run-vision-recognition', async (req, res, next) => {
  const startedAt = new Date().toISOString();
  let model = String(req.body?.model || getLlmRuntimeConfig().model);
  let builtPrompt: BuiltPrompt | undefined;
  let promptRun: PromptRunRecord | undefined;
  const runKey = recognitionRunKey(req.params.taskId, req.params.packageId);
  activeRecognitionRuns.get(runKey)?.abort(new Error('Superseded by a new recognition run.'));
  const abortController = new AbortController();
  const mergeWithExisting = req.body?.mergeWithExisting === true;
  activeRecognitionRuns.set(runKey, abortController);
  try {
    await updateTask(req.params.taskId, (draft) => {
      const group = findGroup(draft.groups, req.params.packageId);
      group.status = 'AI_RUNNING';
      group.recognitionStartedAt = startedAt;
      group.aiResponse = undefined;
      if (!mergeWithExisting) group.procedureUnderstanding = undefined;
      group.visionRunRecord = undefined;
      group.recognitionEvaluation = undefined;
      // 旧识别结果对应的 GeoJSON 已失效，避免预览显示陈旧轨迹
      group.geojson = undefined;
      group.geojsonStatus = 'NOT_GENERATED';
      group.geojsonGeneratedAt = undefined;
      group.geojsonError = undefined;
      draft.status = 'AI_RUNNING';
      draft.error = undefined;
    });

    const task = await readTask(req.params.taskId);
    const group = findGroup(task.groups, req.params.packageId);
    const packageId = group.packageId || group.groupId;
    model = String(req.body?.model || getLlmRuntimeConfig().model);
    const fullAiInputPackage = buildAiInputPackage(group, task.pages, model);
    const requestedPageNos = Array.isArray(req.body?.pageNos)
      ? req.body.pageNos.map(Number).filter((value: number) => Number.isInteger(value) && value > 0)
      : [];
    const aiInputPackage = requestedPageNos.length
      ? subsetAiInputPackage(fullAiInputPackage, requestedPageNos)
      : fullAiInputPackage;
    if (!aiInputPackage.includedImages.length) {
      throw new Error(`指定页批次没有可发送的图像：${requestedPageNos.join(', ')}`);
    }
    builtPrompt = await buildProcedurePrompt({
      taskId: task.taskId,
      packageId,
      procedurePackage: group,
      aiInputPackage,
      templateOverrideId: req.body?.templateId,
    });
    promptRun = await savePromptRunRecord(task.taskId, packageId, model, builtPrompt, aiInputPackage);

    group.aiRequest = {
      model,
      prompt: builtPrompt.userPrompt,
      schemaName: builtPrompt.outputSchemaName,
      schemaVersion: builtPrompt.outputSchemaVersion,
      promptRunId: promptRun.runId,
      promptTemplateId: builtPrompt.promptTemplateId,
      promptVersion: builtPrompt.promptVersion,
      inputPageNos: Array.from(new Set([
        ...builtPrompt.inputImages.map((page) => page.pageNo),
        ...builtPrompt.supportSummaries.flatMap((item) => item.pageNos),
      ])).sort((a, b) => a - b),
      createdAt: new Date().toISOString(),
    };
    group.aiResponse = await runProcedureUnderstandingRecognition(builtPrompt, model, abortController.signal);
    const originalRawText = group.aiResponse.rawText;
    const buildCandidate = (parsed: unknown) => {
      const normalized = normalizeProcedureUnderstandingResult(parsed, group, aiInputPackage) as ProcedureUnderstandingResult;
      return mergeWithExisting && group.procedureUnderstanding
        ? mergeProcedureUnderstandingResults(group.procedureUnderstanding, normalized)
        : normalized;
    };
    group.aiResponse.parsedJson = buildCandidate(group.aiResponse.parsedJson);
    let validationResult = validateProcedureUnderstandingResult(group.aiResponse.parsedJson, builtPrompt.responseSchema);
    let schemaRepairApplied = false;

    // Schema 校验失败：保留原始结果 → 触发一次修复 Prompt（文本修复，不再送图）→
    // 修复后仍失败则进入人工复核，不得静默降级成错误结果
    if (!validationResult.schemaValid) {
      try {
        const repairResponse = await runProcedureUnderstandingRecognition(
          {
            ...builtPrompt,
            userPrompt: buildSchemaRepairPrompt(validationResult.errors, originalRawText),
            inputImages: [],
          },
          model,
          abortController.signal,
        );
        const repairedCandidate = buildCandidate(repairResponse.parsedJson);
        const repairedValidation = validateProcedureUnderstandingResult(repairedCandidate, builtPrompt.responseSchema);
        if (repairedValidation.schemaValid) {
          schemaRepairApplied = true;
          group.aiResponse = { ...repairResponse, parsedJson: repairedCandidate };
          validationResult = repairedValidation;
        }
      } catch {
        // 修复调用失败保持原校验错误，进入人工复核
      }
    }

    const completedAt = new Date().toISOString();
    const validationErrorMessage = validationResult.schemaValid ? undefined : schemaValidationMessage(validationResult.errors);
    if (validationResult.schemaValid) {
      const candidate = group.aiResponse.parsedJson as ProcedureUnderstandingResult;
      if (schemaRepairApplied) {
        candidate.warnings = [
          ...(candidate.warnings ?? []),
          { message: '模型首次输出未通过 Schema 校验，已通过一次修复 Prompt 纠正；请复核关键字段。', pageNos: [], fieldName: null, reviewRequired: true },
        ];
        candidate.reviewRequired = true;
      }
      group.procedureUnderstanding = candidate;
    }
    // 校验失败：保留 group.procedureUnderstanding 原值（不得用非法结果覆盖），原始输出存于 visionRunRecord
    group.aiResponse.errors = validationResult.schemaValid ? undefined : validationResult.errors;
    group.visionRunRecord = {
      runId: `vision_run_${Date.now()}`,
      provider: group.aiResponse.provider,
      model,
      baseUrl: group.aiResponse.baseUrl,
      endpointType: group.aiResponse.endpointType,
      imageMode: group.aiResponse.imageMode,
      structuredOutputModeUsed: group.aiResponse.structuredOutputModeUsed,
      promptTemplateId: builtPrompt.promptTemplateId,
      promptVersion: builtPrompt.promptVersion,
      schemaName: builtPrompt.outputSchemaName,
      schemaVersion: builtPrompt.outputSchemaVersion,
      inputPackageHash: promptRun.inputPackageHash,
      imagePages: group.aiResponse.imagePages ?? imagePageRecords(builtPrompt, group.aiResponse.imageMode),
      supportSummaryPages: Array.from(new Set(builtPrompt.supportSummaries.flatMap((item) => item.pageNos))).sort((a, b) => a - b),
      startedAt,
      completedAt,
      rawResponse: originalRawText,
      parsedJson: group.aiResponse.parsedJson,
      validationResult,
      schemaValidation: {
        valid: validationResult.schemaValid,
        errors: validationResult.errors,
      },
      errorType: validationResult.schemaValid
        ? (schemaRepairApplied ? 'SCHEMA_REPAIRED' : undefined)
        : 'SCHEMA_VALIDATION_REVIEW',
      errorMessage: validationErrorMessage,
    };
    group.status = validationResult.schemaValid ? 'AI_COMPLETED' : 'ERROR';
    task.status = validationResult.schemaValid ? 'AI_COMPLETED' : 'ERROR';
    await saveTask(task);

    res.json({
      packageId,
      status: group.status,
      promptRunId: promptRun.runId,
      visionRunId: group.visionRunRecord.runId,
      promptTemplateId: builtPrompt.promptTemplateId,
      promptVersion: builtPrompt.promptVersion,
      outputSchemaName: builtPrompt.outputSchemaName,
      outputSchemaVersion: builtPrompt.outputSchemaVersion,
      result: group.procedureUnderstanding,
      visionRunRecord: group.visionRunRecord,
      rawText: group.aiResponse.rawText,
    });
  } catch (error) {
    const normalized = normalizeRecognitionError(error);
    if (normalized.errorType === 'CANCELLED') {
      await markRecognitionCancelled(req.params.taskId, req.params.packageId);
      return res.status(499).json({
        ok: false,
        taskId: req.params.taskId,
        packageId: req.params.packageId,
        errorType: normalized.errorType,
        error: 'AI 识别已停止。',
        rawError: normalized.rawError,
      });
    }
    await markRecognitionError(req.params.taskId, req.params.packageId, error, { startedAt, model, builtPrompt, promptRun });
    res.status(500).json({
      ok: false,
      taskId: req.params.taskId,
      packageId: req.params.packageId,
      errorType: normalized.errorType,
      error: normalized.message,
      rawError: normalized.rawError,
    });
  } finally {
    if (activeRecognitionRuns.get(runKey) === abortController) activeRecognitionRuns.delete(runKey);
  }
});

router.post('/:taskId/packages/:packageId/evaluate-recognition', async (req, res, next) => {
  try {
    const task = await readTask(req.params.taskId);
    const group = findGroup(task.groups, req.params.packageId);
    if (!group.procedureUnderstanding) return res.status(400).json({ error: 'No ProcedureUnderstanding result to evaluate.' });

    const goldenCase = await loadGoldenCase('wmkj-rwy16-rnav-star.expected.json');
    const evaluation = evaluateProcedureUnderstanding(group.procedureUnderstanding, goldenCase);
    group.recognitionEvaluation = evaluation;
    await saveTask(task);
    res.json(evaluation);
  } catch (error) {
    next(error);
  }
});

router.post('/:taskId/packages/:packageId/jeppesen424/compare', async (req, res, next) => {
  try {
    const task = await readTask(req.params.taskId);
    const group = findGroup(task.groups, req.params.packageId);
    if (!group.procedureUnderstanding) return res.status(400).json({ error: 'No ProcedureUnderstanding result to compare.' });

    const text = String(req.body?.text ?? '');
    if (!text.trim()) return res.status(400).json({ error: 'Jeppesen 424 text is required.' });

    const procedureFilter = Array.isArray(req.body?.procedureFilter)
      ? req.body.procedureFilter.map((item: unknown) => normalizeCompareText(item)).filter(Boolean)
      : [];
    const runway = normalizeRunway(req.body?.runway ?? group.runway ?? group.procedureUnderstanding.runway ?? '');

    const allAiLegs = aiProcedureToSimpleLegs(group.procedureUnderstanding);
    // 先用 424 路线代码把 Jeppesen 腿段对齐到 AI 程序名下，再做程序/跑道过滤
    const alignedJeppesenLegs = alignJeppesenProcedureNames(allAiLegs, parseJeppesen424Text(text));
    const parsedJeppesenLegs = filterSimpleLegs(alignedJeppesenLegs, procedureFilter, runway);
    const aiLegs = filterSimpleLegs(allAiLegs, procedureFilter, runway);
    const procedureResults = compareSimpleProcedureLegs(aiLegs, parsedJeppesenLegs);

    // ==================== 四阶段程序图对比（身份门槛 → 拓扑 → 腿段 → 字段） ====================
    // 覆盖率与拓扑差异基于"全部" 424 腿段（不受跑道过滤影响），保证遗漏的跑道分支/过渡可见
    const aiGraphs = buildGraphsFromUnderstanding(group.procedureUnderstanding);
    const jeppesenGraphs = buildGraphsFromJeppesenLegs(
      alignedJeppesenLegs,
      String(group.procedureUnderstanding.airportIcao ?? ''),
    );
    const graphComparisons = aiGraphs.length
      ? aiGraphs.map((aiGraph) => compareProcedureGraphs(aiGraph, findMatchingJeppesenGraph(aiGraph, jeppesenGraphs)))
      : jeppesenGraphs.map((jeppesenGraph) => compareProcedureGraphs(
        { ...jeppesenGraph, builtFrom: 'AI_UNDERSTANDING', runwayTransitions: [], commonRoutes: [], enrouteTransitions: [], mergePoints: [] },
        jeppesenGraph,
      ));
    const identityPassed = graphComparisons.some((comparison) => comparison.comparisonStatus === 'MATCHED');

    const totalLegs = procedureResults.reduce((sum, result) => sum + result.totalLegs, 0);
    const matchedLegs = procedureResults.reduce((sum, result) => sum + result.matchedLegs, 0);
    const partialLegs = procedureResults.reduce((sum, result) => sum + result.partialLegs, 0);
    const mismatchedLegs = procedureResults.reduce((sum, result) => sum + result.mismatchedLegs, 0);
    const missingAiLegs = procedureResults.reduce((sum, result) => sum + result.legResults.filter((leg) => leg.status === 'MISSING_AI').length, 0);
    const missingJeppesenLegs = procedureResults.reduce((sum, result) => sum + result.legResults.filter((leg) => leg.status === 'MISSING_JEPPESEN').length, 0);
    const fieldMismatchCount = procedureResults.reduce(
      (sum, result) => sum + result.legResults.reduce((legSum, leg) => legSum + leg.fieldResults.filter((field) => !field.matched).length, 0),
      0,
    );
    const issueCount = fieldMismatchCount + missingAiLegs + missingJeppesenLegs;
    // 程序身份门槛：主程序没有匹配成功时禁止输出总体匹配率（null，不是 0，更不是 91.3%）
    const overallScore = !identityPassed
      ? null
      : totalLegs
        ? Math.round((procedureResults.reduce((sum, result) => sum + result.score * result.totalLegs, 0) / totalLegs) * 10) / 10
        : 0;

    const importedAt = new Date().toISOString();
    const procedureCount = new Set(parsedJeppesenLegs.map((leg) => `${leg.procedureName}|${leg.runway}`)).size;
    group.jeppesen424Source = {
      text,
      parsedLegs: parsedJeppesenLegs,
      importedAt,
      procedureCount,
      legCount: parsedJeppesenLegs.length,
    };
    group.geojsonRenderMode = group.geojsonRenderMode ?? 'AUTO';
    // 用新导入的 424 腿段就地重建 GeoJSON，预览保持可用（不清空回“待处理”）
    try {
      const renderPlan = buildProcedureRenderPlan(
        group.procedureUnderstanding,
        group,
        parsedJeppesenLegs,
        group.geojsonRenderMode,
      );
      group.geojsonRenderSummary = {
        requestedMode: renderPlan.requestedMode,
        source: renderPlan.source,
        canonicalProcedureCount: renderPlan.canonicalProcedureCount,
        canonicalLegCount: renderPlan.canonicalLegCount,
        aiProcedureCount: renderPlan.aiProcedureCount,
        warnings: renderPlan.warnings,
      };
      group.geojson = buildGeoJsonFromProcedureUnderstanding(group.procedureUnderstanding, group, task.pages, { renderPlan });
      const geojsonValidation = validateProcedureGeoJson(group.geojson, group);
      group.geojsonStatus = geojsonValidation.valid ? 'GENERATED' : 'ERROR';
      group.geojsonGeneratedAt = geojsonValidation.valid ? new Date().toISOString() : undefined;
      group.geojsonError = geojsonValidation.valid ? undefined : geojsonValidation.errors.join('; ');
    } catch (renderError) {
      // 重建失败时保留原有预览，只记录错误
      group.geojsonError = renderError instanceof Error ? renderError.message : String(renderError);
    }
    await saveTask(task);

    res.json({
      ok: true,
      summary: {
        totalProcedures: procedureResults.length,
        matchedProcedures: procedureResults.filter((result) => result.score >= 99.999).length,
        totalLegs,
        matchedLegs,
        partialLegs,
        mismatchedLegs,
        missingAiLegs,
        missingJeppesenLegs,
        fieldMismatchCount,
        issueCount,
        overallScore,
        comparisonStatus: identityPassed
          ? (graphComparisons.some((comparison) => comparison.overallStatus === 'PARTIAL_COMPARISON') ? 'PARTIAL_COMPARISON' : 'MATCHED')
          : (graphComparisons[0]?.comparisonStatus ?? 'NOT_COMPARABLE'),
        reason: identityPassed ? undefined : graphComparisons[0]?.reason,
      },
      graphComparisons,
      procedureResults,
      parsedJeppesenLegs,
      aiLegs,
      renderSource: {
        importedAt,
        procedureCount,
        legCount: parsedJeppesenLegs.length,
        defaultRenderMode: 'AUTO',
      },
      geojson: group.geojson,
      geojsonStatus: group.geojsonStatus,
      geojsonRenderMode: group.geojsonRenderMode,
      geojsonRenderSummary: group.geojsonRenderSummary,
      geojsonGeneratedAt: group.geojsonGeneratedAt,
    });
  } catch (error) {
    next(error);
  }
});

router.get('/:taskId/packages/:packageId/jeppesen424/export', async (req, res, next) => {
  try {
    const task = await readTask(req.params.taskId);
    const group = findGroup(task.groups, req.params.packageId);
    if (!group.procedureUnderstanding) return res.status(400).json({ error: 'No ProcedureUnderstanding result to export.' });

    const aiLegs = aiProcedureToSimpleLegs(group.procedureUnderstanding);
    if (!aiLegs.length) return res.status(400).json({ error: 'AI 识别结果中没有可导出的腿段。' });

    const holdingFixes = (group.procedureUnderstanding.holdings ?? [])
      .map((holding) => String(holding.fixIdentifier ?? holding.fix ?? '').trim())
      .filter(Boolean);

    let text: string;
    try {
      text = simpleLegsTo424Text(aiLegs, {
        airportIcao: group.procedureUnderstanding.airportIcao ?? airportIcaoFromGroup(group) ?? undefined,
        holdingFixes,
      });
    } catch (error) {
      return res.status(422).json({ error: error instanceof Error ? error.message : String(error) });
    }

    const fileName = `${groupBaseName(group)}-jeppesen424.txt`;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${asciiFileName(fileName)}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    );
    res.send(`${text}\n`);
  } catch (error) {
    next(error);
  }
});

router.get('/:taskId/groups/:groupId/geojson', async (req, res, next) => {
  try {
    const task = await readTask(req.params.taskId);
    const group = findGroup(task.groups, req.params.groupId);
    if (!group.geojson) return res.status(404).json({ error: '该分组还没有 GeoJSON 结果。' });
    res.json(group.geojson);
  } catch (error) {
    next(error);
  }
});

router.get('/:taskId/packages/:packageId/geojson', async (req, res, next) => {
  try {
    const task = await readTask(req.params.taskId);
    const group = findGroup(task.groups, req.params.packageId);
    if (!group.geojson) return res.status(404).json({ error: 'GeoJSON has not been generated for this package.' });
    res.json(group.geojson);
  } catch (error) {
    next(error);
  }
});

router.get('/:taskId/packages/:packageId/geojson/download', async (req, res, next) => {
  try {
    const task = await readTask(req.params.taskId);
    const group = findGroup(task.groups, req.params.packageId);
    if (!group.geojson) return res.status(404).json({ error: 'GeoJSON has not been generated for this package.' });
    const fileName = geojsonFileName(group);
    res.setHeader('Content-Type', 'application/geo+json; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${asciiFileName(fileName)}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    );
    res.send(JSON.stringify(group.geojson, null, 2));
  } catch (error) {
    next(error);
  }
});

router.post('/:taskId/groups/:groupId/validate-geojson', async (req, res, next) => {
  try {
    const task = await readTask(req.params.taskId);
    const group = findGroup(task.groups, req.params.groupId);
    res.json(validateProcedureGeoJson(req.body?.geojson || group.geojson, group));
  } catch (error) {
    next(error);
  }
});

// 程序图结构：跑道过渡 / 公共航路 / 航路过渡 / 汇合点 + 全部可飞实例（供地图选择器与拓扑报告）
router.get('/:taskId/packages/:packageId/procedure-graph', async (req, res, next) => {
  try {
    const task = await readTask(req.params.taskId);
    const group = findGroup(task.groups, req.params.packageId);
    if (!group.procedureUnderstanding) return res.status(400).json({ error: 'No ProcedureUnderstanding result.' });
    const graphs = buildGraphsFromUnderstanding(group.procedureUnderstanding).map((graph) => ({
      ...graph,
      routeInstances: materializeAllRoutes(graph),
    }));
    res.json({ graphs });
  } catch (error) {
    next(error);
  }
});

function findGroup(groups: ProcedureGroup[], groupId: string) {
  const group = groups.find((item) => item.groupId === groupId || item.packageId === groupId);
  if (!group) throw new Error('分组不存在。');
  return group;
}

function recognitionRunKey(taskId: string, packageId: string) {
  return `${taskId}::${packageId}`;
}

async function markRecognitionCancelled(taskId: string, packageId: string) {
  return updateTask(taskId, (draft) => {
    const group = findGroup(draft.groups, packageId);
    const now = new Date().toISOString();
    group.status = 'AI_CANCELLED';
    group.aiResponse = {
      rawText: 'AI recognition was cancelled by the user.',
      errors: ['AI 识别已停止。'],
      createdAt: now,
    };
    group.visionRunRecord = undefined;
    if (draft.status === 'AI_RUNNING' || draft.status === 'ERROR') draft.status = 'AI_CANCELLED';
    draft.error = 'AI 识别已停止。';
  });
}

function filterSimpleLegs<T extends { procedureName: string; runway: string; transitionName?: string }>(legs: T[], procedureFilter: string[], runway: string) {
  return legs.filter((leg) => {
    if (procedureFilter.length && !procedureMatchesFilter(leg.procedureName, procedureFilter)) return false;
    // 跑道过滤只作用于跑道过渡腿：enroute transition 与 common route 属于整个程序，
    // 与选定跑道无关，不得因 runway 过滤被整体丢弃（否则 DRAKY/TATEY 等过渡会凭空"缺失 0"）
    if (runway && leg.runway && !leg.transitionName && normalizeRunway(leg.runway) !== runway) return false;
    return true;
  });
}

// 分组名与 AI 程序名粒度不同（如分组 "LARIT" vs AI "LARIT 1T"），前缀相容即视为命中
function procedureMatchesFilter(procedureName: string, filters: string[]) {
  const name = normalizeCompareText(procedureName);
  return filters.some((filter) => name === filter || name.startsWith(`${filter} `) || filter.startsWith(`${name} `));
}

function normalizeCompareText(value: unknown) {
  return String(value ?? '').trim().replace(/\s+/g, ' ').toUpperCase();
}

function normalizeRunway(value: unknown) {
  const text = normalizeCompareText(value).replace(/\s+/g, '').replace(/^RWY/, 'RW');
  if (!text) return '';
  return text.startsWith('RW') ? text : `RW${text}`;
}

function subsetAiInputPackage(input: AiInputPackage, pageNos: number[]): AiInputPackage {
  const allowed = new Set(pageNos);
  return {
    ...input,
    corePages: input.corePages.filter((page) => allowed.has(page.pageNo)),
    includedImages: input.includedImages.filter((page) => allowed.has(page.pageNo)),
  };
}

export function mergeProcedureUnderstandingResults(
  existing: ProcedureUnderstandingResult,
  incomingValue: ProcedureUnderstandingResult,
): ProcedureUnderstandingResult {
  const incoming = namespaceCollidingEvidence(existing, incomingValue);
  const classification = {
    ...(existing.procedureClassification ?? {}),
    ...(incoming.procedureClassification ?? {}),
    procedureNames: uniqueStrings([
      ...(existing.procedureClassification?.procedureNames ?? []),
      ...(incoming.procedureClassification?.procedureNames ?? []),
    ]),
  };
  return {
    ...existing,
    ...incoming,
    airportIcao: incoming.airportIcao ?? existing.airportIcao,
    airportName: incoming.airportName ?? existing.airportName,
    packageType: incoming.packageType ?? existing.packageType,
    procedureCategory: incoming.procedureCategory ?? existing.procedureCategory,
    navigationType: incoming.navigationType ?? existing.navigationType,
    runway: incoming.runway ?? existing.runway,
    procedureClassification: classification,
    procedures: normalizeMergedProcedureVariants(removeLowConfidencePlaceholders(
      mergeByKey(
        (existing.procedures ?? []) as unknown as Record<string, unknown>[],
        (incoming.procedures ?? []) as unknown as Record<string, unknown>[],
        procedureIdentity,
      ),
    )) as unknown as ProcedureUnderstandingResult['procedures'],
    tableLegs: removeCoveredTableLegVariants(
      mergeByKey(
        (existing.tableLegs ?? []) as unknown as Record<string, unknown>[],
        (incoming.tableLegs ?? []) as unknown as Record<string, unknown>[],
        tableLegIdentity,
      ),
    ) as unknown as ProcedureUnderstandingResult['tableLegs'],
    fixes: mergeRecordsByKey(existing.fixes ?? [], incoming.fixes ?? [], (item) => normalizedKey(item.identifier ?? item.fixIdentifier)),
    navaids: mergeRecordsByKey(existing.navaids ?? [], incoming.navaids ?? [], (item) => normalizedKey(item.identifier ?? item.ident)),
    runways: mergeRecordsByKey(existing.runways ?? [], incoming.runways ?? [], (item) => normalizedKey(item.identifier ?? item.runway)),
    chartTexts: mergeDistinct(existing.chartTexts ?? [], incoming.chartTexts ?? []),
    geometrySemantics: mergeDistinct(existing.geometrySemantics ?? [], incoming.geometrySemantics ?? []),
    labelPlan: mergeDistinct(existing.labelPlan ?? [], incoming.labelPlan ?? []),
    supportObjects: mergeDistinct(existing.supportObjects ?? [], incoming.supportObjects ?? []),
    communications: mergeDistinct(existing.communications ?? [], incoming.communications ?? []),
    holdings: mergeDistinct(existing.holdings ?? [], incoming.holdings ?? []),
    msa: mergeDistinct(existing.msa ?? [], incoming.msa ?? []),
    sourceEvidence: mergeByKey(existing.sourceEvidence ?? [], incoming.sourceEvidence ?? [], (item) => normalizedKey(item.id)),
    warnings: mergeDistinct(existing.warnings ?? [], incoming.warnings ?? []),
    confidence: averageDefined(existing.confidence, incoming.confidence),
    reviewRequired: Boolean(existing.reviewRequired || incoming.reviewRequired),
  };
}

function namespaceCollidingEvidence(
  existing: ProcedureUnderstandingResult,
  incoming: ProcedureUnderstandingResult,
): ProcedureUnderstandingResult {
  const used = new Set((existing.sourceEvidence ?? []).map((item) => String(item.id ?? '')));
  const replacements = new Map<string, string>();
  let index = 1;
  for (const item of incoming.sourceEvidence ?? []) {
    const id = String(item.id ?? '');
    if (!id || !used.has(id)) continue;
    let replacement = `batch_${index}_${id}`;
    while (used.has(replacement)) replacement = `batch_${++index}_${id}`;
    replacements.set(id, replacement);
    used.add(replacement);
    index += 1;
  }
  if (!replacements.size) return incoming;
  const rewrite = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(rewrite);
    if (!value || typeof value !== 'object') return value;
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key === 'id' && typeof child === 'string' && replacements.has(child)) {
        output[key] = replacements.get(child);
      } else if ((key === 'sourceEvidenceId' || key === 'evidenceId') && typeof child === 'string') {
        output[key] = replacements.get(child) ?? child;
      } else if (key === 'sourceEvidenceIds' && Array.isArray(child)) {
        output[key] = child.map((id) => replacements.get(String(id)) ?? id);
      } else {
        output[key] = rewrite(child);
      }
    }
    return output;
  };
  return rewrite(incoming) as ProcedureUnderstandingResult;
}

function procedureIdentity(item: Record<string, unknown>) {
  return [
    procedureFamilyKey(item.procedureName),
    runwayVariantKey(item.runway),
    transitionVariantKey(item.transitionName),
  ].join('|');
}

function removeLowConfidencePlaceholders<T extends { legs?: unknown[]; confidence?: number }>(procedures: T[]) {
  if (!procedures.some((item) => (item.legs?.length ?? 0) > 0)) return procedures;
  return procedures.filter((item) => (item.legs?.length ?? 0) > 0 || Number(item.confidence ?? 0) > 0.5);
}

function normalizeMergedProcedureVariants<T extends Record<string, unknown>>(procedures: T[]) {
  const normalized = procedures.map((item) => ({
    ...item,
    transitionName: typeof item.transitionName === 'string'
      ? item.transitionName.replace(/\s+TRANSITION$/i, '').trim()
      : item.transitionName,
  } as T));
  const coveredSingles = new Set<string>();
  for (const item of normalized) {
    const runway = runwayVariantKey(item.runway);
    if (!runway.includes('/')) continue;
    const family = procedureFamilyKey(item.procedureName);
    for (const member of runway.split('/').filter(Boolean)) {
      coveredSingles.add(`${family}|${member}`);
    }
  }
  return normalized.filter((item) => {
    const runway = runwayVariantKey(item.runway);
    if (!runway || runway.includes('/')) return true;
    return !coveredSingles.has(`${procedureFamilyKey(item.procedureName)}|${runway}`);
  });
}

function tableLegIdentity(item: Record<string, unknown>) {
  const name = normalizedKey(item.procedureName);
  return [
    procedureFamilyKey(name),
    runwayVariantKey(runwayFromProcedureName(name)),
    transitionFromProcedureName(name),
    item.sequence,
  ].map(normalizedKey).join('|');
}

function removeCoveredTableLegVariants<T extends Record<string, unknown>>(legs: T[]) {
  const coveredSingles = new Set<string>();
  for (const leg of legs) {
    const name = normalizedKey(leg.procedureName);
    const runway = runwayVariantKey(runwayFromProcedureName(name));
    if (!runway.includes('/')) continue;
    const family = procedureFamilyKey(name);
    for (const member of runway.split('/').filter(Boolean)) coveredSingles.add(`${family}|${member}`);
  }
  return legs.filter((leg) => {
    const name = normalizedKey(leg.procedureName);
    const runway = runwayVariantKey(runwayFromProcedureName(name));
    if (!runway || runway.includes('/')) return true;
    return !coveredSingles.has(`${procedureFamilyKey(name)}|${runway}`);
  });
}

function procedureFamilyKey(value: unknown) {
  return normalizedKey(value)
    .replace(/\s*\/\s*[A-Z0-9 -]+\s+TRANSITION$/, '')
    .replace(/\s+RWY?\s*\d{2}[LRCB]?(?:\s*\/\s*(?:RWY?\s*)?\d{2}[LRCB]?)*$/, '')
    .replace(/\s+(?:DEPARTURE|ARRIVAL)$/, '')
    .trim();
}

function runwayFromProcedureName(value: string) {
  return value.match(/RWY?\s*\d{2}[LRCB]?(?:\s*\/\s*(?:RWY?\s*)?\d{2}[LRCB]?)*$/)?.[0] ?? '';
}

function transitionFromProcedureName(value: string) {
  return value.match(/\/\s*([A-Z0-9 -]+)\s+TRANSITION$/)?.[1]?.trim().slice(0, 5) ?? '';
}

function runwayVariantKey(value: unknown) {
  return normalizedKey(value).replace(/\s+/g, '').replace(/RWY?/g, '');
}

function transitionVariantKey(value: unknown) {
  return normalizedKey(value).slice(0, 5);
}

function mergeByKey<T>(existing: T[], incoming: T[], keyOf: (item: T) => string) {
  const merged = new Map<string, T>();
  for (const item of existing) merged.set(keyOf(item), item);
  for (const item of incoming) merged.set(keyOf(item), item);
  return [...merged.values()];
}

function mergeRecordsByKey<T extends Record<string, unknown>>(
  existing: T[],
  incoming: T[],
  keyOf: (item: T) => string,
) {
  const merged = new Map<string, T>();
  for (const item of existing) merged.set(keyOf(item), item);
  for (const item of incoming) {
    const key = keyOf(item);
    const previous = merged.get(key);
    if (!previous) {
      merged.set(key, item);
      continue;
    }
    const nonNullIncoming = Object.fromEntries(
      Object.entries(item).filter(([, value]) => value !== null && value !== undefined && value !== ''),
    );
    merged.set(key, { ...previous, ...nonNullIncoming } as T);
  }
  return [...merged.values()];
}

function mergeDistinct<T>(existing: T[], incoming: T[]) {
  return mergeByKey(existing, incoming, (item) => JSON.stringify(item));
}

function normalizedKey(value: unknown) {
  return String(value ?? '').trim().toUpperCase();
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.map((value) => String(value).trim()).filter(Boolean))];
}

function averageDefined(a: number | undefined, b: number | undefined) {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return (a + b) / 2;
}

function groupBaseName(group: ProcedureGroup) {
  return (group.packageName || group.groupName || group.packageId || group.groupId)
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || 'procedure';
}

function geojsonFileName(group: ProcedureGroup) {
  return `${groupBaseName(group)}.geojson`;
}

function asciiFileName(fileName: string) {
  return fileName.replace(/[^\x20-\x7E]+/g, '').trim() || 'procedure.geojson';
}

function normalizeGeoJsonRenderMode(value: unknown): GeoJsonRenderMode | undefined {
  const mode = String(value ?? '').toUpperCase();
  return mode === 'AUTO' || mode === 'JEPPESEN_424' || mode === 'AI' ? mode : undefined;
}

async function loadGoldenCase(fileName: string) {
  const filePath = path.resolve(routeDir, '..', 'services', 'evaluation', 'golden-cases', fileName);
  return JSON.parse(await fs.readFile(filePath, 'utf-8'));
}

function validateProcedureUnderstandingResult(value: unknown, schema?: unknown) {
  const errors: string[] = [];
  if (!value || typeof value !== 'object') {
    return { schemaValid: false, errors: ['Response is not a JSON object.'] };
  }
  if (schema) {
    try {
      const ajv = new Ajv2020({ allErrors: true, strict: false });
      const validate = ajv.compile(schema);
      if (!validate(value)) {
        return {
          schemaValid: false,
          errors: (validate.errors ?? []).map((error) => `${error.instancePath || '/'} ${error.message || 'schema validation failed'}`),
        };
      }
      return { schemaValid: true, errors: [] };
    } catch (error) {
      errors.push(error instanceof Error ? `Schema validator failed: ${error.message}` : 'Schema validator failed.');
    }
  }
  const record = value as Record<string, unknown>;
  for (const key of ['procedures', 'fixes', 'sourceEvidence', 'warnings', 'confidence', 'reviewRequired']) {
    if (!(key in record)) errors.push(`Missing required field: ${key}`);
  }
  for (const key of ['procedures', 'fixes', 'sourceEvidence', 'warnings']) {
    if (key in record && !Array.isArray(record[key])) errors.push(`Field must be an array: ${key}`);
  }
  return { schemaValid: errors.length === 0, errors };
}

// 修复 Prompt：把校验错误 + 模型原始输出回喂，只允许修 JSON 结构，不得改动已识别的业务值
function buildSchemaRepairPrompt(errors: string[], rawOutput: string) {
  return [
    'Your previous JSON output failed schema validation. Repair it.',
    '',
    'Validation errors:',
    ...errors.slice(0, 40).map((error) => `- ${error}`),
    '',
    'Rules:',
    '- Return the SAME recognition content as a single valid JSON object matching the schema.',
    '- Fix structure only (missing required keys, wrong types, illegal enum values).',
    '- Do NOT invent new procedures, legs, fixes, or values. Fields without evidence stay null.',
    '- No markdown fences, no prose.',
    '',
    'Previous output:',
    rawOutput.slice(0, 60000),
  ].join('\n');
}

function schemaValidationMessage(errors: string[]) {
  const shown = errors.slice(0, 8).join('; ');
  const suffix = errors.length > 8 ? `; ...and ${errors.length - 8} more` : '';
  return `AI returned JSON but it did not match ProcedureUnderstanding schema: ${shown}${suffix}`;
}

async function markRecognitionError(
  taskId: string,
  packageId: string,
  error: unknown,
  context: {
    startedAt: string;
    model: string;
    builtPrompt?: BuiltPrompt;
    promptRun?: PromptRunRecord;
  },
) {
  try {
    await updateTask(taskId, (draft) => {
      const group = findGroup(draft.groups, packageId);
      const normalized = normalizeRecognitionError(error);
      const config = getLlmRuntimeConfig(context.model);
      group.status = 'ERROR';
      group.aiResponse = {
        rawText: normalized.message,
        errors: [normalized.message],
        createdAt: new Date().toISOString(),
      };
      if (context.builtPrompt) {
        group.visionRunRecord = {
          runId: `vision_run_${Date.now()}`,
          provider: config.provider,
          model: context.model,
          baseUrl: config.baseUrl,
          endpointType: config.endpointType,
          imageMode: config.imageMode,
          structuredOutputModeUsed: plannedStructuredOutputMode(config.structuredOutputMode),
          promptTemplateId: context.builtPrompt.promptTemplateId,
          promptVersion: context.builtPrompt.promptVersion,
          schemaName: context.builtPrompt.outputSchemaName,
          schemaVersion: context.builtPrompt.outputSchemaVersion,
          inputPackageHash: context.promptRun?.inputPackageHash || '',
          imagePages: imagePageRecords(context.builtPrompt, config.imageMode),
          supportSummaryPages: Array.from(new Set(context.builtPrompt.supportSummaries.flatMap((item) => item.pageNos))).sort((a, b) => a - b),
          startedAt: context.startedAt,
          completedAt: new Date().toISOString(),
          rawResponse: '',
          validationResult: {
            schemaValid: false,
            errors: [normalized.message],
          },
          schemaValidation: {
            valid: false,
            errors: [normalized.message],
          },
          errorType: normalized.errorType,
          errorMessage: normalized.message,
          rawError: normalized.rawError,
        };
      }
      draft.status = 'ERROR';
      draft.error = normalized.message;
    });
  } catch {
    // The original API error is more useful than a secondary persistence failure.
  }
}

function imagePageRecords(builtPrompt: BuiltPrompt, imageMode: 'base64' | 'url' = 'base64') {
  return builtPrompt.inputImages.map((page) => ({
    pageNo: page.pageNo,
    aipPageNo: page.aipPageNo,
    role: page.role,
    region: page.region || 'full_page',
    imageMode,
  }));
}

function normalizeRecognitionError(error: unknown) {
  if (error instanceof LlmApiError) {
    return {
      errorType: error.errorType,
      message: error.message,
      rawError: error.rawError,
    };
  }
  return {
    errorType: 'UNKNOWN',
    message: error instanceof Error ? error.message : 'Vision recognition failed',
    rawError: error instanceof Error ? error.stack || error.message : String(error),
  };
}

function plannedStructuredOutputMode(mode: string) {
  if (mode === 'json_object') return 'json_object' as const;
  if (mode === 'none') return 'text_json_extract' as const;
  return 'json_schema' as const;
}

export default router;
