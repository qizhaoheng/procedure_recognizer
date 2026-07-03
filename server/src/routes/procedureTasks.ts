import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import multer from 'multer';
import { createTask, getUploadDir, listTasks, readTask, saveTask, updateTask } from '../storage/taskStore';
import { extractCandidates } from '../services/candidateExtractor';
import { validateProcedureGeoJson } from '../services/geojsonValidator';
import { runProcedureRecognition } from '../services/llmService';
import { parsePdfTask } from '../services/pdfService';
import { buildAiRequestPreview } from '../services/promptBuilder';
import { regroupPages } from '../services/procedureGrouper';
import type { ProcedureGroup } from '../types/procedure';

const router = express.Router();
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

router.post('/:taskId/groups/:groupId/run-ai', async (req, res, next) => {
  try {
    let responsePayload = {};
    await updateTask(req.params.taskId, async (draft) => {
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
      inputPageNos: preview.inputPages.map((page) => page.pageNo),
      createdAt: new Date().toISOString(),
    };
    group.aiResponse = await runProcedureRecognition(group, preview);
    group.geojson = group.aiResponse.geojson;
    group.status = group.geojson ? 'AI_COMPLETED' : 'ERROR';
    task.status = group.geojson ? 'AI_COMPLETED' : 'ERROR';
    await saveTask(task);

    responsePayload = {
      groupId: group.groupId,
      status: group.status,
      geojsonResultId: `geojson_${group.groupId}`,
      geojson: group.geojson,
    };
    res.json(responsePayload);
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

router.post('/:taskId/groups/:groupId/validate-geojson', async (req, res, next) => {
  try {
    const task = await readTask(req.params.taskId);
    const group = findGroup(task.groups, req.params.groupId);
    res.json(validateProcedureGeoJson(req.body?.geojson || group.geojson));
  } catch (error) {
    next(error);
  }
});

function findGroup(groups: ProcedureGroup[], groupId: string) {
  const group = groups.find((item) => item.groupId === groupId);
  if (!group) throw new Error('分组不存在。');
  return group;
}

export default router;
