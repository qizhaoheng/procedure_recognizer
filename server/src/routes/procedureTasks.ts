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
import { compareSimpleProcedureLegs } from '../services/jeppesen424/simpleProcedureComparator';
import { simpleLegsTo424Text } from '../services/jeppesen424/simpleLegsTo424Text';
import { buildPrompt as buildProcedurePrompt } from '../services/prompt/promptBuilder';
import { savePromptRunRecord } from '../services/prompt/promptRunStore';
import { buildAiRequestPreview } from '../services/promptBuilder';
import { buildGeoJsonFromProcedureUnderstanding } from '../services/procedureUnderstandingGeojson';
import { normalizeProcedureUnderstandingResult } from '../services/procedureUnderstandingNormalizer';
import { buildGroupingDebug } from '../services/procedurePackageGrouper';
import { regroupPages } from '../services/procedureGrouper';
import { getLlmRuntimeConfig } from '../services/llm/llmClient';
import type { EvaluationResult, ProcedureGroup, ProcedureUnderstandingResult } from '../types/procedure';
import type { BuiltPrompt, PromptRunRecord } from '../services/prompt/promptTypes';

const router = express.Router();
const routeDir = path.dirname(fileURLToPath(import.meta.url));
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

router.post('/upload', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: '缺少 PDF 文件。' });
    const task = await createTask(req.file.originalname, req.file.path);
    return res.json({ taskId: task.taskId, fileName: task.fileName, status: task.status });
  } catch (error) {
    return next(error);
  }
});

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
    group.geojsonStatus = group.geojson ? 'GENERATED' : 'ERROR';
    group.geojsonGeneratedAt = group.geojson ? new Date().toISOString() : undefined;
    group.geojsonError = group.geojson ? undefined : group.aiResponse.errors?.join('; ') || 'GeoJSON generation failed';
    group.status = group.geojson ? 'AI_COMPLETED' : 'ERROR';
    task.status = group.geojson ? 'AI_COMPLETED' : 'ERROR';
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
    await updateTask(req.params.taskId, (draft) => {
      const group = findGroup(draft.groups, req.params.packageId);
      group.geojsonStatus = 'GENERATING';
      group.geojsonError = undefined;
    });

    const task = await readTask(req.params.taskId);
    const group = findGroup(task.groups, req.params.packageId);
    const model = req.body?.model || process.env.LLM_MODEL || 'mock-procedure-recognizer';
    if (group.procedureUnderstanding) {
      group.geojson = buildGeoJsonFromProcedureUnderstanding(group.procedureUnderstanding, group);
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
    group.status = group.geojson ? 'AI_COMPLETED' : 'ERROR';
    task.status = group.geojson ? 'AI_COMPLETED' : 'ERROR';
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

router.post('/:taskId/packages/:packageId/run-vision-recognition', async (req, res, next) => {
  const startedAt = new Date().toISOString();
  let model = String(req.body?.model || getLlmRuntimeConfig().model);
  let builtPrompt: BuiltPrompt | undefined;
  let promptRun: PromptRunRecord | undefined;
  try {
    await updateTask(req.params.taskId, (draft) => {
      const group = findGroup(draft.groups, req.params.packageId);
      group.status = 'AI_RUNNING';
      group.aiResponse = undefined;
      group.procedureUnderstanding = undefined;
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
    const aiInputPackage = buildAiInputPackage(group, task.pages, model);
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
    group.aiResponse = await runProcedureUnderstandingRecognition(builtPrompt, model);
    group.aiResponse.parsedJson = normalizeProcedureUnderstandingResult(group.aiResponse.parsedJson, group, aiInputPackage);
    const completedAt = new Date().toISOString();
    const validationResult = validateProcedureUnderstandingResult(group.aiResponse.parsedJson, builtPrompt.responseSchema);
    const validationErrorMessage = validationResult.schemaValid ? undefined : schemaValidationMessage(validationResult.errors);
    group.procedureUnderstanding = group.aiResponse.parsedJson as ProcedureUnderstandingResult;
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
      rawResponse: group.aiResponse.rawText,
      parsedJson: group.aiResponse.parsedJson,
      validationResult,
      schemaValidation: {
        valid: validationResult.schemaValid,
        errors: validationResult.errors,
      },
      errorType: validationResult.schemaValid ? undefined : 'SCHEMA_VALIDATION',
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
    await markRecognitionError(req.params.taskId, req.params.packageId, error, { startedAt, model, builtPrompt, promptRun });
    const normalized = normalizeRecognitionError(error);
    res.status(500).json({
      ok: false,
      taskId: req.params.taskId,
      packageId: req.params.packageId,
      errorType: normalized.errorType,
      error: normalized.message,
      rawError: normalized.rawError,
    });
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

    const parsedJeppesenLegs = filterSimpleLegs(parseJeppesen424Text(text), procedureFilter, runway);
    const aiLegs = filterSimpleLegs(aiProcedureToSimpleLegs(group.procedureUnderstanding), procedureFilter, runway);
    const procedureResults = compareSimpleProcedureLegs(aiLegs, parsedJeppesenLegs);

    const totalLegs = procedureResults.reduce((sum, result) => sum + result.totalLegs, 0);
    const matchedLegs = procedureResults.reduce((sum, result) => sum + result.matchedLegs, 0);
    const missingAiLegs = procedureResults.reduce((sum, result) => sum + result.legResults.filter((leg) => leg.status === 'MISSING_AI').length, 0);
    const missingJeppesenLegs = procedureResults.reduce((sum, result) => sum + result.legResults.filter((leg) => leg.status === 'MISSING_JEPPESEN').length, 0);
    const fieldMismatchCount = procedureResults.reduce(
      (sum, result) => sum + result.legResults.reduce((legSum, leg) => legSum + leg.fieldResults.filter((field) => !field.matched).length, 0),
      0,
    );
    const issueCount = fieldMismatchCount + missingAiLegs + missingJeppesenLegs;
    const overallScore = totalLegs
      ? Math.round((procedureResults.reduce((sum, result) => sum + result.score * result.totalLegs, 0) / totalLegs) * 10) / 10
      : 0;

    res.json({
      ok: true,
      summary: {
        totalProcedures: procedureResults.length,
        matchedProcedures: procedureResults.filter((result) => result.score >= 99.999).length,
        totalLegs,
        matchedLegs,
        missingAiLegs,
        missingJeppesenLegs,
        fieldMismatchCount,
        issueCount,
        overallScore,
      },
      procedureResults,
      parsedJeppesenLegs,
      aiLegs,
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
        airportIcao: group.procedureUnderstanding.airportIcao ?? undefined,
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

function findGroup(groups: ProcedureGroup[], groupId: string) {
  const group = groups.find((item) => item.groupId === groupId || item.packageId === groupId);
  if (!group) throw new Error('分组不存在。');
  return group;
}

function filterSimpleLegs<T extends { procedureName: string; runway: string }>(legs: T[], procedureFilter: string[], runway: string) {
  const allowedProcedures = new Set(procedureFilter);
  return legs.filter((leg) => {
    if (allowedProcedures.size && !allowedProcedures.has(normalizeCompareText(leg.procedureName))) return false;
    if (runway && normalizeRunway(leg.runway) !== runway) return false;
    return true;
  });
}

function normalizeCompareText(value: unknown) {
  return String(value ?? '').trim().replace(/\s+/g, ' ').toUpperCase();
}

function normalizeRunway(value: unknown) {
  const text = normalizeCompareText(value).replace(/\s+/g, '').replace(/^RWY/, 'RW');
  if (!text) return '';
  return text.startsWith('RW') ? text : `RW${text}`;
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
