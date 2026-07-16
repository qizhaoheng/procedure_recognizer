import crypto from 'node:crypto';
import type { PdfPageAsset, ProcedureGroup, ProcedureTask } from '../../../types/procedure';
import {
  RECOGNITION_V2_CONTRACT_VERSION,
  RECOGNITION_V2_SCHEMA_IDS,
  type CandidateEntityType,
  type ExtractionStageResult,
  type FieldCandidate,
  type ModelExecutionRef,
  type PageLayoutStageResult,
  type PageRegion,
  type SourceEvidence,
} from '../contracts/index';
import {
  assertValidExtractionStageResult,
  assertValidModelWaypointNavaid,
  readRecognitionV2Schema,
} from '../contracts/schemaValidation';
import { renderDynamicRegionCrop } from '../layout/dynamicRegionCrop';
import type { StageAuditArtifact, StageAuditWriter } from '../layout/pageLayoutExecutor';
import { runVisionStage, type VisionStageClient } from '../orchestration/visionStageClient';
import { readRecognitionV2Prompt } from '../prompts/promptResources';
import { extractAipCoordinatePairs, parseAipCoordinatePair } from './coordinateParser';

const PROMPT_ID = 'v2_waypoint_navaid';
const PROMPT_VERSION = '2.0.0-alpha.1';
const MODEL_SCHEMA_ID = 'recognition-v2-model-waypoint-navaid.schema.json';
const COORDINATE_RULE_ID = 'AIP_COORDINATE_TO_DECIMAL';
const COORDINATE_RULE_VERSION = '1.0.0';

interface RawObservation {
  entityType: 'FIX' | 'NAVAID';
  identifier: string | null;
  coordinateText: string | null;
  navaidType: string | null;
  frequency: string | null;
  channel: string | null;
  pageNo: number;
  regionId?: string;
  rawText?: string | null;
  visualDescription?: string | null;
  confidence: number;
  modelExecution?: ModelExecutionRef;
}

interface ModelWaypointNavaidResult {
  observations: Array<Required<Omit<RawObservation, 'modelExecution' | 'regionId'>> & { regionId: string }>;
  warnings: string[];
}

interface AllowedRegion {
  page: PdfPageAsset;
  region: PageRegion;
}

export interface WaypointNavaidExecutionResult {
  output: ExtractionStageResult;
  auditArtifacts: StageAuditArtifact[];
}

