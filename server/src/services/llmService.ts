import fs from 'node:fs/promises';
import path from 'node:path';
import type { FeatureCollection, Geometry, GeoJsonProperties } from 'geojson';
import type { AiResponseRecord, ProcedureGroup } from '../types/procedure';
import { validateProcedureGeoJson, withBbox } from './geojsonValidator';
import type { BuiltPrompt } from './prompt/promptTypes';
import type { AiRequestPreview } from './promptBuilder';

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
  const apiKey = process.env.LLM_API_KEY;

  if (!apiKey) {
    throw new Error('LLM_API_KEY is not configured. Vision recognition was not sent to GPT-5.5.');
  }

  try {
    const rawText = await callStructuredVisionApi(builtPrompt, model, apiKey);
    return {
      rawText,
      parsedJson: extractAnyJson(rawText),
      createdAt: now,
    };
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : 'LLM call failed');
  }
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

async function callStructuredVisionApi(builtPrompt: BuiltPrompt, model: string, apiKey: string) {
  const baseUrl = process.env.LLM_BASE_URL || 'https://api.openai.com/v1';
  const imageContent = await Promise.all(
    builtPrompt.inputImages
      .filter((image) => image.imageUrl)
      .map(async (image) => ({
        type: 'image_url',
        image_url: {
          url: await localImageAsDataUrl(image.imageUrl!),
        },
      })),
  );

  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      temperature: 0.1,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: schemaResponseName(builtPrompt.outputSchemaName),
          strict: true,
          schema: builtPrompt.responseSchema,
        },
      },
      messages: [
        { role: 'system', content: builtPrompt.systemPrompt },
        {
          role: 'user',
          content: [
            { type: 'text', text: builtPrompt.userPrompt },
            ...imageContent,
          ],
        },
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

async function localImageAsDataUrl(imageUrl: string) {
  if (/^https?:\/\//i.test(imageUrl) || imageUrl.startsWith('data:')) return imageUrl;
  const relative = imageUrl.replace(/^\/uploads\//, '');
  const filePath = path.resolve(process.cwd(), 'server', 'data', relative);
  const bytes = await fs.readFile(filePath);
  return `data:${mimeFor(filePath)};base64,${bytes.toString('base64')}`;
}

function mimeFor(filePath: string) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  return 'image/png';
}

function schemaResponseName(schemaName: string) {
  return schemaName.replace(/\W+/g, '_').replace(/^_+|_+$/g, '') || 'procedure_understanding';
}
