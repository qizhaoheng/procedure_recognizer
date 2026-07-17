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
import { extractProcedureNamesFromText, type ProcedureTitleObservation } from '../identity/procedureTitleParser';
import { readLocalRasterOcrText, recoverLocalRasterProcedureTable } from './localRasterTableRecovery';

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
    const ruleTable = rulePhysicalTable(item.page, item.region);
    let rasterFallback: PhysicalTable | undefined;
    if (input.useModel && item.page.imageUrl && !ruleTable) {
      try {
        rasterFallback = await recoverLocalRasterProcedureTable(item.page);
      } catch (error) {
        warnings.push(`Local raster table hint was unavailable for page ${item.page.pageNo}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (input.useModel && item.page.imageUrl) {
      const modelRegion = rasterFallback?.bbox ? { ...item.region, bbox: rasterFallback.bbox } : item.region;
      try {
        const modelTable = await modelPhysicalTable(input, item.page, modelRegion, auditArtifacts);
        assertRestoredTableQuality(modelTable);
        tables.push(modelTable);
        continue;
      } catch (error) {
        warnings.push(`Vision table restoration was rejected for page ${item.page.pageNo}, region ${item.region.regionId}: ${error instanceof Error ? error.message : String(error)}. Deterministic fallback was used when available.`);
      }
      if (rasterFallback) {
        tables.push(rasterFallback);
        warnings.push(`Local raster OCR recovered the procedure table on page ${item.page.pageNo} after the model result was rejected.`);
        continue;
      }
    }
    if (input.useModel && !item.page.imageUrl) warnings.push(`Vision table restoration skipped for page ${item.page.pageNo}: no image asset.`);
    if (ruleTable) tables.push(ruleTable);
    else warnings.push(`No physical procedure-table rows were recovered from page ${item.page.pageNo}, region ${item.region.regionId}.`);
  }
  const recoveredPageNos = new Set(tables.map((table) => table.pageNo));
  for (const pageNo of input.group.tabularPages ?? []) {
    if (recoveredPageNos.has(pageNo)) continue;
    const page = pageByNo.get(pageNo);
    if (!page) continue;
    const recovered = structuredTextProcedureTables(page, input.group);
    if (!recovered.length) continue;
    tables.push(...recovered);
    recoveredPageNos.add(pageNo);
    warnings.push(`Recovered ${recovered.length} deterministic procedure table section(s) from the text layer on page ${pageNo}.`);
  }
  if (!tables.length) {
    const fallbackPageNos = new Set([
      ...(input.group.chartPages ?? []),
      ...(input.group.tabularPages ?? []),
      ...(input.group.coordinatePages ?? []),
    ]);
    for (const page of input.task.pages.filter((item) => fallbackPageNos.has(item.pageNo) && item.imageUrl)) {
      let recovered: PhysicalTable | undefined;
      try {
        if (pageText(page).trim().length < 200) {
          const rasterText = await readLocalRasterOcrText(page);
          const proseTables = rasterText ? localRasterDmeArcProcedureTables(page, input.group, rasterText) : [];
          if (proseTables.length) {
            tables.push(...proseTables);
            warnings.push(`Local raster OCR materialized ${proseTables.length} DME-arc procedure description(s) from page ${page.pageNo}.`);
            continue;
          }
        }
        recovered = await recoverLocalRasterProcedureTable(page);
      } catch (error) {
        warnings.push(`Local raster OCR was unavailable for page ${page.pageNo}: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      if (!recovered) continue;
      tables.push(recovered);
      warnings.push(`Local raster OCR recovered a procedure table from page ${page.pageNo} because the embedded text layer was incomplete.`);
    }
  }
  if (!regions.length) warnings.push('No PROCEDURE_LEG_TABLE region is available; no leg values were guessed from the chart.');

  const tableTitles = new Map<number, ProcedureTitleObservation>();
  for (const pageNo of new Set(tables.map((table) => table.pageNo))) {
    const page = pageByNo.get(pageNo);
    if (!page) continue;
    let sourceText = pageText(page);
    if (page.imageUrl && sourceText.trim().length < 200) {
      try {
        sourceText = (await readLocalRasterOcrText(page)) || sourceText;
      } catch {
        // Table recovery already records OCR failures; title association remains unresolved.
      }
    }
    const title = extractProcedureNamesFromText(sourceText)[0];
    if (title) tableTitles.set(pageNo, title);
  }

  const extraction = semanticCandidates(input.task, input.group, input.layout, tables, tableTitles);
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

function assertRestoredTableQuality(table: PhysicalTable) {
  const dataRows = table.rows.filter((row) => row.rowType === 'DATA');
  const headerRows = table.rows.filter((row) => row.rowType === 'HEADER');
  if (table.columnCount < 2 || !headerRows.length || !dataRows.length || dataRows.every((row) => row.cells.length < 2)) {
    throw new Error('Model output does not contain a credible multi-column header and data row structure');
  }
}

function structuredTextProcedureTables(page: PdfPageAsset, group: ProcedureGroup): PhysicalTable[] {
  const lines = pageText(page).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const sections: PhysicalTable[] = [];
  for (let titleIndex = 0; titleIndex < lines.length; titleIndex += 1) {
    const title = lines[titleIndex].match(/^(.{2,80}?RNP-APCH\s+RWY\s*([0-9]{2}[LCR]?))\s*[-\u2013\u2014]\s*APPROACH\s+FROM\s+([A-Z0-9]{2,8})$/i);
    if (!title) continue;
    const nextTitle = lines.findIndex((line, index) => index > titleIndex && (/RNP-APCH\s+RWY/i.test(line) || /^WAYPOINT\s+COORDINATES$/i.test(line)));
    const end = nextTitle < 0 ? lines.length : nextTitle;
    const tokens = lines.slice(titleIndex + 1, end);
    const rows: string[][] = [];
    for (let index = 0; index + 11 <= tokens.length;) {
      if (!explicitPathTerminator(tokens[index])) {
        index += 1;
        continue;
      }
      const values = tokens.slice(index, index + 11);
      if (!identifier(values[1]) || !/^(?:RNP\s*APCH|RNAV\s*\d*)$/i.test(values[10])) {
        index += 1;
        continue;
      }
      rows.push(values);
      index += 11;
    }
    if (rows.length < 2) continue;
    const procedureName = group.procedureNames[0] || `RNP RWY${title[2].toUpperCase()}`;
    const transitionName = title[3].toUpperCase();
    const region = fullPageTableRegion(page.pageNo, `p${page.pageNo}-structured-${transitionName.toLowerCase()}`);
    const headers = ['Procedure Name', 'Transition Name', 'Path Terminator', 'Waypoint Name', 'Fly-Over', 'Course', 'Magnetic Variation', 'Distance (NM)', 'Turn Direction', 'Altitude', 'Speed Limit', 'VPA/TCH', 'Navigation Spec'];
    const tableId = stableId('table', ['structured-approach-description', page.pageNo, transitionName, rows]);
    sections.push({
      tableId,
      pageNo: page.pageNo,
      regionId: region.regionId,
      bbox: region.bbox,
      columnCount: headers.length,
      rows: [
        physicalRow(tableId, 0, 'HEADER', headers, 0.99, false),
        ...rows.map((values, rowIndex) => physicalRow(tableId, rowIndex + 1, 'DATA', [procedureName, transitionName, ...values], 0.97, false)),
      ],
      analysisMethod: 'TEXT_RULES',
      warnings: ['Recovered a complete 11-column approach table section from an explicit publisher text stream.'],
    });
    titleIndex = end - 1;
  }
  return sections;
}

function localRasterDmeArcProcedureTables(page: PdfPageAsset, group: ProcedureGroup, rawText: string): PhysicalTable[] {
  const text = normalizeDmeArcOcr(rawText);
  const pattern = /(?:ARRIVAL\s+VIA\s+[A-Z0-9]+\s+TO|OVER)\s+([A-Z0-9]{2,8})\s*[,\s]*THEN\s+TRACK\s+INBOUND\s+ON\s+RDL\s*-?\s*(\d{3})\s+([A-Z0-9]{2,5})\s+VOR[\s\S]{0,180}?AT\s+(\d{1,2})\s+DME\s+\3\s+VOR[.\s,]*TURN\s+(LEFT|RIGHT)\s+TO\s+JOIN\s+(\d{1,2})\s+DME\s+ARC\s+\3\s+VOR[\s\S]{0,120}?THEN\s+TURN\s+(LEFT|RIGHT)\s+TO\s+INTERCEPT\s+RDL\s*-?\s*(\d{3})\s+\3\s+VOR/gi;
  const rows = [...text.matchAll(pattern)];
  if (rows.length < 2) return [];
  const headers = ['Procedure Name', 'Transition Name', 'Path Terminator', 'From Fix', 'Waypoint Name', 'Course', 'Distance (NM)', 'Turn Direction', 'Recommended Navaid', 'Arc Center', 'Radius (NM)', 'Navigation Spec'];
  return rows.map((match) => {
    const arrivalFix = match[1].toUpperCase();
    const entryRadial = match[2];
    const center = match[3].toUpperCase();
    const entryDistance = Number(match[4]);
    const joinTurn = match[5].toUpperCase() === 'LEFT' ? 'L' : 'R';
    const radiusNm = Number(match[6]);
    const arcTurn = match[7].toUpperCase() === 'LEFT' ? 'L' : 'R';
    const exitRadial = match[8];
    const entry13 = dmeFix(entryRadial, entryDistance, center);
    const entryArc = dmeFix(entryRadial, radiusNm, center);
    const exitArc = dmeFix(exitRadial, radiusNm, center);
    const procedureName = group.procedureNames.find((name) => name.toUpperCase().startsWith(arrivalFix)) || `${arrivalFix} 1G`;
    const inboundCourse = String((Number(entryRadial) + 180) % 360).padStart(3, '0');
    const values = [
      [procedureName, arrivalFix, 'IF', '-', arrivalFix, '-', '-', '-', '-', '-', '-', 'DME ARC'],
      [procedureName, arrivalFix, 'CF', arrivalFix, entry13, inboundCourse, '-', joinTurn, center, '-', '-', 'DME ARC'],
      [procedureName, arrivalFix, 'CF', entry13, entryArc, inboundCourse, String(Math.abs(entryDistance - radiusNm)), joinTurn, center, '-', '-', 'DME ARC'],
      [procedureName, arrivalFix, 'AF', entryArc, exitArc, '-', '-', arcTurn, center, center, String(radiusNm), 'DME ARC'],
    ];
    const region = fullPageTableRegion(page.pageNo, `p${page.pageNo}-raster-dme-${arrivalFix.toLowerCase()}`);
    const tableId = stableId('table', ['local-raster-dme-arc-procedure', page.pageNo, arrivalFix, match[0]]);
    return {
      tableId,
      pageNo: page.pageNo,
      regionId: region.regionId,
      bbox: region.bbox,
      columnCount: headers.length,
      rows: [physicalRow(tableId, 0, 'HEADER', headers, 0.9, true), ...values.map((row, index) => physicalRow(tableId, index + 1, 'DATA', row, 0.82, true))],
      analysisMethod: 'TEXT_RULES' as const,
      warnings: ['Materialized a publisher prose DME-arc description from local raster OCR; all rows require human review before release.'],
    };
  });
}

function normalizeDmeArcOcr(value: string) {
  return value
    .replace(/\bVJ\s+B\b/gi, 'VJB')
    .replace(/\bRDL\s*[-.]?\s*(\d{3})/gi, 'RDL-$1')
    .replace(/\b(\d)\s+(\d)\s+DME\b/gi, '$1$2 DME')
    .replace(/\bNTE\s+RCEPT\b/gi, 'INTERCEPT')
    .replace(/\bAP\s+PROACH\b/gi, 'APPROACH')
    .replace(/[|\uFF0C\u3002]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function dmeFix(radial: string, distanceNm: number, center: string) {
  return `RDL${radial}_${distanceNm}DME_${center}`;
}

function fullPageTableRegion(pageNo: number, regionId: string): PageRegion {
  return { regionId, pageNo, type: 'PROCEDURE_LEG_TABLE', bbox: [0, 0, 1, 1], rotationDeg: 0, readingOrder: 0, confidence: 0.9, reviewRequired: false };
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
      `Required top-level keys: pageNo, regionId, columnCount, rows, warnings.`,
      `Every row requires rowIndex, uppercase rowType (HEADER, DATA, CONTINUATION, or NOTE), rawText, cells, and confidence.`,
      `Every cell requires columnIndex, rowSpan, columnSpan, rawText, and confidence. bbox is optional and, if present, every coordinate must be between 0 and 1.`,
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
  const structured = structuredTabularDescription(page, region, sourceLines);
  if (structured) return structured;
  if (page.chartRole === 'CHART') return undefined;
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

const TABULAR_COLUMNS = [
  'Path Terminator',
  'Waypoint Name',
  'Fly-Over',
  'Course',
  'Distance (NM)',
  'Turn Direction',
  'Altitude',
  'Speed Limit',
  'Navigation Spec',
] as const;

/**
 * AIP publishers often expose the visual row-major table as a clean stream of
 * nine text tokens. Recover that physical structure only when every row starts
 * with an explicit ARINC path terminator and all nine columns are present.
 */
function structuredTabularDescription(page: PdfPageAsset, region: PageRegion, lines: string[]): PhysicalTable | undefined {
  const marker = lines.findIndex((line) => /^TABULAR\s+DESCRIPTIONS?$/i.test(line));
  if (marker < 0) return undefined;
  const stopPatterns = [
    /^RADIO\s+COMMUNICATIONS?\s+FAILURE/i,
    /^COMMUNICATIONS?\s+FAILURE/i,
    /^MISSED\s+APPROACH/i,
  ];
  const tokens: string[] = [];
  for (const line of lines.slice(marker + 1)) {
    if (stopPatterns.some((pattern) => pattern.test(line))) break;
    tokens.push(line);
  }
  const rows: string[][] = [];
  for (let index = 0; index + TABULAR_COLUMNS.length <= tokens.length;) {
    if (!explicitPathTerminator(tokens[index])) {
      index += 1;
      continue;
    }
    const values = tokens.slice(index, index + TABULAR_COLUMNS.length);
    if (!identifier(values[1]) || !courseValue(values[3]) || !distanceValue(values[4])) {
      index += 1;
      continue;
    }
    rows.push(values);
    index += TABULAR_COLUMNS.length;
  }
  if (rows.length < 2) return undefined;
  const tableId = stableId('table', ['structured-tabular-description', page.pageNo, region.regionId, rows]);
  const physicalRows: PhysicalTableRow[] = [
    physicalRow(tableId, 0, 'HEADER', [...TABULAR_COLUMNS], 0.98, false),
    ...rows.map((values, index) => physicalRow(tableId, index + 1, 'DATA', values, 0.94, false)),
  ];
  return {
    tableId,
    pageNo: page.pageNo,
    regionId: region.regionId,
    bbox: region.bbox,
    columnCount: TABULAR_COLUMNS.length,
    rows: physicalRows,
    analysisMethod: 'TEXT_RULES',
    warnings: ['Recovered an exact 9-column Tabular Descriptions token stream; row order remains auditable as a deterministic derivation.'],
  };
}

function physicalRow(tableId: string, rowIndex: number, rowType: PhysicalTableRowType, values: string[], confidence: number, reviewRequired: boolean): PhysicalTableRow {
  return {
    rowId: `${tableId}:row:${rowIndex}`,
    rowIndex,
    rowType,
    rawText: values.join(' | '),
    confidence,
    reviewRequired,
    cells: values.map((rawText, columnIndex) => ({
      cellId: `${tableId}:row:${rowIndex}:cell:${columnIndex}`,
      rowIndex,
      columnIndex,
      rowSpan: 1,
      columnSpan: 1,
      rawText,
      confidence,
      reviewRequired,
    })),
  };
}

function courseValue(value: string) {
  return /^\d{1,3}(?:\.\d+)?(?:\(\d{1,3}(?:\.\d+)?\))?$/.test(value.trim());
}

function distanceValue(value: string) {
  return /^\d+(?:\.\d+)?$/.test(value.trim());
}

function semanticCandidates(
  task: ProcedureTask,
  group: ProcedureGroup,
  layout: PageLayoutStageResult,
  tables: PhysicalTable[],
  tableTitles: Map<number, ProcedureTitleObservation>,
): ExtractionStageResult & { taskType: 'PROCEDURE_TABLE' } {
  const pageByNo = new Map(task.pages.map((page) => [page.pageNo, page]));
  const evidence: SourceEvidence[] = [];
  const candidates: FieldCandidate[] = [];
  const warnings: string[] = [];
  for (const table of tables) {
    const page = pageByNo.get(table.pageNo);
    const headers = headerByColumn(table.rows);
    const dataRows = table.rows.filter((item) => item.rowType === 'DATA' || item.rowType === 'CONTINUATION');
    for (const [dataIndex, row] of dataRows.entries()) {
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
      const tableTitle = tableTitles.get(table.pageNo);
      if (tableTitle) {
        const titleEvidenceId = stableId('evidence', ['procedure-table-title', table.pageNo, tableTitle.name, tableTitle.rawText]);
        if (!evidence.some((item) => item.evidenceId === titleEvidenceId)) {
          evidence.push({
            evidenceId: titleEvidenceId,
            fileName: page?.sourceFileName || task.fileName,
            pageNo: table.pageNo,
            aipPageNo: page?.aipPageNo,
            sourceType: 'PROCEDURE_TITLE',
            rawText: tableTitle.rawText,
            extractionTask: 'PROCEDURE_TABLE',
            confidence: 0.88,
            status: 'OBSERVED',
          });
        }
        candidates.push(candidate(entityKey, 'procedureName', tableTitle.name, tableTitle.name, titleEvidenceId, 0.88, false));
        seenFields.add('procedureName');
      }
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
        const unreadableFieldName = cell.rawText === '[UNREADABLE]' ? fieldNameForHeader(headers.get(cell.columnIndex)) : undefined;
        if (unreadableFieldName && !seenFields.has(unreadableFieldName)) {
          seenFields.add(unreadableFieldName);
          candidates.push(candidate(entityKey, unreadableFieldName, null, null, cellEvidenceId, 0, true, 'UNRESOLVED'));
        }
      }
      addRegexCandidates(row.rawText, entityKey, evidenceId, row.confidence, candidates, seenFields);
      if (!seenFields.has('pathTerminator')) {
        candidates.push(candidate(entityKey, 'pathTerminator', null, null, evidenceId, row.confidence, true, 'UNRESOLVED'));
      }
      const rowInputs = candidates
        .filter((item) => item.entityKey === entityKey && ['pathTerminator', 'toFix'].includes(item.fieldName) && item.status !== 'UNRESOLVED')
        .map((item) => item.candidateId);
      if (rowInputs.length) {
        const sequence = (dataIndex + 1) * 10;
        candidates.push({
          candidateId: stableId('candidate', ['derived-row-sequence', entityKey, sequence, rowInputs]),
          entityType: 'LEG',
          entityKey,
          fieldName: 'sequence',
          value: sequence,
          normalizedValue: sequence,
          status: 'DERIVED',
          sourceEvidenceIds: [evidenceId],
          derivation: {
            ruleId: 'PHYSICAL_TABLE_ROW_ORDER_TO_SEQUENCE',
            ruleVersion: '1.0.0',
            inputCandidateIds: rowInputs,
          },
          confidence: row.confidence,
          reviewRequired: row.reviewRequired,
        });
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

function fieldNameForHeader(header: string | undefined) {
  if (!header) return undefined;
  if (/DIST|LENGTH/.test(header)) return 'distanceNm';
  if (/PATH|TERMINATOR|LEG TYPE/.test(header)) return 'pathTerminator';
  if (/WAYPOINT|FIX|IDENT/.test(header)) return 'toFix';
  return undefined;
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
  const rfGeometry = raw.match(/\bRF\s*(?:ARC\s*)?CENT(?:RE|ER)\s*:?\s*([A-Z0-9]{2,8})\b[^\r\n]*?\bR\s*=\s*(\d+(?:\.\d+)?)(?:\s*NM\b)?/i);
  if (rfGeometry) {
    addText('pathTerminator', 'RF');
    addText('centerFix', rfGeometry[1].toUpperCase());
    addNumeric('radiusNm', rfGeometry[2], 'NM');
  }
  if (/PROCEDURE\s+NAME/.test(header)) addText('procedureName', raw.toUpperCase());
  else if (/TRANSITION\s+NAME/.test(header)) addText('transitionName', raw.toUpperCase());
  else if (/SEQ|SEQUENCE|NO\.?$/.test(header)) addNumeric('sequence', raw, undefined);
  else if (/PATH|TERMINATOR|LEG TYPE/.test(header)) addText('pathTerminator', explicitPathTerminator(raw));
  else if (/FROM\s+(?:WAYPOINT|FIX)|FROM\s+FIX/.test(header)) addText('fromFix', identifier(raw));
  else if (/WAYPOINT|FIX|IDENT/.test(header)) addText('toFix', identifier(raw));
  else if (/COURSE|TRACK|BEARING/.test(header)) {
    const pair = coursePair(raw);
    if (pair.magnetic !== undefined) addNumericValue('courseDegMag', pair.magnetic, 'deg');
    if (pair.true !== undefined) addNumericValue('courseDegTrue', pair.true, 'deg');
  }
  else if (/MAGNETIC\s+VARIATION|MAG\s+VAR/.test(header)) {
    const magneticCourse = selectedNumber('courseDegMag');
    const trueCourse = selectedNumber('courseDegTrue');
    const courseDerived = magneticCourse !== undefined && trueCourse !== undefined
      ? ((magneticCourse - trueCourse + 540) % 360) - 180
      : undefined;
    const parsed = magneticVariation(raw);
    // Raster OCR occasionally reverses "3 0" into "0 3". The two clearly
    // printed course values provide an independent deterministic checksum.
    const variation = courseDerived !== undefined && Math.abs(courseDerived) <= 30 ? courseDerived : parsed;
    if (variation !== undefined) addNumericValue('magneticVariationDeg', variation, 'deg');
  }
  else if (/DIST|LENGTH/.test(header)) addNumeric('distanceNm', raw, 'NM');
  else if (/ALT|LEVEL/.test(header)) addText('altitudeConstraint', raw);
  else if (/SPEED|KIAS/.test(header)) addNumeric('speedLimitKias', raw, 'KIAS');
  else if (/TURN/.test(header)) addText('turnDirection', turnDirection(raw));
  else if (/ARC\s+CENTER|CENT(?:RE|ER)\s+FIX/.test(header)) addText('centerFix', identifier(raw));
  else if (/RADIUS/.test(header)) addNumeric('radiusNm', raw, 'NM');
  else if (/NAVAID|VOR|DME|RECOMMENDED/.test(header)) addText('recommendedNavaid', identifier(raw));
  else if (/NAVIGATION\s+SPEC/.test(header)) addText('navigationSpecification', raw === '-' ? undefined : raw.toUpperCase());
  else if (/FLY-?OVER/.test(header)) addText('flyOver', /^(?:Y|YES)$/i.test(raw) ? 'Y' : /^(?:N|NO|-)$/.test(raw.toUpperCase()) ? 'N' : undefined);

  function addText(fieldName: string, value: string | undefined) {
    if (!value || seen.has(fieldName)) return;
    seen.add(fieldName);
    candidates.push(candidate(entityKey, fieldName, raw, value, evidenceId, Math.min(confidence, cell.confidence), cell.reviewRequired));
  }
  function addNumeric(fieldName: string, value: string, unit: string | undefined) {
    const parsed = Number(value.match(/-?\d+(?:\.\d+)?/)?.[0]);
    if (!Number.isFinite(parsed)) return;
    addNumericValue(fieldName, parsed, unit);
  }
  function addNumericValue(fieldName: string, parsed: number, unit: string | undefined) {
    if (!Number.isFinite(parsed) || seen.has(fieldName)) return;
    seen.add(fieldName);
    candidates.push(candidate(entityKey, fieldName, raw, parsed, evidenceId, Math.min(confidence, cell.confidence), cell.reviewRequired, 'OBSERVED', unit));
  }
  function selectedNumber(fieldName: string) {
    const value = [...candidates].reverse().find((item) => item.entityKey === entityKey && item.fieldName === fieldName)?.normalizedValue;
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  }
}

function coursePair(value: string) {
  const numbers = [...value.matchAll(/\d{1,3}(?:\.\d+)?/g)]
    .map((match) => Number(match[0]))
    .filter((number) => Number.isFinite(number) && number >= 0 && number <= 360);
  return { magnetic: numbers[0], true: numbers[1] };
}

function magneticVariation(value: string) {
  const normalized = value.toUpperCase().replace(/(\d)\s+(\d)\b/, '$1.$2');
  const magnitude = Number(normalized.match(/\d{1,2}(?:\.\d+)?/)?.[0]);
  if (!Number.isFinite(magnitude) || magnitude > 30) return undefined;
  if (/E\b/.test(normalized)) return -magnitude;
  if (/W\b/.test(normalized)) return magnitude;
  if (normalized.includes('-')) return -magnitude;
  return magnitude;
}

function addRegexCandidates(
  rawText: string,
  entityKey: string,
  evidenceId: string,
  confidence: number,
  candidates: FieldCandidate[],
  seen: Set<string>,
) {
  const rfGeometry = rawText.match(/\bRF\s*(?:ARC\s*)?CENT(?:RE|ER)\s*:?\s*([A-Z0-9]{2,8})\b[^\r\n]*?\bR\s*=\s*(\d+(?:\.\d+)?)(?:\s*NM\b)?/i);
  if (rfGeometry) {
    addText('pathTerminator', 'RF');
    addText('centerFix', rfGeometry[1]);
    addNumber('radiusNm', rfGeometry[2], 'NM');
  }
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
  const normalized = value.trim().toUpperCase()
    .replace(/^H\s*(\d{3})\s*H$/, 'HH$1')
    .replace(/\s+/g, '');
  if (/^RDL\d{3}_\d{1,2}DME_[A-Z0-9]{2,5}$/.test(normalized)) return normalized;
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
