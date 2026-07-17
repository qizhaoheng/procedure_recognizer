import crypto from 'node:crypto';
import type { PdfPageAsset, ProcedureGroup, ProcedureTask } from '../../../types/procedure';
import { localImageAsDataUrl } from '../../llmService';
import {
  RECOGNITION_V2_CONTRACT_VERSION,
  RECOGNITION_V2_SCHEMA_IDS,
  type ModelExecutionRef,
  type PageLayoutResult,
  type PageLayoutStageResult,
  type PageRegion,
  type PageRole,
} from '../contracts/index';
import {
  assertValidModelPageLayout,
  assertValidPageLayoutResult,
  assertValidPageLayoutStageResult,
  readRecognitionV2Schema,
} from '../contracts/schemaValidation';
import { packagePageNos } from '../orchestration/sourcePackageHash';
import { runVisionStage, type VisionStageClient } from '../orchestration/visionStageClient';
import { readRecognitionV2Prompt } from '../prompts/promptResources';
import { analyzePageLayoutWithRules } from './ruleBasedPageLayout';

const PROMPT_ID = 'v2_page_layout';
const PROMPT_VERSION = '2.0.0-alpha.1';
const MODEL_SCHEMA_ID = 'recognition-v2-model-page-layout.schema.json';

interface ModelLayoutObservation {
  pageNo: number;
  pageRoles: PageRole[];
  regions: Array<Omit<PageRegion, 'regionId' | 'pageNo' | 'reviewRequired'>>;
  warnings: string[];
}

const MODEL_PAGE_ROLES = new Set<PageRole>([
  'PROCEDURE_DIAGRAM', 'PROCEDURE_LEG_TABLE', 'WAYPOINT_COORDINATE_TABLE', 'PROCEDURE_TITLE',
  'PROCEDURE_NOTES', 'PROFILE_VIEW', 'MINIMA_TABLE', 'MSA', 'SUPPORTING_INFORMATION', 'UNKNOWN',
]);

const MODEL_ROLE_ALIASES: Record<string, PageRole> = {
  CHART: 'PROCEDURE_DIAGRAM',
  TITLE: 'PROCEDURE_TITLE',
  NOTES: 'PROCEDURE_NOTES',
  PROCEDURE_TABLE: 'PROCEDURE_LEG_TABLE',
  TABULAR_DESCRIPTION: 'PROCEDURE_LEG_TABLE',
  WAYPOINT_TABLE: 'WAYPOINT_COORDINATE_TABLE',
  COORDINATE_TABLE: 'WAYPOINT_COORDINATE_TABLE',
  AERODROME_DATA_TABLE: 'SUPPORTING_INFORMATION',
  AD_DATA_TABLE: 'SUPPORTING_INFORMATION',
  OPERATIONAL_HOURS_TABLE: 'SUPPORTING_INFORMATION',
};

export interface StageAuditArtifact {
  fileName: string;
  value: unknown;
}

export type StageAuditWriter = (artifact: StageAuditArtifact) => void | Promise<void>;

export interface PageLayoutExecutionResult {
  output: PageLayoutStageResult;
  auditArtifacts: StageAuditArtifact[];
}

