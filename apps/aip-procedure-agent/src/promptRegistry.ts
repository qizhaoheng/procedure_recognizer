import fs from 'node:fs/promises';
import path from 'node:path';

export interface PromptBundle { name: string; version: string; systemPrompt: string; userTemplate: string; schema: unknown }
const root = path.resolve(process.cwd(), 'apps', 'aip-procedure-agent', 'prompts');
export async function loadPrompt(name: string): Promise<PromptBundle> { const dir = path.join(root, name); const [systemPrompt, userTemplate, schemaText, versionText] = await Promise.all([fs.readFile(path.join(dir, 'system.md'), 'utf8'), fs.readFile(path.join(dir, 'user-template.md'), 'utf8'), fs.readFile(path.join(dir, 'output-schema.json'), 'utf8'), fs.readFile(path.join(dir, 'version.json'), 'utf8')]); const version = JSON.parse(versionText); return { name, version: version.version, systemPrompt, userTemplate, schema: JSON.parse(schemaText) }; }
export function renderTemplate(template: string, values: Record<string, unknown>) { return template.replace(/\{\{(\w+)\}\}/g, (_m, key) => typeof values[key] === 'string' ? String(values[key]) : JSON.stringify(values[key], null, 2)); }
