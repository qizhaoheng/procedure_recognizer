import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const promptDir = path.dirname(fileURLToPath(import.meta.url));

export type RecognitionV2PromptFile =
  | 'page-layout.prompt.md'
  | 'procedure-identity.prompt.md'
  | 'procedure-table-physical.prompt.md'
  | 'waypoint-navaid.prompt.md';

export async function readRecognitionV2Prompt(fileName: RecognitionV2PromptFile) {
  return fs.readFile(path.join(promptDir, fileName), 'utf8');
}