export async function executeWaypointNavaid(input: {
  task: ProcedureTask;
  group: ProcedureGroup;
  layout: PageLayoutStageResult;
  model: string;
  useModel: boolean;
  stageInputHash: string;
  abortSignal?: AbortSignal;
  visionClient?: VisionStageClient;
  onAuditArtifact?: StageAuditWriter;
}): Promise<WaypointNavaidExecutionResult> {
  const pageByNo = new Map(input.task.pages.map((page) => [page.pageNo, page]));
  const navaidPages = new Set([
    ...(input.group.supportingInfoRefs?.navaid ?? []),
    ...(input.group.supportingInfoDetails ?? []).filter((item) => item.supportType === 'NAVAID').map((item) => item.pageNo),
  ]);
  const allowed = new Map<string, AllowedRegion>();
  for (const layoutPage of input.layout.pages) {
    const page = pageByNo.get(layoutPage.pageNo);
    if (!page) continue;
    for (const region of layoutPage.regions) {
      if (region.type !== 'WAYPOINT_COORDINATE_TABLE' && !(region.type === 'SUPPORTING_INFORMATION' && navaidPages.has(page.pageNo))) continue;
      allowed.set(`${page.pageNo}:${region.regionId}`, { page, region });
    }
  }

  const observations: RawObservation[] = [];
  const warnings: string[] = [];
  const processedRulePages = new Set<number>();
  for (const { page, region } of allowed.values()) {
    if (processedRulePages.has(page.pageNo)) continue;
    processedRulePages.add(page.pageNo);
    observations.push(...ruleObservations(input.group, page, region, navaidPages.has(page.pageNo)));
  }

  const auditArtifacts: StageAuditArtifact[] = [];
  if (input.useModel) {
    for (const { page, region } of allowed.values()) {
      if (!page.imageUrl) {
        warnings.push(`Vision waypoint/navaid extraction skipped for page ${page.pageNo}: no image asset.`);
        continue;
      }
      const modelResult = await modelObservations(input, page, region, auditArtifacts);
      observations.push(...modelResult.observations.map((observation) => ({ ...observation, modelExecution: modelResult.execution })));
      warnings.push(...modelResult.warnings);
    }
  }
  if (!allowed.size) warnings.push('No waypoint-coordinate or referenced navaid region is available; no coordinates were guessed.');

  const evidence: SourceEvidence[] = [];
  const candidates: FieldCandidate[] = [];
  observations.forEach((observation, index) => addObservation(input.task, input.group, observation, index, allowed, evidence, candidates, warnings));
  const relevantPageNos = [...new Set(allowed.size ? [...allowed.values()].map((item) => item.page.pageNo) : input.layout.pages.map((page) => page.pageNo))];
  const output: ExtractionStageResult = {
    contractVersion: RECOGNITION_V2_CONTRACT_VERSION,
    schemaId: RECOGNITION_V2_SCHEMA_IDS.extractionStageResult,
    taskType: 'WAYPOINT_NAVAID',
    pageNos: relevantPageNos,
    regionIds: [...new Set([...allowed.values()].map((item) => item.region.regionId))],
    evidence,
    candidates,
    warnings: [...new Set(warnings)],
    completedAt: new Date().toISOString(),
  };
  await assertValidExtractionStageResult(output);
  return { output, auditArtifacts };
}

async function modelObservations(
  input: Parameters<typeof executeWaypointNavaid>[0],
  page: PdfPageAsset,
  region: PageRegion,
  auditArtifacts: StageAuditArtifact[],
) {
  const crop = await renderDynamicRegionCrop(page.imageUrl!, region.bbox, region.rotationDeg, 2);
  const systemPrompt = await readRecognitionV2Prompt('waypoint-navaid.prompt.md');
  const responseSchema = await readRecognitionV2Schema(MODEL_SCHEMA_ID);
  const modelResult = await (input.visionClient ?? runVisionStage)({
    model: input.model,
    promptId: PROMPT_ID,
    promptVersion: PROMPT_VERSION,
    schemaId: MODEL_SCHEMA_ID,
    schemaVersion: PROMPT_VERSION,
    inputHash: hashValue([input.stageInputHash, page.pageNo, region.regionId, region.bbox]),
    systemPrompt,
    userPrompt: [
      `Allowed page number: ${page.pageNo}`,
      `Allowed region id: ${region.regionId}`,
      `Text-layer hint only (may be incomplete):\n${pageText(page).slice(0, 7000)}`,
    ].join('\n\n'),
    responseSchema,
    images: [{ pageNo: page.pageNo, aipPageNo: page.aipPageNo, role: `${region.type}:${region.regionId}`, dataUrl: crop.dataUrl }],
    abortSignal: input.abortSignal,
  });
  const auditArtifact = { fileName: `waypoint-navaid-model-page-${page.pageNo}-${safeName(region.regionId)}.json`, value: modelResult.audit };
  if (input.onAuditArtifact) await input.onAuditArtifact(auditArtifact);
  else auditArtifacts.push(auditArtifact);
  await assertValidModelWaypointNavaid(modelResult.parsedJson);
  const parsed = modelResult.parsedJson as ModelWaypointNavaidResult;
  for (const observation of parsed.observations) {
    if (observation.pageNo !== page.pageNo || observation.regionId !== region.regionId) {
      throw new Error(`Waypoint/navaid model returned unprovided region ${observation.pageNo}:${observation.regionId}.`);
    }
  }
  return { ...parsed, execution: modelResult.execution };
}

