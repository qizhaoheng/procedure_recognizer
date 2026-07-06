import type { AiInputPackage, CandidateExtractionResult, PdfPageAsset, ProcedureGroup } from '../types/procedure';
import { buildAiInputPackage, selectPromptTemplate } from './aiInputPackageBuilder';

export interface AiRequestPreview {
  model: string;
  prompt: string;
  schema: Record<string, unknown>;
  inputPages: Array<Pick<PdfPageAsset, 'pageNo' | 'aipPageNo' | 'chartRole' | 'imageUrl' | 'thumbnailUrl'>>;
  supportPages: Array<Pick<PdfPageAsset, 'pageNo' | 'aipPageNo' | 'chartRole' | 'imageUrl' | 'thumbnailUrl'>>;
  candidateSummary: Record<string, unknown>;
  aiInputPackage: AiInputPackage;
}

export function buildAiRequestPreview(
  group: ProcedureGroup,
  pages: PdfPageAsset[],
  model = process.env.LLM_MODEL || 'mock-procedure-recognizer',
): AiRequestPreview {
  const candidates: CandidateExtractionResult = {
    groupId: group.groupId,
    textCandidates: group.textCandidates ?? [],
    geometryCandidates: group.geometryCandidates ?? [],
    waypointCandidates: group.waypointCandidates ?? [],
    tableCandidates: group.tableCandidates ?? [],
  };
  const aiInputPackage = buildAiInputPackage(group, pages, model);
  const inputPages = pages
    .filter((page) => aiInputPackage.corePages.some((inputPage) => inputPage.pageNo === page.pageNo))
    .map(({ pageNo, aipPageNo, chartRole, imageUrl, thumbnailUrl }) => ({ pageNo, aipPageNo, chartRole, imageUrl, thumbnailUrl }));
  const supportImagePageNos = new Set(
    aiInputPackage.includedImages
      .filter((page) => !aiInputPackage.corePages.some((corePage) => corePage.pageNo === page.pageNo))
      .map((page) => page.pageNo),
  );
  const supportPages = pages
    .filter((page) => supportImagePageNos.has(page.pageNo))
    .map(({ pageNo, aipPageNo, chartRole, imageUrl, thumbnailUrl }) => ({ pageNo, aipPageNo, chartRole, imageUrl, thumbnailUrl }));
  const prompt = buildPrompt(group, aiInputPackage, candidates);
  aiInputPackage.promptPreview = prompt;

  return {
    model,
    prompt,
    schema: geoJsonSchema(),
    inputPages,
    supportPages,
    candidateSummary: {
      textCandidates: candidates.textCandidates.length,
      waypointCandidates: candidates.waypointCandidates.length,
      geometryCandidates: candidates.geometryCandidates.length,
      tableCandidates: candidates.tableCandidates.length,
    },
    aiInputPackage,
  };
}

export function buildPrompt(
  group: ProcedureGroup,
  aiInputPackage: AiInputPackage,
  candidates: CandidateExtractionResult,
) {
  const templateName = selectPromptTemplate(group);
  const corePageNos = new Set(aiInputPackage.corePages.map((page) => page.pageNo));
  const promptInput = {
    packageMetadata: {
      packageId: group.packageId || group.groupId,
      packageName: group.packageName || group.groupName,
      packageType: group.packageType,
      procedureCategory: group.procedureCategory,
      navigationType: group.navigationType,
      runway: group.runway,
      procedureNames: group.procedureNames,
      chartNo: group.chartNo,
      relatedChartNos: group.relatedChartNos,
      source: group.source,
    },
    corePages: aiInputPackage.corePages,
    candidateTextsFromCorePages: candidates.textCandidates.filter((candidate) => corePageNos.has(candidate.pageNo)).slice(0, 160),
    candidateGeometryFromChartPages: candidates.geometryCandidates.filter((candidate) => corePageNos.has(candidate.pageNo)).slice(0, 80),
    supportingInfoPackage: aiInputPackage.supportingInfo,
    supportingInfoSummary: aiInputPackage.supportSummary,
    includedImages: aiInputPackage.includedImages,
    includedSummaries: aiInputPackage.includedSummaries.map(({ supportType, pageNos, sendMode }) => ({ supportType, pageNos, sendMode })),
    excludedSupport: aiInputPackage.excludedSupport.map(({ supportType, pageNos, reason }) => ({ supportType, pageNos, reason })),
    waypointCandidates: candidates.waypointCandidates.slice(0, 80),
    tableCandidates: candidates.tableCandidates.slice(0, 80),
  };

  return [
    `Template: ${templateName}`,
    '',
    'You are assisting with AIP AD flight procedure chart recognition.',
    'Return only a valid GeoJSON FeatureCollection. Do not invent uncertain coordinates or semantics.',
    'When evidence is insufficient, set review_required=true and explain the source_text.',
    '',
    'Required feature object_type values include ProcedureChart, ProcedureTrack, ProcedureLeg, ProcedureFix, Navaid, Runway, HoldingPattern, MSA, LabelPoint, SourceEvidence, and semantic geometry:null objects.',
    'Every feature.properties must include object_type, source_page, source_text, coordinate_quality, review_required, and confidence.',
    '',
    'Use the ProcedurePackage core pages as the primary evidence. Supporting pages may only supplement common runway, frequency, navaid, and flight-procedure context.',
    '',
    'Use this structured input. Treat corePages as the only procedure package pages; use supportingInfoSummary only as contextual evidence.',
    '',
    JSON.stringify(promptInput, null, 2),
  ].join('\n');
}

function geoJsonSchema() {
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: 'GeoJSON geometry or null for allowed semantic objects',
        properties: {
          object_type: 'string',
          source_page: 'number',
          source_text: 'string',
          source_bbox: 'optional [x,y,w,h]',
          coordinate_quality: 'known | derived | approximate | unknown',
          review_required: 'boolean',
          confidence: 'number 0..1',
        },
      },
    ],
  };
}