export async function executePageLayout(input: {
  task: ProcedureTask;
  group: ProcedureGroup;
  model: string;
  useModel: boolean;
  stageInputHash: string;
  abortSignal?: AbortSignal;
  visionClient?: VisionStageClient;
  onAuditArtifact?: StageAuditWriter;
}): Promise<PageLayoutExecutionResult> {
  const pages = corePages(input.task, input.group);
  const modelEligiblePages = packageSpecificPageNos(input.group);
  if (!pages.length) throw new Error('PAGE_LAYOUT has no package pages to analyze.');
  const systemPrompt = await readRecognitionV2Prompt('page-layout.prompt.md');
  const modelSchema = input.useModel ? await readRecognitionV2Schema(MODEL_SCHEMA_ID) : undefined;
  const visionClient = input.visionClient ?? runVisionStage;
  const results: PageLayoutResult[] = [];
  const auditArtifacts: StageAuditArtifact[] = [];

  for (const page of pages) {
    const rules = analyzePageLayoutWithRules(page);
    if (!input.useModel || !page.imageUrl || !modelEligiblePages.has(page.pageNo)) {
      if (input.useModel && !page.imageUrl) rules.warnings.push('Vision model skipped because this page has no image asset.');
      if (input.useModel && page.imageUrl && !modelEligiblePages.has(page.pageNo)) {
        rules.warnings.push('Vision model intentionally skipped for a generic supporting page; rules-only layout retained.');
      }
      await assertValidPageLayoutResult(rules);
      results.push(rules);
      continue;
    }

    const pageInputHash = hashValue([input.stageInputHash, page.pageNo, rules]);
    const userPrompt = [
      `Page number: ${page.pageNo}`,
      `Required response keys: pageNo, pageRoles, regions, warnings. Region keys: type, bbox, rotationDeg, readingOrder, confidence. Do not return regionId, pageNo or reviewRequired inside regions.`,
      `Allowed role/type values: ${[...MODEL_PAGE_ROLES].join(', ')}.`,
      `Existing non-authoritative rule hints: ${JSON.stringify({ pageRoles: rules.pageRoles, regions: rules.regions.map(modelRegionHint) })}`,
      `Extracted text hint (may be incomplete or wrongly ordered):\n${pageText(page).slice(0, 5000)}`,
    ].join('\n\n');
    const modelResult = await visionClient({
      model: input.model,
      promptId: PROMPT_ID,
      promptVersion: PROMPT_VERSION,
      schemaId: MODEL_SCHEMA_ID,
      schemaVersion: PROMPT_VERSION,
      inputHash: pageInputHash,
      systemPrompt,
      userPrompt,
      responseSchema: modelSchema,
      abortSignal: input.abortSignal,
      images: [{ pageNo: page.pageNo, aipPageNo: page.aipPageNo, role: 'PAGE_LAYOUT', dataUrl: await localImageAsDataUrl(page.imageUrl) }],
    });
    const auditArtifact = { fileName: `page-layout-model-page-${page.pageNo}.json`, value: modelResult.audit };
    if (input.onAuditArtifact) await input.onAuditArtifact(auditArtifact);
    else auditArtifacts.push(auditArtifact);
    const normalizedModelResult = normalizeModelLayoutObservation(modelResult.parsedJson);
    await assertValidModelPageLayout(normalizedModelResult);
    const observation = normalizedModelResult as ModelLayoutObservation;
    if (observation.pageNo !== page.pageNo) throw new Error(`Layout model returned page ${observation.pageNo} for page ${page.pageNo}.`);
    const merged = mergeLayout(rules, observation, modelResult.execution);
    await assertValidPageLayoutResult(merged);
    results.push(merged);
  }

  const output: PageLayoutStageResult = {
    contractVersion: RECOGNITION_V2_CONTRACT_VERSION,
    schemaId: RECOGNITION_V2_SCHEMA_IDS.pageLayoutStageResult,
    pages: results.sort((a, b) => a.pageNo - b.pageNo),
    warnings: [...new Set(results.flatMap((page) => page.warnings.map((warning) => `Page ${page.pageNo}: ${warning}`)))],
    completedAt: new Date().toISOString(),
  };
  await assertValidPageLayoutStageResult(output);
  return { output, auditArtifacts };
}

function modelRegionHint(region: PageRegion) {
  return {
    type: region.type,
    bbox: region.bbox,
    rotationDeg: region.rotationDeg,
    readingOrder: region.readingOrder,
    confidence: region.confidence,
  };
}

