import fs from 'node:fs/promises';
import path from 'node:path';
import type { FeatureCollection, Geometry, GeoJsonProperties } from 'geojson';
import type { AiInputPage, AiResponseRecord, ProcedureGroup } from '../types/procedure';
import { validateProcedureGeoJson, withBbox } from './geojsonValidator';
import {
  getLlmRuntimeConfig,
  LlmApiError,
  runVisionRecognition,
  type StructuredOutputModeUsed,
} from './llm/llmClient';
import type { BuiltPrompt } from './prompt/promptTypes';
import type { AiRequestPreview } from './promptBuilder';

export { LlmApiError };

export interface VisionImagePayload {
  page: AiInputPage;
  dataUrl: string;
  imageUrl?: string;
}

export interface LlmVisionTestResult {
  ok: boolean;
  provider: string;
  model: string;
  baseUrl: string;
  endpointType: string;
  imageMode: string;
  structuredOutputModeUsed?: StructuredOutputModeUsed;
  latencyMs: number;
  result: unknown;
}

export async function runProcedureRecognition(group: ProcedureGroup, preview: AiRequestPreview): Promise<AiResponseRecord> {
  const now = new Date().toISOString();
  const apiKey = process.env.LLM_API_KEY;

  if (!apiKey) {
    const geojson = await loadMockGeoJson(group);
    return {
      rawText: JSON.stringify(geojson, null, 2),
      parsedJson: geojson,
      geojson,
      errors: validateProcedureGeoJson(geojson).errors,
      createdAt: now,
    };
  }

  try {
    const rawText = await callCompatibleChatApi(preview, apiKey);
    const parsedJson = extractJson(rawText);
    const geojson = parsedJson?.type === 'FeatureCollection' ? withBbox(parsedJson) : undefined;
    return {
      rawText,
      parsedJson,
      geojson,
      errors: geojson ? validateProcedureGeoJson(geojson).errors : ['大模型响应不是 GeoJSON FeatureCollection。'],
      createdAt: now,
    };
  } catch (error) {
    const fallback = await loadMockGeoJson(group);
    return {
      rawText: error instanceof Error ? error.message : 'LLM 调用失败',
      parsedJson: fallback,
      geojson: fallback,
      errors: ['LLM 调用失败，已返回 mock GeoJSON。'],
      createdAt: now,
    };
  }
}

export async function runProcedureUnderstandingRecognition(
  builtPrompt: BuiltPrompt,
  model: string,
): Promise<AiResponseRecord> {
  const now = new Date().toISOString();
  const images = await buildVisionImagePayloads(builtPrompt.inputImages);

  const result = await runVisionRecognition({
    model,
    systemPrompt: builtPrompt.systemPrompt,
    userPrompt: builtPrompt.userPrompt,
    responseSchema: builtPrompt.responseSchema,
    schemaName: builtPrompt.outputSchemaName,
    images: images.map((image) => ({
      pageNo: image.page.pageNo,
      aipPageNo: image.page.aipPageNo,
      role: image.page.role,
      dataUrl: image.dataUrl,
      imageUrl: image.imageUrl,
    })),
  });

  if (!result.ok) {
    throw new LlmApiError(
      result.error?.type || 'LLM_ERROR',
      result.error?.message || 'LLM vision recognition failed.',
      typeof result.error?.raw === 'string' ? result.error.raw : JSON.stringify(result.error?.raw ?? result.rawResponse ?? result),
    );
  }

  return {
    rawText: result.rawText || JSON.stringify(result.rawResponse),
    parsedJson: result.parsedJson,
    provider: result.provider,
    baseUrl: result.baseUrl,
    endpointType: result.endpointType,
    imageMode: result.imageMode,
    structuredOutputModeUsed: result.structuredOutputModeUsed,
    rawProviderResponse: result.rawResponse,
    latencyMs: result.latencyMs,
    createdAt: now,
  };
}

