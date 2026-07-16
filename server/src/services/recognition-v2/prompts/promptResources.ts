import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const promptDir = path.dirname(fileURLToPath(import.meta.url));

export async function readRecognitionV2Prompt(fileName: 'page-layout.prompt.md' | 'procedure-identity.prompt.md') {
  return fs.readFile(path.join(promptDir, fileName), 'utf8');
}

