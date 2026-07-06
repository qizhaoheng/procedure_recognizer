import type { LlmRuntimeConfig, VisionRecognitionRequest, VisionRecognitionResponse } from '../llmClient';
import { LlmApiError } from '../llmClient';
import { responseError } from './providerUtils';

export async function runDoubaoVisionRecognition(
  request: VisionRecognitionRequest,
  config: LlmRuntimeConfig,
): Promise<VisionRecognitionResponse> {
  const startedAt = Date.now();
  return responseError(
    request,
    config,
    startedAt,
    new LlmApiError('UNIMPLEMENTED_PROVIDER', 'Doubao provider is reserved but not implemented for this Qwen migration.'),
  );
}
