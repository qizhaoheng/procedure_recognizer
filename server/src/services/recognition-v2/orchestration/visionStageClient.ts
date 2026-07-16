import crypto from 'node:crypto';
import { runVisionRecognition, type AiInputImage } from '../../llm/llmClient';
import type { ModelExecutionRef } from '../contracts/index';

export interface VisionStageRequest {
  model: string;
  promptId: string;
  promptVersion: string;
  schemaId: string;
  schemaVersion: string;
  inputHash: string;
  systemPrompt: string;
  userPrompt: string;
  responseSchema: unknown;
  images: AiInputImage[];
  abortSignal?: AbortSignal;
}

export interface VisionStageResult {
  parsedJson: unknown;
  execution: ModelExecutionRef;
  audit: {
    systemPrompt: string;
    userPrompt: string;
    rawText: string;
    rawResponse: unknown;
    provider: string;
    model: string;
    schemaId: string;
  };
}

export type VisionStageClient = (request: VisionStageRequest) => Promise<VisionStageResult>;

export const runVisionStage: VisionStageClient = async (request) => {
  const runId = `v2_model_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
  const result = await runVisionRecognition({
    model: request.model,
    systemPrompt: request.systemPrompt,
    userPrompt: request.userPrompt,
    responseSchema: request.responseSchema,
    schemaName: request.schemaId,
    abortSignal: request.abortSignal,
    images: request.images,
  });
  if (!result.ok) {
    throw new Error(result.error?.message || `Recognition V2 vision stage ${request.promptId} failed.`);
  }
  return {
    parsedJson: result.parsedJson,
    execution: {
      provider: result.provider,
      model: request.model,
      promptId: request.promptId,
      promptVersion: request.promptVersion,
      schemaId: request.schemaId,
      schemaVersion: request.schemaVersion,
      inputHash: request.inputHash,
      runId,
    },
    audit: {
      systemPrompt: request.systemPrompt,
      userPrompt: request.userPrompt,
      rawText: result.rawText || '',
      rawResponse: result.rawResponse,
      provider: result.provider,
      model: request.model,
      schemaId: request.schemaId,
    },
  };
};

