import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  ExtractionStageResult,
  FusionStageResult,
  PageLayoutStageResult,
  ProcedureTableStageResult,
  RecognitionV2RunManifest,
  ValidationStageResult,
} from '../contracts/index';
import { readTask } from '../../../storage/taskStore';
import {
  evaluateTopologyGoldenCase,
  loadPhase5TopologyGoldenCases,
  topologyActualFromExtraction,
  type TopologyGoldenCase,
  type TopologyGoldenFailure,
} from './topologyGoldenEvaluator';

export const PHASE52_CASE_ORDER = [
  'vhhh-bekol1x-rf',
  'wsss-rnp02l-akoma-holding',
  'wsss-asuna2b-vector',
  'wsss-rnp02l-missed-approach',
  'wmkj-adlov1g-dme-arc',
  'wmkj-four-star-merge',
] as const;

export interface Phase52GoldenBinding {
  taskId: string;
  packageId: string;
  pageMap: Record<number, number>;
}

export const PHASE52_GOLDEN_BINDINGS: Record<string, Phase52GoldenBinding> = {
  'vhhh-bekol1x-rf': {
    taskId: 'task_1783923235373_l10sqd',
    packageId: 'pkg_12_1e6mlf2',
    pageMap: { 4: 91, 5: 92 },
  },
  'wsss-rnp02l-akoma-holding': {
    taskId: 'task_1784184509517_llosbo',
    packageId: 'pkg_90_126ojoe',
    pageMap: { 254: 254 },
  },
  'wsss-asuna2b-vector': {
    taskId: 'task_1784184509517_llosbo',
    packageId: 'pkg_68_1ga7utu',
    pageMap: { 210: 210 },
  },
  'wsss-rnp02l-missed-approach': {
    taskId: 'task_1784184509517_llosbo',
    packageId: 'pkg_90_126ojoe',
    pageMap: { 254: 254 },
  },
  'wmkj-adlov1g-dme-arc': {
    taskId: 'task_1783064836113_5z3ako',
    packageId: 'pkg_9_86n30l',
    pageMap: { 1: 55, 2: 56 },
  },
  'wmkj-four-star-merge': {
    taskId: 'task_1783064836113_5z3ako',
    packageId: 'pkg_9_86n30l',
    pageMap: { 1: 55, 2: 56 },
  },
};

export type Phase52FailureCode =
  | 'SOURCE_TEXT_MISSING'
  | 'SOURCE_PAGE_MISSING'
  | 'LAYOUT_ROLE_MISSING'
  | 'TABLE_ROWS_MISSING'
  | 'TOPOLOGY_EDGES_MISSING'
  | 'GOLDEN_MISMATCH'
  | 'VALIDATION_BLOCKED'
  | 'PIPELINE_STAGE_FAILED';

export interface Phase52FailureReason {
  code: Phase52FailureCode;
  stage: string;
  message: string;
  details?: unknown;
}

export interface Phase52StageObservation {
  stage: string;
  status: 'COMPLETED' | 'SKIPPED' | 'FAILED';
  durationMs: number;
  outputRef?: string;
  metrics?: Record<string, number | string | boolean>;
  warnings?: string[];
  error?: string;
}

export interface Phase52CaseReport {
  caseId: string;
  category: string;
  airportIcao: string;
  procedureName: string;
  binding: Phase52GoldenBinding;
  runId?: string;
  runStatus?: string;
  modelRequested: boolean;
  sourceFallbackUsed: boolean;
  sourcePages: Array<{ goldenPageNo: number; taskPageNo: number; textLength: number; hasImage: boolean; available: boolean }>;
  stages: Phase52StageObservation[];
  score: number;
  topologyPassed: boolean;
  passed: boolean;
  releaseDecision?: string;
  releaseReady: boolean;
  reviewIssueCount?: number;
  reviewRuleCounts?: Record<string, number>;
  topologyFailures: TopologyGoldenFailure[];
  failureReasons: Phase52FailureReason[];
}

export interface Phase52PipelineReport {
  reportVersion: 'phase5.2.1' | 'phase5.3.0';
  startedAt: string;
  completedAt: string;
  baseUrl: string;
  useModel: boolean;
  cases: Phase52CaseReport[];
  summary: {
    total: number;
    passed: number;
    averageScore: number;
    failureCounts: Record<string, number>;
    releaseCounts?: Record<string, number>;
  };
}

interface HttpResponse<T = unknown> {
  run?: RecognitionV2RunManifest;
  outputRef?: string;
  result?: T;
  error?: string;
  code?: string;
}

