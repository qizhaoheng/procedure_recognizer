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
  type ProcedureTableStageResult,
  type SourceEvidence,
} from '../contracts/index';
import {
  assertValidExtractionStageResult,
  assertValidModelChartTopology,
  readRecognitionV2Schema,
} from '../contracts/schemaValidation';
import { renderDynamicRegionCrop } from '../layout/dynamicRegionCrop';
import type { StageAuditArtifact, StageAuditWriter } from '../layout/pageLayoutExecutor';
import { runVisionStage, type VisionStageClient } from '../orchestration/visionStageClient';
import { readRecognitionV2Prompt } from '../prompts/promptResources';
import { readLocalRasterOcrText } from '../tables/localRasterTableRecovery';

const PROMPT_ID = 'v2_chart_topology';
const PROMPT_VERSION = '2.0.0-alpha.1';
const MODEL_SCHEMA_ID = 'recognition-v2-model-chart-topology.schema.json';
const TABLE_TOPOLOGY_RULE_ID = 'ORDERED_PROCEDURE_TABLE_TO_TOPOLOGY';
const TABLE_TOPOLOGY_RULE_VERSION = '1.0.0';

type TopologyRelation = 'TRACK' | 'ARC' | 'HOLD' | 'VECTOR' | 'MISSED_APPROACH';

interface ModelChartTopology {
  pageNo: number;
  regionId: string;
  nodes: Array<{ identifier: string; nodeType: 'FIX' | 'NAVAID' | 'RUNWAY' | 'PSEUDO'; confidence: number }>;
  edges: Array<{
    fromIdentifier: string | null;
    toIdentifier: string | null;
    relation: TopologyRelation;
    turnDirection: 'L' | 'R' | null;
    centerIdentifier?: string | null;
    radiusNm?: number | null;
    inboundCourseDeg?: number | null;
    legTimeMinutes?: number | null;
    minimumAltitudeFt?: number | null;
    openEnded?: boolean;
    confidence: number;
  }>;
  warnings: string[];
}

export interface ChartTopologyExecutionResult {
  output: ExtractionStageResult;
  auditArtifacts: StageAuditArtifact[];
}

