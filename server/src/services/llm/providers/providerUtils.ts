import type { StructuredOutputModeUsed, VisionRecognitionRequest } from '../llmClient';
import { LlmApiError, type LlmRuntimeConfig, type VisionRecognitionResponse } from '../llmClient';

export function endpointUrl(config: LlmRuntimeConfig, path: string) {
  return `${config.baseUrl.replace(/\/$/, '')}${path}`;
}

export async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error(`LLM_TIMEOUT_MS elapsed after ${timeoutMs}ms.`)), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    const message = summarizeError(error);
    const raw = describeError(error);
    const code = errorCode(error);
    if ((error instanceof Error && error.name === 'AbortError') || controller.signal.aborted || isUndiciTimeout(code)) {
      throw new LlmApiError(
        'TIMEOUT',
        `LLM request timed out after ${timeoutMs}ms. ${message}`,
        raw,
      );
    }
    throw new LlmApiError('NETWORK_ERROR', `LLM network request failed. ${message}`, raw);
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
    describeError(error),
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

function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as Error & { cause?: unknown }).cause;
  const stack = error.stack && error.stack !== error.message ? `\n${error.stack}` : '';
  return `${summarizeSingleError(error)}${cause ? `; cause: ${describeError(cause)}` : ''}${stack}`;
}

function summarizeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as Error & { cause?: unknown }).cause;
  const causeDetails = cause ? `; cause=${summarizeError(cause)}` : '';
  return `${summarizeSingleError(error)}${causeDetails}`;
}

function summarizeSingleError(error: Error): string {
  const parts = [error.name, error.message].filter(Boolean).join(': ') || 'Error';
  const code = errorCode(error);
  const codeDetails = code ? `; code=${code}` : '';
  return `${parts}${codeDetails}`;
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const record = error as { code?: unknown; cause?: unknown };
  if (typeof record.code === 'string') return record.code;
  return errorCode(record.cause);
}

function isUndiciTimeout(code: string | undefined) {
  return code === 'UND_ERR_HEADERS_TIMEOUT' || code === 'UND_ERR_BODY_TIMEOUT' || code === 'UND_ERR_CONNECT_TIMEOUT';
}
