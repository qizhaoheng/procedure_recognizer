import type { StructuredOutputModeUsed, VisionRecognitionRequest } from '../llmClient';
import { LlmApiError, type LlmRuntimeConfig, type VisionRecognitionResponse } from '../llmClient';

export function endpointUrl(config: LlmRuntimeConfig, path: string) {
  return `${config.baseUrl.replace(/\/$/, '')}${path}`;
}

export async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new LlmApiError('TIMEOUT', `LLM request timed out after ${timeoutMs}ms.`);
    }
    throw new LlmApiError('NETWORK_ERROR', error instanceof Error ? error.message : 'LLM network request failed.');
  } finally {
    clearTimeout(timeout);
  }
}

export async function withRetries<T>(fn: () => Promise<T>, maxRetries: number): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isRetryable(error) || attempt === maxRetries) break;
      await delay(500 * (attempt + 1));
    }
  }
  throw lastError;
}

export function extractAnyJson(rawText: string): unknown {
  try {
    return JSON.parse(rawText);
  } catch {
    const match = rawText.match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : undefined;
  }
}

export function schemaResponseName(schemaName: string | undefined) {
  return (schemaName || 'procedure_understanding').replace(/\W+/g, '_').replace(/^_+|_+$/g, '') || 'procedure_understanding';
}

export function responseOk(
  request: VisionRecognitionRequest,
  config: LlmRuntimeConfig,
  startedAt: number,
  rawResponse: unknown,
  rawText: string,
  structuredOutputModeUsed: StructuredOutputModeUsed,
): VisionRecognitionResponse {
  return {
    ok: true,
    provider: config.provider,
    model: request.model || config.model,
    baseUrl: config.baseUrl,
    endpointType: config.endpointType,
    imageMode: config.imageMode,
    structuredOutputModeUsed,
    rawResponse,
    rawText,
    parsedJson: extractAnyJson(rawText),
    latencyMs: Date.now() - startedAt,
  };
}

export function responseError(
  request: VisionRecognitionRequest,
  config: LlmRuntimeConfig,
  startedAt: number,
  error: unknown,
  structuredOutputModeUsed?: StructuredOutputModeUsed,
): VisionRecognitionResponse {
  const normalized = normalizeError(error);
  return {
    ok: false,
    provider: config.provider,
    model: request.model || config.model,
    baseUrl: config.baseUrl,
    endpointType: config.endpointType,
    imageMode: config.imageMode,
    structuredOutputModeUsed,
    latencyMs: Date.now() - startedAt,
    error: {
      type: normalized.errorType,
      message: normalized.message,
      raw: normalized.rawError,
    },
  };
}

export async function readErrorResponse(response: Response) {
  const raw = await response.text();
  const type = response.status === 401 || response.status === 403 ? 'AUTHENTICATION' : 'API_ERROR';
  return new LlmApiError(type, `LLM API ${response.status}: ${shorten(raw)}`, raw, response.status);
}

export function normalizeError(error: unknown) {
  if (error instanceof LlmApiError) return error;
  return new LlmApiError(
    'UNKNOWN',
    error instanceof Error ? error.message : 'LLM request failed.',
    error instanceof Error ? error.stack || error.message : String(error),
  );
}

export function isStructuredOutputUnsupported(error: unknown) {
  const normalized = normalizeError(error);
  if (normalized.status && normalized.status !== 400 && normalized.status !== 422) return false;
  return /response_format|json_schema|json_object|schema|unsupported|not support|不支持/i.test(normalized.rawError);
}

export function shorten(value: string, maxLength = 800) {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function isRetryable(error: unknown) {
  if (!(error instanceof LlmApiError)) return false;
  return error.errorType === 'NETWORK_ERROR' || error.errorType === 'TIMEOUT' || (error.status !== undefined && error.status >= 500);
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
