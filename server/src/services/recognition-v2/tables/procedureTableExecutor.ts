import crypto from 'node:crypto';
import type { PdfPageAsset, ProcedureGroup, ProcedureTask } from '../../../types/procedure';
import {
  RECOGNITION_V2_CONTRACT_VERSION,
  RECOGNITION_V2_SCHEMA_IDS,
  type ExtractionStageResult,
  type FieldCandidate,
  type ModelExecutionRef,
  type PageLayoutStageResult,
  type PageRegion,
  type PhysicalTable,
  type PhysicalTableCell,
  type PhysicalTableRow,
  type PhysicalTableRowType,
  type ProcedureTableStageResult,
  type SourceEvidence,
} from '../contracts/index';
import {
  assertValidExtractionStageResult,
  assertValidModelTablePhysical,
  assertValidProcedureTableStageResult,
  readRecognitionV2Schema,
} from '../contracts/schemaValidation';
import { renderDynamicRegionCrop } from '../layout/dynamicRegionCrop';
import type { StageAuditArtifact, StageAuditWriter } from '../layout/pageLayoutExecutor';
import { runVisionStage, type VisionStageClient } from '../orchestration/visionStageClient';
import { readRecognitionV2Prompt } from '../prompts/promptResources';

const PROMPT_ID = 'v2_procedure_table_physical';
const PROMPT_VERSION = '2.0.0-alpha.1';
const MODEL_SCHEMA_ID = 'recognition-v2-model-table-physical.schema.json';
const PATH_TERMINATORS = ['AF', 'CA', 'CD', 'CF', 'CI', 'CR', 'DF', 'FA', 'FC', 'FD', 'FM', 'HA', 'HF', 'HM', 'IF', 'PI', 'RF', 'TF', 'VA', 'VD', 'VI', 'VM', 'VR'] as const;

interface ModelPhysicalTable {
  pageNo: number;
  regionId: string;
  columnCount: number;
  rows: Array<{
    rowIndex: number;
    rowType: PhysicalTableRowType;
    rawText: string;
    confidence: number;
    cells: Array<{
      columnIndex: number;
      rowSpan: number;
      columnSpan: number;
      rawText: string;
      bbox?: [number, number, number, number];
      confidence: number;
    }>;
  }>;
  warnings: string[];
}

export interface ProcedureTableExecutionResult {
  output: ProcedureTableStageResult;
  auditArtifacts: StageAuditArtifact[];
}

export async function executeProcedureTable(input: {
  task: ProcedureTask;
  group: ProcedureGroup;
  layout: PageLayoutStageResult;
  model: string;
  useModel: boolean;
  stageInputHash: string;
  abortSignal?: AbortSignal;
  visionClient?: VisionStageClient;
  onAuditArtifact?: StageAuditWriter;
}): Promise<ProcedureTableExecutionResult> {
  const pageByNo = new Map(input.task.pages.map((page) => [page.pageNo, page]));
  const regions = input.layout.pages.flatMap((layoutPage) => layoutPage.regions
    .filter((region) => region.type === 'PROCEDURE_LEG_TABLE')
    .map((region) => ({ layoutPage, region, page: pageByNo.get(layoutPage.pageNo) })));
  const tables: PhysicalTable[] = [];
  const auditArtifacts: StageAuditArtifact[] = [];
  const warnings: string[] = [];

  for (const item of regions) {
    if (!item.page) {
      warnings.push(`Table region ${item.region.regionId} references missing page ${item.layoutPage.pageNo}.`);
      continue;
    }
    if (input.useModel && item.page.imageUrl) {
      tables.push(await modelPhysicalTable(input, item.page, item.region, auditArtifacts));
      continue;
    }
    if (input.useModel && !item.page.imageUrl) warnings.push(`Vision table restoration skipped for page ${item.page.pageNo}: no image asset.`);
    const table = rulePhysicalTable(item.page, item.region);
    if (table) tables.push(table);
    else warnings.push(`No physical procedure-table rows were recovered from page ${item.page.pageNo}, region ${item.region.regionId}.`);
  }
  if (!regions.length) warnings.push('No PROCEDURE_LEG_TABLE region is available; no leg values were guessed from the chart.');

  const extraction = semanticCandidates(input.task, input.group, input.layout, tables);
  const completedAt = new Date().toISOString();
  extraction.completedAt = completedAt;
  extraction.warnings = [...new Set([...extraction.warnings, ...warnings])];
  await assertValidExtractionStageResult(extraction);
  const output: ProcedureTableStageResult = {
    contractVersion: RECOGNITION_V2_CONTRACT_VERSION,
    schemaId: RECOGNITION_V2_SCHEMA_IDS.procedureTableStageResult,
    tables,
    extraction,
    warnings: [...new Set([...warnings, ...tables.flatMap((table) => table.warnings)])],
    completedAt,
  };
  await assertValidProcedureTableStageResult(output);
  return { output, auditArtifacts };
}

