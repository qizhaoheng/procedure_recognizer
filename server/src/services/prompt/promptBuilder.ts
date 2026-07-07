import type { BuildPromptInput, BuiltPrompt } from './promptTypes';
import { readPromptExample, readPromptSchema, readPromptSection, readPromptTemplate, renderTemplate } from './promptRenderer';
import { routePromptTemplate } from './promptRouter';

// 分层系统 Prompt：按固定顺序组装，通用规则全部放在 system prompt，
// 程序类型专用模板 + few-shot + 动态输入包放在 user prompt。
const PROMPT_SECTIONS = [
  'base-role.prompt.md',
  'procedure-classification.prompt.md',
  'input-materials.prompt.md',
  'chart-text-recognition.prompt.md',
  'table-semantic-recognition.prompt.md',
  'support-filtering.prompt.md',
  'geometry-semantic-recognition.prompt.md',
  'output-schema-rules.prompt.md',
  'hallucination-guard.prompt.md',
];

export async function buildPrompt(input: BuildPromptInput): Promise<BuiltPrompt> {
  const template = routePromptTemplate(input.procedurePackage, input.templateOverrideId);
  const [sectionTexts, procedureTemplate, responseSchema, fewShotExample] = await Promise.all([
    Promise.all(PROMPT_SECTIONS.map((section) => readPromptSection(section))),
    readPromptTemplate(template.templatePath),
    readPromptSchema(template.outputSchemaName),
    template.examplePath ? readPromptExample(template.examplePath) : Promise.resolve(''),
  ]);
  const baseSystemPrompt = sectionTexts.map((text) => text.trim()).join('\n\n');

  const renderedAt = new Date().toISOString();
  const metadata = buildPackageMetadata(input);
  const dynamicInput = {
    packageMetadata: metadata,
    corePages: input.aiInputPackage.corePages,
    supportingInfoSummary: input.aiInputPackage.supportSummary,
    supportSummaries: input.aiInputPackage.includedSummaries,
    excludedSupport: input.aiInputPackage.excludedSupport,
    includedImages: input.aiInputPackage.includedImages.map(({ pageNo, aipPageNo, role, region, sendMode, imageUrl, reason }) => ({
      pageNo,
      aipPageNo,
      role,
      region: region || 'full_page',
      sendMode,
      imageUrl,
      reason,
    })),
  };

  const userPrompt = [
    renderTemplate(procedureTemplate, metadata),
    ...(fewShotExample ? ['', fewShotExample.trim()] : []),
    '',
    '## Current ProcedurePackage Metadata',
    fencedJson(metadata),
    '',
    '## Core Pages',
    fencedJson(input.aiInputPackage.corePages),
    '',
    '## Supporting Info Summary',
    fencedJson(input.aiInputPackage.supportSummary),
    '',
    '## Included Supporting Summaries',
    fencedJson(input.aiInputPackage.includedSummaries),
    '',
    '## Excluded Support',
    fencedJson(input.aiInputPackage.excludedSupport),
    '',
    '## Output Reminder',
    '- Return exactly one JSON object matching the provided ProcedureUnderstanding schema. No markdown fences, no prose.',
    '- Follow the staged reading workflow and fill ALL of: procedureClassification, chartTexts, tableLegs, geometrySemantics, supportObjects, procedures/fixes/navaids, warnings, confidence, reviewRequired.',
    '- Apply the support-filtering rules: support-only idents must not enter navaids, fixes, or legs.',
    '- Do NOT return final map coordinates or GeoJSON; return procedure semantics only.',
    '',
    '## Machine-Readable Input Package',
    fencedJson(dynamicInput),
  ].join('\n');

  return {
    promptTemplateId: template.id,
    promptTemplateName: template.name,
    promptVersion: template.version,
    outputSchemaName: template.outputSchemaName,
    outputSchemaVersion: template.outputSchemaVersion,
    systemPrompt: baseSystemPrompt.trim(),
    userPrompt,
    responseSchema,
    inputImages: input.aiInputPackage.includedImages,
    supportSummaries: input.aiInputPackage.includedSummaries,
    excludedSupport: input.aiInputPackage.excludedSupport,
    renderedAt,
  };
}

function buildPackageMetadata(input: BuildPromptInput) {
  const group = input.procedurePackage;
  return {
    taskId: input.taskId,
    packageId: input.packageId,
    packageName: input.aiInputPackage.packageName || group.packageName || group.groupName,
    packageType: group.packageType,
    procedureCategory: group.procedureCategory,
    navigationType: group.navigationType,
    runway: group.runway,
    chartTitle: group.chartTitle,
    chartNo: group.chartNo,
    relatedChartNos: group.relatedChartNos,
    relatedPageNos: group.relatedPageNos,
    procedureNames: group.procedureNames,
    source: group.source,
    confidence: group.confidence,
    reviewRequired: group.reviewRequired,
  };
}

function fencedJson(value: unknown) {
  return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}
