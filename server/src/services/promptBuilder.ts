import type { CandidateExtractionResult, PdfPageAsset, ProcedureGroup } from '../types/procedure';

export interface AiRequestPreview {
  model: string;
  prompt: string;
  schema: Record<string, unknown>;
  inputPages: Array<Pick<PdfPageAsset, 'pageNo' | 'aipPageNo' | 'chartRole' | 'imageUrl' | 'thumbnailUrl'>>;
  supportPages: Array<Pick<PdfPageAsset, 'pageNo' | 'aipPageNo' | 'chartRole' | 'imageUrl' | 'thumbnailUrl'>>;
  candidateSummary: Record<string, unknown>;
}

export function buildAiRequestPreview(
  group: ProcedureGroup,
  pages: PdfPageAsset[],
  model = process.env.LLM_MODEL || 'mock-procedure-recognizer',
): AiRequestPreview {
  const inputPageNos = corePages(group);
  const supportPageNos = group.supportingPages ?? [];
  const inputPages = pages
    .filter((page) => inputPageNos.includes(page.pageNo))
    .map(({ pageNo, aipPageNo, chartRole, imageUrl, thumbnailUrl }) => ({ pageNo, aipPageNo, chartRole, imageUrl, thumbnailUrl }));
  const supportPages = pages
    .filter((page) => supportPageNos.includes(page.pageNo))
    .map(({ pageNo, aipPageNo, chartRole, imageUrl, thumbnailUrl }) => ({ pageNo, aipPageNo, chartRole, imageUrl, thumbnailUrl }));
  const candidates: CandidateExtractionResult = {
    groupId: group.groupId,
    textCandidates: group.textCandidates ?? [],
    geometryCandidates: group.geometryCandidates ?? [],
    waypointCandidates: group.waypointCandidates ?? [],
    tableCandidates: group.tableCandidates ?? [],
  };
  const prompt = buildPrompt(group, inputPages, supportPages, candidates);

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
  };
}

export function buildPrompt(
  group: ProcedureGroup,
  inputPages: Array<Pick<PdfPageAsset, 'pageNo' | 'aipPageNo' | 'chartRole' | 'imageUrl' | 'thumbnailUrl'>>,
  supportPages: Array<Pick<PdfPageAsset, 'pageNo' | 'aipPageNo' | 'chartRole' | 'imageUrl' | 'thumbnailUrl'>>,
  candidates: CandidateExtractionResult,
) {
  const templateName = selectTemplate(group);
  const corePageNos = new Set(inputPages.map((page) => page.pageNo));
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
    corePages: inputPages,
    candidateTextsFromCorePages: candidates.textCandidates.filter((candidate) => corePageNos.has(candidate.pageNo)).slice(0, 160),
    candidateGeometryFromChartPages: candidates.geometryCandidates.filter((candidate) => corePageNos.has(candidate.pageNo)).slice(0, 80),
    supportingInfoSummary: group.supportingInfoSummary,
    supportingPages: supportPages,
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

function selectTemplate(group: ProcedureGroup) {
  if (group.procedureCategory === 'ARRIVAL' && group.navigationType === 'RNAV') return 'RNAV_STAR_PROMPT';
  if (group.procedureCategory === 'ARRIVAL' && group.navigationType === 'DME_ARC') return 'CONVENTIONAL_STAR_PROMPT';
  if (group.procedureCategory === 'DEPARTURE' && group.navigationType === 'RNAV') return 'RNAV_SID_PROMPT';
  if (group.procedureCategory === 'APPROACH' && group.navigationType === 'ILS_LOC') return 'ILS_LOC_APPROACH_PROMPT';
  if (group.procedureCategory === 'APPROACH' && group.navigationType === 'ILS') return 'ILS_APPROACH_PROMPT';
  if (group.procedureCategory === 'APPROACH' && group.navigationType === 'LOC') return 'LOC_APPROACH_PROMPT';
  if (group.procedureCategory === 'APPROACH' && group.navigationType === 'VOR') return 'VOR_APPROACH_PROMPT';
  if (group.procedureCategory === 'APPROACH' && group.navigationType === 'RNP') return 'RNP_APPROACH_PROMPT';
  return 'CONVENTIONAL_STAR_PROMPT';
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

function corePages(group: ProcedureGroup) {
  return [
    ...group.chartPages,
    ...group.tabularPages,
    ...group.coordinatePages,
    ...group.minimaPages,
    ...(group.textSupplementPages ?? []),
  ];
}