async function modelPhysicalTable(
  input: Parameters<typeof executeProcedureTable>[0],
  page: PdfPageAsset,
  region: PageRegion,
  auditArtifacts: StageAuditArtifact[],
) {
  const crop = await renderDynamicRegionCrop(page.imageUrl!, region.bbox, region.rotationDeg, 2);
  const systemPrompt = await readRecognitionV2Prompt('procedure-table-physical.prompt.md');
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
      `Page number: ${page.pageNo}`,
      `Region id: ${region.regionId}`,
      `Text-layer hint only (ordering may be wrong):\n${pageText(page).slice(0, 7000)}`,
    ].join('\n\n'),
    responseSchema,
    images: [{ pageNo: page.pageNo, aipPageNo: page.aipPageNo, role: `PROCEDURE_LEG_TABLE:${region.regionId}`, dataUrl: crop.dataUrl }],
    abortSignal: input.abortSignal,
  });
  const auditArtifact = { fileName: `procedure-table-model-page-${page.pageNo}-${safeName(region.regionId)}.json`, value: modelResult.audit };
  if (input.onAuditArtifact) await input.onAuditArtifact(auditArtifact);
  else auditArtifacts.push(auditArtifact);
  await assertValidModelTablePhysical(modelResult.parsedJson);
  const observed = modelResult.parsedJson as ModelPhysicalTable;
  if (observed.pageNo !== page.pageNo || observed.regionId !== region.regionId) {
    throw new Error(`Procedure-table model returned ${observed.pageNo}:${observed.regionId}; expected ${page.pageNo}:${region.regionId}.`);
  }
  assertPhysicalTableCoherence(observed);
  return physicalTableFromModel(observed, region, modelResult.execution);
}

function assertPhysicalTableCoherence(table: ModelPhysicalTable) {
  const rowIndexes = new Set<number>();
  for (const row of table.rows) {
    if (rowIndexes.has(row.rowIndex)) throw new Error(`Procedure-table model returned duplicate row index ${row.rowIndex}.`);
    rowIndexes.add(row.rowIndex);
    const columnIndexes = new Set<number>();
    for (const cell of row.cells) {
      if (cell.columnIndex >= table.columnCount) throw new Error(`Procedure-table model returned cell column ${cell.columnIndex} outside columnCount ${table.columnCount}.`);
      if (columnIndexes.has(cell.columnIndex)) throw new Error(`Procedure-table model returned duplicate column ${cell.columnIndex} in row ${row.rowIndex}.`);
      columnIndexes.add(cell.columnIndex);
      if (cell.bbox && (cell.bbox[2] <= cell.bbox[0] || cell.bbox[3] <= cell.bbox[1])) {
        throw new Error(`Procedure-table model returned a zero-area bbox in row ${row.rowIndex}, column ${cell.columnIndex}.`);
      }
    }
  }
}

function physicalTableFromModel(model: ModelPhysicalTable, region: PageRegion, execution: ModelExecutionRef): PhysicalTable {
  const tableId = stableId('table', ['model', execution.runId, model.pageNo, model.regionId]);
  return {
    tableId,
    pageNo: model.pageNo,
    regionId: model.regionId,
    bbox: region.bbox,
    columnCount: model.columnCount,
    rows: model.rows.sort((a, b) => a.rowIndex - b.rowIndex).map((row) => ({
      rowId: `${tableId}:row:${row.rowIndex}`,
      rowIndex: row.rowIndex,
      rowType: row.rowType,
      rawText: row.rawText,
      confidence: row.confidence,
      reviewRequired: true,
      cells: row.cells.sort((a, b) => a.columnIndex - b.columnIndex).map((cell) => ({
        cellId: `${tableId}:row:${row.rowIndex}:cell:${cell.columnIndex}`,
        rowIndex: row.rowIndex,
        columnIndex: cell.columnIndex,
        rowSpan: cell.rowSpan,
        columnSpan: cell.columnSpan,
        rawText: cell.rawText,
        bbox: cell.bbox ? cropBboxToPageBbox(cell.bbox, region) : undefined,
        confidence: cell.confidence,
        reviewRequired: true,
      })),
    })),
    analysisMethod: 'VISION_MODEL',
    warnings: model.warnings,
    modelExecution: execution,
  };
}

