import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getTaskDir } from '../../storage/taskStore';
import type { AiInputPackage } from '../../types/procedure';
import type { BuiltPrompt, PromptRunRecord } from './promptTypes';

export async function savePromptRunRecord(
  taskId: string,
  packageId: string,
  model: string,
  builtPrompt: BuiltPrompt,
  aiInputPackage: AiInputPackage,
) {
  const record: PromptRunRecord = {
    runId: `prompt_run_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
    taskId,
    packageId,
    model,
    promptTemplateId: builtPrompt.promptTemplateId,
    promptVersion: builtPrompt.promptVersion,
    outputSchemaName: builtPrompt.outputSchemaName,
    outputSchemaVersion: builtPrompt.outputSchemaVersion,
    inputPackageHash: hashInput(aiInputPackage),
    renderedPrompt: {
      systemPrompt: builtPrompt.systemPrompt,
      userPrompt: builtPrompt.userPrompt,
    },
    createdAt: new Date().toISOString(),
  };

  const records = await listPromptRunRecords(taskId);
  records.push(record);
  await fs.writeFile(promptRunsPath(taskId), JSON.stringify(records, null, 2), 'utf-8');
  return record;
}

export async function listPromptRunRecords(taskId: string): Promise<PromptRunRecord[]> {
  try {
    return JSON.parse(await fs.readFile(promptRunsPath(taskId), 'utf-8')) as PromptRunRecord[];
  } catch {
    return [];
  }
}

function hashInput(aiInputPackage: AiInputPackage) {
  return crypto.createHash('sha256').update(JSON.stringify(aiInputPackage)).digest('hex');
}

function promptRunsPath(taskId: string) {
  return path.join(getTaskDir(taskId), 'prompt-runs.json');
}
