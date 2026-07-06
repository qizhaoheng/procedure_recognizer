import type { BuildPromptInput, BuiltPrompt } from './promptTypes';
import { readBaseSystemPrompt, readPromptSchema, readPromptTemplate, renderTemplate } from './promptRenderer';
import { routePromptTemplate } from './promptRouter';

export async function buildPrompt(input: BuildPromptInput): Promise<BuiltPrompt> {
  const template = routePromptTemplate(input.procedurePackage, input.templateOverrideId);
  const [baseSystemPrompt, procedureTemplate, responseSchema] = await Promise.all([
    readBaseSystemPrompt(),
    readPromptTemplate(template.templatePath),
    readPromptSchema(template.outputSchemaName),
  ]);

  const renderedAt = new Date().toISOString();
  const metadata = buildPackageMetadata(input);
  const dynamicInput = {
    packageMetadata: metadata,
    corePages: input.aiInputPackage.corePages,
    supportingInfoSummary: input.aiInputPackage.supportSummary,
    supportSummaries: input.aiInputPackage.includedSummaries,
    excludedSupport: input.aiInputPackage.excludedSupport,
    includedImages: input.aiInputPackage.includedImages.map(({ pageNo, aipPageNo, role, sendMode, imageUrl, reason }) => ({
      pageNo,
      aipPageNo,
      role,
      sendMode,
      imageUrl,
      reason,
    })),
  };

  const userPrompt = [
    renderTemplate(procedureTemplate, metadata),
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
    '## Output Rules',
    '- Return exactly one JSON object matching the provided ProcedureUnderstanding schema.',
    '- Do not include markdown fences, comments, prose, or extra top-level keys.',
    '- Keep procedure-package boundaries strict: do not mix procedures from other packages.',
    '',
    '## Source Evidence Rules',
    '- Every key operational field must cite sourceEvidenceIds.',
    '- Each sourceEvidence item must include pageNo, evidenceType, fieldName, and rawText or visualDescription.',
    '- Prefer tabular description pages for leg sequence and path terminators; use chart imagery to cross-check geometry and labels.',
    '',
    '## Uncertainty Rules',
    '- Do not guess uncertain values.',
    '- Set reviewRequired=true on uncertain procedures, legs, fixes, and the overall output.',
    '- Preserve conflicts in warnings with the page numbers and fields involved.',
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