export async function testVisionConnection(model = process.env.LLM_MODEL || getLlmRuntimeConfig().model): Promise<LlmVisionTestResult> {
  const startedAt = Date.now();
  const result = await runVisionRecognition({
    model,
    systemPrompt: 'You test whether a vision-capable LLM endpoint can read an attached image and return structured JSON.',
    userPrompt: 'Inspect the attached tiny test image. Return ok=true when the API request, image input, and schema output are working. Set imageReadable=true if an image was received.',
    responseSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['ok', 'imageReadable', 'message'],
      properties: {
        ok: { type: 'boolean' },
        imageReadable: { type: 'boolean' },
        message: { type: 'string' },
      },
    },
    schemaName: 'llm_test_vision',
    images: [
      {
        page: {
          pageNo: 0,
          aipPageNo: 'LLM test image',
          role: 'CHART',
          sendMode: 'IMAGE_ONLY',
          reason: 'LLM connection test',
          confidence: 1,
          reviewRequired: false,
        },
        dataUrl: await testPngDataUrl(),
      },
    ],
  });
  if (!result.ok) {
    throw new LlmApiError(
      result.error?.type || 'LLM_ERROR',
      result.error?.message || 'LLM vision test failed.',
      typeof result.error?.raw === 'string' ? result.error.raw : JSON.stringify(result.error?.raw ?? result.rawResponse ?? result),
    );
  }
  return {
    ok: true,
    provider: result.provider,
    model,
    baseUrl: result.baseUrl,
    endpointType: result.endpointType,
    imageMode: result.imageMode,
    structuredOutputModeUsed: result.structuredOutputModeUsed,
    latencyMs: result.latencyMs ?? Date.now() - startedAt,
    result: result.parsedJson,
  };
}

