import crypto from 'node:crypto';
import Ajv, { type ValidateFunction } from 'ajv';
import { getLlmRuntimeConfig, runVisionRecognition } from '../../../server/src/services/llm/llmClient';
import type { AgentTask, ModelCall } from './domain';
import { loadPrompt, renderTemplate } from './promptRegistry';
import { saveAgentTask, writeArtifact } from './storage';

/**
 * 响应必须符合所声明的 schema，而不只是"是合法 JSON"。
 *
 * structuredOutputMode=json_object 时 schema 是作为文本拼进提示词的，模型可能把它
 * 原样吐回来——那段回声本身是合法 JSON，旧检查（只看 parsedJson 存在）一路放行。
 * 实测 WMKJ 一次分析的 44 次转写里有 13 次是这种回声：顶层没有 fullText、
 * 只有 type/properties/required，读出来是 undefined -> 空字符串，
 * 却被记为转写成功。其中三页原本就没有原生文本，分组读不到内容便按页序推测命名，
 * 把 p65 的 VOR Z 挪到了 p59 上——而 p59 的标题栏明写着 ILS Y OR LOC Y RWY 16。
 *
 * strict:false —— 仓库里的 schema 用了一些 ajv 严格模式不接受的写法，
 * 打开会在编译期直接抛错，而那与响应对不对无关。
 */
const ajv = new Ajv({ allErrors: false, strict: false });
const validators = new Map<string, ValidateFunction>();
function validatorFor(promptName: string, schema: unknown): ValidateFunction {
  const existing = validators.get(promptName);
  if (existing) return existing;
  const compiled = ajv.compile(schema as object);
  validators.set(promptName, compiled);
  return compiled;
}

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
  const validate = validatorFor(promptName, prompt.schema);
  if (!validate(result.parsedJson)) {
    // 抛错而不是凑合着用：字段对不上时下游读到的是 undefined，会被当成"源里没有这项",
    // 静默变成缺数据。抛出去还能触发上层的一次重试。
    const echoedSchema = typeof result.parsedJson === 'object' && result.parsedJson !== null
      && 'properties' in (result.parsedJson as object) && 'type' in (result.parsedJson as object);
    throw new Error(`${promptName} 的响应不符合其输出 schema${echoedSchema ? '（模型把 schema 原样返回了）' : ''}：${ajv.errorsText(validate.errors).slice(0, 200)}`);
  }
  return { parsed: result.parsedJson, callId };
}