function rulePhysicalTable(page: PdfPageAsset, region: PageRegion): PhysicalTable | undefined {
  const sourceLines = pageText(page).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const selected = sourceLines.filter((line) => isHeaderLine(line) || isDataLine(line) || /^(?:NOTE|REMARK)/i.test(line)).slice(0, 300);
  if (!selected.length) return undefined;
  const tableId = stableId('table', ['rules', page.pageNo, region.regionId, selected]);
  const rows = selected.map((rawText, rowIndex) => {
    const parts = splitCells(rawText);
    const rowType = isHeaderLine(rawText) ? 'HEADER' : /^(?:NOTE|REMARK)/i.test(rawText) ? 'NOTE' : 'DATA';
    const confidence = parts.length > 1 ? 0.66 : 0.5;
    return {
      rowId: `${tableId}:row:${rowIndex}`,
      rowIndex,
      rowType,
      rawText,
      confidence,
      reviewRequired: true,
      cells: parts.map((rawText, columnIndex): PhysicalTableCell => ({
        cellId: `${tableId}:row:${rowIndex}:cell:${columnIndex}`,
        rowIndex,
        columnIndex,
        rowSpan: 1,
        columnSpan: 1,
        rawText,
        confidence,
        reviewRequired: true,
      })),
    } satisfies PhysicalTableRow;
  });
  return {
    tableId,
    pageNo: page.pageNo,
    regionId: region.regionId,
    bbox: region.bbox,
    columnCount: Math.max(...rows.map((row) => row.cells.length)),
    rows,
    analysisMethod: 'TEXT_RULES',
    warnings: ['Text-layer table boundaries are heuristic and require visual confirmation.'],
  };
}

function semanticCandidates(task: ProcedureTask, group: ProcedureGroup, layout: PageLayoutStageResult, tables: PhysicalTable[]): ExtractionStageResult & { taskType: 'PROCEDURE_TABLE' } {
  const pageByNo = new Map(task.pages.map((page) => [page.pageNo, page]));
  const evidence: SourceEvidence[] = [];
  const candidates: FieldCandidate[] = [];
  const warnings: string[] = [];
  for (const table of tables) {
    const page = pageByNo.get(table.pageNo);
    const headers = headerByColumn(table.rows);
    for (const row of table.rows.filter((item) => item.rowType === 'DATA' || item.rowType === 'CONTINUATION')) {
      const evidenceId = stableId('evidence', ['procedure-table', table.tableId, row.rowId, row.rawText]);
      evidence.push({
        evidenceId,
        fileName: page?.sourceFileName || task.fileName,
        pageNo: table.pageNo,
        aipPageNo: page?.aipPageNo,
        regionId: table.analysisMethod === 'VISION_MODEL' ? table.regionId : undefined,
        bbox: table.analysisMethod === 'VISION_MODEL' ? table.bbox : undefined,
        sourceType: table.analysisMethod === 'VISION_MODEL' ? 'PROCEDURE_LEG_TABLE' : 'TEXT_LAYER',
        rawText: row.rawText,
        extractionTask: 'PROCEDURE_TABLE',
        confidence: row.confidence,
        status: 'OBSERVED',
        modelExecution: table.modelExecution,
      });
      const entityKey = `LEG:${group.packageId || group.groupId}:${table.pageNo}:${table.regionId}:${row.rowIndex}`;
      const seenFields = new Set<string>();
      for (const cell of row.cells) {
        let cellEvidenceId = evidenceId;
        if (table.analysisMethod === 'VISION_MODEL' && cell.bbox) {
          cellEvidenceId = stableId('evidence', ['procedure-table-cell', table.tableId, cell.cellId, cell.rawText, cell.bbox]);
          evidence.push({
            evidenceId: cellEvidenceId,
            fileName: page?.sourceFileName || task.fileName,
            pageNo: table.pageNo,
            aipPageNo: page?.aipPageNo,
            regionId: table.regionId,
            bbox: cell.bbox,
            sourceType: 'PROCEDURE_LEG_TABLE',
            rawText: cell.rawText,
            extractionTask: 'PROCEDURE_TABLE',
            confidence: cell.confidence,
            status: 'OBSERVED',
            modelExecution: table.modelExecution,
          });
        }
        addHeaderMappedCandidate(cell, headers.get(cell.columnIndex), entityKey, cellEvidenceId, row.confidence, candidates, seenFields);
      }
      addRegexCandidates(row.rawText, entityKey, evidenceId, row.confidence, candidates, seenFields);
      if (!seenFields.has('pathTerminator')) {
        candidates.push(candidate(entityKey, 'pathTerminator', null, null, evidenceId, row.confidence, true, 'UNRESOLVED'));
      }
    }
  }
  if (!tables.length) warnings.push('No procedure table was recovered; the stage returned no invented leg candidates.');
  const pageNos = [...new Set((tables.length ? tables.map((table) => table.pageNo) : layout.pages.map((page) => page.pageNo)))];
  return {
    contractVersion: RECOGNITION_V2_CONTRACT_VERSION,
    schemaId: RECOGNITION_V2_SCHEMA_IDS.extractionStageResult,
    taskType: 'PROCEDURE_TABLE',
    pageNos,
    regionIds: [...new Set(tables.map((table) => table.regionId))],
    evidence,
    candidates,
    warnings,
    completedAt: new Date().toISOString(),
  };
}