function ruleObservations(group: ProcedureGroup, page: PdfPageAsset, region: PageRegion, navaidPage: boolean): RawObservation[] {
  const observations: RawObservation[] = [];
  for (const line of pageText(page).split(/\r?\n/).map((value) => value.trim()).filter(Boolean)) {
    const coordinates = extractAipCoordinatePairs(line);
    for (const coordinate of coordinates) {
      const prefix = line.slice(0, coordinate.startIndex);
      const navaidType = visibleNavaidType(line);
      const entityType = navaidPage || navaidType ? 'NAVAID' : 'FIX';
      observations.push({
        entityType,
        identifier: visibleIdentifier(group, page, prefix, entityType),
        coordinateText: coordinate.rawText,
        navaidType,
        frequency: line.match(/\b\d{3}\.\d{1,3}\s*MHZ\b|\b\d{3,4}\s*KHZ\b/i)?.[0] ?? null,
        channel: line.match(/\bCH\s*\d+[XY]\b/i)?.[0] ?? null,
        pageNo: page.pageNo,
        regionId: region.regionId,
        rawText: line,
        confidence: 0.82,
      });
    }
    if (!coordinates.length && navaidPage) {
      const navaidType = visibleNavaidType(line);
      const identifier = navaidType ? visibleIdentifier(group, page, line, 'NAVAID') : null;
      if (navaidType && identifier) {
        observations.push({
          entityType: 'NAVAID',
          identifier,
          coordinateText: null,
          navaidType,
          frequency: line.match(/\b\d{3}\.\d{1,3}\s*MHZ\b|\b\d{3,4}\s*KHZ\b/i)?.[0] ?? null,
          channel: line.match(/\bCH\s*\d+[XY]\b/i)?.[0] ?? null,
          pageNo: page.pageNo,
          regionId: region.regionId,
          rawText: line,
          confidence: 0.76,
        });
      }
    }
  }
  return observations;
}