export async function executeChartTopology(input: {
  task: ProcedureTask;
  group: ProcedureGroup;
  layout: PageLayoutStageResult;
  table: ProcedureTableStageResult;
  model: string;
  useModel: boolean;
  stageInputHash: string;
  abortSignal?: AbortSignal;
  visionClient?: VisionStageClient;
  onAuditArtifact?: StageAuditWriter;
}): Promise<ChartTopologyExecutionResult> {
  const packageId = input.group.packageId || input.group.groupId;
  const chartPages = new Set(input.group.chartPages ?? []);
  const pageByNo = new Map(input.task.pages.map((page) => [page.pageNo, page]));
  const diagramRegions = input.layout.pages.flatMap((layoutPage) => layoutPage.regions
    .filter((region) => region.type === 'PROCEDURE_DIAGRAM' && (!chartPages.size || chartPages.has(layoutPage.pageNo)))
    .map((region) => ({ page: pageByNo.get(layoutPage.pageNo), region }))
    .filter((item): item is { page: PdfPageAsset; region: PageRegion } => Boolean(item.page)));
  const evidence: SourceEvidence[] = [];
  const candidates: FieldCandidate[] = [];
  const warnings: string[] = [];
  const auditArtifacts: StageAuditArtifact[] = [];

  addTableDerivedTopology(packageId, input.table, evidence, candidates, warnings);
  addPrintedNodePresence(input.task, packageId, diagramRegions, evidence, candidates);
  addPrintedSpecialTopology(input.task, input.group, packageId, diagramRegions, evidence, candidates, warnings);
  await addLocalRasterDmeArcTopology(input.task, input.group, packageId, evidence, candidates, warnings);

  if (input.useModel) {
    for (const { page, region } of diagramRegions) {
      if (!page.imageUrl) {
        warnings.push(`Vision topology extraction skipped for page ${page.pageNo}: no image asset.`);
        continue;
      }
      try {
        const crop = await renderDynamicRegionCrop(page.imageUrl, region.bbox, region.rotationDeg, 2);
        const modelResult = await (input.visionClient ?? runVisionStage)({
          model: input.model,
          promptId: PROMPT_ID,
          promptVersion: PROMPT_VERSION,
          schemaId: MODEL_SCHEMA_ID,
          schemaVersion: PROMPT_VERSION,
          inputHash: hashValue([input.stageInputHash, page.pageNo, region.regionId, region.bbox]),
          systemPrompt: await readRecognitionV2Prompt('chart-topology.prompt.md'),
          userPrompt: [
            `Allowed page number: ${page.pageNo}`,
            `Allowed region id: ${region.regionId}`,
            'Return exactly this top-level object: {"pageNo":1,"regionId":"supplied id","nodes":[],"edges":[],"warnings":[]}. Never omit pageNo, regionId, or warnings, including when no topology is visible.',
            `Table-derived hints are non-authoritative for chart observation: ${JSON.stringify(tableEdgeHints(input.table))}`,
          ].join('\n\n'),
          responseSchema: await readRecognitionV2Schema(MODEL_SCHEMA_ID),
          images: [{ pageNo: page.pageNo, aipPageNo: page.aipPageNo, role: `PROCEDURE_DIAGRAM:${region.regionId}`, dataUrl: crop.dataUrl }],
          abortSignal: input.abortSignal,
        });
        const auditArtifact = { fileName: `chart-topology-model-page-${page.pageNo}-${safeName(region.regionId)}.json`, value: modelResult.audit };
        if (input.onAuditArtifact) await input.onAuditArtifact(auditArtifact);
        else auditArtifacts.push(auditArtifact);
        const normalized = normalizeModelChartTopology(modelResult.parsedJson, page.pageNo, region.regionId);
        await assertValidModelChartTopology(normalized);
        const observed = normalized as ModelChartTopology;
        if (observed.pageNo !== page.pageNo || observed.regionId !== region.regionId) {
          throw new Error(`Chart-topology model returned unprovided region ${observed.pageNo}:${observed.regionId}.`);
        }
        addModelTopology(input.task, packageId, page, region, observed, modelResult.execution, evidence, candidates);
        warnings.push(...observed.warnings);
      } catch (error) {
        warnings.push(`Vision chart-topology extraction was rejected for page ${page.pageNo}, region ${region.regionId}: ${error instanceof Error ? error.message : String(error)}. Deterministic table topology was preserved.`);
      }
    }
  }
  addGraphStructureCandidates(packageId, candidates);

  if (!diagramRegions.length) warnings.push('No PROCEDURE_DIAGRAM region is available; topology is limited to deterministic table order.');
  const pageNos = [...new Set([
    ...diagramRegions.map((item) => item.page.pageNo),
    ...input.table.extraction.pageNos,
  ])].sort((a, b) => a - b);
  const output: ExtractionStageResult = {
    contractVersion: RECOGNITION_V2_CONTRACT_VERSION,
    schemaId: RECOGNITION_V2_SCHEMA_IDS.extractionStageResult,
    taskType: 'CHART_TOPOLOGY',
    pageNos: pageNos.length ? pageNos : input.layout.pages.map((page) => page.pageNo),
    regionIds: [...new Set(diagramRegions.map((item) => item.region.regionId))],
    evidence: dedupe(evidence, (item) => item.evidenceId),
    candidates: dedupe(candidates, (item) => item.candidateId),
    warnings: [...new Set(warnings)],
    completedAt: new Date().toISOString(),
  };
  await assertValidExtractionStageResult(output);
  return { output, auditArtifacts };
}

export function normalizeModelChartTopology(value: unknown, pageNo: number, regionId: string): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.nodes) || !Array.isArray(record.edges)) return value;
  return {
    ...record,
    pageNo: Number.isInteger(record.pageNo) ? record.pageNo : pageNo,
    regionId: typeof record.regionId === 'string' && record.regionId ? record.regionId : regionId,
    warnings: Array.isArray(record.warnings) ? record.warnings : [],
  };
}

