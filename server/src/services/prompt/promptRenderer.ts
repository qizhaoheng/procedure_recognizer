import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const promptDir = path.dirname(fileURLToPath(import.meta.url));

export async function readPromptTemplate(templatePath: string) {
  return fs.readFile(path.join(promptDir, 'templates', templatePath), 'utf-8');
}

export async function readBaseSystemPrompt() {
  return readPromptTemplate('base.system.prompt.md');
}

export async function readPromptExample(examplePath: string) {
  return fs.readFile(path.join(promptDir, 'examples', examplePath), 'utf-8');
}

export async function readPromptSchema(schemaName: string) {
  const text = await fs.readFile(path.join(promptDir, 'schemas', schemaName), 'utf-8');
  return JSON.parse(text);
}

export function renderTemplate(template: string, values: Record<string, unknown>) {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, key: string) => {
    const value = key.split('.').reduce<unknown>((current, part) => {
      if (!current || typeof current !== 'object') return undefined;
      return (current as Record<string, unknown>)[part];
    }, values);
    return value === undefined || value === null ? '' : String(value);
  });
}
