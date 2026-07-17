import crypto from 'node:crypto';
import type { PdfPageAsset, ProcedureGroup, ProcedureTask } from '../../../types/procedure';
import {
  RECOGNITION_V2_CONTRACT_VERSION,
  RECOGNITION_V2_SCHEMA_IDS,
  type ExtractionStageResult,
  type FieldCandidate,
  type ModelExecutionRef,
  type PageLayoutStageResult,
  type SourceEvidence,
} from '../contracts/index';
import { assertValidExtractionStageResult, assertValidModelNotesConstraints, readRecognitionV2Schema } from '../contracts/schemaValidation';
import { renderDynamicRegionCrop } from '../layout/dynamicRegionCrop';
import type { StageAuditArtifact, StageAuditWriter } from '../layout/pageLayoutExecutor';
import { runVisionStage, type VisionStageClient } from '../orchestration/visionStageClient';
import { readRecognitionV2Prompt } from '../prompts/promptResources';
import { locateLocalRasterTextRegions, readLocalRasterOcrText } from '../tables/localRasterTableRecovery';

const MODEL_SCHEMA_ID = 'recognition-v2-model-notes-constraints.schema.json';
const PROMPT_VERSION = '2.0.0-alpha.1';

export type ConstraintType = 'INITIAL_CLIMB' | 'CLIMB_GRADIENT' | 'SPEED_RESTRICTION' | 'NAVIGATION_REQUIREMENT' | 'FLY_OVER' | 'OPERATIONAL_NOTE' | 'COMMUNICATION_FAILURE';

interface NoteObservation {
  constraintType: ConstraintType;
  text: string | null;
  pageNo: number;
  regionId?: string;
  rawText?: string | null;
  visualDescription?: string | null;
  confidence: number;
  sourceType: SourceEvidence['sourceType'];
  modelExecution?: ModelExecutionRef;
}

interface ModelResult {
  observations: Array<Omit<NoteObservation, 'sourceType' | 'modelExecution'> & { regionId: string }>;
  warnings: string[];
}

