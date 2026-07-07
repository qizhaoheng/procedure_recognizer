import { runDoubaoVisionRecognition } from './providers/doubaoProvider';
import { runOpenAiVisionRecognition } from './providers/openaiProvider';
import { runQwenVisionRecognition } from './providers/qwenProvider';

export type LlmProviderName = 'openai' | 'qwen' | 'doubao';
export type LlmEndpointType = 'responses' | 'chat_completions';
export type LlmImageMode = 'base64' | 'url';
export type StructuredOutputMode = 'json_schema' | 'json_object' | 'none';
export type StructuredOutputModeUsed = 'json_schema' | 'json_object' | 'text_json_extract';

export interface AiInputImage {
  pageNo: number;
  aipPageNo?: string;
  role?: string;
  dataUrl?: string;
  imageUrl?: string;
}

export interface VisionRecognitionRequest {
  model: string;
  systemPrompt: string;
  userPrompt: string;
  images: AiInputImage[];
  responseSchema?: unknown;
  schemaName?: string;
  structuredOutputMode?: StructuredOutputMode;
}

export interface VisionRecognitionResponse {
  ok: boolean;
  provider: string;
  model: string;
  baseUrl: string;
  endpointType: LlmEndpointType;
  imageMode: LlmImageMode;
  structuredOutputModeUsed?: StructuredOutputModeUsed;
  rawResponse?: unknown;
  rawText?: string;
  parsedJson?: unknown;
  latencyMs?: number;
  error?: {
    type: string;
    message: string;
    raw?: unknown;
  };
}

export interface LlmRuntimeConfig {
  provider: LlmProviderName;
  baseUrl: string;
  apiKey: string;
  model: string;
  endpointType: LlmEndpointType;
  imageMode: LlmImageMode;
  structuredOutputMode: StructuredOutputMode;
  enableThinking: boolean;
  timeoutMs: number;
  maxRetries: number;
}

export class LlmApiError extends Error {
  errorType: string;
  rawError: string;
  status?: number;

  constructor(errorType: string, message: string, rawError = message, status?: number) {
    super(message);
    this.name = 'LlmApiError';
    this.errorType = errorType;
    this.rawError = rawError;
    this.status = status;
  }
}

export async function runVisionRecognition(request: VisionRecognitionRequest): Promise<VisionRecognitionResponse> {
  const config = getLlmRuntimeConfig(request.model);
  if (!config.apiKey) {
    throw new LlmApiError('CONFIGURATION', `LLM_API_KEY is not configured. Vision recognition was not sent to ${config.model}.`);
  }
  if (!config.baseUrl) {
    throw new LlmApiError('CONFIGURATION', `LLM_BASE_URL is not configured for provider ${config.provider}.`);
  }

  if (config.provider === 'qwen') return runQwenVisionRecognition(request, config);
  if (config.provider === 'doubao') return runDoubaoVisionRecognition(request, config);
  return runOpenAiVisionRecognition(request, config);
}

export function getLlmRuntimeConfig(modelOverride?: string): LlmRuntimeConfig {
  const provider = normalizeProvider(process.env.LLM_PROVIDER);
  const endpointType = normalizeEndpointType(process.env.LLM_ENDPOINT_TYPE, provider);
  return {
    provider,
    baseUrl: defaultBaseUrl(provider).replace(/\/$/, ''),
    apiKey: process.env.LLM_API_KEY || '',
    model: modelOverride || process.env.LLM_MODEL || defaultModel(provider),
    endpointType,
    imageMode: normalizeImageMode(process.env.LLM_IMAGE_MODE),
    structuredOutputMode: normalizeStructuredOutputMode(process.env.LLM_STRUCTURED_OUTPUT_MODE),
    enableThinking: process.env.LLM_ENABLE_THINKING === 'true',
    timeoutMs: positiveIntegerEnv(process.env.LLM_TIMEOUT_MS, 180000),
    maxRetries: nonNegativeIntegerEnv(process.env.LLM_MAX_RETRIES, 1),
  };
}

function normalizeProvider(value: string | undefined): LlmProviderName {
  if (value === 'qwen' || value === 'doubao' || value === 'openai') return value;
  return 'qwen';
}

function normalizeEndpointType(value: string | undefined, provider: LlmProviderName): LlmEndpointType {
  if (value === 'responses' || value === 'chat_completions') return value;
  return provider === 'openai' ? 'responses' : 'chat_completions';
}

function normalizeImageMode(value: string | undefined): LlmImageMode {
  return value === 'url' ? 'url' : 'base64';
}

function normalizeStructuredOutputMode(value: string | undefined): StructuredOutputMode {
  if (value === 'json_object' || value === 'none') return value;
  return 'json_schema';
}

function defaultBaseUrl(provider: LlmProviderName) {
  return process.env.LLM_BASE_URL || (provider === 'openai' ? 'https://api.openai.com/v1' : '');
}

function defaultModel(provider: LlmProviderName) {
  if (provider === 'qwen') return 'qwen3-vl-plus';
  if (provider === 'doubao') return 'doubao-seed-1-6-vision';
  return 'gpt-5.5';
}

function positiveIntegerEnv(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function nonNegativeIntegerEnv(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}
