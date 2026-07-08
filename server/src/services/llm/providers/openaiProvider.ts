import type {
  LlmRuntimeConfig,
  StructuredOutputModeUsed,
  VisionRecognitionRequest,
  VisionRecognitionResponse,
} from '../llmClient';
import { LlmApiError } from '../llmClient';
import {
  endpointUrl,
  fetchWithTimeout,
  readErrorResponse,
  responseError,
  responseOk,
  schemaResponseName,
  withRetries,
} from './providerUtils';

export async function runOpenAiVisionRecognition(
  request: VisionRecognitionRequest,
  config: LlmRuntimeConfig,
): Promise<VisionRecognitionResponse> {
  const startedAt = Date.now();
  const used: StructuredOutputModeUsed = config.endpointType === 'chat_completions'
    ? config.structuredOutputMode === 'json_object' ? 'json_object' : 'json_schema'
    : 'json_schema';

  try {
    return await withRetries(
      () => config.endpointType === 'chat_completions'
        ? callOpenAiChatCompletions(request, config, startedAt, used)
        : callOpenAiResponses(request, config, startedAt),
      config.maxRetries,
    );
  } catch (error) {
    return responseError(request, config, startedAt, error, used);
  }
}

async function callOpenAiResponses(request: VisionRecognitionRequest, config: LlmRuntimeConfig, startedAt: number) {
  const response = await fetchWithTimeout(endpointUrl(config, '/responses'), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: request.model || config.model,
      input: [
        {
          role: 'system',
          content: [{ type: 'input_text', text: request.systemPrompt }],
        },
        {
          role: 'user',
          content: [
            { type: 'input_text', text: request.userPrompt },
            ...request.images.map((image) => ({
              type: 'input_image',
              image_url: image.dataUrl || image.imageUrl,
              detail: 'high',
            })),
          ],
        },
      ],
      text: {
        format: {
          type: 'json_schema',
          name: schemaResponseName(request.schemaName),
          schema: request.responseSchema,
          strict: true,
        },
      },
    }),
  }, config.timeoutMs, request.abortSignal);

  if (!response.ok) throw await readErrorResponse(response);

  const rawResponse = await response.json();
  const refusal = findResponseRefusal(rawResponse);
  if (refusal) throw new LlmApiError('MODEL_REFUSAL', refusal, JSON.stringify(rawResponse));
  const rawText = extractResponseOutputText(rawResponse);
  if (!rawText) throw new LlmApiError('EMPTY_RESPONSE', 'LLM returned no structured output text.', JSON.stringify(rawResponse));
  return responseOk(request, config, startedAt, rawResponse, rawText, 'json_schema');
}

async function callOpenAiChatCompletions(
  request: VisionRecognitionRequest,
  config: LlmRuntimeConfig,
  startedAt: number,
  used: StructuredOutputModeUsed,
) {
  const response = await fetchWithTimeout(endpointUrl(config, '/chat/completions'), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: request.model || config.model,
      temperature: 0.1,
      response_format: used === 'json_object'
        ? { type: 'json_object' }
        : {
            type: 'json_schema',
            json_schema: {
              name: schemaResponseName(request.schemaName),
              strict: true,
              schema: request.responseSchema,
            },
          },
      messages: [
        { role: 'system', content: request.systemPrompt },
        {
          role: 'user',
          content: [
            { type: 'text', text: request.userPrompt },
            ...request.images.map((image) => ({
              type: 'image_url',
              image_url: { url: image.dataUrl || image.imageUrl },
            })),
          ],
        },
      ],
    }),
  }, config.timeoutMs, request.abortSignal);

  if (!response.ok) throw await readErrorResponse(response);

  const rawResponse = await response.json();
  const choices = Array.isArray((rawResponse as Record<string, unknown>).choices)
    ? ((rawResponse as Record<string, unknown>).choices as unknown[])
    : [];
  const rawText = (((choices[0] as Record<string, unknown> | undefined)?.message as Record<string, unknown> | undefined)?.content as string | undefined) || '';
  if (!rawText) throw new LlmApiError('EMPTY_RESPONSE', 'LLM returned no message content.', JSON.stringify(rawResponse));
  return responseOk(request, config, startedAt, rawResponse, rawText, used);
}

function extractResponseOutputText(data: unknown): string | undefined {
  const record = data as Record<string, unknown>;
  if (typeof record.output_text === 'string') return record.output_text;
  const output = Array.isArray(record.output) ? record.output : [];
  const parts: string[] = [];
  for (const item of output) {
    const content = Array.isArray((item as Record<string, unknown>).content)
      ? ((item as Record<string, unknown>).content as unknown[])
      : [];
    for (const contentItem of content) {
      const contentRecord = contentItem as Record<string, unknown>;
      if (typeof contentRecord.text === 'string') parts.push(contentRecord.text);
      if (typeof contentRecord.output_text === 'string') parts.push(contentRecord.output_text);
    }
  }
  return parts.join('').trim() || undefined;
}

function findResponseRefusal(data: unknown): string | undefined {
  const record = data as Record<string, unknown>;
  const output = Array.isArray(record.output) ? record.output : [];
  for (const item of output) {
    const content = Array.isArray((item as Record<string, unknown>).content)
      ? ((item as Record<string, unknown>).content as unknown[])
      : [];
    for (const contentItem of content) {
      const contentRecord = contentItem as Record<string, unknown>;
      if (typeof contentRecord.refusal === 'string') return contentRecord.refusal;
      if (contentRecord.type === 'refusal' && typeof contentRecord.text === 'string') return contentRecord.text;
    }
  }
  return undefined;
}