async function addLocalRasterDmeArcTopology(
  task: ProcedureTask,
  group: ProcedureGroup,
  packageId: string,
  evidence: SourceEvidence[],
  candidates: FieldCandidate[],
  warnings: string[],
) {
  const pageNos = new Set([...(group.chartPages ?? []), ...(group.tabularPages ?? [])]);
  const pages = task.pages.filter((page) => pageNos.has(page.pageNo) && page.imageUrl && pageText(page).trim().length < 200);
  if (!pages.length) return;
  const rasterPages: Array<{ page: PdfPageAsset; text: string }> = [];
  for (const page of pages) {
    let text: string | undefined;
    try {
      text = await readLocalRasterOcrText(page);
    } catch (error) {
      warnings.push(`Local raster OCR was unavailable for topology page ${page.pageNo}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (text) rasterPages.push({ page, text: normalizeDmeArcOcr(text) });
  }
  const tablePage = rasterPages.find((item) => /TABULAR\s+DESCRIPTION/i.test(item.text) && /DME\s+ARC/i.test(item.text));
  if (!tablePage) return;
  const rowPattern = /(?:ARRIVAL\s+VIA\s+[A-Z0-9]+\s+TO|OVER)\s+([A-Z0-9]{2,8})\s*[,，、]?\s*THEN\s+TRACK\s+INBOUND\s+ON\s+RDL\s*-?\s*(\d{3})\s+([A-Z0-9]{2,5})\s+VOR[\s\S]{0,180}?TURN\s+(LEFT|RIGHT)\s+TO\s+JOIN\s+(\d{1,2})\s+DME\s+ARC\s+\3\s+VOR[\s\S]{0,120}?THEN\s+TURN\s+(LEFT|RIGHT)\s+TO\s+INTERCEPT\s+RDL\s*-?\s*(\d{3})\s+\3\s+VOR/gi;
  const rows = [...tablePage.text.matchAll(rowPattern)];
  if (rows.length < 2) {
    warnings.push(`Page ${tablePage.page.pageNo} mentions a DME arc, but fewer than two complete transition rows were recovered.`);
    return;
  }
  const exitRadials = new Set<string>();
  for (const row of rows) {
    const arrivalFix = row[1].toUpperCase();
    const entryRadial = row[2];
    const center = row[3].toUpperCase();
    const radiusNm = Number(row[5]);
    const turnDirection = row[6].toUpperCase() === 'LEFT' ? 'L' : 'R';
    const exitRadial = row[7];
    exitRadials.add(exitRadial);
    const entry = dmeArcPseudoFix(entryRadial, radiusNm, center);
    const exit = dmeArcPseudoFix(exitRadial, radiusNm, center);
    const evidenceId = stableId('evidence', ['local-raster-dme-arc-row', tablePage.page.pageNo, row[0]]);
    evidence.push({
      evidenceId,
      fileName: tablePage.page.sourceFileName || task.fileName,
      pageNo: tablePage.page.pageNo,
      aipPageNo: tablePage.page.aipPageNo,
      sourceType: 'PROCEDURE_LEG_TABLE',
      rawText: row[0],
      extractionTask: 'CHART_TOPOLOGY',
      confidence: 0.76,
      status: 'OBSERVED',
    });
    addSpecialEdge(packageId, {
      from: entry,
      to: exit,
      relation: 'ARC',
      pathTerminator: 'AF',
      turnDirection,
      centerIdentifier: center,
      radiusNm,
    }, evidenceId, candidates, 'PRINTED_DME_ARC_TRANSITION_ROW_TO_TOPOLOGY');
    addSpecialNode(packageId, arrivalFix, evidenceId, candidates);
  }

  const chartPage = rasterPages.find((item) => item.page.pageNo !== tablePage.page.pageNo && /ARRIVAL\s*\(\s*\d+\s+DME\s+ARC/i.test(item.text));
  const chartFix = chartPage?.text.match(/\b([A-Z]{5})\s+\d{3,4}\b/i)?.[1]?.toUpperCase();
  if (chartPage && chartFix && exitRadials.size === 1) {
    const center = rows[0][3].toUpperCase();
    const radiusNm = Number(rows[0][5]);
    const exit = dmeArcPseudoFix([...exitRadials][0], radiusNm, center);
    const evidenceId = stableId('evidence', ['local-raster-dme-arc-exit', chartPage.page.pageNo, exit, chartFix]);
    evidence.push({
      evidenceId,
      fileName: chartPage.page.sourceFileName || task.fileName,
      pageNo: chartPage.page.pageNo,
      aipPageNo: chartPage.page.aipPageNo,
      sourceType: 'PROCEDURE_DIAGRAM',
      rawText: `${exit} -> ${chartFix}`,
      visualDescription: `The common DME-arc exit continues to the printed fix ${chartFix}; raster-derived geometry requires review.`,
      extractionTask: 'CHART_TOPOLOGY',
      confidence: 0.68,
      status: 'OBSERVED',
    });
    addSpecialEdge(packageId, { from: exit, to: chartFix, relation: 'TRACK', pathTerminator: null }, evidenceId, candidates, 'PRINTED_COMMON_DME_ARC_EXIT_TO_FIX');
  } else if (exitRadials.size === 1) {
    warnings.push('A common DME-arc exit was recovered, but its downstream chart fix could not be resolved without guessing.');
  }
}

function normalizeDmeArcOcr(value: string) {
  return value
    .replace(/\bVJ\s+B\b/gi, 'VJB')
    .replace(/\bRDL\s*[-.]?\s*(\d{3})/gi, 'RDL-$1')
    .replace(/\b(\d)\s+(\d)\s+DME\b/gi, '$1$2 DME')
    .replace(/\bNTE\s+RCEPT\b/gi, 'INTERCEPT')
    .replace(/\bAP\s+PROACH\b/gi, 'APPROACH')
    .replace(/\|/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function dmeArcPseudoFix(radial: string, radiusNm: number, center: string) {
  return `RDL${radial}_${radiusNm}DME_${center}`;
}

function addSpecialNode(packageId: string, identifier: string, evidenceId: string, candidates: FieldCandidate[]) {
  candidates.push({
    candidateId: stableId('candidate', ['printed-special-node', packageId, identifier, evidenceId]),
    entityType: 'TOPOLOGY',
    entityKey: `TOPOLOGY:${packageId}:NODE:${identifier}`,
    fieldName: 'presentOnChart',
    value: true,
    normalizedValue: true,
    status: 'OBSERVED',
    sourceEvidenceIds: [evidenceId],
    confidence: 0.76,
    reviewRequired: true,
  });
}

function addPrintedSpecialTopology(
  task: ProcedureTask,
  group: ProcedureGroup,
  packageId: string,
  regions: Array<{ page: PdfPageAsset; region: PageRegion }>,
  evidence: SourceEvidence[],
  candidates: FieldCandidate[],
  warnings: string[],
) {
  for (const { page, region } of regions) {
    const rawText = pageText(page);
    const normalized = rawText.replace(/\s+/g, ' ').trim();
    const missed = normalized.match(/MISSED\s+APPROACH\s*:\s*CLIMB\s+DIRECT\s+TO\s+([A-Z0-9]{2,8})\s*\.\s*TURN\s+(LEFT|RIGHT)\s+TO\s+([A-Z0-9]{2,8})\s+TO\s+JOIN\s+THE\s+HOLDING\s+AT\s+([\d\s]+)\s*FT/i);
    if (missed) {
      const directFix = missed[1].toUpperCase();
      const holdFix = missed[3].toUpperCase();
      const turnDirection = missed[2].toUpperCase() === 'LEFT' ? 'L' : 'R';
      const minimumAltitudeFt = Number(missed[4].replace(/\s/g, ''));
      const runway = runwayNode(group, normalized);
      const evidenceId = addPrintedSpecialEvidence(task, page, region, 'missed-approach', missed[0], evidence);
      if (runway) {
        addSpecialEdge(packageId, {
          from: runway, to: directFix, relation: 'MISSED_APPROACH', pathTerminator: null,
        }, evidenceId, candidates, 'PRINTED_MISSED_APPROACH_INSTRUCTION_TO_TOPOLOGY');
      } else {
        warnings.push(`Page ${page.pageNo} prints a missed-approach instruction, but its runway start could not be resolved without guessing.`);
      }
      addSpecialEdge(packageId, {
        from: directFix, to: holdFix, relation: 'MISSED_APPROACH', pathTerminator: null, turnDirection, minimumAltitudeFt,
      }, evidenceId, candidates, 'PRINTED_MISSED_APPROACH_INSTRUCTION_TO_TOPOLOGY');

      const degree = '(?:掳|°|o)';
      const escapedFix = escapeRegex(holdFix);
      const holdPattern = new RegExp(`(\\d{3})\\s*${degree}\\s*(\\d{3})\\s*${degree}\\s*${escapedFix}\\s+MISSED\\s+APCH[\\s\\S]{0,180}?MNM\\s+ALT\\s+([\\d\\s]+)[\\s\\S]{0,180}?(\\d+(?:\\.\\d+)?)\\s*Min`, 'i');
      const hold = normalized.match(holdPattern);
      if (hold) {
        const holdEvidenceId = addPrintedSpecialEvidence(task, page, region, 'holding-pattern', hold[0], evidence);
        addSpecialEdge(packageId, {
          from: holdFix,
          to: holdFix,
          relation: 'HOLD',
          pathTerminator: 'HM',
          turnDirection,
          outboundCourseDeg: Number(hold[1]),
          inboundCourseDeg: Number(hold[2]),
          minimumAltitudeFt: Number(hold[3].replace(/\s/g, '')),
          legTimeMinutes: Number(hold[4]),
        }, holdEvidenceId, candidates, 'PRINTED_HOLD_BLOCK_TO_TOPOLOGY');
      } else {
        warnings.push(`Page ${page.pageNo} identifies holding fix ${holdFix}, but a complete course/time hold block was not recovered.`);
      }
    }

    const radarText = normalized.replace(/\bR\s+A\s+D\s+A\s+R\s+R\s+O\s+U\s+T\s+E\b/i, 'RADAR ROUTE');
    if (/EXPECT\s+RADAR\s+VECTORS/i.test(radarText) && /RADAR\s+ROUTE/i.test(radarText)) {
      const finalTableFix = [...candidates].reverse().map((candidate) => {
        if (candidate.entityType !== 'TOPOLOGY' || candidate.fieldName !== 'edge') return undefined;
        const value = candidate.value as { to?: string | null } | undefined;
        return value?.to ?? undefined;
      }).find((value): value is string => Boolean(value));
      const radarMarkerIndex = radarText.search(/RADAR\s+ROUTE/i);
      const beforeRadar = radarMarkerIndex >= 0 ? radarText.slice(0, radarMarkerIndex) : radarText;
      const coordinateFixPattern = /\b([A-Z][A-Z0-9]{1,7})\s+\d{2}\s*(?:掳|°|o)\s*\d{2}'\s*\d{2}''\s*N\s+\d{3}\s*(?:掳|°|o)\s*\d{2}'\s*\d{2}''\s*E/gi;
      const coordinateFixes = [...beforeRadar.matchAll(coordinateFixPattern)].map((match) => match[1].toUpperCase());
      const printedRadarAnchor = coordinateFixes.at(-1);
      const finalPublishedFix = printedRadarAnchor ?? finalTableFix;
      if (finalPublishedFix) {
        if (printedRadarAnchor && finalTableFix && printedRadarAnchor !== finalTableFix) {
          warnings.push(`Page ${page.pageNo} radar-route anchor ${printedRadarAnchor} differs from final table fix ${finalTableFix}; the printed chart anchor was retained for review.`);
        }
        const vectorEvidence = radarText.match(/FOR\s+APPROACH\s+RWY\s+\w+\s+EXPECT\s+RADAR\s+VECTORS/i)?.[0] ?? 'EXPECT RADAR VECTORS / RADAR ROUTE';
        const evidenceId = addPrintedSpecialEvidence(task, page, region, 'radar-vector', vectorEvidence, evidence);
        addSpecialEdge(packageId, {
          from: finalPublishedFix,
          to: null,
          relation: 'VECTOR',
          pathTerminator: null,
          openEnded: true,
        }, evidenceId, candidates, 'PRINTED_OPEN_RADAR_ROUTE_AFTER_FINAL_TABLE_FIX');
      } else {
        warnings.push(`Page ${page.pageNo} prints an open radar route, but no final published table fix is available as its start.`);
      }
    }
  }
}

function addPrintedSpecialEvidence(
  task: ProcedureTask,
  page: PdfPageAsset,
  region: PageRegion,
  kind: string,
  rawText: string,
  evidence: SourceEvidence[],
) {
  const evidenceId = stableId('evidence', ['printed-special-topology', kind, page.pageNo, region.regionId, rawText]);
  evidence.push({
    evidenceId,
    fileName: page.sourceFileName || task.fileName,
    pageNo: page.pageNo,
    aipPageNo: page.aipPageNo,
    regionId: region.regionId,
    bbox: region.bbox,
    sourceType: 'PROCEDURE_DIAGRAM',
    rawText,
    extractionTask: 'CHART_TOPOLOGY',
    confidence: 0.78,
    status: 'OBSERVED',
  });
  return evidenceId;
}

function addSpecialEdge(
  packageId: string,
  value: {
    from: string | null;
    to: string | null;
    relation: TopologyRelation;
    pathTerminator: string | null;
    turnDirection?: 'L' | 'R';
    inboundCourseDeg?: number;
    outboundCourseDeg?: number;
    legTimeMinutes?: number;
    minimumAltitudeFt?: number;
    openEnded?: boolean;
    centerIdentifier?: string;
    radiusNm?: number;
  },
  evidenceId: string,
  candidates: FieldCandidate[],
  ruleId: string,
) {
  candidates.push({
    candidateId: stableId('candidate', [ruleId, packageId, value, evidenceId]),
    entityType: 'TOPOLOGY',
    entityKey: edgeEntityKey(packageId, value.from, value.to ?? 'OPEN', value.relation),
    fieldName: 'edge',
    value,
    normalizedValue: { from: value.from, to: value.to, relation: value.relation },
    status: 'OBSERVED',
    sourceEvidenceIds: [evidenceId],
    confidence: 0.76,
    reviewRequired: true,
  });
}

function runwayNode(group: ProcedureGroup, text: string) {
  const groupValue = String(group.runway ?? '').match(/(?:RWY)?\s*(\d{2}[LCR]?)/i)?.[1];
  const textValue = text.match(/RNP\s+RWY\s*(\d{2}[LCR]?)/i)?.[1] ?? text.match(/RWY\s*(\d{2}[LCR]?)/i)?.[1];
  const value = groupValue ?? textValue;
  return value ? `RW${value.toUpperCase()}` : undefined;
}

function addGraphStructureCandidates(packageId: string, candidates: FieldCandidate[]) {
  const edgeCandidates = candidates.filter((item) => item.fieldName === 'edge');
  const distinctEdges = new Map<string, { edge: { from: string | null; to: string; relation: string }; inputs: FieldCandidate[] }>();
  for (const candidate of edgeCandidates) {
    const value = candidate.normalizedValue as { from?: string | null; to?: string; relation?: string };
    if (value?.from === undefined || !value.to || !value.relation) continue;
    const key = JSON.stringify([value.from, value.to, value.relation]);
    const group = distinctEdges.get(key) ?? { edge: { from: value.from, to: value.to, relation: value.relation }, inputs: [] };
    group.inputs.push(candidate);
    distinctEdges.set(key, group);
  }
  const outgoing = new Map<string, Array<{ to: string; inputs: FieldCandidate[] }>>();
  const incoming = new Map<string, Array<{ from: string; inputs: FieldCandidate[] }>>();
  for (const { edge, inputs } of distinctEdges.values()) {
    if (edge.from) {
      const values = outgoing.get(edge.from) ?? [];
      values.push({ to: edge.to, inputs });
      outgoing.set(edge.from, values);
      const arrivals = incoming.get(edge.to) ?? [];
      arrivals.push({ from: edge.from, inputs });
      incoming.set(edge.to, arrivals);
    }
  }
  for (const [node, edges] of outgoing) {
    const targets = [...new Set(edges.map((item) => item.to))].sort();
    if (targets.length > 1) addStructureCandidate(node, 'branchTargets', targets, edges.flatMap((item) => item.inputs));
  }
  for (const [node, edges] of incoming) {
    const sources = [...new Set(edges.map((item) => item.from))].sort();
    if (sources.length > 1) addStructureCandidate(node, 'mergeSources', sources, edges.flatMap((item) => item.inputs));
  }

  function addStructureCandidate(node: string, fieldName: 'branchTargets' | 'mergeSources', value: string[], inputs: FieldCandidate[]) {
    const sourceEvidenceIds = [...new Set(inputs.flatMap((item) => item.sourceEvidenceIds))];
    candidates.push({
      candidateId: stableId('candidate', ['graph-structure', packageId, node, fieldName, value, inputs.map((item) => item.candidateId).sort()]),
      entityType: 'TOPOLOGY',
      entityKey: `TOPOLOGY:${packageId}:NODE:${node}`,
      fieldName,
      value,
      normalizedValue: value,
      status: 'DERIVED',
      sourceEvidenceIds,
      derivation: {
        ruleId: 'TOPOLOGY_EDGE_DEGREE_TO_BRANCH_MERGE',
        ruleVersion: '1.0.0',
        inputCandidateIds: inputs.map((item) => item.candidateId),
      },
      confidence: Math.min(...inputs.map((item) => item.confidence)),
      reviewRequired: inputs.some((item) => item.reviewRequired),
    });
  }
}

function addTableDerivedTopology(
  packageId: string,
  table: ProcedureTableStageResult,
  evidence: SourceEvidence[],
  candidates: FieldCandidate[],
  warnings: string[],
) {
  const byEntity = new Map<string, FieldCandidate[]>();
  for (const candidate of table.extraction.candidates.filter((item) => item.entityType === 'LEG')) {
    const values = byEntity.get(candidate.entityKey) ?? [];
    values.push(candidate);
    byEntity.set(candidate.entityKey, values);
  }
  const legs = [...byEntity.entries()].map(([entityKey, fields]) => ({
    entityKey,
    fields,
    sequence: numericField(fields, 'sequence'),
    toFix: textField(fields, 'toFix'),
    pathTerminator: textField(fields, 'pathTerminator'),
    turnDirection: textField(fields, 'turnDirection'),
    centerIdentifier: textField(fields, 'centerFix') ?? textField(fields, 'recommendedNavaid'),
    radiusNm: numericField(fields, 'radiusNm'),
    distanceNm: numericField(fields, 'distanceNm'),
    courseDegMag: numericField(fields, 'courseDegMag'),
    fromFix: textField(fields, 'fromFix'),
    procedureName: textField(fields, 'procedureName'),
    transitionName: textField(fields, 'transitionName'),
  })).filter((leg) => leg.sequence !== undefined && leg.toFix)
    .sort((a, b) => legScope(a).localeCompare(legScope(b)) || a.sequence! - b.sequence! || a.entityKey.localeCompare(b.entityKey));
  if (!legs.length) {
    warnings.push('No ordered table legs are available; no deterministic topology edge was created.');
    return;
  }
  const evidenceById = new Map(table.extraction.evidence.map((item) => [item.evidenceId, item]));
  let prior: typeof legs[number] | undefined;
  for (const leg of legs) {
    if (prior && legScope(prior) !== legScope(leg)) prior = undefined;
    const inputs = [
      ...fieldCandidates(leg.fields, 'sequence'),
      ...fieldCandidates(leg.fields, 'toFix'),
      ...fieldCandidates(leg.fields, 'pathTerminator'),
      ...fieldCandidates(leg.fields, 'turnDirection'),
      ...fieldCandidates(leg.fields, 'centerFix'),
      ...fieldCandidates(leg.fields, 'recommendedNavaid'),
      ...fieldCandidates(leg.fields, 'radiusNm'),
      ...fieldCandidates(leg.fields, 'distanceNm'),
      ...fieldCandidates(leg.fields, 'courseDegMag'),
      ...fieldCandidates(leg.fields, 'fromFix'),
      ...fieldCandidates(leg.fields, 'procedureName'),
      ...fieldCandidates(leg.fields, 'transitionName'),
      ...(prior ? fieldCandidates(prior.fields, 'toFix') : []),
    ];
    const sourceEvidenceIds = [...new Set(inputs.flatMap((item) => item.sourceEvidenceIds))];
    for (const evidenceId of sourceEvidenceIds) {
      const item = evidenceById.get(evidenceId);
      if (item) evidence.push(item);
    }
    const relation = relationFor(leg.pathTerminator);
    const normalizedValue = { from: leg.fromFix ?? prior?.toFix ?? null, to: leg.toFix!, relation };
    const edgeValue = {
      ...normalizedValue,
      pathTerminator: leg.pathTerminator ?? null,
      turnDirection: leg.turnDirection ?? null,
      centerIdentifier: leg.centerIdentifier ?? null,
      radiusNm: leg.radiusNm ?? null,
      distanceNm: leg.distanceNm ?? null,
      courseDegMag: leg.courseDegMag ?? null,
    };
    candidates.push({
      candidateId: stableId('candidate', ['table-topology-edge', packageId, edgeValue, inputs.map((item) => item.candidateId)]),
      entityType: 'TOPOLOGY',
      entityKey: edgeEntityKey(packageId, normalizedValue.from, normalizedValue.to, normalizedValue.relation),
      fieldName: 'edge',
      value: edgeValue,
      normalizedValue,
      status: 'DERIVED',
      sourceEvidenceIds,
      derivation: {
        ruleId: TABLE_TOPOLOGY_RULE_ID,
        ruleVersion: TABLE_TOPOLOGY_RULE_VERSION,
        inputCandidateIds: inputs.map((item) => item.candidateId),
      },
      confidence: Math.min(...inputs.map((item) => item.confidence)),
      reviewRequired: inputs.some((item) => item.reviewRequired),
    });
    prior = leg;
  }
}

function legScope(leg: { procedureName?: string; transitionName?: string }) {
  return `${leg.procedureName ?? 'PACKAGE'}\u0000${leg.transitionName ?? 'DEFAULT'}`;
}

function addPrintedNodePresence(
  task: ProcedureTask,
  packageId: string,
  regions: Array<{ page: PdfPageAsset; region: PageRegion }>,
  evidence: SourceEvidence[],
  candidates: FieldCandidate[],
) {
  const identifiers = new Set(candidates.filter((item) => item.fieldName === 'edge').flatMap((item) => {
    const value = item.normalizedValue as { from?: string | null; to?: string };
    return [value?.from, value?.to].filter((identifier): identifier is string => Boolean(identifier));
  }));
  for (const identifier of identifiers) {
    for (const { page, region } of regions) {
      const rawLine = pageText(page).split(/\r?\n/).map((line) => line.trim()).find((line) => new RegExp(`(^|\\W)${escapeRegex(identifier)}(\\W|$)`, 'i').test(line));
      if (!rawLine) continue;
      const evidenceId = stableId('evidence', ['chart-node-presence', page.pageNo, region.regionId, identifier, rawLine]);
      evidence.push({
        evidenceId,
        fileName: page.sourceFileName || task.fileName,
        pageNo: page.pageNo,
        aipPageNo: page.aipPageNo,
        regionId: region.regionId,
        bbox: region.bbox,
        sourceType: 'PROCEDURE_DIAGRAM',
        rawText: rawLine,
        visualDescription: `Printed procedure node label ${identifier}.`,
        extractionTask: 'CHART_TOPOLOGY',
        confidence: 0.92,
        status: 'OBSERVED',
      });
      candidates.push({
        candidateId: stableId('candidate', ['chart-node-presence', packageId, identifier, evidenceId]),
        entityType: 'TOPOLOGY',
        entityKey: `TOPOLOGY:${packageId}:NODE:${identifier}`,
        fieldName: 'presentOnChart',
        value: true,
        normalizedValue: true,
        status: 'OBSERVED',
        sourceEvidenceIds: [evidenceId],
        confidence: 0.92,
        reviewRequired: false,
      });
    }
  }
}

function addModelTopology(
  task: ProcedureTask,
  packageId: string,
  page: PdfPageAsset,
  region: PageRegion,
  observed: ModelChartTopology,
  execution: ModelExecutionRef,
  evidence: SourceEvidence[],
  candidates: FieldCandidate[],
) {
  for (const node of observed.nodes) {
    const evidenceId = stableId('evidence', ['model-topology-node', execution.runId, page.pageNo, region.regionId, node.identifier]);
    evidence.push(modelEvidence(task, page, region, execution, evidenceId, node.confidence, `Visible ${node.nodeType} node ${node.identifier}.`));
    candidates.push({
      candidateId: stableId('candidate', ['model-topology-node', execution.runId, packageId, node.identifier]),
      entityType: 'TOPOLOGY',
      entityKey: `TOPOLOGY:${packageId}:NODE:${node.identifier}`,
      fieldName: 'presentOnChart',
      value: true,
      normalizedValue: true,
      status: 'OBSERVED',
      sourceEvidenceIds: [evidenceId],
      confidence: node.confidence,
      reviewRequired: true,
    });
  }
  for (const edge of observed.edges) {
    const normalizedValue = { from: edge.fromIdentifier, to: edge.toIdentifier, relation: edge.relation };
    const evidenceId = stableId('evidence', ['model-topology-edge', execution.runId, page.pageNo, region.regionId, normalizedValue]);
    evidence.push(modelEvidence(task, page, region, execution, evidenceId, edge.confidence, `Visible ${edge.relation} edge ${edge.fromIdentifier ?? 'unknown'} -> ${edge.toIdentifier}.`));
    candidates.push({
      candidateId: stableId('candidate', ['model-topology-edge', execution.runId, packageId, normalizedValue]),
      entityType: 'TOPOLOGY',
      entityKey: edgeEntityKey(packageId, edge.fromIdentifier, edge.toIdentifier, edge.relation),
      fieldName: 'edge',
      value: {
        ...normalizedValue,
        turnDirection: edge.turnDirection,
        centerIdentifier: edge.centerIdentifier ?? null,
        radiusNm: edge.radiusNm ?? null,
        inboundCourseDeg: edge.inboundCourseDeg ?? null,
        legTimeMinutes: edge.legTimeMinutes ?? null,
        minimumAltitudeFt: edge.minimumAltitudeFt ?? null,
        openEnded: edge.openEnded ?? edge.toIdentifier === null,
      },
      normalizedValue,
      status: 'OBSERVED',
      sourceEvidenceIds: [evidenceId],
      confidence: edge.confidence,
      reviewRequired: true,
    });
  }
}

function modelEvidence(task: ProcedureTask, page: PdfPageAsset, region: PageRegion, execution: ModelExecutionRef, evidenceId: string, confidence: number, visualDescription: string): SourceEvidence {
  return {
    evidenceId,
    fileName: page.sourceFileName || task.fileName,
    pageNo: page.pageNo,
    aipPageNo: page.aipPageNo,
    regionId: region.regionId,
    bbox: region.bbox,
    sourceType: 'PROCEDURE_DIAGRAM',
    visualDescription,
    extractionTask: 'CHART_TOPOLOGY',
    confidence,
    status: 'OBSERVED',
    modelExecution: execution,
  };
}

function tableEdgeHints(table: ProcedureTableStageResult) {
  const groups = new Map<string, FieldCandidate[]>();
  for (const candidate of table.extraction.candidates.filter((item) => item.entityType === 'LEG')) {
    const values = groups.get(candidate.entityKey) ?? [];
    values.push(candidate);
    groups.set(candidate.entityKey, values);
  }
  return [...groups.values()].map((fields) => ({ sequence: numericField(fields, 'sequence'), toFix: textField(fields, 'toFix') }))
    .filter((item) => item.sequence !== undefined && item.toFix)
    .sort((a, b) => a.sequence! - b.sequence!);
}

function relationFor(pathTerminator: string | undefined): TopologyRelation {
  if (pathTerminator === 'AF' || pathTerminator === 'RF') return 'ARC';
  if (pathTerminator && ['HA', 'HF', 'HM'].includes(pathTerminator)) return 'HOLD';
  if (pathTerminator && ['FM', 'VM'].includes(pathTerminator)) return 'VECTOR';
  return 'TRACK';
}

function fieldCandidates(candidates: FieldCandidate[], fieldName: string) {
  return candidates.filter((item) => item.fieldName === fieldName && item.status !== 'UNRESOLVED' && item.value !== null);
}

function textField(candidates: FieldCandidate[], fieldName: string) {
  const value = fieldCandidates(candidates, fieldName)[0];
  return value ? String(value.normalizedValue ?? value.value).toUpperCase() : undefined;
}

function numericField(candidates: FieldCandidate[], fieldName: string) {
  const value = fieldCandidates(candidates, fieldName)[0];
  const parsed = Number(value?.normalizedValue ?? value?.value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function edgeEntityKey(packageId: string, from: string | null, to: string | null, relation: string) {
  return `TOPOLOGY:${packageId}:EDGE:${from ?? 'START'}:${to ?? 'UNKNOWN'}:${relation}`;
}

function pageText(page: PdfPageAsset) {
  return page.ocrText || page.textLayerText || '';
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

function dedupe<T>(values: T[], key: (value: T) => string) {
  return [...new Map(values.map((value) => [key(value), value])).values()];
}