export async function executeNotesConstraints(input: {
  task: ProcedureTask;
  group: ProcedureGroup;
  layout: PageLayoutStageResult;
  model: string;
  useModel: boolean;
  stageInputHash: string;
  abortSignal?: AbortSignal;
  visionClient?: VisionStageClient;
  onAuditArtifact?: StageAuditWriter;
}): Promise<{ output: ExtractionStageResult; auditArtifacts: StageAuditArtifact[] }> {
  const pageByNo = new Map(input.task.pages.map((page) => [page.pageNo, page]));
  const pageNos = new Set([
    ...(input.group.chartPages ?? []),
    ...(input.group.tabularPages ?? []),
    ...(input.group.textSupplementPages ?? []),
  ]);
  const observations: NoteObservation[] = [];
  const warnings: string[] = [];
  const auditArtifacts: StageAuditArtifact[] = [];

  for (const pageNo of pageNos) {
    const page = pageByNo.get(pageNo);
    if (!page) continue;
    let text = pageText(page);
    let sourceType: SourceEvidence['sourceType'] = 'TEXT_LAYER';
    if (page.imageUrl && text.trim().length < 400) {
      try {
        text = (await readLocalRasterOcrText(page)) || text;
        sourceType = 'PROCEDURE_NOTES';
      } catch (error) {
        warnings.push(`Local raster note OCR failed for page ${pageNo}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    observations.push(...extractConstraintObservations(text, pageNo, sourceType));
  }

  if (input.useModel) {
    const regions = (await Promise.all(input.layout.pages.map(async (layoutPage) => {
      const page = pageByNo.get(layoutPage.pageNo);
      if (!page?.imageUrl || !pageNos.has(page.pageNo)) return [];
      const notes = layoutPage.regions.filter((region) => region.type === 'PROCEDURE_NOTES');
      const located = notes.length ? [] : await locateLocalRasterTextRegions(page, [/[IL]NITIAL\s+CLIMB/i, /TERRAIN\s+CLEARANCE/i, /S\s*PEED\s+RESTRI/i, /FLY-?OVE\s*R\s+WAYPOINT/i]);
      const fallback = located.map((item, index) => ({ regionId: `p${page.pageNo}-notes-ocr-${index + 1}`, pageNo: page.pageNo, type: 'PROCEDURE_NOTES' as const, bbox: item.bbox, rotationDeg: 0 as const, readingOrder: index, confidence: 0.75, reviewRequired: true, ocrHint: item.rawText }));
      return (notes.length ? notes : fallback)
        .map((region) => ({ page, region }));
    }))).flat();
    for (const { page, region } of regions) {
      const crop = await renderDynamicRegionCrop(page.imageUrl!, region.bbox, region.rotationDeg, 2);
      const request = {
        model: input.model,
        promptId: 'v2_notes_constraints',
        promptVersion: PROMPT_VERSION,
        schemaId: MODEL_SCHEMA_ID,
        schemaVersion: PROMPT_VERSION,
        inputHash: hash([input.stageInputHash, page.pageNo, region.regionId, region.bbox]),
        systemPrompt: await readRecognitionV2Prompt('notes-constraints.prompt.md'),
        userPrompt: [
          `Allowed page number: ${page.pageNo}`,
          `Allowed region id: ${region.regionId}`,
          'Return exactly this object shape: {"observations":[{"constraintType":"INITIAL_CLIMB|CLIMB_GRADIENT|SPEED_RESTRICTION|NAVIGATION_REQUIREMENT|FLY_OVER|OPERATIONAL_NOTE|COMMUNICATION_FAILURE","text":"visible statement or null","pageNo":1,"regionId":"supplied id","rawText":"visible statement or null","visualDescription":null,"confidence":0.0}],"warnings":[]}',
          'Do not return pageNo or regionId at the root. Do not use a category field. Ignore titles, dates, publisher names, page numbers and amendment text.',
          `Non-authoritative OCR heading hint: ${'ocrHint' in region ? String(region.ocrHint) : 'none'}`,
        ].join('\n'),
        responseSchema: await readRecognitionV2Schema(MODEL_SCHEMA_ID),
        images: [{ pageNo: page.pageNo, aipPageNo: page.aipPageNo, role: `PROCEDURE_NOTES:${region.regionId}`, dataUrl: crop.dataUrl }],
        abortSignal: input.abortSignal,
      };
      const result = await (input.visionClient ?? runVisionStage)(request);
      const artifact = { fileName: `notes-constraints-model-page-${page.pageNo}-${region.regionId}.json`, value: result.audit };
      if (input.onAuditArtifact) await input.onAuditArtifact(artifact); else auditArtifacts.push(artifact);
      await assertValidModelNotesConstraints(result.parsedJson);
      const parsed = result.parsedJson as ModelResult;
      for (const item of parsed.observations) {
        if (item.pageNo !== page.pageNo || item.regionId !== region.regionId) throw new Error(`Notes model returned unprovided region ${item.pageNo}:${item.regionId}.`);
        if (!String(item.text ?? item.rawText ?? '').trim()) {
          warnings.push(`Notes model returned an empty ${item.constraintType} observation for ${item.regionId}; it was rejected.`);
          continue;
        }
        observations.push({ ...item, sourceType: 'PROCEDURE_NOTES', modelExecution: result.execution });
      }
      warnings.push(...parsed.warnings);
    }
  }

  const evidence: SourceEvidence[] = [];
  const candidates: FieldCandidate[] = [];
  for (const observation of dedupe(observations, (item) => `${item.pageNo}:${item.constraintType}:${normalize(item.text ?? item.rawText ?? '')}`)) {
    const page = pageByNo.get(observation.pageNo);
    const value = cleanObservationText(observation.constraintType, observation.text || observation.rawText || '');
    const entityKey = constraintEntityKey(input.group.packageId || input.group.groupId, observation.constraintType, value);
    const evidenceId = `evidence_${hash([entityKey, observation.pageNo, observation.rawText, observation.visualDescription]).slice(-20)}`;
    evidence.push({
      evidenceId,
      fileName: page?.sourceFileName || input.task.fileName,
      pageNo: observation.pageNo,
      aipPageNo: page?.aipPageNo,
      regionId: observation.regionId,
      sourceType: observation.sourceType,
      rawText: observation.rawText || observation.text || undefined,
      visualDescription: observation.visualDescription || undefined,
      extractionTask: 'NOTES_CONSTRAINTS',
      confidence: observation.confidence,
      status: value ? 'OBSERVED' : 'UNRESOLVED',
      modelExecution: observation.modelExecution,
    });
    addCandidate(candidates, entityKey, 'constraintType', observation.constraintType, evidenceId, observation.confidence, observation.modelExecution);
    addCandidate(candidates, entityKey, 'text', value || null, evidenceId, observation.confidence, observation.modelExecution);
    addStructuredCandidates(candidates, entityKey, observation.constraintType, value, evidenceId, observation.confidence, observation.modelExecution);
  }
  if (!observations.length) warnings.push('No operational note or constraint was recovered; publication completeness validation must decide whether this is acceptable.');
  const output: ExtractionStageResult = {
    contractVersion: RECOGNITION_V2_CONTRACT_VERSION,
    schemaId: RECOGNITION_V2_SCHEMA_IDS.extractionStageResult,
    taskType: 'NOTES_CONSTRAINTS',
    pageNos: [...pageNos].sort((a, b) => a - b),
    regionIds: [...new Set(observations.map((item) => item.regionId).filter((item): item is string => Boolean(item)))],
    evidence,
    candidates,
    warnings: [...new Set(warnings)],
    completedAt: new Date().toISOString(),
  };
  await assertValidExtractionStageResult(output);
  return { output, auditArtifacts };
}

export function extractConstraintObservations(text: string, pageNo: number, sourceType: SourceEvidence['sourceType'] = 'TEXT_LAYER'): NoteObservation[] {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return [];
  const definitions: Array<[ConstraintType, RegExp]> = [
    ['INITIAL_CLIMB', /[IL]NITIAL\s+CLIMB\s+(.{5,500}?)(?=TERRAIN\s+CLEARANCE|SPEED\s+RESTRI|COMMUNICATION|$)/i],
    ['CLIMB_GRADIENT', /(?:TERRAIN\s+CLEARANCE\s+)?(?:MINIMUM|M\s*NIMUM|MNM)\s+CLIMB\s+GRADIENT\s+(?:OF\s+)?(.{5,500}?)(?=S\s*PEED\s+RESTRI|CIVI[LI1]\s+AVIATION|AMENDMENT|COMMUNICATION|$)/i],
    ['SPEED_RESTRICTION', /S\s*PEED\s+RESTRICTION\s+(?:OF\s+)?(.{5,700}?)(?=COMMUNICATION|RADIO\s+FAILURE|CIVI[LI1]\s+AVIATION|AMENDMENT|$)/i],
    ['COMMUNICATION_FAILURE', /(?:RADIO\s+)?COMMUNICATIONS?\s+FAILURE\s+(.{5,700}?)(?=$)/i],
    ['FLY_OVER', /([A-Z0-9]{2,8}\s+IS\s+A\s+FLY-?OVE\s*R\s+WAYPOINT[^.]*\.)/i],
    ['NAVIGATION_REQUIREMENT', /((?:RNP|RNAV)\s*\d+(?:\.\d+)?\s+REQUIREMENT[^.]*\.)/i],
  ];
  return definitions.flatMap(([constraintType, pattern]) => {
    const match = normalized.match(pattern);
    if (!match) return [];
    const rawText = `${constraintType === 'INITIAL_CLIMB' ? 'INITIAL CLIMB ' : constraintType === 'SPEED_RESTRICTION' ? 'SPEED RESTRICTION ' : ''}${match[1]}`.trim();
    return [{ constraintType, text: rawText, pageNo, rawText, confidence: sourceType === 'TEXT_LAYER' ? 0.9 : 0.8, sourceType }];
  });
}

function addStructuredCandidates(candidates: FieldCandidate[], entityKey: string, type: ConstraintType, text: string, evidenceId: string, confidence: number, model?: ModelExecutionRef) {
  if (type === 'CLIMB_GRADIENT') {
    const percent = text.match(/(\d+(?:\.\d+)?)\s*[%％]/)?.[1];
    const feet = text.match(/(\d{2,4})\s*FT\s*\/\s*NM/i)?.[1];
    const until = text.match(/(?:UNTIL|TO)\s+(?:PASSING\s+)?(\d(?:\s?\d){2,4})\s*(?:FT)?/i)?.[1]?.replace(/\s+/g, '');
    if (percent) addCandidate(candidates, entityKey, 'minimumClimbGradientPercent', Number(percent), evidenceId, confidence, model, '%');
    if (feet) addCandidate(candidates, entityKey, 'minimumClimbGradientFtPerNm', Number(feet), evidenceId, confidence, model, 'FT/NM');
    if (until) addCandidate(candidates, entityKey, 'untilAltitudeFt', Number(until), evidenceId, confidence, model, 'FT');
  }
  if (type === 'SPEED_RESTRICTION') {
    const values = [...text.matchAll(/(\d{2,3})\s*KIAS/gi)].map((match) => Number(match[1]));
    if (values.length) addCandidate(candidates, entityKey, 'speedValuesKias', [...new Set(values)], evidenceId, confidence, model, 'KIAS');
  }
  if (type === 'FLY_OVER') {
    const fix = text.match(/^([A-Z0-9]{2,8})\s+IS\s+A\s+FLY/i)?.[1];
    if (fix) addCandidate(candidates, entityKey, 'fixIdentifier', fix, evidenceId, confidence, model);
  }
}

function addCandidate(candidates: FieldCandidate[], entityKey: string, fieldName: string, value: unknown, evidenceId: string, confidence: number, model?: ModelExecutionRef, unit?: string) {
  candidates.push({
    candidateId: `candidate_${hash([entityKey, fieldName, value, evidenceId]).slice(-20)}`,
    entityType: 'CONSTRAINT', entityKey, fieldName, value: value ?? null,
    normalizedValue: typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : value ?? null,
    unit, status: value === null ? 'UNRESOLVED' : 'OBSERVED', sourceEvidenceIds: [evidenceId],
    confidence: value === null ? 0 : confidence, reviewRequired: true,
  });
}

function pageText(page: PdfPageAsset) { return page.ocrText || page.textLayerText || ''; }
function cleanObservationText(type: ConstraintType, value: string) {
  let cleaned = value.trim().replace(/\s+/g, ' ');
  if (type === 'CLIMB_GRADIENT') cleaned = cleaned.split(/S\s*PEED\s+RESTR/i)[0].trim();
  if (type === 'SPEED_RESTRICTION') cleaned = cleaned.replace(/\s+\d(?:\s+\d){1,}\s*$/, '').trim();
  return cleaned;
}
function constraintEntityKey(packageId: string, type: ConstraintType, value: string) {
  let discriminator = value;
  if (['INITIAL_CLIMB', 'CLIMB_GRADIENT', 'SPEED_RESTRICTION', 'NAVIGATION_REQUIREMENT'].includes(type)) discriminator = type;
  if (type === 'FLY_OVER') discriminator = value.match(/^([A-Z0-9]{2,8})\s+IS\s+A\s+FLY/i)?.[1] || value;
  return `CONSTRAINT:${packageId}:${type}:${hash(discriminator).slice(-12)}`;
}
function normalize(value: string) { return value.trim().replace(/\s+/g, ' ').toUpperCase(); }
function hash(value: unknown) { return crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex'); }
function dedupe<T>(items: T[], key: (item: T) => string) { return [...new Map(items.map((item) => [key(item), item])).values()]; }
