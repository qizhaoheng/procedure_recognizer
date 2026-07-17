import crypto from 'node:crypto';
import type { PdfPageAsset, ProcedureGroup, ProcedureTask } from '../../../types/procedure';
import { parsePageHeader } from '../../pageHeaderParser';
import {
  RECOGNITION_V2_CONTRACT_VERSION,
  RECOGNITION_V2_SCHEMA_IDS,
  type CandidateEntityType,
  type ExtractionStageResult,
  type FieldCandidate,
  type ModelExecutionRef,
  type PageLayoutStageResult,
  type SourceEvidence,
} from '../contracts/index';
import {
  assertValidExtractionStageResult,
  assertValidModelProcedureIdentity,
  readRecognitionV2Schema,
} from '../contracts/schemaValidation';
import { renderDynamicRegionCrop } from '../layout/dynamicRegionCrop';
import { runVisionStage, type VisionStageClient } from '../orchestration/visionStageClient';
import { readRecognitionV2Prompt } from '../prompts/promptResources';
import type { StageAuditArtifact, StageAuditWriter } from '../layout/pageLayoutExecutor';
import { locateLocalRasterEvidence, readLocalRasterOcrText } from '../tables/localRasterTableRecovery';
import { extractProcedureNamesFromText } from './procedureTitleParser';

export { extractProcedureNamesFromText } from './procedureTitleParser';

const PROMPT_ID = 'v2_procedure_identity';
const PROMPT_VERSION = '2.0.0-alpha.1';
const MODEL_SCHEMA_ID = 'recognition-v2-model-procedure-identity.schema.json';

const FIELD_ENTITY: Record<string, CandidateEntityType> = {
  airportIcao: 'AIRPORT',
  airportName: 'AIRPORT',
  packageType: 'PROCEDURE',
  procedureCategory: 'PROCEDURE',
  navigationType: 'PROCEDURE',
  runway: 'RUNWAY',
  procedureName: 'PROCEDURE',
  transitionName: 'PROCEDURE',
  effectiveDate: 'PROCEDURE',
  chartNumber: 'PROCEDURE',
};

interface ModelIdentityObservation {
  observations: Array<{
    entityType: 'AIRPORT' | 'RUNWAY' | 'PROCEDURE';
    fieldName: keyof typeof FIELD_ENTITY;
    value: string | string[] | null;
    pageNo: number;
    regionId: string | null;
    rawText: string | null;
    visualDescription: string | null;
    confidence: number;
  }>;
  unresolvedFields: Array<keyof typeof FIELD_ENTITY>;
  warnings: string[];
}

export interface ProcedureIdentityExecutionResult {
  output: ExtractionStageResult;
  auditArtifacts: StageAuditArtifact[];
}

