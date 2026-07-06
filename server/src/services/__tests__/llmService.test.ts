import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runProcedureUnderstandingRecognition } from '../llmService';
import type { BuiltPrompt } from '../prompt/promptTypes';

describe('llm service', () => {
  it('does not fake ProcedureUnderstanding completion when LLM_API_KEY is missing', async () => {
    const previous = process.env.LLM_API_KEY;
    delete process.env.LLM_API_KEY;
    try {
      await assert.rejects(
        () => runProcedureUnderstandingRecognition(minimalBuiltPrompt(), 'gpt-5.5'),
        /LLM_API_KEY is not configured/,
      );
    } finally {
      if (previous === undefined) delete process.env.LLM_API_KEY;
      else process.env.LLM_API_KEY = previous;
    }
  });
});

function minimalBuiltPrompt(): BuiltPrompt {
  return {
    promptTemplateId: 'rnav_star_v1',
    promptTemplateName: 'RNAV STAR Procedure Understanding',
    promptVersion: '1.0.0',
    outputSchemaName: 'procedure-understanding.schema.json',
    outputSchemaVersion: '1.0.0',
    systemPrompt: 'Return JSON.',
    userPrompt: 'Recognize procedure.',
    responseSchema: { type: 'object' },
    inputImages: [],
    supportSummaries: [],
    excludedSupport: [],
    renderedAt: new Date().toISOString(),
  };
}