function addObservation(
  task: ProcedureTask,
  group: ProcedureGroup,
  observation: RawObservation,
  index: number,
  allowed: Map<string, AllowedRegion>,
  evidence: SourceEvidence[],
  candidates: FieldCandidate[],
  warnings: string[],
) {
  const allowedRegion = observation.regionId ? allowed.get(`${observation.pageNo}:${observation.regionId}`) : undefined;
  if (observation.modelExecution && !allowedRegion) {
    warnings.push(`Rejected model waypoint/navaid observation for unprovided region ${observation.pageNo}:${observation.regionId ?? ''}.`);
    return;
  }
  const page = allowedRegion?.page ?? task.pages.find((item) => item.pageNo === observation.pageNo);
  if (!page) {
    warnings.push(`Rejected waypoint/navaid observation for missing page ${observation.pageNo}.`);
    return;
  }
  const identifier = normalizeIdentifier(observation.identifier);
  if (identifier && isProcedureOrTransitionName(group, page, identifier)) {
    warnings.push(`Rejected ${identifier} as a waypoint/navaid identifier because it is a procedure or transition name.`);
    return;
  }
  const evidenceId = stableId('evidence', ['waypoint-navaid', observation.modelExecution?.runId ?? 'rules', observation.pageNo, observation.regionId, index, observation.rawText, observation.visualDescription]);
  const entityKey = `${observation.entityType}:${identifier || `UNRESOLVED:${observation.pageNo}:${observation.regionId ?? 'text'}:${index}`}`;
  const modelReviewRequired = Boolean(observation.modelExecution);
  evidence.push({
    evidenceId,
    fileName: page.sourceFileName || task.fileName,
    pageNo: page.pageNo,
    aipPageNo: page.aipPageNo,
    regionId: observation.modelExecution ? observation.regionId : undefined,
    bbox: observation.modelExecution ? allowedRegion?.region.bbox : undefined,
    sourceType: observation.modelExecution ? allowedRegion!.region.type : 'TEXT_LAYER',
    rawText: observation.rawText || undefined,
    visualDescription: observation.visualDescription || undefined,
    extractionTask: 'WAYPOINT_NAVAID',
    confidence: observation.confidence,
    status: 'OBSERVED',
    modelExecution: observation.modelExecution,
  });

  if (identifier) candidates.push(observedCandidate(observation.entityType, entityKey, 'identifier', observation.identifier, identifier, evidenceId, observation.confidence, modelReviewRequired));
  else candidates.push(unresolvedCandidate(observation.entityType, entityKey, 'identifier', evidenceId));
  if (observation.navaidType) candidates.push(observedCandidate(observation.entityType, entityKey, 'navaidType', observation.navaidType, observation.navaidType.toUpperCase(), evidenceId, observation.confidence, modelReviewRequired));
  if (observation.frequency) candidates.push(observedCandidate(observation.entityType, entityKey, 'frequency', observation.frequency, observation.frequency.toUpperCase(), evidenceId, observation.confidence, modelReviewRequired));
  if (observation.channel) candidates.push(observedCandidate(observation.entityType, entityKey, 'channel', observation.channel, observation.channel.toUpperCase().replace(/\s+/g, ''), evidenceId, observation.confidence, modelReviewRequired));

  if (!observation.coordinateText) {
    candidates.push(unresolvedCandidate(observation.entityType, entityKey, 'latitude', evidenceId));
    candidates.push(unresolvedCandidate(observation.entityType, entityKey, 'longitude', evidenceId));
    return;
  }
  const rawCoordinate = observedCandidate(observation.entityType, entityKey, 'rawCoordinate', observation.coordinateText, observation.coordinateText.trim(), evidenceId, observation.confidence, modelReviewRequired);
  candidates.push(rawCoordinate);
  const parsed = parseAipCoordinatePair(observation.coordinateText);
  if (!parsed) {
    warnings.push(`Coordinate text could not be deterministically parsed for ${identifier || entityKey}: ${observation.coordinateText}`);
    candidates.push(unresolvedCandidate(observation.entityType, entityKey, 'latitude', evidenceId));
    candidates.push(unresolvedCandidate(observation.entityType, entityKey, 'longitude', evidenceId));
    return;
  }
  candidates.push(derivedCoordinateCandidate(observation.entityType, entityKey, 'latitude', parsed.latitude, rawCoordinate.candidateId, evidenceId, observation.confidence, modelReviewRequired));
  candidates.push(derivedCoordinateCandidate(observation.entityType, entityKey, 'longitude', parsed.longitude, rawCoordinate.candidateId, evidenceId, observation.confidence, modelReviewRequired));
  candidates.push(observedCandidate(observation.entityType, entityKey, 'coordinateFormat', parsed.format, parsed.format, evidenceId, observation.confidence, modelReviewRequired));
}

function observedCandidate(
  entityType: Extract<CandidateEntityType, 'FIX' | 'NAVAID'>,
  entityKey: string,
  fieldName: string,
  value: unknown,
  normalizedValue: unknown,
  evidenceId: string,
  confidence: number,
  forceReview = false,
): FieldCandidate {
  return {
    candidateId: stableId('candidate', ['observed', entityKey, fieldName, normalizedValue, evidenceId]),
    entityType,
    entityKey,
    fieldName,
    value,
    normalizedValue,
    status: 'OBSERVED',
    sourceEvidenceIds: [evidenceId],
    confidence,
    reviewRequired: forceReview || confidence < 0.8,
  };
}