export async function executeProcedureIdentity(input: {
  task: ProcedureTask;
  group: ProcedureGroup;
  layout: PageLayoutStageResult;
  model: string;
  useModel: boolean;
  stageInputHash: string;
  abortSignal?: AbortSignal;
  visionClient?: VisionStageClient;
  onAuditArtifact?: StageAuditWriter;
}): Promise<ProcedureIdentityExecutionResult> {
  const pageByNo = new Map(input.task.pages.map((page) => [page.pageNo, page]));
  const identityPages = identityPageNos(input.group, input.layout);
  const evidence: SourceEvidence[] = [];
  const candidates: FieldCandidate[] = [];
  const warnings: string[] = [];
  for (const layoutPage of input.layout.pages) {
    if (!identityPages.has(layoutPage.pageNo)) continue;
    const page = pageByNo.get(layoutPage.pageNo);
    if (!page) {
      warnings.push(`Layout references missing task page ${layoutPage.pageNo}.`);
      continue;
    }
    addRuleCandidates(input.group, page, evidence, candidates);
    if (page.imageUrl && pageText(page).trim().length < 200) {
      try {
        const rasterText = await readLocalRasterOcrText(page);
        if (rasterText) await addRasterTitleCandidates(input.group, page, rasterText, evidence, candidates);
      } catch (error) {
        warnings.push(`Local raster identity recovery failed for page ${page.pageNo}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  addGroupFallbackCandidates(input.group, input.layout, pageByNo, evidence, candidates);
  const airportMasterPageNos = addAirportMasterDataCandidates(input.task, input.group, evidence, candidates);

  const auditArtifacts: StageAuditArtifact[] = [];
  if (input.useModel) {
    const imageInputs = [];
    const allowedRegions = new Map<string, AllowedIdentityRegion>();
    for (const layoutPage of input.layout.pages) {
      if (!identityPages.has(layoutPage.pageNo)) continue;
      const page = pageByNo.get(layoutPage.pageNo);
      if (!page?.imageUrl) continue;
      const titleRegions = layoutPage.regions.filter((region) => region.type === 'PROCEDURE_TITLE');
      for (const region of titleRegions) {
        const crop = await renderDynamicRegionCrop(page.imageUrl, region.bbox, region.rotationDeg);
        imageInputs.push({
          pageNo: page.pageNo,
          aipPageNo: `${page.aipPageNo ?? ''} region=${region.regionId}`.trim(),
          role: `PROCEDURE_TITLE:${region.regionId}`,
          dataUrl: crop.dataUrl,
        });
        allowedRegions.set(`${page.pageNo}:${region.regionId}`, {
          pageNo: page.pageNo,
          regionId: region.regionId,
          bbox: region.bbox,
          fileName: input.task.fileName,
          aipPageNo: page.aipPageNo,
        });
      }
    }
    if (imageInputs.length) {
      const systemPrompt = await readRecognitionV2Prompt('procedure-identity.prompt.md');
      const responseSchema = await readRecognitionV2Schema(MODEL_SCHEMA_ID);
      const userPrompt = [
        `Package id: ${input.group.packageId || input.group.groupId}`,
        `Allowed page/region pairs: ${JSON.stringify([...allowedRegions.values()])}`,
        `Non-authoritative rule candidates: ${JSON.stringify(candidates.map(({ fieldName, value, confidence }) => ({ fieldName, value, confidence })))}`,
      ].join('\n\n');
      const modelResult = await (input.visionClient ?? runVisionStage)({
        model: input.model,
        promptId: PROMPT_ID,
        promptVersion: PROMPT_VERSION,
        schemaId: MODEL_SCHEMA_ID,
        schemaVersion: PROMPT_VERSION,
        inputHash: input.stageInputHash,
        systemPrompt,
        userPrompt,
        responseSchema,
        images: imageInputs,
        abortSignal: input.abortSignal,
      });
      const auditArtifact = { fileName: 'procedure-identity-model.json', value: modelResult.audit };
      if (input.onAuditArtifact) await input.onAuditArtifact(auditArtifact);
      else auditArtifacts.push(auditArtifact);
      await assertValidModelProcedureIdentity(modelResult.parsedJson);
      addModelCandidates(
        modelResult.parsedJson as ModelIdentityObservation,
        modelResult.execution,
        input.group,
        allowedRegions,
        evidence,
        candidates,
        warnings,
      );
    } else {
      warnings.push('Vision identity model skipped because no validated PROCEDURE_TITLE region with an image was available.');
    }
  }

  const output: ExtractionStageResult = {
    contractVersion: RECOGNITION_V2_CONTRACT_VERSION,
    schemaId: RECOGNITION_V2_SCHEMA_IDS.extractionStageResult,
    taskType: 'PROCEDURE_IDENTITY',
    pageNos: [...new Set([...identityPages, ...airportMasterPageNos])].sort((a, b) => a - b),
    regionIds: input.layout.pages.filter((page) => identityPages.has(page.pageNo)).flatMap((page) => page.regions.filter((region) => region.type === 'PROCEDURE_TITLE').map((region) => region.regionId)),
    evidence: dedupeBy(evidence, (item) => item.evidenceId),
    candidates: dedupeBy(candidates, candidateKey),
    warnings: [...new Set(warnings)],
    completedAt: new Date().toISOString(),
  };
  await assertValidExtractionStageResult(output);
  return { output, auditArtifacts };
}

function addAirportMasterDataCandidates(
  task: ProcedureTask,
  group: ProcedureGroup,
  evidence: SourceEvidence[],
  candidates: FieldCandidate[],
) {
  const pageNos = new Set([
    ...(group.supportingInfoRefs?.airportMetadata ?? []),
    ...(group.supportingInfoRefs?.communication ?? []),
  ]);
  const airportIcao = String(group.supportingInfoSummary?.airportMetadata?.airportIcao ?? '').trim().toUpperCase();
  for (const page of task.pages.filter((item) => pageNos.has(item.pageNo))) {
    const text = pageText(page).replace(/\s+/g, ' ');
    const transition = text.match(/TRANSITION\s+ALTITUDE[^0-9]{0,30}(\d(?:[\d\s,.]*\d)?)\s*(FT|M)?/i);
    if (transition) {
      const numeric = Number(transition[1].replace(/[^0-9.]/g, ''));
      const feet = transition[2]?.toUpperCase() === 'M' ? Math.round(numeric * 3.280839895) : numeric;
      if (Number.isFinite(feet) && feet >= 1000 && feet <= 30000) {
        addAirportField(page, airportIcao, 'transitionAltitudeFt', transition[0], Math.round(feet), 'ft');
      }
    }
    const variation = text.match(/(?:MAG(?:NETIC)?\s+VAR(?:IATION)?|MAG\s+VAR)[^0-9]{0,20}(\d{1,2}(?:\.\d+)?)\s*(?:掳|°)?\s*([EW])/i);
    if (variation) {
      const magnitude = Number(variation[1]);
      if (Number.isFinite(magnitude) && magnitude <= 30) {
        addAirportField(page, airportIcao, 'magneticVariationDeg', variation[0], variation[2].toUpperCase() === 'W' ? magnitude : -magnitude, 'deg');
      }
    }
  }
  return [...pageNos];

  function addAirportField(page: PdfPageAsset, icao: string, fieldName: string, rawText: string, value: number, unit: string) {
    const entity = `AIRPORT:${icao || group.packageId || group.groupId}`;
    const evidenceId = stableId('evidence', ['airport-master-data', page.pageNo, fieldName, rawText]);
    evidence.push({
      evidenceId,
      fileName: page.sourceFileName || task.fileName,
      pageNo: page.pageNo,
      aipPageNo: page.aipPageNo,
      sourceType: 'SUPPORTING_INFORMATION',
      rawText,
      visualDescription: `Deterministically parsed airport ${fieldName} from AIP AD supporting data.`,
      extractionTask: 'PROCEDURE_IDENTITY',
      confidence: 0.98,
      status: 'OBSERVED',
    });
    candidates.push({
      candidateId: stableId('candidate', ['airport-master-data', page.pageNo, fieldName, value]),
      entityType: 'AIRPORT',
      entityKey: entity,
      fieldName,
      value,
      normalizedValue: value,
      unit,
      status: 'OBSERVED',
      sourceEvidenceIds: [evidenceId],
      confidence: 0.98,
      reviewRequired: false,
    });
  }
}

async function addRasterTitleCandidates(
  group: ProcedureGroup,
  page: PdfPageAsset,
  rasterText: string,
  evidence: SourceEvidence[],
  candidates: FieldCandidate[],
) {
  for (const observation of extractProcedureNamesFromText(rasterText)) {
    if (hasEquivalentCandidate(candidates, 'procedureName', observation.name)) continue;
    const evidenceId = stableId('evidence', ['local-raster-title', page.pageNo, observation.name, observation.rawText]);
    const location = await locateLocalRasterEvidence(page, observation.name.split(/\s+/), 'PROCEDURE_TITLE');
    evidence.push({
      evidenceId,
      fileName: page.sourceFileName || 'AIP AD-2',
      pageNo: page.pageNo,
      aipPageNo: page.aipPageNo,
      bbox: location?.bbox,
      sourceType: 'PROCEDURE_TITLE',
      rawText: observation.rawText,
      visualDescription: 'Locally OCR-recovered formal procedure title',
      extractionTask: 'PROCEDURE_IDENTITY',
      confidence: 0.88,
      status: 'OBSERVED',
    });
    candidates.push({
      candidateId: stableId('candidate', ['local-raster-title', page.pageNo, observation.name, observation.rawText]),
      entityType: 'PROCEDURE',
      entityKey: entityKey(group, 'PROCEDURE', observation.name),
      fieldName: 'procedureName',
      value: observation.name,
      normalizedValue: normalizeIdentityValue('procedureName', observation.name),
      status: 'OBSERVED',
      sourceEvidenceIds: [evidenceId],
      confidence: 0.88,
      reviewRequired: true,
    });
  }
}

/**
 * Supporting pages are useful to later extract navaids and notes, but they are
 * not allowed to redefine the identity of this procedure package. Chart index
 * pages in particular contain many unrelated procedures and otherwise create
 * deterministic false conflicts.
 */
function identityPageNos(group: ProcedureGroup, layout: PageLayoutStageResult) {
  const core = new Set([
    ...(group.chartPages ?? []),
    ...(group.tabularPages ?? []),
    ...(group.textSupplementPages ?? []),
  ]);
  if (core.size) return core;
  return new Set(layout.pages.map((page) => page.pageNo));
}

function addRuleCandidates(
  group: ProcedureGroup,
  page: PdfPageAsset,
  evidence: SourceEvidence[],
  candidates: FieldCandidate[],
) {
  const header = parsePageHeader(page);
  addRuleValue(group, page, 'airportIcao', header.airportIcao, 0.94, evidence, candidates);
  addRuleValue(group, page, 'packageType', header.packageType === 'OTHER' ? undefined : header.packageType, 0.9, evidence, candidates);
  addRuleValue(group, page, 'procedureCategory', header.procedureCategory === 'UNKNOWN' ? undefined : header.procedureCategory, 0.9, evidence, candidates);
  addRuleValue(group, page, 'navigationType', header.navigationType === 'UNKNOWN' ? undefined : header.navigationType, 0.86, evidence, candidates);
  addRuleValue(group, page, 'runway', header.runway, 0.88, evidence, candidates);
  if ((group.chartPages ?? []).includes(page.pageNo) || !(group.chartPages ?? []).length) {
    addRuleValue(group, page, 'chartNumber', header.aipPageNo, 0.94, evidence, candidates);
  }
  for (const name of header.procedureNames.filter(plausibleProcedureName)) addRuleValue(group, page, 'procedureName', name, 0.9, evidence, candidates);
  for (const transition of page.pageClassification?.transitionNames ?? []) {
    addRuleValue(group, page, 'transitionName', transition, 0.86, evidence, candidates);
  }
  const effectiveDate = pageText(page).match(/(?:EFFECTIVE|EFF)\s*(?:DATE)?\s*[:\-]?\s*(\d{1,2}\s+[A-Z]{3}\s+20\d{2}|20\d{2}[-/]\d{2}[-/]\d{2})/i)?.[1];
  addRuleValue(group, page, 'effectiveDate', effectiveDate, 0.82, evidence, candidates);
}

function addGroupFallbackCandidates(
  group: ProcedureGroup,
  layout: PageLayoutStageResult,
  pageByNo: Map<number, PdfPageAsset>,
  evidence: SourceEvidence[],
  candidates: FieldCandidate[],
) {
  const firstPage = pageByNo.get(layout.pages[0]?.pageNo);
  if (!firstPage) return;
  const authoritativeGroup = group.confidence !== undefined && group.confidence >= 0.9 && /CHART_INDEX/i.test(group.source ?? '');
  const confidenceFloor = authoritativeGroup ? Math.min(0.96, group.confidence!) : undefined;
  const values: Array<[keyof typeof FIELD_ENTITY, string | undefined, number]> = [
    ['packageType', group.packageType, confidenceFloor ?? 0.7],
    ['procedureCategory', group.procedureCategory === 'UNKNOWN' ? undefined : group.procedureCategory, confidenceFloor ?? 0.7],
    ['navigationType', group.navigationType === 'UNKNOWN' ? undefined : group.navigationType, confidenceFloor ?? 0.68],
    ['runway', group.runway, confidenceFloor ?? 0.68],
    ['chartNumber', group.chartNo, confidenceFloor ?? 0.75],
  ];
  for (const [field, value, confidence] of values) {
    if (!hasEquivalentCandidate(candidates, field, value)) addRuleValue(group, firstPage, field, value, confidence, evidence, candidates, true, !authoritativeGroup);
  }
  for (const name of group.procedureNames.filter(plausibleProcedureName)) {
    if (!hasEquivalentCandidate(candidates, 'procedureName', name)) {
      addRuleValue(group, firstPage, 'procedureName', name, confidenceFloor ?? 0.68, evidence, candidates, true, !authoritativeGroup);
    }
  }
}

function addRuleValue(
  group: ProcedureGroup,
  page: PdfPageAsset,
  fieldName: keyof typeof FIELD_ENTITY,
  value: string | undefined | null,
  confidence: number,
  evidence: SourceEvidence[],
  candidates: FieldCandidate[],
  metadataFallback = false,
  forceReview = metadataFallback,
) {
  const normalized = String(value ?? '').trim();
  if (!normalized) return;
  const rawLine = sourceLine(page, normalized);
  const evidenceId = stableId('evidence', ['rule', page.pageNo, fieldName, normalized, metadataFallback]);
  evidence.push({
    evidenceId,
    fileName: page.sourceFileName || 'AIP AD-2',
    pageNo: page.pageNo,
    aipPageNo: page.aipPageNo,
    sourceType: rawLine ? 'TEXT_LAYER' : 'DOCUMENT_METADATA',
    rawText: rawLine || `${fieldName}=${normalized}`,
    extractionTask: 'PROCEDURE_IDENTITY',
    confidence,
    status: 'OBSERVED',
  });
  candidates.push({
    candidateId: stableId('candidate', ['rule', page.pageNo, fieldName, normalized, metadataFallback]),
    entityType: FIELD_ENTITY[fieldName],
    entityKey: entityKey(group, FIELD_ENTITY[fieldName], normalized),
    fieldName,
    value: normalized,
    normalizedValue: normalizeIdentityValue(fieldName, normalized),
    status: 'OBSERVED',
    sourceEvidenceIds: [evidenceId],
    confidence,
    reviewRequired: forceReview || confidence < 0.75,
  });
}

function plausibleProcedureName(value: string) {
  const text = value.trim().replace(/\s+/g, ' ');
  if (!text || text.length > 80) return false;
  if (/MISSED\s+APPROACH|TRANSITION\s+(?:LEVEL|ALT)|CATEGORY\s+OF\s+AIRCRAFT|\d{2,3}\s*[掳°]/i.test(text)) return false;
  return /[A-Z]/i.test(text);
}

function hasEquivalentCandidate(candidates: FieldCandidate[], fieldName: keyof typeof FIELD_ENTITY, value: string | undefined) {
  if (!value) return true;
  const normalized = normalizeIdentityValue(fieldName, value);
  return candidates.some((candidate) => candidate.fieldName === fieldName && candidate.normalizedValue === normalized);
}

function addModelCandidates(
  model: ModelIdentityObservation,
  execution: ModelExecutionRef,
  group: ProcedureGroup,
  allowedRegions: Map<string, AllowedIdentityRegion>,
  evidence: SourceEvidence[],
  candidates: FieldCandidate[],
  warnings: string[],
) {
  for (const observation of model.observations) {
    const regionKey = `${observation.pageNo}:${observation.regionId ?? ''}`;
    const allowedRegion = observation.regionId ? allowedRegions.get(regionKey) : undefined;
    if (!allowedRegion) {
      warnings.push(`Rejected model identity observation for unprovided region ${regionKey}.`);
      continue;
    }
    if (FIELD_ENTITY[observation.fieldName] !== observation.entityType) {
      warnings.push(`Rejected model identity observation with mismatched entity ${observation.entityType}.${observation.fieldName}.`);
      continue;
    }
    const values = Array.isArray(observation.value) ? observation.value : [observation.value];
    for (const value of values) {
      const normalized = String(value ?? '').trim();
      const evidenceId = stableId('evidence', ['model', execution.runId, observation.pageNo, observation.regionId, observation.fieldName, normalized]);
      evidence.push({
        evidenceId,
        fileName: allowedRegion.fileName,
        pageNo: observation.pageNo,
        aipPageNo: allowedRegion.aipPageNo ?? undefined,
        regionId: observation.regionId ?? undefined,
        bbox: allowedRegion.bbox,
        sourceType: 'PROCEDURE_TITLE',
        rawText: observation.rawText || undefined,
        visualDescription: observation.visualDescription || undefined,
        extractionTask: 'PROCEDURE_IDENTITY',
        confidence: observation.confidence,
        status: 'OBSERVED',
        modelExecution: execution,
      });
      candidates.push({
        candidateId: stableId('candidate', ['model', execution.runId, observation.pageNo, observation.regionId, observation.fieldName, normalized]),
        entityType: observation.entityType,
        entityKey: entityKey(group, observation.entityType, normalized || 'UNRESOLVED'),
        fieldName: observation.fieldName,
        value: normalized || null,
        normalizedValue: normalized ? normalizeIdentityValue(observation.fieldName, normalized) : null,
        status: normalized ? 'OBSERVED' : 'UNRESOLVED',
        sourceEvidenceIds: [evidenceId],
        confidence: observation.confidence,
        reviewRequired: true,
      });
    }
  }
  for (const fieldName of model.unresolvedFields) {
    candidates.push({
      candidateId: stableId('candidate', ['model-unresolved', execution.runId, fieldName]),
      entityType: FIELD_ENTITY[fieldName],
      entityKey: entityKey(group, FIELD_ENTITY[fieldName], 'UNRESOLVED'),
      fieldName,
      value: null,
      status: 'UNRESOLVED',
      sourceEvidenceIds: [],
      confidence: 0,
      reviewRequired: true,
    });
  }
  warnings.push(...model.warnings);
}

interface AllowedIdentityRegion {
  pageNo: number;
  regionId: string;
  bbox: [number, number, number, number];
  fileName: string;
  aipPageNo?: string;
}

function entityKey(group: ProcedureGroup, entityType: CandidateEntityType, value: string) {
  if (entityType === 'PROCEDURE') return `PACKAGE:${group.packageId || group.groupId}`;
  if (entityType === 'AIRPORT') return `AIRPORT:${value.toUpperCase()}`;
  return `RUNWAY:${value.toUpperCase().replace(/\s+/g, '')}`;
}

function normalizeIdentityValue(fieldName: string, value: string) {
  const text = value.trim().replace(/\s+/g, ' ');
  if (fieldName === 'runway') return text.toUpperCase().replace(/^RWY?/, 'RW');
  return text.toUpperCase();
}

function sourceLine(page: PdfPageAsset, value: string) {
  const needle = value.replace(/\s+/g, ' ').toUpperCase();
  return pageText(page).split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .find((line) => line.toUpperCase().includes(needle));
}

function pageText(page: PdfPageAsset) {
  return page.ocrText || page.textLayerText || '';
}

function stableId(prefix: string, value: unknown) {
  return `${prefix}_${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 20)}`;
}

function candidateKey(candidate: FieldCandidate) {
  return JSON.stringify([candidate.entityType, candidate.entityKey, candidate.fieldName, candidate.normalizedValue, candidate.status, candidate.sourceEvidenceIds]);
}

function dedupeBy<T>(items: T[], keyOf: (item: T) => string) {
  return [...new Map(items.map((item) => [keyOf(item), item])).values()];
}
