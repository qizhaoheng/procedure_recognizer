import fs from 'node:fs/promises';
import path from 'node:path';
import type { FeatureCollection, Geometry, GeoJsonProperties } from 'geojson';
import type { AiResponseRecord, ProcedureGroup } from '../types/procedure';
import { validateProcedureGeoJson, withBbox } from './geojsonValidator';
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
