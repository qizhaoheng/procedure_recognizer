import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 策略:prompt templates/ 与 sections/ 是全球通用的识别知识,禁止出现任何具体机场的
// 标识符或"标准答案"。机场特定内容只允许存在于两处:
//   1. examples/ 下的 few-shot 文件(必须声明 do NOT copy)
//   2. evaluation/golden-cases/ 下的回归基准
// 每验收一个新机场,把它的独有标识符(ICAO 码、导航台、航路点、地名)追加到下面的
// 列表里,模板一旦混入这些词,本测试立即失败。

const AIRPORT_SPECIFIC_TOKENS = [
  // WMKJ Senai / Johor Bahru
  'WMKJ',
  'VJB',
  'IJB',
  'SENAI',
  'Senai',
  'JOHOR',
  'Johor',
  'PIMOK',
  'SABKA',
  'AROSO',
  'ADLOV',
  'OMKOM',
  'EMTUV',
  'INVOV',
  'OSRUP',
  'UDOSU',
  'AKSOT',
  'KJ703',
  'KJ706',
  'KJ707',
];

// 模板里也禁止出现"某张图的对比标准答案"这类段落标记。
const FORBIDDEN_PHRASES = [/424 comparison target for/i];

const promptDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'prompt');

describe('prompt template generality', () => {
  it('templates and sections contain no airport-specific identifiers', async () => {
    const files = await listMarkdownFiles(path.join(promptDir, 'templates'));
    assert.ok(files.length > 0, 'no template files found');
    const violations: string[] = [];
    for (const file of files) {
      const text = await fs.readFile(file, 'utf-8');
      for (const token of AIRPORT_SPECIFIC_TOKENS) {
        const pattern = new RegExp(`\\b${token}\\b`);
        if (pattern.test(text)) {
          violations.push(`${path.relative(promptDir, file)}: contains airport-specific token "${token}"`);
        }
      }
      for (const phrase of FORBIDDEN_PHRASES) {
        if (phrase.test(text)) {
          violations.push(`${path.relative(promptDir, file)}: contains chart-specific answer section (${phrase})`);
        }
      }
    }
    assert.deepEqual(
      violations,
      [],
      `Airport-specific content belongs in prompt/examples/ (few-shot) or evaluation/golden-cases, never in templates:\n${violations.join('\n')}`,
    );
  });

  it('every few-shot example declares its values must not be copied', async () => {
    const exampleDir = path.join(promptDir, 'examples');
    const files = await listMarkdownFiles(exampleDir);
    assert.ok(files.length > 0, 'no example files found');
    for (const file of files) {
      const text = await fs.readFile(file, 'utf-8');
      assert.match(
        text,
        /do NOT copy/,
        `${path.basename(file)} must warn the model not to copy example values into other charts' output`,
      );
    }
  });

  it('every registered examplePath exists', async () => {
    const { PROMPT_TEMPLATES } = await import('../prompt/promptRegistry');
    for (const template of PROMPT_TEMPLATES) {
      if (!template.examplePath) continue;
      const filePath = path.join(promptDir, 'examples', template.examplePath);
      await assert.doesNotReject(fs.access(filePath), `examplePath missing for ${template.id}: ${template.examplePath}`);
    }
  });
});

async function listMarkdownFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listMarkdownFiles(fullPath)));
    } else if (entry.name.endsWith('.md')) {
      files.push(fullPath);
    }
  }
  return files;
}