function addHeaderMappedCandidate(
  cell: PhysicalTableCell,
  header: string | undefined,
  entityKey: string,
  evidenceId: string,
  confidence: number,
  candidates: FieldCandidate[],
  seen: Set<string>,
) {
  const raw = cell.rawText.trim();
  if (!raw || !header) return;
  if (/SEQ|SEQUENCE|NO\.?$/.test(header)) addNumeric('sequence', raw, undefined);
  else if (/PATH|TERMINATOR|LEG TYPE/.test(header)) addText('pathTerminator', explicitPathTerminator(raw));
  else if (/WAYPOINT|FIX|IDENT/.test(header)) addText('toFix', identifier(raw));
  else if (/COURSE|TRACK|BEARING/.test(header)) addNumeric('courseDegMag', raw, 'deg');
  else if (/DIST|LENGTH/.test(header)) addNumeric('distanceNm', raw, 'NM');
  else if (/ALT|LEVEL/.test(header)) addText('altitudeConstraint', raw);
  else if (/SPEED|KIAS/.test(header)) addNumeric('speedLimitKias', raw, 'KIAS');
  else if (/TURN/.test(header)) addText('turnDirection', turnDirection(raw));
  else if (/NAVAID|VOR|DME|RECOMMENDED/.test(header)) addText('recommendedNavaid', identifier(raw));

  function addText(fieldName: string, value: string | undefined) {
    if (!value || seen.has(fieldName)) return;
    seen.add(fieldName);
    candidates.push(candidate(entityKey, fieldName, raw, value, evidenceId, Math.min(confidence, cell.confidence), cell.reviewRequired));
  }
  function addNumeric(fieldName: string, value: string, unit: string | undefined) {
    const parsed = Number(value.match(/-?\d+(?:\.\d+)?/)?.[0]);
    if (!Number.isFinite(parsed) || seen.has(fieldName)) return;
    seen.add(fieldName);
    candidates.push(candidate(entityKey, fieldName, raw, parsed, evidenceId, Math.min(confidence, cell.confidence), cell.reviewRequired, 'OBSERVED', unit));
  }
}

function addRegexCandidates(
  rawText: string,
  entityKey: string,
  evidenceId: string,
  confidence: number,
  candidates: FieldCandidate[],
  seen: Set<string>,
) {
  addText('pathTerminator', rawText.match(new RegExp(`\\b(${PATH_TERMINATORS.join('|')})\\b`, 'i'))?.[1]?.toUpperCase());
  addNumber('courseDegMag', rawText.match(/\b(\d{1,3}(?:\.\d+)?)\s*(?:°|DEG|COURSE|TRACK)\b/i)?.[1], 'deg');
  addNumber('distanceNm', rawText.match(/\b(\d+(?:\.\d+)?)\s*NM\b/i)?.[1], 'NM');
  addNumber('speedLimitKias', rawText.match(/\b(\d{2,3})\s*(?:KIAS|KT)\b/i)?.[1], 'KIAS');
  const altitude = rawText.match(/\b(?:AT\s+OR\s+(?:ABOVE|BELOW)\s+)?(?:FL\s*\d{2,3}|\d{3,5}\s*(?:FT|M))\b/i)?.[0];
  addText('altitudeConstraint', altitude);
  const turn = rawText.match(/\b(?:TURN\s+)?(LEFT|RIGHT)\b/i)?.[1];
  addText('turnDirection', turn ? turnDirection(turn) : undefined);

  function addText(fieldName: string, value: string | undefined) {
    if (!value || seen.has(fieldName)) return;
    seen.add(fieldName);
    candidates.push(candidate(entityKey, fieldName, value, value.toUpperCase(), evidenceId, confidence, true));
  }
  function addNumber(fieldName: string, value: string | undefined, unit: string) {
    if (!value || seen.has(fieldName)) return;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return;
    seen.add(fieldName);
    candidates.push(candidate(entityKey, fieldName, value, parsed, evidenceId, confidence, true, 'OBSERVED', unit));
  }
}