async function callCompatibleChatApi(preview: AiRequestPreview, apiKey: string) {
  const baseUrl = process.env.LLM_BASE_URL || 'https://api.openai.com/v1';
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: preview.model,
      temperature: 0.1,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'Return only valid JSON. The JSON must be a GeoJSON FeatureCollection.' },
        { role: 'user', content: preview.prompt },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`LLM API ${response.status}: ${await response.text()}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content ?? JSON.stringify(data);
}

async function loadMockGeoJson(group: ProcedureGroup): Promise<FeatureCollection<Geometry | null, GeoJsonProperties>> {
  const preferred = group.navigationType === 'DME_ARC'
    ? 'WMKJ_STAR_RWY16_11DME_ARC_v4_bound_labels.geojson'
    : 'WMKJ_RNAV_RWY16_STAR_AD_2_WMKJ_7_1_bound_labels.geojson';
  const candidates = [
    path.resolve(process.cwd(), 'public', 'data', preferred),
    path.resolve(process.cwd(), 'public', 'data', 'WMKJ_STAR_RWY16_11DME_ARC_v3.geojson'),
  ];

  for (const filePath of candidates) {
    try {
      const text = await fs.readFile(filePath, 'utf-8');
      return withBbox(JSON.parse(text));
    } catch {
      // Try the next fixture.
    }
  }

  return withBbox({
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: null,
        properties: {
          object_type: 'ProcedureChart',
          name: group.groupName,
          source_page: group.chartPages[0] ?? 1,
          source_text: 'Mock result generated because no LLM_API_KEY or fixture is available.',
          coordinate_quality: 'unknown',
          review_required: true,
          confidence: 0.1,
        },
      },
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [103.67, 1.64] },
        properties: {
          object_type: 'LabelPoint',
          label_text: group.groupName || 'Mock Procedure',
          source_page: group.chartPages[0] ?? 1,
          source_text: 'Mock label point',
          coordinate_quality: 'approximate',
          review_required: true,
          confidence: 0.1,
        },
      },
    ],
  });
}

function extractJson(rawText: string): FeatureCollection<Geometry | null, GeoJsonProperties> | undefined {
  try {
    return JSON.parse(rawText);
  } catch {
    const match = rawText.match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : undefined;
  }
}

function extractAnyJson(rawText: string): unknown {
  try {
    return JSON.parse(rawText);
  } catch {
    const match = rawText.match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : undefined;
  }
}

export async function buildVisionImagePayloads(inputImages: AiInputPage[]): Promise<VisionImagePayload[]> {
  const images: VisionImagePayload[] = [];
  for (const image of inputImages) {
    if (!image.imageUrl) {
      throw new LlmApiError('MISSING_IMAGE', `Input image page ${image.pageNo} has no imageUrl.`);
    }
    images.push({
      page: image,
      dataUrl: await localImageAsDataUrl(image.imageUrl),
      imageUrl: publicImageUrl(image.imageUrl),
    });
  }
  return images;
}

function publicImageUrl(imageUrl: string) {
  if (!/^https?:\/\//i.test(imageUrl)) return undefined;
  if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/i.test(imageUrl)) return undefined;
  return imageUrl;
}

export async function localImageAsDataUrl(imageUrl: string) {
  if (/^https?:\/\//i.test(imageUrl) || imageUrl.startsWith('data:')) return imageUrl;
  const relative = imageUrl.replace(/^\/uploads\//, '');
  const filePath = path.resolve(process.cwd(), 'server', 'data', relative);
  if (path.extname(filePath).toLowerCase() === '.svg') {
    return await renderPdfPageForTaskAsset(filePath) ?? svgFileAsPngDataUrl(filePath);
  }
  const bytes = await fs.readFile(filePath);
  return `data:${mimeFor(filePath)};base64,${bytes.toString('base64')}`;
}

async function renderPdfPageForTaskAsset(filePath: string) {
  const taskAsset = parseTaskPageAssetPath(filePath);
  if (!taskAsset) return undefined;

  try {
    const taskPath = path.resolve(process.cwd(), 'server', 'data', 'procedure-tasks', taskAsset.taskId, 'task.json');
    const task = JSON.parse(await fs.readFile(taskPath, 'utf-8')) as { filePath?: string };
    if (!task.filePath) return undefined;
    return await renderPdfPageAsPngDataUrl(task.filePath, taskAsset.pageNo);
  } catch {
    return undefined;
  }
}

function parseTaskPageAssetPath(filePath: string) {
  const normalized = filePath.replace(/\\/g, '/');
  const match = normalized.match(/\/procedure-tasks\/([^/]+)\/pages\/page-(\d+)\.svg$/);
  if (!match) return undefined;
  return { taskId: match[1], pageNo: Number(match[2]) };
}

async function renderPdfPageAsPngDataUrl(pdfPath: string, pageNo: number) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const { createCanvas } = await import('@napi-rs/canvas');
  const data = new Uint8Array(await fs.readFile(pdfPath));
  const loadingTask = pdfjs.getDocument({
    data,
    disableFontFace: true,
    useSystemFonts: true,
  });
  try {
    const pdf = await loadingTask.promise;
    const page = await pdf.getPage(pageNo);
    const scale = Number(process.env.LLM_IMAGE_RENDER_SCALE || 2.5);
    const viewport = page.getViewport({ scale });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const context = canvas.getContext('2d');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: context, viewport }).promise;
    return `data:image/png;base64,${canvas.toBuffer('image/png').toString('base64')}`;
  } finally {
    await loadingTask.destroy();
  }
}

async function svgFileAsPngDataUrl(filePath: string) {
  const { createCanvas, loadImage } = await import('@napi-rs/canvas');
  const svg = (await fs.readFile(filePath, 'utf-8')).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
  const image = await loadImage(Buffer.from(svg));
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext('2d');
  context.drawImage(image, 0, 0);
  return `data:image/png;base64,${canvas.toBuffer('image/png').toString('base64')}`;
}

function mimeFor(filePath: string) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  return 'image/png';
}

async function testPngDataUrl() {
  const { createCanvas } = await import('@napi-rs/canvas');
  const canvas = createCanvas(160, 80);
  const context = canvas.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#0f172a';
  context.font = '24px Arial';
  context.fillText('LLM VISION', 16, 44);
  context.fillStyle = '#2563eb';
  context.fillRect(16, 54, 128, 8);
  return `data:image/png;base64,${canvas.toBuffer('image/png').toString('base64')}`;
}
