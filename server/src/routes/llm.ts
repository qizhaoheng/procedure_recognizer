import express from 'express';
import { LlmApiError, testVisionConnection } from '../services/llmService';
import { getLlmRuntimeConfig } from '../services/llm/llmClient';

const router = express.Router();

router.post('/test-vision', async (req, res) => {
  try {
    const model = String(req.body?.model || getLlmRuntimeConfig().model);
    const result = await testVisionConnection(model);
    res.json(result);
  } catch (error) {
    const llmError = normalizeLlmError(error);
    const config = getLlmRuntimeConfig(req.body?.model ? String(req.body.model) : undefined);
    res.json({
      ok: false,
      provider: config.provider,
      model: config.model,
      errorType: llmError.errorType,
      message: llmError.message,
      rawError: llmError.rawError,
    });
  }
});

function normalizeLlmError(error: unknown) {
  if (error instanceof LlmApiError) return error;
  return new LlmApiError(
    'UNKNOWN',
    error instanceof Error ? error.message : 'LLM vision test failed.',
    error instanceof Error ? error.stack || error.message : String(error),
  );
}

export default router;