export async function runPhase52GoldenPipelines(input: {
  baseUrl?: string;
  useModel?: boolean;
  model?: string;
  caseIds?: string[];
  outputRoot?: string;
  fetchImpl?: typeof fetch;
  phase?: 'phase5.2' | 'phase5.3';
} = {}): Promise<{ report: Phase52PipelineReport; reportDir: string }> {
  const startedAt = new Date().toISOString();
  const baseUrl = (input.baseUrl ?? 'http://127.0.0.1:3317').replace(/\/$/, '');
  const useModel = input.useModel ?? false;
  const fetchImpl = input.fetchImpl ?? fetch;
  const catalog = new Map((await loadPhase5TopologyGoldenCases()).map((item) => [item.caseId, item]));
  const requested = input.caseIds?.length ? input.caseIds : [...PHASE52_CASE_ORDER];
  const cases: Phase52CaseReport[] = [];

  for (const caseId of requested) {
    const golden = catalog.get(caseId);
    if (!golden) throw new Error(`Unknown Phase 5.2 golden case: ${caseId}`);
    const binding = PHASE52_GOLDEN_BINDINGS[caseId];
    if (!binding) throw new Error(`Phase 5.2 golden case ${caseId} has no task/package binding.`);
    cases.push(await runOneCase({ baseUrl, fetchImpl, useModel, model: input.model, golden, binding }));
  }

  const failureCounts: Record<string, number> = {};
  for (const item of cases.flatMap((caseReport) => caseReport.failureReasons)) {
    failureCounts[item.code] = (failureCounts[item.code] ?? 0) + 1;
  }
  const phase = input.phase ?? 'phase5.2';
  const releaseCounts: Record<string, number> = {};
  for (const item of cases) releaseCounts[item.releaseDecision ?? 'NOT_RUN'] = (releaseCounts[item.releaseDecision ?? 'NOT_RUN'] ?? 0) + 1;
  const report: Phase52PipelineReport = {
    reportVersion: phase === 'phase5.3' ? 'phase5.3.0' : 'phase5.2.1',
    startedAt,
    completedAt: new Date().toISOString(),
    baseUrl,
    useModel,
    cases,
    summary: {
      total: cases.length,
      passed: cases.filter((item) => item.passed).length,
      averageScore: cases.length ? round(cases.reduce((sum, item) => sum + item.score, 0) / cases.length) : 0,
      failureCounts,
      releaseCounts,
    },
  };
  const outputRoot = input.outputRoot ?? path.resolve(process.cwd(), 'server', 'data', 'recognition-v2', 'evaluations', phase);
  const reportDir = path.join(outputRoot, startedAt.replace(/[:.]/g, '-'));
  await fs.mkdir(reportDir, { recursive: true });
  await fs.writeFile(path.join(reportDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await fs.writeFile(path.join(reportDir, 'report.md'), renderMarkdownReport(report), 'utf8');
  await fs.writeFile(path.join(outputRoot, 'latest.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return { report, reportDir };
}

async function runOneCase(input: {
  baseUrl: string;
  fetchImpl: typeof fetch;
  useModel: boolean;
  model?: string;
  golden: TopologyGoldenCase;
  binding: Phase52GoldenBinding;
}): Promise<Phase52CaseReport> {
  const sourcePages = await inspectBoundSourcePages(input.golden, input.binding);
  const stages: Phase52StageObservation[] = [];
  const sourceProblems = sourceFailureReasons(sourcePages);
  const failureReasons: Phase52FailureReason[] = [];
  let run: RecognitionV2RunManifest | undefined;
  let topology: ExtractionStageResult | undefined;
  let topologyFailures: TopologyGoldenFailure[] = [];
  let score = 0;
  let releaseDecision: string | undefined;
  let reviewIssueCount = 0;
  let reviewRuleCounts: Record<string, number> = {};

  try {
    const created = await postJson<HttpResponse>(input.fetchImpl, packageUrl(input.baseUrl, input.binding, '/recognition-v2/runs'), {});
    run = requiredRun(created, 'CREATE_RUN');
    const runPath = `/recognition-v2/runs/${encodeURIComponent(run.runId)}`;
    for (const stage of ['PAGE_LAYOUT', 'PROCEDURE_IDENTITY', 'PROCEDURE_TABLE', 'WAYPOINT_NAVAID'] as const) {
      const response = await runStage(input, runPath, stage, stages);
      run = requiredRun(response, stage);
    }
    const notesResponse = await runStage(input, runPath, 'NOTES_CONSTRAINTS', stages);
    run = requiredRun(notesResponse, 'NOTES_CONSTRAINTS');
    const topologyResponse = await runStage(input, runPath, 'CHART_TOPOLOGY', stages);
    run = requiredRun(topologyResponse, 'CHART_TOPOLOGY');
    topology = topologyResponse.result as ExtractionStageResult;
    const evaluated = evaluateTopologyGoldenCase(topologyActualFromExtraction(topology), input.golden);
    topologyFailures = evaluated.failures;
    score = evaluated.score;
    if (!evaluated.passed) {
      failureReasons.push({
        code: 'GOLDEN_MISMATCH',
        stage: 'GOLDEN_EVALUATION',
        message: `${topologyFailures.length} reviewed topology expectation(s) were not met.`,
        details: topologyFailures,
      });
    }
    if (!topology.candidates.some((item) => item.entityType === 'TOPOLOGY' && item.fieldName === 'edge')) {
      failureReasons.push({ code: 'TOPOLOGY_EDGES_MISSING', stage: 'CHART_TOPOLOGY', message: 'The real topology stage produced no edge candidates.' });
    }
    const fusionResponse = await runStage(input, runPath, 'EVIDENCE_FUSION', stages);
    run = requiredRun(fusionResponse, 'EVIDENCE_FUSION');
    const validationResponse = await runStage(input, runPath, 'SEMANTIC_VALIDATION', stages);
    run = requiredRun(validationResponse, 'SEMANTIC_VALIDATION');
    const validation = validationResponse.result as ValidationStageResult;
    releaseDecision = validation.releaseDecision;
    const blocking = validation.issues.filter((item) => item.severity === 'BLOCKING' && item.status === 'OPEN');
    const reviewIssues = validation.issues.filter((item) => item.severity === 'WARNING' && item.status === 'OPEN');
    reviewIssueCount = reviewIssues.length;
    reviewRuleCounts = reviewIssues.reduce<Record<string, number>>((counts, item) => {
      counts[item.ruleId] = (counts[item.ruleId] ?? 0) + 1;
      return counts;
    }, {});
    if (blocking.length) {
      failureReasons.push({
        code: 'VALIDATION_BLOCKED',
        stage: 'SEMANTIC_VALIDATION',
        message: `${blocking.length} blocking semantic validation issue(s) remain.`,
        details: blocking.map((item) => ({ ruleId: item.ruleId, message: item.message, entityKeys: item.entityKeys })),
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failedStage = stages.find((item) => item.status === 'FAILED')?.stage ?? 'PIPELINE';
    failureReasons.push({ code: 'PIPELINE_STAGE_FAILED', stage: failedStage, message });
  }

  if (score < 1 || failureReasons.some((item) => item.code === 'PIPELINE_STAGE_FAILED')) failureReasons.unshift(...sourceProblems);
  addStageDerivedFailures(stages, failureReasons);
  const topologyPassed = score === 1 && !failureReasons.some((item) => item.code === 'PIPELINE_STAGE_FAILED');
  return {
    caseId: input.golden.caseId,
    category: input.golden.category,
    airportIcao: input.golden.airportIcao,
    procedureName: input.golden.procedureName,
    binding: input.binding,
    runId: run?.runId,
    runStatus: run?.status,
    modelRequested: input.useModel,
    sourceFallbackUsed: sourceProblems.some((item) => item.code === 'SOURCE_TEXT_MISSING') && stages.some((item) => item.warnings?.some((warning) => /raster OCR/i.test(warning))),
    sourcePages,
    stages,
    score,
    topologyPassed,
    passed: topologyPassed,
    releaseDecision,
    releaseReady: releaseDecision === 'READY',
    reviewIssueCount,
    reviewRuleCounts,
    topologyFailures,
    failureReasons: dedupeFailures(failureReasons),
  };
}

async function runStage(
  input: { baseUrl: string; fetchImpl: typeof fetch; useModel: boolean; model?: string; binding: Phase52GoldenBinding },
  runPath: string,
  stage: string,
  stages: Phase52StageObservation[],
) {
  const url = packageUrl(input.baseUrl, input.binding, `${runPath}/stages/${stage}/run`);
  try {
    const execution = await timedPost<HttpResponse>(input.fetchImpl, url, { useModel: input.useModel, ...(input.model ? { model: input.model } : {}) });
    const observation = observeStage(stage, execution.durationMs, execution.value);
    stages.push(observation);
    return execution.value;
  } catch (error) {
    stages.push({ stage, status: 'FAILED', durationMs: 0, error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

function observeStage(stage: string, durationMs: number, response: HttpResponse): Phase52StageObservation {
  const result = response.result as PageLayoutStageResult | ProcedureTableStageResult | ExtractionStageResult | FusionStageResult | ValidationStageResult | undefined;
  const metrics: Record<string, number | string | boolean> = {};
  let warnings: string[] = [];
  if (stage === 'PAGE_LAYOUT' && result) {
    const layout = result as PageLayoutStageResult;
    metrics.pages = layout.pages.length;
    metrics.regions = layout.pages.reduce((sum, item) => sum + item.regions.length, 0);
    metrics.unknownPages = layout.pages.filter((item) => item.pageRoles.includes('UNKNOWN')).length;
    warnings = layout.warnings;
  } else if (stage === 'PROCEDURE_TABLE' && result) {
    const table = result as ProcedureTableStageResult;
    metrics.tables = table.tables.length;
    metrics.rows = table.tables.reduce((sum, item) => sum + item.rows.filter((row) => row.rowType === 'DATA').length, 0);
    metrics.candidates = table.extraction.candidates.length;
    warnings = [...table.warnings, ...table.extraction.warnings];
  } else if (['PROCEDURE_IDENTITY', 'WAYPOINT_NAVAID', 'CHART_TOPOLOGY'].includes(stage) && result) {
    const extraction = result as ExtractionStageResult;
    metrics.candidates = extraction.candidates.length;
    metrics.evidence = extraction.evidence.length;
    metrics.edges = extraction.candidates.filter((item) => item.entityType === 'TOPOLOGY' && item.fieldName === 'edge').length;
    warnings = extraction.warnings;
  } else if (stage === 'EVIDENCE_FUSION' && result) {
    const fusion = result as FusionStageResult;
    metrics.entities = fusion.entities.length;
    metrics.conflicts = fusion.conflicts.length;
    metrics.unresolved = fusion.unresolvedItems.length;
    metrics.blockingUnresolved = fusion.unresolvedItems.filter((item) => item.blockingFor424).length;
  } else if (stage === 'SEMANTIC_VALIDATION' && result) {
    const validation = result as ValidationStageResult;
    metrics.issues = validation.issues.length;
    metrics.blockingIssues = validation.issues.filter((item) => item.severity === 'BLOCKING' && item.status === 'OPEN').length;
    metrics.releaseDecision = validation.releaseDecision;
  }
  return { stage, status: 'COMPLETED', durationMs, outputRef: response.outputRef, metrics, warnings: [...new Set(warnings)] };
}

async function inspectBoundSourcePages(golden: TopologyGoldenCase, binding: Phase52GoldenBinding) {
  const task = await readTask(binding.taskId);
  return golden.source.pages.map((page) => {
    const taskPageNo = binding.pageMap[page.pageNo];
    const taskPage = task.pages.find((item) => item.pageNo === taskPageNo);
    const text = taskPage?.ocrText || taskPage?.textLayerText || '';
    return {
      goldenPageNo: page.pageNo,
      taskPageNo,
      textLength: text.trim().length,
      hasImage: Boolean(taskPage?.imageUrl),
      available: Boolean(taskPage),
    };
  });
}

function sourceFailureReasons(pages: Phase52CaseReport['sourcePages']): Phase52FailureReason[] {
  const reasons: Phase52FailureReason[] = [];
  const missing = pages.filter((item) => !item.available);
  if (missing.length) reasons.push({ code: 'SOURCE_PAGE_MISSING', stage: 'SOURCE_RESOLUTION', message: `Bound task page(s) are missing: ${missing.map((item) => item.taskPageNo).join(', ')}.` });
  const lowText = pages.filter((item) => item.available && item.textLength < 200);
  if (lowText.length) {
    reasons.push({
      code: 'SOURCE_TEXT_MISSING',
      stage: 'SOURCE_RESOLUTION',
      message: `Task page(s) ${lowText.map((item) => item.taskPageNo).join(', ')} contain only headers or near-empty text; raster OCR or a configured vision model is required.`,
      details: lowText,
    });
  }
  return reasons;
}

function addStageDerivedFailures(stages: Phase52StageObservation[], failures: Phase52FailureReason[]) {
  const layout = stages.find((item) => item.stage === 'PAGE_LAYOUT');
  if (layout?.status === 'COMPLETED' && Number(layout.metrics?.regions ?? 0) === 0) {
    failures.push({ code: 'LAYOUT_ROLE_MISSING', stage: 'PAGE_LAYOUT', message: 'No page regions were produced.' });
  }
  const table = stages.find((item) => item.stage === 'PROCEDURE_TABLE');
  if (table?.status === 'COMPLETED' && Number(table.metrics?.rows ?? 0) === 0) {
    failures.push({ code: 'TABLE_ROWS_MISSING', stage: 'PROCEDURE_TABLE', message: 'No physical procedure-table data rows were recovered.' });
  }
}

function packageUrl(baseUrl: string, binding: Phase52GoldenBinding, suffix: string) {
  return `${baseUrl}/api/procedure-tasks/${encodeURIComponent(binding.taskId)}/packages/${encodeURIComponent(binding.packageId)}${suffix}`;
}

async function timedPost<T>(fetchImpl: typeof fetch, url: string, body: unknown): Promise<{ value: T; durationMs: number }> {
  const started = performance.now();
  const value = await postJson<T>(fetchImpl, url, body);
  return { value, durationMs: Math.round(performance.now() - started) };
}

async function postJson<T>(fetchImpl: typeof fetch, url: string, body: unknown): Promise<T> {
  const response = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const text = await response.text();
  const value = text ? JSON.parse(text) as T & { error?: string; code?: string } : {} as T & { error?: string; code?: string };
  if (!response.ok) throw new Error(`${response.status} ${value.code ?? 'HTTP_ERROR'}: ${value.error ?? response.statusText}`);
  return value;
}

function requiredRun(response: HttpResponse, stage: string) {
  if (!response.run) throw new Error(`${stage} response did not include a run manifest.`);
  return response.run;
}

function dedupeFailures(failures: Phase52FailureReason[]) {
  const seen = new Set<string>();
  return failures.filter((item) => {
    const key = `${item.code}:${item.stage}:${item.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function round(value: number) {
  return Math.round(value * 1000) / 1000;
}

export function renderMarkdownReport(report: Phase52PipelineReport) {
  const phaseLabel = report.reportVersion.startsWith('phase5.3') ? '5.3 Release-Blocker Reduction' : '5.2 Golden Pipeline';
  const lines = [
    `# Recognition V2 Phase ${phaseLabel} Report`,
    '',
    `- Started: ${report.startedAt}`,
    `- Completed: ${report.completedAt}`,
    `- Mode: ${report.useModel ? 'rules + configured model' : 'deterministic rules only'}`,
    `- Topology golden passed: ${report.summary.passed}/${report.summary.total}`,
    `- Average score: ${report.summary.averageScore}`,
    `- Release decisions: ${JSON.stringify(report.summary.releaseCounts ?? {})}`,
    '',
    '| Order | Case | Category | Score | Topology | 424 release | Remaining blockers |',
    '| ---: | --- | --- | ---: | --- | --- | --- |',
  ];
  report.cases.forEach((item, index) => {
    const failures = item.failureReasons.map((failure) => `${failure.code}@${failure.stage}`).join(', ') || '-';
    lines.push(`| ${index + 1} | ${item.caseId} | ${item.category} | ${item.score} | ${item.topologyPassed ? 'PASS' : 'FAIL'} | ${item.releaseDecision ?? 'NOT_RUN'} | ${failures} |`);
  });
  for (const item of report.cases) {
    lines.push('', `## ${item.caseId}`, '', `Run: ${item.runId ?? 'not created'} (${item.runStatus ?? 'unknown'}); topology=${item.topologyPassed ? 'PASS' : 'FAIL'}; 424 release=${item.releaseDecision ?? 'NOT_RUN'}`, '');
    if (item.sourceFallbackUsed) lines.push('- Source fallback: local raster OCR was used because the embedded text layer was incomplete.');
    lines.push(...item.stages.map((stage) => `- ${stage.stage}: ${stage.status}, ${stage.durationMs} ms, ${JSON.stringify(stage.metrics ?? {})}`));
    if (item.reviewIssueCount) lines.push(`- Open review issues: ${item.reviewIssueCount}; rules=${JSON.stringify(item.reviewRuleCounts ?? {})}`);
    if (item.failureReasons.length) {
      lines.push('', 'Remaining full-pipeline blockers:', '');
      lines.push(...item.failureReasons.map((failure) => `- ${failure.code} / ${failure.stage}: ${failure.message}`));
    }
  }
  return `${lines.join('\n')}\n`;
}
