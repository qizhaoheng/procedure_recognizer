import type {
  AiInputImage,
  LlmRuntimeConfig,
  StructuredOutputMode,
  StructuredOutputModeUsed,
  VisionRecognitionRequest,
  VisionRecognitionResponse,
} from '../llmClient';
import { LlmApiError } from '../llmClient';
import {
  endpointUrl,
  fetchWithTimeout,
  isStructuredOutputUnsupported,
  readErrorResponse,
  responseError,
  responseOk,
  schemaResponseName,
  withRetries,
} from './providerUtils';

export async function runQwenVisionRecognition(
  request: VisionRecognitionRequest,
  config: LlmRuntimeConfig,
): Promise<VisionRecognitionResponse> {
  const startedAt = Date.now();
  const preferredMode = request.structuredOutputMode || config.structuredOutputMode;
  const modes = modeFallbacks(preferredMode);
  let lastError: unknown;

  for (const mode of modes) {
    const used = usedMode(mode);
    try {
      return await withRetries(
        () => callQwenChatCompletions(request, config, mode, used, startedAt),
        config.maxRetries,
      );
    } catch (error) {
      lastError = error;
      if (!shouldFallback(mode, error)) {
        return responseError(request, config, startedAt, error, used);
      }
    }
  }

  return responseError(request, config, startedAt, lastError, 'text_json_extract');
}

async function callQwenChatCompletions(
  request: VisionRecognitionRequest,
  config: LlmRuntimeConfig,
  mode: StructuredOutputMode,
  used: StructuredOutputModeUsed,
  startedAt: number,
) {
  if (config.endpointType !== 'chat_completions') {
    throw new LlmApiError('UNSUPPORTED_ENDPOINT', 'Qwen provider supports LLM_ENDPOINT_TYPE=chat_completions only.');
  }

  const response = await fetchWithTimeout(endpointUrl(config, '/chat/completions'), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: request.model || config.model,
      temperature: 0.1,
      enable_thinking: config.enableThinking,
      ...(responseFormatFor(mode, request) ? { response_format: responseFormatFor(mode, request) } : {}),
      messages: [
        { role: 'system', content: request.systemPrompt },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: userPromptForMode(request, mode),
            },
            ...request.images.map((image) => ({
              type: 'image_url',
              image_url: {
                url: imageUrlFor(config, image),
              },
            })),
          ],
        },
      ],
    }),
  }, config.timeoutMs, request.abortSignal);

  if (!response.ok) throw await readErrorResponse(response);

  const rawResponse = await response.json();
  const rawText = extractChatCompletionText(rawResponse);
  if (!rawText) throw new LlmApiError('EMPTY_RESPONSE', 'LLM returned no message content.', JSON.stringify(rawResponse));
  return responseOk(request, config, startedAt, rawResponse, rawText, used);
}

function responseFormatFor(mode: StructuredOutputMode, request: VisionRecognitionRequest) {
  if (mode === 'json_schema') {
    return {
      type: 'json_schema',
      json_schema: {
        name: schemaResponseName(request.schemaName),
        strict: true,
        schema: request.responseSchema,
      },
    };
  }
  if (mode === 'json_object') return { type: 'json_object' };
  return undefined;
}

function userPromptForMode(request: VisionRecognitionRequest, mode: StructuredOutputMode) {
  if (mode === 'json_schema') return request.userPrompt;
  const schemaHint = request.schemaName || 'procedure-understanding.schema.json';
  return [
    request.userPrompt,
    '',
    `Return exactly one JSON object matching ${schemaHint}.`,
    'Do not include markdown fences, comments, prose, or extra top-level keys.',
  ].join('\n');
}

function imageUrlFor(config: LlmRuntimeConfig, image: AiInputImage) {
  if (config.imageMode === 'base64') {
    if (!image.dataUrl) throw new LlmApiError('MISSING_IMAGE', `Image page ${image.pageNo} has no base64 data URL.`);
    return image.dataUrl;
  }
  if (!image.imageUrl) throw new LlmApiError('MISSING_IMAGE_URL', `Image page ${image.pageNo} has no public image URL.`);
  if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/i.test(image.imageUrl)) {
    throw new LlmApiError('LOCAL_IMAGE_URL', 'Localhost image URLs cannot be sent to a cloud model. Use base64 or a public OSS signed URL.');
  }
  return image.imageUrl;
}

function extractChatCompletionText(rawResponse: unknown) {
  const record = rawResponse as Record<string, unknown>;
  const choices = Array.isArray(record.choices) ? record.choices : [];
  const first = choices[0] as Record<string, unknown> | undefined;
  const message = first?.message as Record<string, unknown> | undefined;
  if (typeof message?.content === 'string') return message.content;
  if (Array.isArray(message?.content)) {
    return message.content
      .map((item) => {
        const contentItem = item as Record<string, unknown>;
        return typeof contentItem.text === 'string' ? contentItem.text : '';
      })
      .join('')
      .trim();
  }
  return undefined;
}

function modeFallbacks(mode: StructuredOutputMode): StructuredOutputMode[] {
  if (mode === 'none') return ['none'];
  if (mode === 'json_object') return ['json_object', 'none'];
  return ['json_schema', 'json_object', 'none'];
}

function usedMode(mode: StructuredOutputMode): StructuredOutputModeUsed {
  if (mode === 'json_schema') return 'json_schema';
  if (mode === 'json_object') return 'json_object';
  return 'text_json_extract';
}

function shouldFallback(mode: StructuredOutputMode, error: unknown) {
  if (mode === 'none') return false;
  return isStructuredOutputUnsupported(error);
}