function derivedCoordinateCandidate(
  entityType: Extract<CandidateEntityType, 'FIX' | 'NAVAID'>,
  entityKey: string,
  fieldName: 'latitude' | 'longitude',
  value: number,
  rawCoordinateCandidateId: string,
  evidenceId: string,
  confidence: number,
  forceReview = false,
): FieldCandidate {
  return {
    candidateId: stableId('candidate', ['derived-coordinate', entityKey, fieldName, value, rawCoordinateCandidateId]),
    entityType,
    entityKey,
    fieldName,
    value,
    normalizedValue: value,
    unit: 'deg',
    status: 'DERIVED',
    sourceEvidenceIds: [evidenceId],
    derivation: {
      ruleId: COORDINATE_RULE_ID,
      ruleVersion: COORDINATE_RULE_VERSION,
      inputCandidateIds: [rawCoordinateCandidateId],
    },
    confidence,
    reviewRequired: forceReview || confidence < 0.8,
  };
}

function unresolvedCandidate(entityType: 'FIX' | 'NAVAID', entityKey: string, fieldName: string, evidenceId: string): FieldCandidate {
  return {
    candidateId: stableId('candidate', ['unresolved', entityKey, fieldName, evidenceId]),
    entityType,
    entityKey,
    fieldName,
    value: null,
    normalizedValue: null,
    status: 'UNRESOLVED',
    sourceEvidenceIds: [evidenceId],
    confidence: 0,
    reviewRequired: true,
  };
}

function visibleNavaidType(line: string) {
  return line.match(/\b(?:VOR\/DME|VORTAC|TACAN|GP\/DME|ILS|LOC|VOR|DME|NDB)\b/i)?.[0]?.toUpperCase() ?? null;
}

function visibleIdentifier(group: ProcedureGroup, page: PdfPageAsset, prefix: string, entityType: 'FIX' | 'NAVAID') {
  const text = prefix.toUpperCase();
  if (entityType === 'NAVAID') {
    const afterType = text.match(/(?:VOR\/DME|VORTAC|TACAN|GP\/DME|ILS|LOC|VOR|DME|NDB)\s+([A-Z0-9]{2,5})\b/)?.[1];
    const beforeType = text.match(/\b([A-Z0-9]{2,5})\s+(?:VOR\/DME|VORTAC|TACAN|GP\/DME|ILS|LOC|VOR|DME|NDB)\b/)?.[1];
    return normalizeIdentifier(afterType || beforeType);
  }
  const tokens = text.match(/\b[A-Z][A-Z0-9]{1,7}\b/g) ?? [];
  const excluded = excludedIdentifiers(group, page);
  return [...tokens].reverse().find((token) => !excluded.has(token) && !GENERIC_IDENTIFIERS.has(token)) ?? null;
}

const GENERIC_IDENTIFIERS = new Set(['LAT', 'LONG', 'LATITUDE', 'LONGITUDE', 'WAYPOINT', 'COORDINATES', 'FIX', 'IDENT', 'NAME', 'REMARKS', 'NORTH', 'SOUTH', 'EAST', 'WEST']);

function excludedIdentifiers(group: ProcedureGroup, page: PdfPageAsset) {
  return new Set([
    ...(group.procedureNames ?? []),
    ...(page.procedureNames ?? []),
    ...(page.pageClassification?.transitionNames ?? []),
  ].flatMap((value) => value.toUpperCase().match(/[A-Z0-9]+/g) ?? []));
}

function isProcedureOrTransitionName(group: ProcedureGroup, page: PdfPageAsset, identifier: string) {
  return excludedIdentifiers(group, page).has(identifier);
}

function normalizeIdentifier(value: string | null | undefined) {
  const normalized = String(value ?? '').trim().toUpperCase();
  return /^[A-Z][A-Z0-9]{1,7}$/.test(normalized) ? normalized : null;
}

function pageText(page: PdfPageAsset) {
  return page.ocrText || page.textLayerText || '';
}

function safeName(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 80);
}

function hashValue(value: unknown) {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function stableId(prefix: string, value: unknown) {
  return `${prefix}_${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 20)}`;
}