function candidate(
  entityKey: string,
  fieldName: string,
  value: unknown,
  normalizedValue: unknown,
  evidenceId: string,
  confidence: number,
  reviewRequired: boolean,
  status: 'OBSERVED' | 'UNRESOLVED' = 'OBSERVED',
  unit?: string,
): FieldCandidate {
  return {
    candidateId: stableId('candidate', [entityKey, fieldName, normalizedValue, evidenceId, status]),
    entityType: 'LEG',
    entityKey,
    fieldName,
    value,
    normalizedValue,
    unit,
    status,
    sourceEvidenceIds: status === 'OBSERVED' ? [evidenceId] : [evidenceId],
    confidence: status === 'UNRESOLVED' ? 0 : confidence,
    reviewRequired: status === 'UNRESOLVED' || reviewRequired || confidence < 0.8,
  };
}

function headerByColumn(rows: PhysicalTableRow[]) {
  const map = new Map<number, string>();
  for (const row of rows.filter((item) => item.rowType === 'HEADER')) {
    for (const cell of row.cells) {
      const prior = map.get(cell.columnIndex);
      map.set(cell.columnIndex, `${prior ?? ''} ${cell.rawText}`.trim().toUpperCase());
    }
  }
  return map;
}

function isHeaderLine(line: string) {
  const matches = line.toUpperCase().match(/\b(?:SEQ(?:UENCE)?|PATH|TERM(?:INATOR)?|WAYPOINT|FIX|IDENT(?:IFIER)?|COURSE|TRACK|DIST(?:ANCE)?|ALT(?:ITUDE)?|SPEED|REMARKS?)\b/g);
  return (matches?.length ?? 0) >= 2;
}

function isDataLine(line: string) {
  return new RegExp(`\\b(?:${PATH_TERMINATORS.join('|')})\\b`, 'i').test(line)
    || /\b\d+(?:\.\d+)?\s*(?:NM|KIAS|FT)\b/i.test(line)
    || /^\s*\d{1,4}\s+/.test(line);
}

function splitCells(line: string) {
  const values = line.split(/\s*\|\s*|\t+|\s{2,}/).map((value) => value.trim()).filter((value) => value.length > 0);
  return values.length ? values : [line];
}

function explicitPathTerminator(value: string) {
  const match = value.trim().toUpperCase().match(new RegExp(`^(?:${PATH_TERMINATORS.join('|')})$`));
  return match?.[0];
}

function identifier(value: string) {
  const normalized = value.trim().toUpperCase();
  return /^[A-Z0-9]{2,8}$/.test(normalized) && /[A-Z]/.test(normalized) ? normalized : undefined;
}

function turnDirection(value: string) {
  const normalized = value.trim().toUpperCase();
  if (/^(?:L|LEFT)$/.test(normalized)) return 'L';
  if (/^(?:R|RIGHT)$/.test(normalized)) return 'R';
  return undefined;
}

function pageText(page: PdfPageAsset) {
  return page.ocrText || page.textLayerText || '';
}

function safeName(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 80);
}

function cropBboxToPageBbox(bbox: [number, number, number, number], region: PageRegion): [number, number, number, number] {
  const corners: Array<[number, number]> = [
    [bbox[0], bbox[1]], [bbox[2], bbox[1]], [bbox[2], bbox[3]], [bbox[0], bbox[3]],
  ];
  const unrotated = corners.map(([x, y]): [number, number] => {
    if (region.rotationDeg === 90) return [y, 1 - x];
    if (region.rotationDeg === 180) return [1 - x, 1 - y];
    if (region.rotationDeg === 270) return [1 - y, x];
    return [x, y];
  });
  const xs = unrotated.map(([x]) => x);
  const ys = unrotated.map(([, y]) => y);
  const width = region.bbox[2] - region.bbox[0];
  const height = region.bbox[3] - region.bbox[1];
  return [
    clamp(region.bbox[0] + Math.min(...xs) * width),
    clamp(region.bbox[1] + Math.min(...ys) * height),
    clamp(region.bbox[0] + Math.max(...xs) * width),
    clamp(region.bbox[1] + Math.max(...ys) * height),
  ];
}

function clamp(value: number) {
  return Math.round(Math.max(0, Math.min(1, value)) * 1e9) / 1e9;
}

function hashValue(value: unknown) {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function stableId(prefix: string, value: unknown) {
  return `${prefix}_${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 20)}`;
}