export function normalizeModelLayoutObservation(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const source = value as Record<string, unknown>;
  if (!Array.isArray(source.regions)) return value;
  let normalized = !Array.isArray(source.pageRoles) || !Array.isArray(source.warnings);
  const regions = source.regions.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    const region = item as Record<string, unknown>;
    const type = normalizeModelRole(region.type);
    normalized ||= type !== region.type || Object.keys(region).some((key) => !['type', 'bbox', 'rotationDeg', 'readingOrder', 'confidence'].includes(key));
    return {
      type,
      bbox: region.bbox,
      rotationDeg: region.rotationDeg,
      readingOrder: region.readingOrder,
      confidence: region.confidence,
    };
  });
  const hasSuppliedRoles = Array.isArray(source.pageRoles);
  const suppliedRoles = hasSuppliedRoles ? source.pageRoles as unknown[] : [];
  const pageRoles = [...new Set((hasSuppliedRoles ? suppliedRoles : regions.map((region) =>
    region && typeof region === 'object' && !Array.isArray(region) ? (region as Record<string, unknown>).type : undefined))
    .map(normalizeModelRole)
    .filter((role): role is PageRole => typeof role === 'string'))];
  const warnings = Array.isArray(source.warnings) ? source.warnings.filter((item): item is string => typeof item === 'string') : [];
  if (normalized) warnings.push('Compatible model layout fields were normalized to the current V2 contract before validation.');
  return {
    pageNo: source.pageNo,
    pageRoles: hasSuppliedRoles ? pageRoles : pageRoles.length ? pageRoles : ['UNKNOWN'],
    regions,
    warnings: [...new Set(warnings)],
  };
}

function normalizeModelRole(value: unknown): unknown {
  const role = String(value ?? '').trim().toUpperCase();
  if (MODEL_PAGE_ROLES.has(role as PageRole)) return role as PageRole;
  return MODEL_ROLE_ALIASES[role] ?? value;
}

function mergeLayout(rules: PageLayoutResult, model: ModelLayoutObservation, execution: ModelExecutionRef): PageLayoutResult {
  const warnings = [...rules.warnings, ...model.warnings];
  const regions: PageRegion[] = model.regions
    .filter((region) => positiveArea(region.bbox))
    .map((region, index) => ({
      ...region,
      regionId: `p${rules.pageNo}-vision-${index + 1}`,
      pageNo: rules.pageNo,
      reviewRequired: region.confidence < 0.75,
    }));
  if (regions.length !== model.regions.length) warnings.push('One or more zero-area model regions were rejected.');
  const modelRoles = new Set(model.pageRoles);
  for (const ruleRegion of rules.regions) {
    if (ruleRegion.type === 'UNKNOWN' || modelRoles.has(ruleRegion.type)) continue;
    regions.push({ ...ruleRegion, regionId: `${ruleRegion.regionId}-unconfirmed`, reviewRequired: true });
    warnings.push(`Rule-detected role ${ruleRegion.type} was not confirmed by the vision model.`);
  }
  const pageRoles: PageRole[] = [...new Set(regions.map((region) => region.type).filter((role) => role !== 'UNKNOWN'))];
  if (!pageRoles.length) pageRoles.push('UNKNOWN');
  return {
    ...rules,
    pageRoles,
    regions: regions.length ? regions : rules.regions,
    analysisMethod: 'HYBRID',
    warnings: [...new Set(warnings)],
    modelExecution: execution,
  };
}

function corePages(task: ProcedureTask, group: ProcedureGroup) {
  const coreNos = new Set([
    ...(group.chartPages ?? []),
    ...(group.tabularPages ?? []),
    ...(group.coordinatePages ?? []),
    ...(group.minimaPages ?? []),
    ...(group.textSupplementPages ?? []),
    ...(group.supportingPages ?? []),
  ]);
  const fallback = coreNos.size ? coreNos : new Set(packagePageNos(group));
  return task.pages.filter((page) => fallback.has(page.pageNo)).sort((a, b) => a.pageNo - b.pageNo);
}

function packageSpecificPageNos(group: ProcedureGroup) {
  return new Set([
    ...(group.chartPages ?? []),
    ...(group.tabularPages ?? []),
    ...(group.coordinatePages ?? []),
    ...(group.minimaPages ?? []),
    ...(group.textSupplementPages ?? []),
  ]);
}

function pageText(page: PdfPageAsset) {
  return page.ocrText || page.textLayerText || '';
}

function positiveArea(bbox: [number, number, number, number]) {
  return bbox[2] > bbox[0] && bbox[3] > bbox[1];
}

function hashValue(value: unknown) {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}
