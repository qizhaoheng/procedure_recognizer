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
import { readLocalRasterOcrText, recoverLocalRasterWaypointCoordinates } from '../tables/localRasterTableRecovery';
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
  bbox?: [number, number, number, number];
  confidence: number;
  reviewRequired?: boolean;
  sourceType?: SourceEvidence['sourceType'];
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
  for (const page of input.task.pages.filter((item) => (input.group.supportingPages ?? []).includes(item.pageNo))) {
    if (/RADIO\s+NAVIGATION\s+AND\s+LANDING\s+AIDS|\b(?:DVOR\/DME|VOR\/DME|NDB)\b[\s\S]{0,240}\b\d{3}\.\d{1,3}\s*MHZ/i.test(pageText(page))) {
      navaidPages.add(page.pageNo);
    }
  }
  const chartPages = new Set(input.group.chartPages ?? []);
  const allowed = new Map<string, AllowedRegion>();
  for (const layoutPage of input.layout.pages) {
    const page = pageByNo.get(layoutPage.pageNo);
    if (!page) continue;
    for (const region of layoutPage.regions) {
      const printedChartCoordinates = region.type === 'PROCEDURE_DIAGRAM' && chartPages.has(page.pageNo);
      if (region.type !== 'WAYPOINT_COORDINATE_TABLE' && !printedChartCoordinates && !(region.type === 'SUPPORTING_INFORMATION' && navaidPages.has(page.pageNo))) continue;
      allowed.set(`${page.pageNo}:${region.regionId}`, { page, region });
    }
  }
  for (const pageNo of navaidPages) {
    if ([...allowed.values()].some((item) => item.page.pageNo === pageNo)) continue;
    const page = pageByNo.get(pageNo);
    if (!page) continue;
    const region: PageRegion = {
      regionId: `p${pageNo}-supporting-navaid`, pageNo, type: 'SUPPORTING_INFORMATION', bbox: [0, 0, 1, 1],
      rotationDeg: 0, readingOrder: 0, confidence: 0.95, reviewRequired: false,
    };
    allowed.set(`${pageNo}:${region.regionId}`, { page, region });
  }

  const observations: RawObservation[] = [];
  const warnings: string[] = [];
  const processedRulePages = new Set<number>();
  for (const { page, region } of allowed.values()) {
    if (processedRulePages.has(page.pageNo)) continue;
    processedRulePages.add(page.pageNo);
    observations.push(...ruleObservations(input.group, page, region, navaidPages.has(page.pageNo)));
  }
  const rasterCoordinateSources: Array<{ page: PdfPageAsset; text: string }> = [];
  const corePageNos = new Set([...(input.group.chartPages ?? []), ...(input.group.tabularPages ?? []), ...(input.group.coordinatePages ?? [])]);
  for (const page of input.task.pages.filter((item) => corePageNos.has(item.pageNo) && item.imageUrl && pageText(item).trim().length < 200)) {
    try {
      const text = await readLocalRasterOcrText(page);
      if (!text) continue;
      const recovered = localRasterCoordinateObservations(input.group, page, text);
      const gridRows = await recoverLocalRasterWaypointCoordinates(page);
      for (const row of gridRows) {
        if (recovered.some((item) => item.identifier === row.identifier)) continue;
        recovered.push({
          entityType: 'FIX',
          identifier: row.identifier,
          coordinateText: row.coordinateText,
          navaidType: null,
          frequency: null,
          channel: null,
          pageNo: page.pageNo,
          rawText: `${row.identifier} ${row.rawText}`,
          bbox: row.bbox,
          confidence: row.confidence,
          reviewRequired: true,
          sourceType: 'WAYPOINT_COORDINATE_TABLE',
        });
      }
      if (recovered.length) {
        observations.push(...recovered);
        rasterCoordinateSources.push({ page, text });
        warnings.push(`Local raster OCR recovered ${recovered.length} labeled waypoint/navaid coordinate row(s) from page ${page.pageNo}.`);
      }
    } catch (error) {
      warnings.push(`Local raster OCR was unavailable for coordinate page ${page.pageNo}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const auditArtifacts: StageAuditArtifact[] = [];
  if (input.useModel) {
    for (const { page, region } of allowed.values()) {
      // Auto-attached AD 2.19 navaid pages are added for deterministic text
      // extraction. They were not selected by page-layout, so do not spend an
      // extra model call on the synthetic full-page region.
      if (region.regionId === `p${page.pageNo}-supporting-navaid`) continue;
      if (!page.imageUrl) {
        warnings.push(`Vision waypoint/navaid extraction skipped for page ${page.pageNo}: no image asset.`);
        continue;
      }
      try {
        const modelResult = await modelObservations(input, page, region, auditArtifacts);
        observations.push(...modelResult.observations.map((observation) => ({ ...observation, modelExecution: modelResult.execution })));
        warnings.push(...modelResult.warnings);
      } catch (error) {
        warnings.push(`Vision waypoint/navaid extraction was rejected for page ${page.pageNo}, region ${region.regionId}: ${error instanceof Error ? error.message : String(error)}. Deterministic observations were preserved.`);
      }
    }
  }
  if (!allowed.size && !observations.length) warnings.push('No waypoint-coordinate, procedure-diagram, or referenced navaid region is available; no coordinates were guessed.');

  const evidence: SourceEvidence[] = [];
  const candidates: FieldCandidate[] = [];
  observations.forEach((observation, index) => addObservation(input.task, input.group, observation, index, allowed, evidence, candidates, warnings));
  for (const source of rasterCoordinateSources) addDmeRadialFixCandidates(input.task, input.group, source.page, source.text, evidence, candidates, warnings);
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
      'Return exactly this top-level object: {"observations":[{"entityType":"FIX|NAVAID","identifier":null,"coordinateText":null,"navaidType":null,"frequency":null,"channel":null,"pageNo":1,"regionId":"supplied id","rawText":null,"visualDescription":null,"confidence":0.0}],"warnings":[]}.',
      'If no waypoint or navaid evidence is visible, return {"observations":[],"warnings":["No visible waypoint or navaid evidence in this crop."]}. Never return one observation directly at the top level.',
      `Text-layer hint only (may be incomplete):\n${pageText(page).slice(0, 7000)}`,
    ].join('\n\n'),
    responseSchema,
    images: [{ pageNo: page.pageNo, aipPageNo: page.aipPageNo, role: `${region.type}:${region.regionId}`, dataUrl: crop.dataUrl }],
    abortSignal: input.abortSignal,
  });
  const auditArtifact = { fileName: `waypoint-navaid-model-page-${page.pageNo}-${safeName(region.regionId)}.json`, value: modelResult.audit };
  if (input.onAuditArtifact) await input.onAuditArtifact(auditArtifact);
  else auditArtifacts.push(auditArtifact);
  const normalized = normalizeModelWaypointNavaid(modelResult.parsedJson, page.pageNo, region.regionId);
  await assertValidModelWaypointNavaid(normalized);
  const parsed = normalized as ModelWaypointNavaidResult;
  for (const observation of parsed.observations) {
    if (observation.pageNo !== page.pageNo || observation.regionId !== region.regionId) {
      throw new Error(`Waypoint/navaid model returned unprovided region ${observation.pageNo}:${observation.regionId}.`);
    }
  }
  return { ...parsed, execution: modelResult.execution };
}

function normalizeModelWaypointNavaid(value: unknown, pageNo: number, regionId: string): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.observations)) {
    return { ...record, warnings: Array.isArray(record.warnings) ? record.warnings : [] };
  }

  const singletonKeys = ['entityType', 'identifier', 'coordinateText', 'navaidType', 'frequency', 'channel', 'rawText', 'visualDescription'];
  if (!singletonKeys.some((key) => key in record)) return value;
  const rawText = typeof record.rawText === 'string' && record.rawText.trim() ? record.rawText : null;
  const visualDescription = typeof record.visualDescription === 'string' && record.visualDescription.trim() ? record.visualDescription : null;
  const entityType = record.entityType === 'FIX' || record.entityType === 'NAVAID' ? record.entityType : null;
  if (!entityType || (!rawText && !visualDescription)) {
    return {
      observations: [],
      warnings: ['Model returned a singleton with no visible waypoint/navaid evidence; it was treated as an empty observation set.'],
    };
  }
  return {
    observations: [{
      entityType,
      identifier: typeof record.identifier === 'string' ? record.identifier : null,
      coordinateText: typeof record.coordinateText === 'string' ? record.coordinateText : null,
      navaidType: typeof record.navaidType === 'string' ? record.navaidType : null,
      frequency: typeof record.frequency === 'string' ? record.frequency : null,
      channel: typeof record.channel === 'string' ? record.channel : null,
      pageNo: Number.isInteger(record.pageNo) ? record.pageNo : pageNo,
      regionId: typeof record.regionId === 'string' && record.regionId ? record.regionId : regionId,
      rawText,
      visualDescription,
      confidence: typeof record.confidence === 'number' && record.confidence >= 0 && record.confidence <= 1 ? record.confidence : 0.5,
    }],
    warnings: ['A singleton model observation was normalized to the required observations array.'],
  };
}

function ruleObservations(group: ProcedureGroup, page: PdfPageAsset, region: PageRegion, navaidPage: boolean): RawObservation[] {
  const observations: RawObservation[] = [];
  const text = pageText(page);
  const tableObservations = navaidPage ? navaidTableObservations(text, page.pageNo, region.regionId) : [];
  if (tableObservations.length) return tableObservations;
  const coordinates = extractAipCoordinatePairs(text);
  for (const coordinate of coordinates) {
      const prefixLines = text.slice(0, coordinate.startIndex).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      const localPrefix = prefixLines.slice(-4).join(' ');
      const navaidPrefixLines = prefixLines.slice(-12);
      const navaidPrefix = navaidPrefixLines.join(' ');
      const context = `${navaidPage ? navaidPrefix : localPrefix} ${coordinate.rawText}`.replace(/\s+/g, ' ').trim();
      const navaidType = visibleNavaidType(navaidPage ? navaidPrefix : localPrefix);
      const entityType = navaidPage || navaidType ? 'NAVAID' : 'FIX';
      observations.push({
        entityType,
        identifier: entityType === 'NAVAID'
          ? navaidIdentifierFromLines(group, page, navaidPrefixLines)
          : region.type === 'PROCEDURE_DIAGRAM'
            ? visiblePrintedCoordinateIdentifier(prefixLines)
            : visibleIdentifier(group, page, localPrefix, entityType),
        coordinateText: coordinate.rawText,
        navaidType,
        frequency: context.match(/\b\d{3}\.\d{1,3}\s*MHZ\b|\b\d{3,4}\s*KHZ\b/i)?.[0] ?? null,
        channel: context.match(/\bCH\s*\d+[XY]\b/i)?.[0] ?? null,
        pageNo: page.pageNo,
        regionId: region.regionId,
        rawText: context,
        confidence: region.type === 'PROCEDURE_DIAGRAM' ? 0.9 : 0.82,
      });
  }
  if (navaidPage) {
    for (const line of text.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)) {
      const navaidType = visibleNavaidType(line);
      const identifier = navaidType ? visibleIdentifier(group, page, line, 'NAVAID') : null;
      if (navaidType && identifier && !observations.some((item) => item.entityType === 'NAVAID' && item.identifier === identifier)) {
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

function navaidTableObservations(text: string, pageNo: number, regionId: string): RawObservation[] {
  const lines = text.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  const headerPattern = /^([A-Z][A-Z0-9]{1,4})\s+(DVOR\/DME|VOR\/DME|VORTAC|TACAN|GP\/DME|ILS|LOC|VOR|DME|NDB)$/i;
  const rows: Array<{ identifier: string; type: string; text: string }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const header = lines[index].match(headerPattern);
    if (!header) continue;
    let end = index + 1;
    while (end < lines.length && !headerPattern.test(lines[end])) end += 1;
    rows.push({ identifier: header[1].toUpperCase(), type: header[2].toUpperCase(), text: lines.slice(index, end).join(' ') });
    index = end - 1;
  }
  if (!rows.length) return [];

  const grouped = new Map<string, typeof rows>();
  for (const row of rows) grouped.set(row.identifier, [...(grouped.get(row.identifier) ?? []), row]);
  return [...grouped.entries()].map(([identifier, members]) => {
    const rawText = members.map((row) => row.text).join(' | ');
    const coordinates = extractAipCoordinatePairs(rawText);
    const types = [...new Set(members.map((row) => row.type))];
    const combinedType = types.includes('LOC') && types.includes('DME')
      ? 'LOC/DME'
      : types.join('/');
    return {
      entityType: 'NAVAID' as const,
      identifier,
      coordinateText: coordinates.at(-1)?.rawText ?? null,
      navaidType: combinedType,
      frequency: rawText.match(/\b\d{3}\.\d{1,3}\s*MHZ\b|\b\d{3,4}\s*KHZ\b/i)?.[0] ?? null,
      channel: rawText.match(/\bCH\s*\d+[XY]\b/i)?.[0] ?? null,
      pageNo,
      regionId,
      rawText,
      confidence: 0.9,
    };
  });
}

function navaidIdentifierFromLines(group: ProcedureGroup, page: PdfPageAsset, lines: string[]) {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!visibleNavaidType(lines[index])) continue;
    const inline = visibleIdentifier(group, page, lines[index], 'NAVAID');
    if (inline && !GENERIC_IDENTIFIERS.has(inline)) return inline;
    for (const adjacent of lines.slice(index + 1)) {
      const identifier = normalizeIdentifier(adjacent.match(/^([A-Z][A-Z0-9]{1,4})$/i)?.[1]);
      if (identifier && !GENERIC_IDENTIFIERS.has(identifier)) return identifier;
    }
  }
  return visibleIdentifier(group, page, lines.join(' '), 'NAVAID');
}

function visiblePrintedCoordinateIdentifier(prefixLines: string[]) {
  for (const line of [...prefixLines].reverse()) {
    const match = line.trim().toUpperCase().match(/^([A-Z][A-Z0-9]{1,7})(?:\s+\(|$)/);
    const identifier = normalizeIdentifier(match?.[1]);
    if (identifier && !GENERIC_IDENTIFIERS.has(identifier) && !/^(?:FL|A)\d+$/.test(identifier)) return identifier;
  }
  return null;
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
  if (identifier && !observation.coordinateText && isProcedureOrTransitionName(group, page, identifier)) {
    warnings.push(`Rejected ${identifier} as a waypoint/navaid identifier because it is a procedure or transition name.`);
    return;
  }
  const evidenceId = stableId('evidence', ['waypoint-navaid', observation.modelExecution?.runId ?? 'rules', observation.pageNo, observation.regionId, index, observation.rawText, observation.visualDescription]);
  const entityKey = `${observation.entityType}:${identifier || `UNRESOLVED:${observation.pageNo}:${observation.regionId ?? 'text'}:${index}`}`;
  const modelReviewRequired = Boolean(observation.modelExecution) || Boolean(observation.reviewRequired);
  evidence.push({
    evidenceId,
    fileName: page.sourceFileName || task.fileName,
    pageNo: page.pageNo,
    aipPageNo: page.aipPageNo,
    regionId: observation.modelExecution ? observation.regionId : undefined,
    bbox: observation.modelExecution ? allowedRegion?.region.bbox : observation.bbox,
    sourceType: observation.modelExecution ? allowedRegion!.region.type : observation.sourceType ?? 'TEXT_LAYER',
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

function localRasterCoordinateObservations(group: ProcedureGroup, page: PdfPageAsset, rawText: string): RawObservation[] {
  const text = normalizeRasterOcr(rawText);
  if (!/DATA\s+TABULATION/i.test(text) || !/COORDINATES/i.test(text)) return [];
  const labels = ['VJB', ...group.procedureNames.map((name) => name.match(/^([A-Z0-9]{2,8})\b/i)?.[1]?.toUpperCase()).filter((item): item is string => Boolean(item))];
  const labelBlock = text.slice(text.indexOf('WAYPOINT'), text.indexOf('NAVAID FREQUENCY') > 0 ? text.indexOf('NAVAID FREQUENCY') : text.indexOf('COORDINATES'));
  const orderedLabels = [...new Set(labels)]
    .map((identifier) => ({ identifier, index: labelBlock.indexOf(identifier) }))
    .filter((item) => item.index >= 0)
    .sort((a, b) => a.index - b.index)
    .map((item) => item.identifier);
  const coordinateBlock = text.slice(text.indexOf('COORDINATES'));
  const matches = [...coordinateBlock.matchAll(/(\d{2,3})\s*[.\u00b0]\s*(\d{1,2})\s*'\s*(\d{1,2})\s*\.\s*(\d{1,2})\s*"\s*([NSEW])/g)]
    .map((match) => ({
      degrees: Number(match[1]),
      minutes: Number(match[2]),
      seconds: Number(`${match[3]}.${match[4]}`),
      hemisphere: match[5],
      raw: match[0],
    }))
    .filter((item) => item.minutes < 60 && item.seconds < 60);
  const latitudes = matches.filter((item) => /[NS]/.test(item.hemisphere));
  const longitudes = matches.filter((item) => /[EW]/.test(item.hemisphere));
  const count = Math.min(orderedLabels.length, latitudes.length, longitudes.length);
  const observations: RawObservation[] = [];
  for (let index = 0; index < count; index += 1) {
    const identifier = orderedLabels[index];
    const latitude = latitudes[index];
    const longitude = longitudes[index];
    observations.push({
      entityType: identifier === 'VJB' ? 'NAVAID' : 'FIX',
      identifier,
      coordinateText: `${dmsText(latitude)} ${dmsText(longitude)}`,
      navaidType: identifier === 'VJB' ? 'VOR/DME' : null,
      frequency: identifier === 'VJB' ? text.match(/112\s*\.\s*5\s*MHZ/i)?.[0]?.replace(/\s+/g, '') ?? null : null,
      channel: identifier === 'VJB' ? text.match(/CH\s*72X/i)?.[0]?.replace(/\s+/g, '') ?? null : null,
      pageNo: page.pageNo,
      rawText: `${identifier} ${latitude.raw} ${longitude.raw}`,
      confidence: 0.84,
      reviewRequired: true,
      sourceType: 'WAYPOINT_COORDINATE_TABLE',
    });
  }
  return observations;
}

function addDmeRadialFixCandidates(
  task: ProcedureTask,
  group: ProcedureGroup,
  page: PdfPageAsset,
  rawText: string,
  evidence: SourceEvidence[],
  candidates: FieldCandidate[],
  warnings: string[],
) {
  const centerLat = candidates.find((item) => item.entityKey === 'NAVAID:VJB' && item.fieldName === 'latitude' && item.status === 'DERIVED');
  const centerLon = candidates.find((item) => item.entityKey === 'NAVAID:VJB' && item.fieldName === 'longitude' && item.status === 'DERIVED');
  if (!centerLat || !centerLon) return;
  const latitude = Number(centerLat.normalizedValue);
  const longitude = Number(centerLon.normalizedValue);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return;
  const text = normalizeRasterOcr(rawText)
    .replace(/\bVJ\s+B\b/gi, 'VJB')
    .replace(/\bRDL\s*[-.]?\s*(\d{3})/gi, 'RDL-$1')
    .replace(/\b(\d)\s+(\d)\s+DME\b/gi, '$1$2 DME');
  const radials = [...new Set([...text.matchAll(/RDL-(\d{3})\s+VJB/gi)].map((match) => match[1]))];
  const radiusMatch = text.match(/JOIN\s+(\d{1,2})\s+DME\s+ARC\s+VJB/i);
  const entryMatch = text.match(/AT\s+(\d{1,2})\s+DME\s+VJB/i);
  const radiusNm = Number(radiusMatch?.[1]);
  const entryNm = Number(entryMatch?.[1]);
  if (!radials.length || !Number.isFinite(radiusNm) || !Number.isFinite(entryNm)) return;
  const definitions = new Set<string>();
  for (const radial of radials) {
    definitions.add(`${radial}:${radiusNm}`);
    if (radial !== '340') definitions.add(`${radial}:${entryNm}`);
  }
  for (const definition of definitions) {
    const [radialText, distanceText] = definition.split(':');
    const radial = Number(radialText);
    const distanceNm = Number(distanceText);
    const identifier = `RDL${radialText}_${distanceNm}DME_VJB`;
    const point = destinationPoint(latitude, longitude, radial, distanceNm);
    const sourceText = `RDL-${radialText} VJB / ${distanceNm} DME derived from VJB coordinate`;
    const evidenceId = stableId('evidence', ['dme-radial-coordinate', page.pageNo, identifier, sourceText]);
    evidence.push({
      evidenceId,
      fileName: page.sourceFileName || task.fileName,
      pageNo: page.pageNo,
      aipPageNo: page.aipPageNo,
      sourceType: 'WAYPOINT_COORDINATE_TABLE',
      rawText: sourceText,
      extractionTask: 'WAYPOINT_NAVAID',
      confidence: 0.8,
      status: 'OBSERVED',
    });
    const inputs = [centerLat.candidateId, centerLon.candidateId];
    for (const [fieldName, value, unit] of [
      ['identifier', identifier, undefined],
      ['latitude', point.latitude, 'deg'],
      ['longitude', point.longitude, 'deg'],
    ] as const) {
      candidates.push({
        candidateId: stableId('candidate', ['derived-dme-radial-fix', identifier, fieldName, value, inputs]),
        entityType: 'FIX',
        entityKey: `FIX:${identifier}`,
        fieldName,
        value,
        normalizedValue: value,
        unit,
        status: 'DERIVED',
        sourceEvidenceIds: [evidenceId],
        derivation: { ruleId: 'DME_RADIAL_DISTANCE_TO_COORDINATE', ruleVersion: '1.0.0', inputCandidateIds: inputs },
        confidence: 0.8,
        reviewRequired: true,
      });
    }
  }
  warnings.push(`Derived ${definitions.size} VJB radial/DME pseudo-fix coordinate pair(s); magnetic/true-bearing assumptions require review.`);
}

function normalizeRasterOcr(value: string) {
  return value
    .toUpperCase()
    .replace(/\bVJ\s+B\b/g, 'VJB')
    .replace(/\bSAB\s+KA\b/g, 'SABKA')
    .replace(/\u3002/g, '\u00b0')
    .replace(/[\uFF0E\uFF0C\u3001]/g, '.')
    .replace(/\s+/g, ' ')
    .trim();
}

function dmsText(value: { degrees: number; minutes: number; seconds: number; hemisphere: string }) {
  return `${String(value.degrees).padStart(value.hemisphere === 'E' || value.hemisphere === 'W' ? 3 : 2, '0')}\u00b0 ${String(value.minutes).padStart(2, '0')}' ${value.seconds.toFixed(2).padStart(5, '0')}" ${value.hemisphere}`;
}

function destinationPoint(latitude: number, longitude: number, bearingDeg: number, distanceNm: number) {
  const angularDistance = distanceNm / 3440.065;
  const bearing = bearingDeg * Math.PI / 180;
  const lat1 = latitude * Math.PI / 180;
  const lon1 = longitude * Math.PI / 180;
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(angularDistance) + Math.cos(lat1) * Math.sin(angularDistance) * Math.cos(bearing));
  const lon2 = lon1 + Math.atan2(Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(lat1), Math.cos(angularDistance) - Math.sin(lat1) * Math.sin(lat2));
  return { latitude: Math.round(lat2 * 180 / Math.PI * 1e9) / 1e9, longitude: Math.round(lon2 * 180 / Math.PI * 1e9) / 1e9 };
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
  return line.match(/\b(?:DVOR\/DME|VOR\/DME|VORTAC|TACAN|GP\/DME|ILS|LOC|VOR|DME|NDB)\b/i)?.[0]?.toUpperCase() ?? null;
}

function visibleIdentifier(group: ProcedureGroup, page: PdfPageAsset, prefix: string, entityType: 'FIX' | 'NAVAID') {
  const text = prefix.toUpperCase();
  if (entityType === 'NAVAID') {
    const afterType = text.match(/(?:DVOR\/DME|VOR\/DME|VORTAC|TACAN|GP\/DME|ILS|LOC|VOR|DME|NDB)(?:\s+\d{2,3}(?:\.\d+)?)?\s+([A-Z0-9]{2,5})\b/)?.[1];
    const beforeType = text.match(/\b([A-Z0-9]{2,5})\s+(?:DVOR\/DME|VOR\/DME|VORTAC|TACAN|GP\/DME|ILS|LOC|VOR|DME|NDB)\b/)?.[1];
    return normalizeIdentifier(afterType || beforeType);
  }
  const tokens = text.match(/\b[A-Z][A-Z0-9]{1,7}\b/g) ?? [];
  const excluded = excludedIdentifiers(group, page);
  return [...tokens].reverse().find((token) => !excluded.has(token) && !GENERIC_IDENTIFIERS.has(token)) ?? null;
}

const GENERIC_IDENTIFIERS = new Set(['LAT', 'LONG', 'LATITUDE', 'LONGITUDE', 'WAYPOINT', 'COORDINATES', 'FIX', 'IDENT', 'NAME', 'REMARKS', 'NORTH', 'SOUTH', 'EAST', 'WEST', 'IAF', 'IF', 'FAF', 'MAPT', 'THR', 'RWY', 'MHZ', 'KHZ', 'CH', 'H24', 'AIP', 'AD', 'NIL']);

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
