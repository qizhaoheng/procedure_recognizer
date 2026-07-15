import crypto from 'node:crypto';
import { getLlmRuntimeConfig, runVisionRecognition } from '../../../server/src/services/llm/llmClient';
import type { AgentTask, ModelCall } from './domain';
import { loadPrompt, renderTemplate } from './promptRegistry';
import { saveAgentTask, writeArtifact } from './storage';

export const budgets = {
  maxModelCalls: Number(process.env.AGENT_MAX_MODEL_CALLS || 120),
  maxImagesPerCall: Number(process.env.AGENT_MAX_IMAGES || 6),
  maxToolCallsPerPackage: Number(process.env.AGENT_MAX_TOOL_CALLS || 12),
  maxPlanSteps: Number(process.env.AGENT_MAX_PLAN_STEPS || 20),
  maxActionRetries: Number(process.env.AGENT_MAX_ACTION_RETRIES || 1),
  maxOcrPages: Number(process.env.AGENT_MAX_OCR_PAGES || 30),
  maxOverlayRounds: Number(process.env.AGENT_MAX_OVERLAY_ROUNDS || 2),
};

export interface ModelCallOptions { procedureId?: string; planAction?: string; toolName?: string }

export async function callModel(
  task: AgentTask,
  promptName: string,
  values: Record<string, unknown>,
  images: Array<{ pageNo?: number; aipPageNo?: string; dataUrl: string }>,
  stepName: string,
  signal: AbortSignal,
  options: ModelCallOptions = {},
): Promise<{ parsed: any; callId: string }> {
  if (task.modelCalls.length >= budgets.maxModelCalls) throw new Error('Agent model-call budget exceeded.');
  const prompt = await loadPrompt(promptName);
  const config = getLlmRuntimeConfig();
  const startedAt = new Date().toISOString();
  const callId = crypto.randomUUID();
  const rendered = renderTemplate(prompt.userTemplate, values);
  const userPrompt = config.structuredOutputMode === 'json_schema'
    ? rendered
    : `${rendered}\n\nRequired output JSON Schema (use exact field names):\n${JSON.stringify(prompt.schema)}`;
  const result = await runVisionRecognition({ model: config.model, systemPrompt: prompt.systemPrompt, userPrompt, images, responseSchema: prompt.schema, schemaName: prompt.name.replace(/-/g, '_'), abortSignal: signal });
  const completedAt = new Date().toISOString();
  const rawPath = `model-calls/${callId}.json`;
  await writeArtifact(task.taskId, rawPath, result.rawResponse ?? result.rawText ?? result.error);
  const record: ModelCall = {
    callId,
    agentRunId: task.taskId,
    procedureId: options.procedureId,
    stepName,
    toolName: options.planAction ?? options.toolName,
    startedAt,
    completedAt,
    model: result.model,
    error: result.ok ? undefined : result.error?.message,
    decisionSummary: typeof (result.parsedJson as any)?.decisionSummary === 'string' ? (result.parsedJson as any).decisionSummary : undefined,
    promptName,
    promptVersion: prompt.version,
    rawResponsePath: rawPath,
  };
  task.modelCalls.push(record);
  await saveAgentTask(task);
  if (!result.ok || !result.parsedJson) throw new Error(result.error?.message || 'Model returned no valid structured JSON.');
  return { parsed: result.parsedJson, callId };
}
