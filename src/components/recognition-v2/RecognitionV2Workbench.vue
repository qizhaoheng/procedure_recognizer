<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { AlertTriangle, Ban, Check, ChevronRight, CircleDashed, Eye, FileCheck2, FileDiff, Layers3, Pencil, Play, RefreshCw, ShieldCheck, Square, X } from 'lucide-vue-next';
import PdfEvidencePage from './PdfEvidencePage.vue';
import type {
  CanonicalPreviewArtifact,
  ExtractionStageResult,
  FieldCandidate,
  FusionStageResult,
  HumanReviewItem,
  HumanReviewStageResult,
  RecognitionV2RunManifest,
  RecognitionV2Stage,
  SourceEvidence,
  StageRunRecord,
  V1V2DiffReport,
  ValidationStageResult,
  PublicationLedger,
  PublicationWorkspace,
} from '../../types/recognitionV2';
import { parseReviewCorrection } from '../../utils/reviewCorrection';

interface AirportPackageOption { packageId?: string; groupId: string; packageName?: string; groupName: string; procedureCategory: string; procedureNames: string[] }
const props = defineProps<{ taskId: string; packageId: string; packageName?: string; packages?: AirportPackageOption[] }>();
const emit = defineEmits<{
  (event: 'updated', run: RecognitionV2RunManifest): void;
  (event: 'select-package', packageId: string): void;
}>();

type WorkbenchTab = 'candidates' | 'topology' | 'conflicts' | 'validation' | 'review' | 'preview' | 'publication' | 'artifacts';
type ArtifactMap = Partial<Record<RecognitionV2Stage, unknown>> & { canonicalPreview?: CanonicalPreviewArtifact; diff?: V1V2DiffReport };

const STAGES: RecognitionV2Stage[] = [
  'PAGE_LAYOUT', 'PROCEDURE_IDENTITY', 'PROCEDURE_TABLE', 'WAYPOINT_NAVAID', 'NOTES_CONSTRAINTS',
  'CHART_TOPOLOGY', 'EVIDENCE_FUSION', 'SEMANTIC_VALIDATION', 'HUMAN_REVIEW', 'PUBLISH_CANONICAL',
];
const EXECUTABLE = new Set<RecognitionV2Stage>(['PAGE_LAYOUT', 'PROCEDURE_IDENTITY', 'PROCEDURE_TABLE', 'WAYPOINT_NAVAID', 'NOTES_CONSTRAINTS', 'CHART_TOPOLOGY', 'EVIDENCE_FUSION', 'SEMANTIC_VALIDATION']);
const SKIPPABLE = new Set<RecognitionV2Stage>();
const DEPENDENCIES: Record<RecognitionV2Stage, RecognitionV2Stage[]> = {
  PAGE_LAYOUT: [],
  PROCEDURE_IDENTITY: ['PAGE_LAYOUT'],
  PROCEDURE_TABLE: ['PAGE_LAYOUT'],
  WAYPOINT_NAVAID: ['PAGE_LAYOUT'],
  NOTES_CONSTRAINTS: ['PAGE_LAYOUT'],
  CHART_TOPOLOGY: ['PAGE_LAYOUT', 'PROCEDURE_TABLE'],
  EVIDENCE_FUSION: ['PROCEDURE_IDENTITY', 'PROCEDURE_TABLE', 'WAYPOINT_NAVAID', 'NOTES_CONSTRAINTS', 'CHART_TOPOLOGY'],
  SEMANTIC_VALIDATION: ['EVIDENCE_FUSION'],
  HUMAN_REVIEW: ['SEMANTIC_VALIDATION'],
  PUBLISH_CANONICAL: ['SEMANTIC_VALIDATION'],
};

const stageLabels: Record<RecognitionV2Stage, string> = {
  PAGE_LAYOUT: '页面角色与区域',
  PROCEDURE_IDENTITY: '程序身份',
  PROCEDURE_TABLE: '程序表格',
  WAYPOINT_NAVAID: '坐标与导航台',
  NOTES_CONSTRAINTS: '注记与约束',
  CHART_TOPOLOGY: '航图拓扑',
  EVIDENCE_FUSION: '候选融合',
  SEMANTIC_VALIDATION: '语义校验',
  HUMAN_REVIEW: '人工复核',
  PUBLISH_CANONICAL: '正式发布',
};
const stageShortLabels: Record<RecognitionV2Stage, string> = {
  PAGE_LAYOUT: '版式', PROCEDURE_IDENTITY: '身份', PROCEDURE_TABLE: '表格', WAYPOINT_NAVAID: '坐标',
  NOTES_CONSTRAINTS: '注记', CHART_TOPOLOGY: '拓扑', EVIDENCE_FUSION: '融合', SEMANTIC_VALIDATION: '校验',
  HUMAN_REVIEW: '复核', PUBLISH_CANONICAL: '发布',
};

const runs = ref<RecognitionV2RunManifest[]>([]);
const selectedRunId = ref('');
const artifacts = ref<ArtifactMap>({});
const loading = ref(false);
const busyStage = ref<RecognitionV2Stage>();
const creating = ref(false);
const cancelling = ref(false);
const autoPipelineBusy = ref(false);
const AUTO_MODEL_STAGES = new Set<RecognitionV2Stage>(['PAGE_LAYOUT', 'NOTES_CONSTRAINTS', 'CHART_TOPOLOGY']);
const activeTab = ref<WorkbenchTab>('publication');
const error = ref('');
const notice = ref('');
const selectedCandidateId = ref('');
const reviewWorkspace = ref<HumanReviewStageResult>();
const reviewBusy = ref(false);
const publicationBusy = ref(false);
const publicationWorkspace = ref<PublicationWorkspace>();
const publicationLedger = ref<PublicationLedger>();
const viewed424Text = ref('');
const viewed424Title = ref('');
const viewing424 = ref(false);
const reference424Text = ref('');
const referenceCompareBusy = ref(false);
const airportReference424Text = ref('');
const airportReferenceCompareBusy = ref(false);
interface Reference424Field { field: string; label: string; startColumn: number; endColumn: number; systemValue: string; referenceValue: string; matched: boolean; severity: 'STANDARD' | 'SUPPLIER_METADATA' }
interface Reference424Record { recordKey: string; status: 'MATCH' | 'DIFFERENT' | 'METADATA_ONLY' | 'MISSING_SYSTEM' | 'MISSING_REFERENCE'; systemLine?: string; referenceLine?: string; fields: Reference424Field[] }
interface Reference424Comparison { systemLineCount: number; referenceLineCount: number; matchedRecordCount: number; differingRecordCount: number; missingSystemCount: number; missingReferenceCount: number; standardDifferenceCount: number; supplierMetadataDifferenceCount: number; records: Reference424Record[] }
const reference424Comparison = ref<Reference424Comparison>();
const airportReference424Comparison = ref<Reference424Comparison>();
interface Airport424Aggregate {
  releaseScope: 'AIRPORT'; airportIcao?: string; airportComplete: boolean; publishable: boolean;
  packageCount: number; activeReleaseCount: number; lineCount: number; duplicateLineCount: number; text: string;
  packageReleases: Array<{ packageId: string; packageName: string; releaseId: string; runId: string }>;
  masterEncodingIssues: string[];
  missingPackages: Array<{ packageId: string; packageName: string; reason: 'NO_ACTIVE_RELEASE' }>;
  conflicts: Array<{ recordKey: string; packageIds: string[]; lines: string[]; message: string }>;
  coverage: Array<{ category: string; sourceCount: number; exportedCount: number; status: 'COMPLETE' | 'NOT_EXTRACTED' | 'NOT_EXPORTED' | 'PARTIAL'; message: string }>;
}
const airport424Aggregate = ref<Airport424Aggregate>();
interface AirportFormalRelease { releaseId: string; artifactFile: string; textHash: string; lineCount: number; packageReleaseCount: number; status: 'ACTIVE' | 'SUPERSEDED' | 'ROLLED_BACK'; publishedAt: string; rolledBackAt?: string }
interface AirportFormalLedger { version: 1; activeReleaseId?: string; releases: AirportFormalRelease[]; updatedAt: string }
const airportFormalLedger = ref<AirportFormalLedger>();
const airportFormalStale = ref(false);
const airportFormalBusy = ref(false);
interface AirportBatchIssue { packageId: string; packageName: string; phase: string; category: 'MODEL_OUTPUT' | 'SOURCE_DATA' | 'VALIDATION' | 'SYSTEM'; message: string }
interface AirportBatchPackageStatus {
  packageId: string; packageName: string; state: 'NOT_STARTED' | 'PAUSED' | 'RUNNING' | 'NEEDS_OPTIMIZATION' | 'READY_TO_PUBLISH' | 'PUBLISHED';
  runId?: string; runStatus?: string; activeStage?: RecognitionV2Stage; activeReleaseId?: string; pendingReviewCount?: number; completedStageCount: number; updatedAt?: string;
  issue?: { phase: string; category: AirportBatchIssue['category']; message: string; retryable: boolean };
}
interface AirportBatchStatus {
  taskId: string; packageCount: number; notStartedCount: number; runningCount: number; pausedCount: number;
  needsOptimizationCount: number; readyToPublishCount: number; activeReleaseCount: number;
  packages: AirportBatchPackageStatus[]; generatedAt: string;
}
const airportBatchStatus = ref<AirportBatchStatus>();
const airportBatchBusy = ref(false);
const airportBatchCurrent = ref('');
const airportBatchCompleted = ref(0);
const airportBatchTotal = ref(0);
const airportBatchIssues = ref<AirportBatchIssue[]>([]);
const airportBatchPublished = ref(0);
const airportBatchCancelRequested = ref(false);
const AIRPORT_BATCH_MODEL_STAGES = new Set<RecognitionV2Stage>([
  'PAGE_LAYOUT', 'PROCEDURE_IDENTITY', 'PROCEDURE_TABLE', 'WAYPOINT_NAVAID', 'NOTES_CONSTRAINTS', 'CHART_TOPOLOGY',
]);
const reviewActionFeedback = ref<{ type: 'error' | 'success'; text: string }>();
const reviewProcedureFilter = ref('ALL');
const selectedReviewItemId = ref('');
const selectedReviewBundleId = ref('');
const correctionDraft = ref('');
const reviewNote = ref('');
const skipReasons = ref<Record<string, string>>({});

const selectedRun = computed(() => runs.value.find((run) => run.runId === selectedRunId.value));
const airportReferenceVisibleRecords = computed(() => {
  const records = airportReference424Comparison.value?.records ?? [];
  const differences = records.filter((item) => item.status !== 'MATCH');
  return (differences.length ? differences : records).slice(0, 500);
});
const stageRecords = computed(() => new Map(selectedRun.value?.stages.map((stage) => [stage.stage, stage]) ?? []));
const fusion = computed(() => artifacts.value.EVIDENCE_FUSION as FusionStageResult | undefined);
const validation = computed(() => reviewWorkspace.value?.reviewedValidation ?? artifacts.value.SEMANTIC_VALIDATION as ValidationStageResult | undefined);
const extractionResults = computed(() => {
  const results: ExtractionStageResult[] = [];
  for (const stage of ['PROCEDURE_IDENTITY', 'PROCEDURE_TABLE', 'WAYPOINT_NAVAID', 'NOTES_CONSTRAINTS', 'CHART_TOPOLOGY'] as RecognitionV2Stage[]) {
    const artifact = artifacts.value[stage] as Record<string, unknown> | undefined;
    if (!artifact) continue;
    const extraction = (artifact.extraction ?? artifact) as ExtractionStageResult;
    if (Array.isArray(extraction.candidates) && Array.isArray(extraction.evidence)) results.push(extraction);
  }
  return results;
});
const candidates = computed(() => extractionResults.value.flatMap((item) => item.candidates));
const topologyCandidates = computed(() => candidates.value.filter((item) => item.entityType === 'TOPOLOGY'));
const topologyEdges = computed(() => topologyCandidates.value.filter((item) => item.fieldName === 'edge'));
const topologyNodes = computed(() => topologyCandidates.value.filter((item) => item.fieldName === 'presentOnChart'));
const evidence = computed(() => extractionResults.value.flatMap((item) => item.evidence));
const candidateById = computed(() => new Map(candidates.value.map((item) => [item.candidateId, item])));
const evidenceById = computed(() => new Map(evidence.value.map((item) => [item.evidenceId, item])));
const selectedCandidate = computed(() => candidateById.value.get(selectedCandidateId.value));
const selectedEvidence = computed(() => selectedCandidate.value?.sourceEvidenceIds.map((id) => evidenceById.value.get(id)).filter((item): item is SourceEvidence => Boolean(item)) ?? []);
const reviewEvidenceById = computed(() => new Map(reviewWorkspace.value?.evidence.map((item) => [item.evidenceId, item]) ?? []));
const reviewProcedures = computed(() => [...new Set(reviewWorkspace.value?.items.flatMap((item) => item.procedureNames) ?? [])].sort());
const visibleReviewItems = computed(() => (reviewWorkspace.value?.items ?? []).filter((item) => reviewProcedureFilter.value === 'ALL' || item.procedureNames.includes(reviewProcedureFilter.value)));
interface ReviewBundle { bundleId: string; label: string; entityType: string; entityKey: string; procedureNames: string[]; items: HumanReviewItem[] }
const visibleReviewBundles = computed<ReviewBundle[]>(() => {
  const groups = new Map<string, ReviewBundle>();
  for (const item of visibleReviewItems.value) {
    const groupEntity = ['FIX', 'NAVAID', 'LEG', 'TOPOLOGY', 'CONSTRAINT'].includes(item.entityType);
    const bundleId = groupEntity ? `${item.entityType}:${item.entityKey}` : `${item.entityType}:${item.entityKey}:${item.fieldName}`;
    const bundle = groups.get(bundleId) ?? {
      bundleId,
      label: item.entityType === 'LEG' ? '程序航段行' : item.entityType === 'FIX' || item.entityType === 'NAVAID' ? '坐标/导航台行' : item.entityType === 'TOPOLOGY' ? '拓扑关系' : item.entityType === 'CONSTRAINT' ? '注记与约束' : '单字段确认',
      entityType: item.entityType, entityKey: item.entityKey, procedureNames: item.procedureNames, items: [],
    };
    bundle.items.push(item);
    bundle.procedureNames = [...new Set([...bundle.procedureNames, ...item.procedureNames])].sort();
    groups.set(bundleId, bundle);
  }
  return [...groups.values()].sort((a, b) => `${a.procedureNames.join('|')}:${a.entityKey}`.localeCompare(`${b.procedureNames.join('|')}:${b.entityKey}`));
});
const selectedReviewBundle = computed(() => visibleReviewBundles.value.find((item) => item.bundleId === selectedReviewBundleId.value));
const selectedReviewItem = computed(() => reviewWorkspace.value?.items.find((item) => item.reviewItemId === selectedReviewItemId.value));
const selectedReviewEvidence = computed(() => [...new Set(selectedReviewBundle.value?.items.flatMap((item) => item.evidenceIds) ?? selectedReviewItem.value?.evidenceIds ?? [])].map((id) => reviewEvidenceById.value.get(id)).filter((item): item is SourceEvidence => Boolean(item)));
const pendingBundleCount = computed(() => visibleReviewBundles.value.filter((bundle) => bundle.items.some((item) => item.status === 'PENDING')).length);
const activeRunning = computed(() => selectedRun.value?.stages.some((stage) => stage.status === 'RUNNING') ?? false);
const nextRunnableStage = computed(() => STAGES.find((stage) => EXECUTABLE.has(stage) && !['COMPLETED', 'SKIPPED'].includes(stageRecord(stage)?.status ?? '') && canRun(stage)));
const completedCount = computed(() => selectedRun.value?.stages.filter((stage) => stage.status === 'COMPLETED' || stage.status === 'SKIPPED').length ?? 0);
const blockingCount = computed(() => validation.value?.blockingIssueCount ?? fusion.value?.unresolvedItems.filter((item) => item.blockingFor424).length ?? 0);
const reviewCount = computed(() => reviewWorkspace.value?.summary.criticalPending ?? validation.value?.reviewIssueCount ?? fusion.value?.unresolvedItems.filter((item) => !item.blockingFor424).length ?? 0);
const releaseDecision = computed(() => validation.value?.releaseDecision ?? 'NOT_VALIDATED');
const runStatusLabel = computed(() => selectedRun.value ? runStatusText(selectedRun.value.status) : '尚未创建识别任务');

function stageRecord(stage: RecognitionV2Stage) {
  return stageRecords.value.get(stage);
}

function canRun(stage: RecognitionV2Stage) {
  if (!selectedRun.value || activeRunning.value || selectedRun.value.status === 'CANCELLED' || !EXECUTABLE.has(stage)) return false;
  return DEPENDENCIES[stage].every((dependency) => ['COMPLETED', 'SKIPPED'].includes(stageRecord(dependency)?.status ?? ''));
}

function canSkip(stage: RecognitionV2Stage) {
  if (!selectedRun.value || activeRunning.value || selectedRun.value.status === 'CANCELLED' || !SKIPPABLE.has(stage)) return false;
  return DEPENDENCIES[stage].every((dependency) => ['COMPLETED', 'SKIPPED'].includes(stageRecord(dependency)?.status ?? ''));
}

async function loadRuns(selectRunId?: string) {
  if (!props.taskId || !props.packageId) return;
  loading.value = true;
  error.value = '';
  try {
    const response = await requestJson<{ runs: RecognitionV2RunManifest[] }>(baseUrl('/runs'));
    runs.value = [...response.runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    selectedRunId.value = selectRunId && runs.value.some((item) => item.runId === selectRunId)
      ? selectRunId
      : runs.value.some((item) => item.runId === selectedRunId.value) ? selectedRunId.value : runs.value[0]?.runId ?? '';
    await Promise.all([loadArtifacts(), loadAirport424Aggregate(), loadAirportBatchStatus(), loadAirportFormalPublication()]);
  } catch (value) {
    error.value = errorMessage(value);
  } finally {
    loading.value = false;
  }
}

async function loadAirport424Aggregate() {
  airport424Aggregate.value = await requestJson<{ aggregate: Airport424Aggregate }>(
    `/api/procedure-tasks/${encodeURIComponent(props.taskId)}/recognition-v2/airport-publication`,
  ).then((response) => response.aggregate).catch(() => undefined);
}

async function loadAirportBatchStatus() {
  const status = await requestJson<{ status: AirportBatchStatus }>(
    `/api/procedure-tasks/${encodeURIComponent(props.taskId)}/recognition-v2/airport-batch-status`,
  ).then((response) => response.status).catch(() => undefined);
  airportBatchStatus.value = status;
  if (!status || airportBatchBusy.value) return;
  airportBatchTotal.value = status.packageCount;
  airportBatchCompleted.value = status.packageCount - status.notStartedCount;
  airportBatchPublished.value = status.activeReleaseCount;
  airportBatchIssues.value = status.packages.flatMap((item) => item.issue ? [{
    packageId: item.packageId,
    packageName: item.packageName,
    phase: item.issue.phase,
    category: item.issue.category,
    message: item.issue.message,
  }] : []);
}

async function loadAirportFormalPublication() {
  const result = await requestJson<{ ledger?: AirportFormalLedger; stale: boolean }>(
    `/api/procedure-tasks/${encodeURIComponent(props.taskId)}/recognition-v2/airport-publication/releases`,
  ).catch(() => undefined);
  airportFormalLedger.value = result?.ledger;
  airportFormalStale.value = result?.stale ?? false;
}

async function refreshAirportOverview() {
  await Promise.all([loadAirport424Aggregate(), loadAirportBatchStatus(), loadAirportFormalPublication()]);
}

async function publishAirportFormalRelease() {
  if (!airport424Aggregate.value?.airportComplete) return;
  airportFormalBusy.value = true;
  error.value = '';
  try {
    const response = await requestJson<{ release: { releaseId: string }; ledger: AirportFormalLedger }>(
      `/api/procedure-tasks/${encodeURIComponent(props.taskId)}/recognition-v2/airport-publication/publish`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
    );
    airportFormalLedger.value = response.ledger;
    airportFormalStale.value = false;
    notice.value = `机场正式版本 ${response.release.releaseId} 已发布。`;
  } catch (value) {
    error.value = errorMessage(value);
  } finally {
    airportFormalBusy.value = false;
  }
}

async function viewAirportFormalRelease(releaseId: string) {
  viewing424.value = true;
  error.value = '';
  try {
    const response = await requestJson<{ release: { airportIcao: string; text: string } }>(
      `/api/procedure-tasks/${encodeURIComponent(props.taskId)}/recognition-v2/airport-publication/releases/${encodeURIComponent(releaseId)}`,
    );
    viewed424Text.value = response.release.text;
    viewed424Title.value = `${response.release.airportIcao} 机场正式 424 · ${releaseId}`;
  } catch (value) {
    error.value = errorMessage(value);
  } finally {
    viewing424.value = false;
  }
}

async function rollbackAirportFormalRelease() {
  if (!airportFormalLedger.value?.activeReleaseId || airportFormalLedger.value.releases.length < 2) return;
  if (!window.confirm('确认把机场正式 424 切换到上一个历史版本？当前发布文件不会被删除。')) return;
  airportFormalBusy.value = true;
  error.value = '';
  try {
    const response = await requestJson<{ ledger: AirportFormalLedger }>(
      `/api/procedure-tasks/${encodeURIComponent(props.taskId)}/recognition-v2/airport-publication/rollback`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
    );
    airportFormalLedger.value = response.ledger;
    notice.value = `机场正式版本已切换为 ${response.ledger.activeReleaseId}。`;
  } catch (value) {
    error.value = errorMessage(value);
  } finally {
    airportFormalBusy.value = false;
  }
}

async function runAirportPipeline() {
  const packages = (props.packages ?? []).filter((item) => item.procedureCategory !== 'UNKNOWN' && item.procedureNames.length > 0);
  if (!packages.length || airportBatchBusy.value) return;
  airportBatchBusy.value = true;
  airportBatchCancelRequested.value = false;
  airportBatchIssues.value = [];
  airportBatchCompleted.value = 0;
  airportBatchPublished.value = 0;
  airportBatchTotal.value = packages.length;
  error.value = '';
  for (const item of packages) {
    if (airportBatchCancelRequested.value) break;
    const packageId = item.packageId || item.groupId;
    const packageName = item.packageName || item.groupName;
    airportBatchCurrent.value = packageName;
    try {
      const result = await processAirportPackage(packageId);
      if (result === 'PUBLISHED') airportBatchPublished.value += 1;
    } catch (value) {
      const message = errorMessage(value);
      airportBatchIssues.value.push({ packageId, packageName, phase: batchFailurePhase(message), category: batchFailureCategory(message), message });
    } finally {
      airportBatchCompleted.value += 1;
    }
  }
  airportBatchCurrent.value = '';
  airportBatchBusy.value = false;
  await Promise.all([loadAirport424Aggregate(), loadAirportBatchStatus(), loadAirportFormalPublication(), loadRuns(selectedRunId.value)]);
  notice.value = airportBatchCancelRequested.value
    ? `全机场处理已暂停；已完成 ${airportBatchCompleted.value}/${airportBatchTotal.value}，再次点击会从已有 Run 继续。`
    : `全机场处理完成：本次发布 ${airportBatchPublished.value} 个程序包，${airportBatchIssues.value.length} 个异常已进入程序优化清单。`;
}

function stopAirportPipeline() {
  airportBatchCancelRequested.value = true;
  notice.value = '将在当前阶段完成后暂停；已经生成的 Run 和 artifact 会保留，下次可继续。';
}

async function processAirportPackage(packageId: string): Promise<'PUBLISHED' | 'ALREADY_PUBLISHED'> {
  const packageUrl = (suffix: string) => `/api/procedure-tasks/${encodeURIComponent(props.taskId)}/packages/${encodeURIComponent(packageId)}/recognition-v2${suffix}`;
  const packageRuns = await requestJson<{ runs: RecognitionV2RunManifest[] }>(packageUrl('/runs')).then((value) => value.runs);
  const existingRun = packageRuns.find((item) => !['CANCELLED'].includes(item.status));
  let run: RecognitionV2RunManifest;
  if (existingRun) {
    run = existingRun;
  } else {
    run = await requestJson<{ run: RecognitionV2RunManifest }>(packageUrl('/runs'), { method: 'POST' }).then((value) => value.run);
  }
  if (run.status === 'COMPLETED') {
    const completedPublication = await requestJson<{ ledger?: PublicationLedger; activeReleaseStale?: boolean; activeReleaseStaleReason?: string }>(packageUrl(`/runs/${encodeURIComponent(run.runId)}/publication`));
    const activeRelease = completedPublication.ledger?.releases.find((item) => item.releaseId === completedPublication.ledger?.activeReleaseId);
    if (activeRelease?.runId === run.runId) {
      if (completedPublication.activeReleaseStaleReason) throw new Error(`PUBLISH_CANONICAL: ${completedPublication.activeReleaseStaleReason}`);
      if (completedPublication.activeReleaseStale) {
        try {
          await requestJson(packageUrl(`/runs/${encodeURIComponent(run.runId)}/publication/reencode`), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
          return 'PUBLISHED';
        } catch (value) {
          const message = errorMessage(value);
          if (/不能只靠重新编码|回读存在阻断差异/.test(message)) {
            await requestJson<{ run: RecognitionV2RunManifest }>(packageUrl('/runs'), { method: 'POST' });
            return processAirportPackage(packageId);
          }
          throw value;
        }
      }
      return 'ALREADY_PUBLISHED';
    }
    run = await requestJson<{ run: RecognitionV2RunManifest }>(packageUrl('/runs'), { method: 'POST' }).then((value) => value.run);
  }

  for (const stage of STAGES.filter((item) => EXECUTABLE.has(item))) {
    const record = run.stages.find((item) => item.stage === stage);
    if (record && ['COMPLETED', 'SKIPPED'].includes(record.status)) continue;
    try {
      run = await requestJson<{ run: RecognitionV2RunManifest }>(packageUrl(`/runs/${encodeURIComponent(run.runId)}/stages/${stage}/run`), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ useModel: AIRPORT_BATCH_MODEL_STAGES.has(stage) }),
      }).then((value) => value.run);
    } catch (value) {
      const message = errorMessage(value);
      if (/SOURCE_PACKAGE_CHANGED/i.test(message) || /changed after this V2 run/i.test(message)) {
        run = await requestJson<{ run: RecognitionV2RunManifest }>(packageUrl('/runs'), { method: 'POST' }).then((response) => response.run);
        return processAirportPackage(packageId);
      }
      throw new Error(`${stage}: ${message}`);
    }
  }

  let review = await requestJson<{ review: HumanReviewStageResult }>(packageUrl(`/runs/${encodeURIComponent(run.runId)}/review/initialize`), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  }).then((value) => value.review);
  if (review.summary.pending > 0) throw new Error(`HUMAN_REVIEW: 仍有 ${review.summary.pending} 个无法由程序安全决定的异常字段。`);
  if (run.stages.find((item) => item.stage === 'HUMAN_REVIEW')?.status !== 'COMPLETED') {
    const completed = await requestJson<{ run: RecognitionV2RunManifest; review: HumanReviewStageResult }>(packageUrl(`/runs/${encodeURIComponent(run.runId)}/review/complete`), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedUpdatedAt: review.updatedAt }),
    });
    run = completed.run;
    review = completed.review;
  }
  if (run.status !== 'APPROVED') throw new Error(`HUMAN_REVIEW: Run 未达到 APPROVED（当前 ${run.status}）。`);

  let publication = await requestJson<{ workspace?: PublicationWorkspace; ledger?: PublicationLedger }>(packageUrl(`/runs/${encodeURIComponent(run.runId)}/publication`));
  const activeRelease = publication.ledger?.releases.find((item) => item.releaseId === publication.ledger?.activeReleaseId);
  if (activeRelease?.runId === run.runId) return 'ALREADY_PUBLISHED';
  if (!publication.workspace || publication.workspace.status === 'STALE') {
    publication = await requestJson<{ workspace: PublicationWorkspace }>(packageUrl(`/runs/${encodeURIComponent(run.runId)}/publication/lock`), { method: 'POST' });
  }
  let workspace = await requestJson<{ workspace: PublicationWorkspace }>(packageUrl(`/runs/${encodeURIComponent(run.runId)}/publication/preflight`), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then((value) => value.workspace);
  if (!workspace.preflight?.passed) {
    const blockers = workspace.preflight?.checks.filter((item) => item.status === 'BLOCK').map((item) => `${item.code}: ${item.message}`).join('; ');
    throw new Error(`PREFLIGHT: ${blockers || '发布前预检未通过。'}`);
  }
  workspace = await requestJson<{ workspace: PublicationWorkspace }>(packageUrl(`/runs/${encodeURIComponent(run.runId)}/publication/dry-run`), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then((value) => value.workspace);
  workspace = await requestJson<{ workspace: PublicationWorkspace }>(packageUrl(`/runs/${encodeURIComponent(run.runId)}/publication/diff`), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then((value) => value.workspace);
  if ((workspace.diff?.blockingDifferenceCount ?? 1) > 0) throw new Error(`DRY_RUN_DIFF: 回读发现 ${workspace.diff?.blockingDifferenceCount ?? '?'} 个阻断差异。`);
  workspace = await requestJson<{ workspace: PublicationWorkspace }>(packageUrl(`/runs/${encodeURIComponent(run.runId)}/publication/diff/accept`), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then((value) => value.workspace);
  if (workspace.status !== 'PUBLISHABLE') throw new Error(`PUBLICATION: 发布门禁状态为 ${workspace.status}。`);
  await requestJson(packageUrl(`/runs/${encodeURIComponent(run.runId)}/publication/publish`), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  return 'PUBLISHED';
}

function batchFailurePhase(message: string) {
  return message.match(/^([A-Z_]+):/)?.[1] ?? 'SYSTEM';
}

function batchFailureCategory(message: string): AirportBatchIssue['category'] {
  if (/contract validation|model|vision|schema/i.test(message)) return 'MODEL_OUTPUT';
  if (/missing|缺少|source|evidence|coordinate|坐标/i.test(message)) return 'SOURCE_DATA';
  if (/validation|review|preflight|diff|conflict|阻断|校验/i.test(message)) return 'VALIDATION';
  return 'SYSTEM';
}

async function createRun() {
  creating.value = true;
  error.value = '';
  try {
    const response = await requestJson<{ run: RecognitionV2RunManifest }>(baseUrl('/runs'), { method: 'POST' });
    notice.value = '已创建独立识别任务；当前正式数据只会在通过发布门禁后更新。';
    await loadRuns(response.run.runId);
    emit('updated', response.run);
  } catch (value) {
    error.value = errorMessage(value);
  } finally {
    creating.value = false;
  }
}

async function runStage(stage: RecognitionV2Stage) {
  if (!selectedRun.value || !canRun(stage)) return;
  busyStage.value = stage;
  error.value = '';
  notice.value = `正在执行：${stageLabels[stage]}`;
  try {
    const response = await requestJson<{ run: RecognitionV2RunManifest }>(baseUrl(`/runs/${selectedRun.value.runId}/stages/${stage}/run`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ useModel: AUTO_MODEL_STAGES.has(stage) }),
    });
    notice.value = `${stageLabels[stage]}执行完成。`;
    await loadRuns(response.run.runId);
    emit('updated', response.run);
    if (stage === 'EVIDENCE_FUSION') activeTab.value = 'conflicts';
    if (stage === 'CHART_TOPOLOGY') activeTab.value = 'topology';
    if (stage === 'SEMANTIC_VALIDATION') activeTab.value = 'validation';
  } catch (value) {
    error.value = errorMessage(value);
    notice.value = '';
    await loadRuns(selectedRun.value.runId);
  } finally {
    busyStage.value = undefined;
  }
}

async function runNextStage() {
  if (nextRunnableStage.value) await runStage(nextRunnableStage.value);
}

async function runAutomaticPipeline() {
  autoPipelineBusy.value = true;
  error.value = '';
  try {
    while (nextRunnableStage.value && !error.value) await runStage(nextRunnableStage.value);
    if (!error.value && !reviewWorkspace.value && stageRecord('SEMANTIC_VALIDATION')?.status === 'COMPLETED') {
      await initializeReview();
    }
    if (!error.value && reviewWorkspace.value && reviewWorkspace.value.summary.pending === 0) {
      await completeReview();
      if (!error.value) notice.value = '识别、确定性校验和可复现字段确认已自动完成，当前 Run 已提升为 READY。';
    } else if (!error.value) {
      notice.value = '自动识别和校验已完成；页面只保留无法由程序安全决定的异常项。';
      activeTab.value = 'review';
    }
  } finally {
    autoPipelineBusy.value = false;
  }
}

async function skipStage(stage: RecognitionV2Stage) {
  if (!selectedRun.value || !canSkip(stage)) return;
  const reason = String(skipReasons.value[stage] ?? '').trim();
  if (!reason) {
    error.value = `${stageLabels[stage]}必须填写跳过原因。`;
    return;
  }
  busyStage.value = stage;
  error.value = '';
  try {
    const response = await requestJson<{ run: RecognitionV2RunManifest }>(baseUrl(`/runs/${selectedRun.value.runId}/stages/${stage}/skip`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason }),
    });
    notice.value = `已显式跳过${stageLabels[stage]}，原因已写入运行清单。`;
    await loadRuns(response.run.runId);
    emit('updated', response.run);
  } catch (value) {
    error.value = errorMessage(value);
  } finally {
    busyStage.value = undefined;
  }
}

async function cancelRun() {
  if (!selectedRun.value) return;
  cancelling.value = true;
  error.value = '';
  try {
    const response = await requestJson<{ run: RecognitionV2RunManifest }>(baseUrl(`/runs/${selectedRun.value.runId}/cancel`), { method: 'POST' });
    notice.value = '识别任务已取消，历史 artifact 仍保留用于审计。';
    await loadRuns(response.run.runId);
    emit('updated', response.run);
  } catch (value) {
    error.value = errorMessage(value);
  } finally {
    cancelling.value = false;
  }
}

async function loadArtifacts() {
  const run = selectedRun.value;
  artifacts.value = {};
  reviewWorkspace.value = undefined;
  publicationWorkspace.value = undefined;
  publicationLedger.value = undefined;
  viewed424Text.value = '';
  viewed424Title.value = '';
  selectedCandidateId.value = '';
  selectedReviewItemId.value = '';
  selectedReviewBundleId.value = '';
  if (!run) return;
  const next: ArtifactMap = {};
  await Promise.all(run.stages.map(async (stage) => {
    if (stage.status !== 'COMPLETED' || !stage.outputRef) return;
    const value = await readArtifact(stage.outputRef).catch(() => undefined);
    if (value !== undefined) next[stage.stage] = value;
  }));
  const validationRecord = run.stages.find((stage) => stage.stage === 'SEMANTIC_VALIDATION');
  if (validationRecord?.status === 'COMPLETED') {
    next.canonicalPreview = await readArtifact(`artifacts/canonical-preview-attempt-${validationRecord.attempt}.json`).catch(() => undefined) as CanonicalPreviewArtifact | undefined;
    next.diff = await readArtifact(`artifacts/v1-v2-diff-attempt-${validationRecord.attempt}.json`).catch(() => undefined) as V1V2DiffReport | undefined;
  }
  let review = next.HUMAN_REVIEW as HumanReviewStageResult | undefined;
  if (!review && validationRecord?.status === 'COMPLETED') {
    review = await requestJson<{ review: HumanReviewStageResult }>(baseUrl(`/runs/${run.runId}/review`)).then((value) => value.review).catch(() => undefined);
  }
  reviewWorkspace.value = review;
  if (review?.canonicalPreviewRef) next.canonicalPreview = await readArtifact(review.canonicalPreviewRef).catch(() => next.canonicalPreview) as CanonicalPreviewArtifact | undefined;
  if (review?.diffRef) next.diff = await readArtifact(review.diffRef).catch(() => next.diff) as V1V2DiffReport | undefined;
  artifacts.value = next;
  const publication = await requestJson<{ workspace?: PublicationWorkspace; ledger?: PublicationLedger }>(baseUrl(`/runs/${run.runId}/publication`)).catch(() => undefined);
  publicationWorkspace.value = publication?.workspace;
  publicationLedger.value = publication?.ledger;
}

async function runPublicationAction(action: 'lock' | 'preflight' | 'dry-run' | 'diff' | 'diff/accept' | 'publish') {
  if (!selectedRun.value) return;
  publicationBusy.value = true;
  error.value = '';
  try {
    const response = await requestJson<{ workspace: PublicationWorkspace; run?: RecognitionV2RunManifest; ledger?: PublicationLedger }>(baseUrl(`/runs/${selectedRun.value.runId}/publication/${action}`), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    publicationWorkspace.value = response.workspace;
    if (response.ledger) publicationLedger.value = response.ledger;
    notice.value = action === 'publish' ? '正式发布完成，当前版本已成为下游 canonical。' : '发布门禁步骤已完成。';
    if (response.run) {
      await loadRuns(response.run.runId);
      activeTab.value = 'publication';
      emit('updated', response.run);
    }
  } catch (value) {
    error.value = errorMessage(value);
  } finally {
    publicationBusy.value = false;
  }
}

async function rollbackPublication() {
  if (!publicationLedger.value?.activeReleaseId || !window.confirm('确认回滚当前正式发布？系统会恢复上一发布版本；若没有上一版，则恢复发布前数据。')) return;
  publicationBusy.value = true;
  error.value = '';
  try {
    const response = await requestJson<{ ledger: PublicationLedger }>(baseUrl('/publication/rollback'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    publicationLedger.value = response.ledger;
    if (publicationWorkspace.value) publicationWorkspace.value = { ...publicationWorkspace.value, status: 'ROLLED_BACK' };
    notice.value = '回滚完成，历史发布文件与审计记录仍然保留。';
  } catch (value) { error.value = errorMessage(value); }
  finally { publicationBusy.value = false; }
}

async function view424(url: string, title: string) {
  viewing424.value = true;
  error.value = '';
  try {
    const response = await fetch(url);
    if (!response.ok) {
      const payload = await response.json().catch(() => undefined) as { error?: string } | undefined;
      throw new Error(payload?.error || `HTTP ${response.status}`);
    }
    viewed424Text.value = await response.text();
    viewed424Title.value = title;
  } catch (value) {
    error.value = errorMessage(value);
  } finally {
    viewing424.value = false;
  }
}

async function viewDryRun() {
  if (!selectedRun.value) return;
  await view424(baseUrl(`/runs/${selectedRun.value.runId}/publication/dry-run.txt`), '424 dry-run 预览');
}

function viewAirport424() {
  if (!airport424Aggregate.value?.text) return;
  viewed424Text.value = airport424Aggregate.value.text;
  viewed424Title.value = `${airport424Aggregate.value.airportIcao || '机场'} 424 汇总预览（当前已生效程序包）`;
}

async function compareReference424() {
  if (!selectedRun.value || !reference424Text.value.trim()) return;
  referenceCompareBusy.value = true;
  error.value = '';
  try {
    const response = await requestJson<{ comparison: Reference424Comparison }>(baseUrl(`/runs/${selectedRun.value.runId}/publication/compare-reference`), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: reference424Text.value }),
    });
    reference424Comparison.value = response.comparison;
    notice.value = response.comparison.standardDifferenceCount
      ? `逐字段对比完成：发现 ${response.comparison.standardDifferenceCount} 个标准字段差异。`
      : '逐字段对比完成：标准字段一致；供应商元数据差异已单独标记。';
  } catch (value) {
    error.value = errorMessage(value);
  } finally {
    referenceCompareBusy.value = false;
  }
}

async function compareAirportReference424() {
  if (!airportReference424Text.value.trim()) return;
  airportReferenceCompareBusy.value = true;
  error.value = '';
  try {
    const response = await requestJson<{ comparison: Reference424Comparison; airportComplete: boolean }>(
      `/api/procedure-tasks/${encodeURIComponent(props.taskId)}/recognition-v2/airport-publication/compare-reference`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: airportReference424Text.value }) },
    );
    airportReference424Comparison.value = response.comparison;
    notice.value = response.airportComplete
      ? `机场级逐字段对比完成：${response.comparison.standardDifferenceCount} 个标准字段差异。`
      : `当前机场 424 尚不完整；已对现有发布范围完成比较，参考文件中的其余记录会显示为系统缺失。`;
  } catch (value) {
    error.value = errorMessage(value);
  } finally {
    airportReferenceCompareBusy.value = false;
  }
}

function openV2GeoJsonPreview() {
  if (!selectedRun.value) return;
  const query = new URLSearchParams({ taskId: props.taskId, packageId: props.packageId, v2RunId: selectedRun.value.runId });
  window.open(`/procedure-geojson?${query.toString()}`, '_blank', 'noopener');
}

function openAirportGeoJsonPreview() {
  const query = new URLSearchParams({ taskId: props.taskId, airport: '1' });
  window.open(`/procedure-geojson?${query.toString()}`, '_blank', 'noopener');
}

async function viewRelease(releaseId: string) {
  await view424(baseUrl(`/publication/releases/${encodeURIComponent(releaseId)}/file`), `正式 424 · ${releaseId}`);
}

async function readArtifact(reference: string) {
  const fileName = reference.replace(/\\/g, '/').split('/').pop();
  if (!fileName || !selectedRun.value) throw new Error('Artifact reference is invalid.');
  return requestJson<unknown>(baseUrl(`/runs/${selectedRun.value.runId}/artifacts/${encodeURIComponent(fileName)}`));
}

function selectCandidate(candidate: FieldCandidate) {
  selectedCandidateId.value = selectedCandidateId.value === candidate.candidateId ? '' : candidate.candidateId;
}

function candidateValues(ids: string[]) {
  return ids.map((id) => candidateById.value.get(id)).filter((item): item is FieldCandidate => Boolean(item));
}

async function initializeReview() {
  if (!selectedRun.value) return;
  reviewBusy.value = true;
  error.value = '';
  try {
    const response = await requestJson<{ review: HumanReviewStageResult }>(baseUrl(`/runs/${selectedRun.value.runId}/review/initialize`), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    reviewWorkspace.value = response.review;
    activeTab.value = 'review';
    notice.value = `已把 ${response.review.summary.mergedSignalCount} 条复核信号合并为 ${response.review.summary.total} 个字段审核项。`;
  } catch (value) {
    error.value = errorMessage(value);
  } finally {
    reviewBusy.value = false;
  }
}

function selectReviewItem(item: HumanReviewItem) {
  reviewActionFeedback.value = undefined;
  selectedReviewItemId.value = item.reviewItemId;
  correctionDraft.value = correctionText(item.status === 'CORRECTED' ? item.correctedValue : item.currentValue);
  reviewNote.value = item.note ?? '';
}

function selectReviewBundle(bundle: ReviewBundle) {
  selectedReviewBundleId.value = bundle.bundleId;
  const target = bundle.items.find((item) => item.status === 'PENDING') ?? bundle.items[0];
  if (target) selectReviewItem(target);
}

function bundleStatus(bundle: ReviewBundle) {
  if (bundle.items.some((item) => item.status === 'PENDING')) return 'PENDING';
  return bundle.items.some((item) => item.status === 'CORRECTED') ? 'CORRECTED' : 'CONFIRMED';
}

function bundleCanConfirm(bundle: ReviewBundle) {
  const pending = bundle.items.filter((item) => item.status === 'PENDING');
  return pending.length > 0 && pending.every((item) => item.evidenceIds.length > 0 && (item.currentValue !== undefined || item.reasonCodes.length === 0));
}

async function confirmReviewBundle() {
  if (!selectedRun.value || !reviewWorkspace.value || !selectedReviewBundle.value) return;
  const decisions = selectedReviewBundle.value.items.filter((item) => item.status === 'PENDING').map((item) => ({ reviewItemId: item.reviewItemId, status: 'CONFIRMED', note: reviewNote.value }));
  if (!decisions.length || !bundleCanConfirm(selectedReviewBundle.value)) {
    reviewActionFeedback.value = { type: 'error', text: '该业务卡片包含缺值或无证据字段，需要逐字段修正。' };
    return;
  }
  reviewBusy.value = true;
  error.value = '';
  reviewActionFeedback.value = undefined;
  try {
    const response = await requestJson<{ review: HumanReviewStageResult; updatedItemCount: number }>(baseUrl(`/runs/${selectedRun.value.runId}/review/batch`), {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decisions, expectedUpdatedAt: reviewWorkspace.value.updatedAt }),
    });
    reviewWorkspace.value = response.review;
    const nextBundle = visibleReviewBundles.value.find((bundle) => bundle.items.some((item) => item.status === 'PENDING'));
    if (nextBundle) selectReviewBundle(nextBundle);
    reviewActionFeedback.value = { type: 'success', text: `已确认本卡片 ${response.updatedItemCount} 个待审字段。` };
    notice.value = `已一次确认 ${response.updatedItemCount} 个同源字段；每个字段均保留独立审计事件。`;
  } catch (value) {
    const message = errorMessage(value);
    error.value = message;
    reviewActionFeedback.value = { type: 'error', text: message };
  } finally { reviewBusy.value = false; }
}

async function saveReviewDecision(status: 'CONFIRMED' | 'CORRECTED') {
  if (!selectedRun.value || !reviewWorkspace.value || !selectedReviewItem.value) return;
  const reviewedField = selectedReviewItem.value.fieldName;
  let correctedValue: unknown;
  try {
    if (status === 'CORRECTED') correctedValue = parseReviewCorrection(correctionDraft.value, selectedReviewItem.value.currentValue);
  } catch (value) {
    const message = errorMessage(value);
    error.value = message;
    reviewActionFeedback.value = { type: 'error', text: message };
    return;
  }
  reviewBusy.value = true;
  error.value = '';
  reviewActionFeedback.value = undefined;
  try {
    const response = await requestJson<{ review: HumanReviewStageResult }>(baseUrl(`/runs/${selectedRun.value.runId}/review/items/${selectedReviewItem.value.reviewItemId}`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status, correctedValue, note: reviewNote.value, expectedUpdatedAt: reviewWorkspace.value.updatedAt }),
    });
    reviewWorkspace.value = response.review;
    const nextPending = visibleReviewItems.value.find((item) => item.status === 'PENDING');
    if (nextPending) selectReviewItem(nextPending);
    reviewActionFeedback.value = {
      type: 'success',
      text: status === 'CONFIRMED' ? `字段 ${reviewedField} 已确认。` : `字段 ${reviewedField} 的修正值已保存。`,
    };
    notice.value = status === 'CONFIRMED' ? '字段已确认，审核事件已写入审计记录。' : '修正值已保存，完成审核时会重新执行确定性校验。';
  } catch (value) {
    const message = errorMessage(value);
    error.value = message;
    reviewActionFeedback.value = { type: 'error', text: message };
  } finally {
    reviewBusy.value = false;
  }
}

async function completeReview() {
  if (!selectedRun.value || !reviewWorkspace.value) return;
  reviewBusy.value = true;
  error.value = '';
  try {
    const response = await requestJson<{ run: RecognitionV2RunManifest; review: HumanReviewStageResult }>(baseUrl(`/runs/${selectedRun.value.runId}/review/complete`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedUpdatedAt: reviewWorkspace.value.updatedAt }),
    });
    notice.value = '全部关键字段已确认并通过重新校验，当前 Run 已提升为 READY / APPROVED。';
    await loadRuns(response.run.runId);
    activeTab.value = 'review';
    emit('updated', response.run);
  } catch (value) {
    error.value = errorMessage(value);
    await loadArtifacts();
    activeTab.value = 'review';
  } finally {
    reviewBusy.value = false;
  }
}

function correctionText(value: unknown) {
  if (value === undefined || value === null) return '';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function evidenceHighlightTerms(evidenceItem: SourceEvidence) {
  const entityParts = selectedReviewBundle.value?.entityKey.split(':') ?? [];
  const entityHint = entityParts[entityParts.length - 1];
  const fieldValues = selectedReviewBundle.value?.items
    .filter((item) => item.evidenceIds.includes(evidenceItem.evidenceId))
    .flatMap((item) => [item.currentValue, ...item.suggestedValues])
    .flatMap(searchableEvidenceValues) ?? [];
  return [...new Set([entityHint, ...fieldValues, evidenceItem.rawText].filter((value): value is string => Boolean(value?.trim())))];
}

function searchableEvidenceValues(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (typeof value === 'number' || typeof value === 'boolean') return [String(value)];
  if (Array.isArray(value)) return value.flatMap(searchableEvidenceValues);
  if (value && typeof value === 'object') return Object.values(value).flatMap(searchableEvidenceValues);
  return [];
}

function baseUrl(suffix: string) {
  return `/api/procedure-tasks/${encodeURIComponent(props.taskId)}/packages/${encodeURIComponent(props.packageId)}/recognition-v2${suffix}`;
}

function statusText(status?: string) {
  const labels: Record<string, string> = { PENDING: '待执行', RUNNING: '执行中', COMPLETED: '已完成', SKIPPED: '已跳过', FAILED: '失败', CANCELLED: '已取消', STALE: '已失效' };
  return labels[status ?? ''] ?? status ?? '待执行';
}

function runStatusText(status: string) {
  const labels: Record<string, string> = { CREATED: '运行中 / 待执行', LAYOUT_RUNNING: '版式分析中', EXTRACTION_RUNNING: '专项抽取中', FUSION_RUNNING: '证据融合中', VALIDATION_RUNNING: '确定性校验中', REVIEW_REQUIRED: '需要复核', APPROVED: '校验已通过', COMPLETED: '已发布', CANCELLED: '已取消', FAILED: '运行失败' };
  return labels[status] ?? status;
}

function displayValue(value: unknown) {
  if (value === undefined || value === null || value === '') return '—';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function topologyEdgeText(candidate: FieldCandidate) {
  const value = (candidate.normalizedValue ?? candidate.value) as { from?: string | null; to?: string; relation?: string } | undefined;
  return value ? `${value.from || 'START'} → ${value.to || '?'} · ${value.relation || 'UNKNOWN'}` : '—';
}

function shortHash(value?: string) {
  return value ? `${value.slice(0, 14)}…${value.slice(-6)}` : '—';
}

function dateTime(value?: string) {
  return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';
}

function json(value: unknown) {
  return JSON.stringify(value ?? {}, null, 2);
}

async function requestJson<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(String(payload.error || payload.message || `${response.status} ${response.statusText}`));
  return payload as T;
}

function errorMessage(value: unknown) {
  return value instanceof Error ? value.message : String(value);
}

watch(() => [props.taskId, props.packageId], () => void loadRuns(), { deep: true });
watch(selectedRunId, () => void loadArtifacts());
onMounted(() => void loadRuns());
</script>

<template>
  <section class="v2-workbench">
    <header class="v2-hero">
      <div>
        <div class="eyebrow"><Layers3 :size="15" /> AIP → ARINC 424</div>
        <h2>机场识别与发布</h2>
        <p>一键处理全机场；当前查看 {{ packageName || packageId }}</p>
      </div>
      <div class="hero-actions">
        <label v-if="runs.length" class="run-picker">
          运行记录
          <select v-model="selectedRunId">
            <option v-for="run in runs" :key="run.runId" :value="run.runId">{{ dateTime(run.createdAt) }} · {{ runStatusText(run.status) }}</option>
          </select>
        </label>
        <button type="button" :disabled="loading" @click="loadRuns(selectedRunId)"><RefreshCw :size="15" />刷新</button>
        <button type="button" class="primary" :disabled="creating" @click="createRun"><Play :size="15" />新建识别任务</button>
      </div>
    </header>

    <div class="isolation-banner"><ShieldCheck :size="17" /><strong>发布门禁已开启</strong><span>只有 READY 锁定、预检、424 dry-run 和差异确认全部通过，才会更新正式 canonical；可按发布记录回滚。</span></div>
    <div v-if="error" class="workbench-message error"><AlertTriangle :size="16" />{{ error }}</div>
    <div v-else-if="notice" class="workbench-message"><Check :size="16" />{{ notice }}</div>

    <div v-if="!selectedRun" class="empty-state">
      <CircleDashed :size="34" />
      <strong>开始全机场自动处理</strong>
      <p>系统会自动为每个程序包创建或续跑识别任务，只把无法安全确定的问题汇总到程序优化清单。</p>
      <div v-if="airportBatchStatus" class="empty-airport-summary"><span>程序包 <b>{{ airportBatchStatus.packageCount }}</b></span><span>未开始 <b>{{ airportBatchStatus.notStartedCount }}</b></span><span>安全生效 <b>{{ airport424Aggregate?.activeReleaseCount ?? 0 }}</b></span><span>需优化 <b>{{ airportBatchStatus.needsOptimizationCount }}</b></span></div>
      <button v-if="!airportBatchBusy" type="button" class="primary" :disabled="!props.packages?.length" @click="runAirportPipeline"><Play :size="15" />全机场自动识别并发布安全通过项</button>
      <button v-else type="button" class="danger-button" @click="stopAirportPipeline"><Square :size="14" />当前阶段后暂停</button>
      <details class="single-package-start"><summary>高级：只处理当前程序包</summary><button type="button" :disabled="creating" @click="createRun">新建当前程序包识别任务</button></details>
    </div>

    <template v-else>
      <section class="run-overview">
        <div class="run-identity">
          <span class="status-dot" :class="selectedRun.status.toLowerCase()"></span>
          <div><small>RUN STATUS</small><strong>{{ runStatusLabel }}</strong></div>
        </div>
        <div class="metric"><small>进度</small><strong>{{ completedCount }} / {{ STAGES.length }}</strong></div>
        <div class="metric danger"><small>阻断问题</small><strong>{{ blockingCount }}</strong></div>
        <div class="metric warn"><small>待复核</small><strong>{{ reviewCount }}</strong></div>
        <div class="metric decision" :class="releaseDecision.toLowerCase()"><small>发布决定</small><strong>{{ releaseDecision }}</strong></div>
        <div class="overview-actions">
          <span class="auto-model-note">AI 按需自动调用：版式、注记、复杂拓扑</span>
          <button type="button" class="primary" :disabled="!nextRunnableStage || autoPipelineBusy" @click="runAutomaticPipeline">
            <ChevronRight :size="15" />{{ nextRunnableStage ? (autoPipelineBusy ? `自动执行：${stageShortLabels[nextRunnableStage]}` : '一键识别并校验') : '识别阶段已完成' }}
          </button>
          <button type="button" class="danger-button" :disabled="cancelling || selectedRun.status === 'CANCELLED'" @click="cancelRun"><Square :size="14" />取消当前识别任务</button>
        </div>
      </section>

      <details class="advanced-diagnostics">
        <summary><span>高级诊断与单阶段重跑</span><small>候选、证据、冲突、阶段状态和审计文件</small></summary>
      <section class="run-meta">
        <span>识别任务 ID <code>{{ selectedRun.runId }}</code></span>
        <span>输入指纹 <code :title="selectedRun.sourcePackageHash">{{ shortHash(selectedRun.sourcePackageHash) }}</code></span>
        <span>更新于 {{ dateTime(selectedRun.updatedAt) }}</span>
      </section>

      <section class="stage-grid">
        <article v-for="(stage, index) in STAGES" :key="stage" class="stage-card" :class="stageRecord(stage)?.status.toLowerCase() || 'pending'">
          <div class="stage-top">
            <span class="stage-index">{{ String(index + 1).padStart(2, '0') }}</span>
            <span class="stage-status">{{ statusText(stageRecord(stage)?.status) }}</span>
          </div>
          <strong>{{ stageLabels[stage] }}</strong>
          <small>{{ stage }}</small>
          <p v-if="DEPENDENCIES[stage].length" class="dependency">依赖：{{ DEPENDENCIES[stage].map((item) => stageShortLabels[item]).join('、') }}</p>
          <p v-if="stageRecord(stage)?.skipReason" class="skip-note">{{ stageRecord(stage)?.skipReason }}</p>
          <p v-if="stageRecord(stage)?.error" class="stage-error">{{ stageRecord(stage)?.error?.message }}</p>
          <div class="stage-card-actions">
            <button v-if="EXECUTABLE.has(stage)" type="button" :disabled="!canRun(stage) || busyStage === stage" @click="runStage(stage)">
              <RefreshCw v-if="busyStage === stage" class="spin" :size="13" /><Play v-else :size="13" />
              {{ stageRecord(stage)?.status === 'COMPLETED' ? '重新执行' : '执行' }}
            </button>
            <template v-else-if="SKIPPABLE.has(stage)">
              <textarea v-model="skipReasons[stage]" rows="2" placeholder="必须说明为什么跳过"></textarea>
              <button type="button" :disabled="!canSkip(stage) || busyStage === stage" @click="skipStage(stage)"><Ban :size="13" />显式跳过</button>
            </template>
            <button v-else-if="stage === 'HUMAN_REVIEW'" type="button" :disabled="reviewBusy || stageRecord('SEMANTIC_VALIDATION')?.status !== 'COMPLETED'" @click="reviewWorkspace ? activeTab = 'review' : initializeReview()">
              <FileCheck2 :size="13" />{{ stageRecord(stage)?.status === 'COMPLETED' ? '查看审核结果' : reviewWorkspace ? '继续审核' : '建立审核队列' }}
            </button>
            <button v-else-if="stage === 'PUBLISH_CANONICAL'" type="button" :disabled="selectedRun.status !== 'APPROVED' && selectedRun.status !== 'COMPLETED'" @click="activeTab = 'publication'">
              <ShieldCheck :size="13" />{{ stageRecord(stage)?.status === 'COMPLETED' ? '查看发布记录' : '进入发布门禁' }}
            </button>
          </div>
        </article>
      </section>

      <nav class="workbench-tabs">
        <button type="button" :class="{ active: activeTab === 'candidates' }" @click="activeTab = 'candidates'">候选与证据 <b>{{ candidates.length }}</b></button>
        <button type="button" :class="{ active: activeTab === 'topology' }" @click="activeTab = 'topology'">航迹拓扑 <b>{{ topologyEdges.length }}</b></button>
        <button type="button" :class="{ active: activeTab === 'conflicts' }" @click="activeTab = 'conflicts'">冲突与未知 <b>{{ (fusion?.conflicts.length || 0) + (fusion?.unresolvedItems.length || 0) }}</b></button>
        <button type="button" :class="{ active: activeTab === 'validation' }" @click="activeTab = 'validation'">确定性校验 <b>{{ validation?.issues.length || 0 }}</b></button>
        <button type="button" :class="{ active: activeTab === 'review' }" @click="activeTab = 'review'">发布审核 <b>{{ reviewWorkspace?.summary.criticalPending ?? reviewCount }}</b></button>
        <button type="button" :class="{ active: activeTab === 'preview' }" @click="activeTab = 'preview'">Canonical 与差异</button>
        <button type="button" :class="{ active: activeTab === 'publication' }" @click="activeTab = 'publication'">424 发布门禁 <b>{{ publicationWorkspace?.status || '未锁定' }}</b></button>
        <button type="button" :class="{ active: activeTab === 'artifacts' }" @click="activeTab = 'artifacts'">审计 Artifact</button>
      </nav>
      </details>

      <section class="workbench-content">
        <template v-if="activeTab === 'candidates'">
          <div v-if="!candidates.length" class="tab-empty">完成身份、表格或坐标专项阶段后，这里会显示字段级候选及其 PDF 证据。</div>
          <div v-else class="candidate-layout">
            <div class="data-table-wrap">
              <table class="data-table">
                <thead><tr><th>实体</th><th>字段</th><th>规范化值</th><th>状态</th><th>证据</th><th>置信度</th></tr></thead>
                <tbody>
                  <tr v-for="candidate in candidates" :key="candidate.candidateId" :class="{ selected: candidate.candidateId === selectedCandidateId, review: candidate.reviewRequired }" @click="selectCandidate(candidate)">
                    <td><span class="entity-type">{{ candidate.entityType }}</span><small>{{ candidate.entityKey }}</small></td>
                    <td><strong>{{ candidate.fieldName }}</strong></td>
                    <td class="value-cell">{{ displayValue(candidate.normalizedValue ?? candidate.value) }}</td>
                    <td><span class="mini-badge" :class="candidate.status.toLowerCase()">{{ candidate.status }}</span><span v-if="candidate.reviewRequired" class="review-mark">复核</span></td>
                    <td>{{ candidate.sourceEvidenceIds.length }}</td>
                    <td>{{ Math.round(candidate.confidence * 100) }}%</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <aside class="evidence-panel">
              <template v-if="selectedCandidate">
                <div class="evidence-title"><Eye :size="16" /><div><strong>{{ selectedCandidate.fieldName }}</strong><small>{{ selectedCandidate.candidateId }}</small></div></div>
                <div v-for="item in selectedEvidence" :key="item.evidenceId" class="evidence-card">
                  <div><span>P{{ item.pageNo }}</span><strong>{{ item.sourceType }}</strong><em>{{ item.modelExecution ? `模型 · ${item.modelExecution.model}` : '确定性来源' }}</em></div>
                  <p>{{ item.rawText || item.visualDescription || '无可展示文本' }}</p>
                  <small>{{ item.fileName }}{{ item.aipPageNo ? ` · AIP ${item.aipPageNo}` : '' }} · {{ Math.round(item.confidence * 100) }}%</small>
                </div>
                <p v-if="!selectedEvidence.length" class="missing-evidence">该候选引用的证据不存在，融合阶段会拒绝它进入 canonical。</p>
              </template>
              <p v-else>点击左侧候选查看来源证据。</p>
            </aside>
          </div>
        </template>

        <template v-else-if="activeTab === 'topology'">
          <div v-if="!artifacts.CHART_TOPOLOGY" class="tab-empty">执行“航图拓扑”后显示表格顺序推导的边、主图节点确认和模型独立观察。</div>
          <template v-else>
            <div class="topology-summary">
              <section><small>可审计航迹边</small><strong>{{ topologyEdges.length }}</strong><p>由表格行序确定性推导；模型观察保持独立。</p></section>
              <section><small>主图确认节点</small><strong>{{ topologyNodes.length }}</strong><p>只确认打印标签存在，不用像素位置反算坐标。</p></section>
              <section><small>需要复核</small><strong>{{ topologyCandidates.filter((item) => item.reviewRequired).length }}</strong><p>模型单源或上游物理行不确定时保留复核标记。</p></section>
            </div>
            <div v-if="!topologyEdges.length" class="tab-empty">尚未形成有证据链的航迹边；系统不会为了补齐图形而猜测连接关系。</div>
            <div v-else class="topology-chain">
              <article v-for="(edge, index) in topologyEdges" :key="edge.candidateId" :class="{ review: edge.reviewRequired }" @click="selectCandidate(edge)">
                <span>{{ String(index + 1).padStart(2, '0') }}</span>
                <div><strong>{{ topologyEdgeText(edge) }}</strong><small>{{ edge.status }} · {{ Math.round(edge.confidence * 100) }}% · {{ edge.sourceEvidenceIds.length }} 条证据</small></div>
                <em v-if="edge.reviewRequired">需复核</em><em v-else>规则确认</em>
              </article>
            </div>
          </template>
        </template>

        <template v-else-if="activeTab === 'conflicts'">
          <div v-if="!fusion" class="tab-empty">执行“候选融合”后显示冲突和未解决项。</div>
          <template v-else>
            <div class="section-heading"><div><h3>来源冲突</h3><p>单值字段出现不同值时不自动覆盖。</p></div><span>{{ fusion.conflicts.length }}</span></div>
            <div v-if="!fusion.conflicts.length" class="success-empty"><Check :size="18" />没有检测到来源冲突</div>
            <article v-for="conflict in fusion.conflicts" :key="conflict.conflictId" class="issue-card" :class="conflict.severity.toLowerCase()">
              <div class="issue-head"><span>{{ conflict.severity }}</span><strong>{{ conflict.entityKey }} · {{ conflict.fieldName }}</strong><em>{{ conflict.resolution }}</em></div>
              <div class="candidate-choices">
                <div v-for="candidate in candidateValues(conflict.candidateIds)" :key="candidate.candidateId"><small>{{ candidate.candidateId }}</small><strong>{{ displayValue(candidate.normalizedValue ?? candidate.value) }}</strong></div>
              </div>
            </article>
            <div class="section-heading"><div><h3>未解决项</h3><p>缺证据、模型单源或需要人工判断的字段。</p></div><span>{{ fusion.unresolvedItems.length }}</span></div>
            <article v-for="item in fusion.unresolvedItems" :key="item.unresolvedId" class="unresolved-card" :class="{ blocking: item.blockingFor424 }">
              <div><span>{{ item.blockingFor424 ? '阻断 424' : '需要复核' }}</span><strong>{{ item.entityKey }} · {{ item.fieldName }}</strong></div>
              <p>{{ item.reasonCode }}{{ item.requiredEvidence ? ` · 需要：${item.requiredEvidence}` : '' }}</p>
            </article>
          </template>
        </template>

        <template v-else-if="activeTab === 'validation'">
          <div v-if="!validation" class="tab-empty">执行“确定性语义校验”后显示发布决定和逐条规则结果。</div>
          <template v-else>
            <div class="decision-banner" :class="validation.releaseDecision.toLowerCase()">
              <ShieldCheck :size="24" />
              <div><small>RELEASE DECISION</small><strong>{{ validation.releaseDecision }}</strong><p>阻断 {{ validation.blockingIssueCount }} · 警告 {{ validation.reviewIssueCount }}</p></div>
            </div>
            <div v-if="!validation.issues.length" class="success-empty"><Check :size="18" />全部确定性规则通过，可以进入后续发布审批</div>
            <article v-for="issue in validation.issues" :key="issue.issueId" class="validation-row" :class="issue.severity.toLowerCase()">
              <span>{{ issue.severity }}</span>
              <div><strong>{{ issue.ruleId }} <small>v{{ issue.ruleVersion }}</small></strong><p>{{ issue.message }}</p><em>{{ issue.entityKeys.join(' · ') }}<template v-if="issue.fieldNames.length"> / {{ issue.fieldNames.join(', ') }}</template></em></div>
            </article>
          </template>
        </template>

        <template v-else-if="activeTab === 'review'">
          <div v-if="!reviewWorkspace" class="tab-empty">
            <FileCheck2 :size="30" />
            <strong>尚未建立字段审核队列</strong>
            <p>完成确定性校验后，系统会按实体和字段合并重复警告，并关联原始 PDF 页面证据。</p>
            <button type="button" class="primary" :disabled="reviewBusy || stageRecord('SEMANTIC_VALIDATION')?.status !== 'COMPLETED'" @click="initializeReview">建立审核队列</button>
          </div>
          <template v-else>
            <div class="review-summary">
              <section><small>合并前信号</small><strong>{{ reviewWorkspace.summary.mergedSignalCount }}</strong></section>
              <section><small>字段审核项</small><strong>{{ reviewWorkspace.summary.total }}</strong></section>
              <section><small>业务审核卡片</small><strong>{{ visibleReviewBundles.length }}</strong></section>
              <section class="pending"><small>待审卡片</small><strong>{{ pendingBundleCount }}</strong></section>
              <section class="confirmed"><small>跨 Run 复用</small><strong>{{ reviewWorkspace.summary.reusedDecisionCount }}</strong></section>
            </div>
            <div class="review-toolbar">
              <label>程序范围<select v-model="reviewProcedureFilter"><option value="ALL">全部程序</option><option v-for="name in reviewProcedures" :key="name" :value="name">{{ name }}</option></select></label>
              <span class="review-safety"><ShieldCheck :size="15" />确认和修正均保留原值与证据</span>
              <button type="button" class="primary" :disabled="reviewBusy || reviewWorkspace.summary.criticalPending > 0 || reviewWorkspace.status === 'COMPLETED'" @click="completeReview">
                <ShieldCheck :size="15" />{{ reviewWorkspace.status === 'COMPLETED' ? '已达到 READY' : '重新校验并提升 READY' }}
              </button>
            </div>
            <div v-if="reviewWorkspace.status === 'COMPLETED'" class="success-empty"><Check :size="18" />全部关键字段已经人工确认，重新校验结果为 READY；审核记录不可再编辑。</div>
            <div class="review-layout">
              <div class="review-list">
                <article v-for="bundle in visibleReviewBundles" :key="bundle.bundleId" :data-review-bundle="bundle.bundleId" :class="['review-item', bundleStatus(bundle).toLowerCase(), { selected: bundle.bundleId === selectedReviewBundleId }]" @click="selectReviewBundle(bundle)">
                  <div class="review-item-head"><span>{{ bundleStatus(bundle) === 'PENDING' ? '待审核' : bundleStatus(bundle) === 'CONFIRMED' ? '已确认' : '含修正' }}</span><em>{{ bundle.items.length }} 个字段</em></div>
                  <strong>{{ bundle.label }}</strong>
                  <small>{{ bundle.entityType }} · {{ bundle.entityKey }}</small>
                  <p>{{ bundle.items.map(item => `${item.fieldName}: ${displayValue(item.status === 'CORRECTED' ? item.correctedValue : item.currentValue)}`).join(' · ') }}</p>
                  <div class="procedure-tags"><i v-for="name in bundle.procedureNames" :key="name">{{ name }}</i></div>
                </article>
                <div v-if="!visibleReviewBundles.length" class="tab-empty">该程序范围没有待审核业务卡片。</div>
              </div>
              <aside class="review-detail">
                <template v-if="selectedReviewBundle && selectedReviewItem">
                  <header><div><small>{{ selectedReviewBundle.entityKey }}</small><h3>{{ selectedReviewBundle.label }}</h3></div><span :class="bundleStatus(selectedReviewBundle).toLowerCase()">{{ bundleStatus(selectedReviewBundle) }}</span></header>
                  <div class="review-detail-body">
                    <div class="review-editor">
                      <div class="bundle-field-list">
                        <button v-for="item in selectedReviewBundle.items" :key="item.reviewItemId" type="button" :class="[item.status.toLowerCase(), { active: item.reviewItemId === selectedReviewItemId }]" @click="selectReviewItem(item)">
                          <span>{{ item.fieldName }}</span><strong>{{ displayValue(item.status === 'CORRECTED' ? item.correctedValue : item.currentValue) }}</strong><em>{{ item.status }}</em>
                        </button>
                      </div>
                      <button type="button" class="bundle-confirm" :disabled="reviewBusy || reviewWorkspace.status === 'COMPLETED' || !bundleCanConfirm(selectedReviewBundle)" @click="confirmReviewBundle"><Check :size="14" />一次确认本卡片全部待审字段</button>
                      <div class="field-editor-title"><small>当前编辑字段</small><strong>{{ selectedReviewItem.fieldName }}</strong></div>
                      <div class="value-comparison"><label>当前规范值<strong>{{ displayValue(selectedReviewItem.currentValue) }}</strong></label><label v-if="selectedReviewItem.status === 'CORRECTED'">已保存修正<strong>{{ displayValue(selectedReviewItem.correctedValue) }}</strong></label></div>
                      <div v-if="selectedReviewItem.suggestedValues.length" class="suggested-values"><small>来源候选值（点击填入修正框）</small><button v-for="(value, index) in selectedReviewItem.suggestedValues" :key="index" type="button" @click="correctionDraft = correctionText(value)">{{ displayValue(value) }}</button></div>
                      <label class="correction-field">确认有误时输入修正值<textarea v-model="correctionDraft" rows="3" placeholder="冲突候选可直接输入所选值；真正的对象或数组使用 JSON"></textarea></label>
                      <label class="correction-field">审核说明（可选）<textarea v-model="reviewNote" rows="2" placeholder="说明核对依据或修改原因"></textarea></label>
                      <div class="review-actions">
                        <button type="button" :disabled="reviewBusy || reviewWorkspace.status === 'COMPLETED' || (selectedReviewItem.currentValue === undefined && selectedReviewItem.reasonCodes.length > 0) || selectedReviewEvidence.length === 0" @click="saveReviewDecision('CONFIRMED')"><Check :size="14" />{{ selectedReviewItem.currentValue === undefined ? '确认校验提示' : '确认当前值' }}</button>
                        <button type="button" class="primary" :disabled="reviewBusy || reviewWorkspace.status === 'COMPLETED'" @click="saveReviewDecision('CORRECTED')"><Pencil :size="14" />保存修正值</button>
                      </div>
                      <p v-if="reviewActionFeedback" :class="['review-action-feedback', reviewActionFeedback.type]" role="status">{{ reviewActionFeedback.text }}</p>
                      <div class="review-reasons"><span v-for="reason in selectedReviewItem.reasonCodes" :key="reason">{{ reason }}</span><span v-for="rule in selectedReviewItem.ruleIds" :key="rule">{{ rule }}</span></div>
                    </div>
                    <section class="review-evidence-column">
                      <div class="section-heading"><div><h3>PDF 原图证据</h3><p>审核时始终可见；红框为字段来源区域。</p></div><span>{{ selectedReviewEvidence.length }}</span></div>
                      <article v-for="item in selectedReviewEvidence" :key="item.evidenceId" class="source-image-card">
                        <div class="source-image"><PdfEvidencePage :task-id="taskId" :page-no="item.pageNo" :bbox="item.bbox" :highlight-terms="evidenceHighlightTerms(item)" :source-type="item.sourceType" /></div>
                        <div><strong>P{{ item.pageNo }} · {{ item.sourceType }}</strong><em>{{ item.fileName }}{{ item.aipPageNo ? ` · AIP ${item.aipPageNo}` : '' }}</em><p>{{ item.rawText || item.visualDescription || '该证据没有文本层，按红框核对原图。' }}</p></div>
                      </article>
                      <p v-if="!selectedReviewEvidence.length" class="missing-evidence">该业务卡片没有可用原图证据，不能仅凭当前值完成安全确认。</p>
                    </section>
                  </div>
                </template>
                <p v-else>从左侧选择一张业务卡片，核对同一坐标行、航段行或拓扑关系的字段和 PDF 原图。</p>
              </aside>
            </div>
          </template>
        </template>

        <template v-else-if="activeTab === 'preview'">
          <div v-if="!artifacts.canonicalPreview" class="tab-empty">完成语义校验后生成只读 canonical 预览和当前活动数据差异报告。</div>
          <template v-else>
            <div class="preview-grid">
              <section class="preview-card"><small>机场</small><strong>{{ displayValue(artifacts.canonicalPreview.procedureUnderstanding.airportIcao) }}</strong></section>
              <section class="preview-card"><small>程序类型</small><strong>{{ displayValue(artifacts.canonicalPreview.procedureUnderstanding.packageType) }}</strong></section>
              <section class="preview-card"><small>导航类型</small><strong>{{ displayValue(artifacts.canonicalPreview.procedureUnderstanding.navigationType) }}</strong></section>
              <section class="preview-card"><small>航段</small><strong>{{ Array.isArray(artifacts.canonicalPreview.procedureUnderstanding.tableLegs) ? artifacts.canonicalPreview.procedureUnderstanding.tableLegs.length : 0 }}</strong></section>
            </div>
            <div class="preview-actions">
              <button type="button" :disabled="!selectedRun || !['APPROVED', 'COMPLETED'].includes(selectedRun.status)" @click="openV2GeoJsonPreview"><Eye :size="15" />打开 GeoJSON 地图预览</button>
              <small>使用 READY canonical 临时生成，不会覆盖当前正式版本。</small>
            </div>
            <div v-if="artifacts.diff" class="diff-summary">
              <span>相同 <b>{{ artifacts.diff.summary.same }}</b></span><span>变更 <b>{{ artifacts.diff.summary.changed }}</b></span><span>仅当前版本 <b>{{ artifacts.diff.summary.onlyV1 }}</b></span><span>仅新预览 <b>{{ artifacts.diff.summary.onlyV2 }}</b></span>
            </div>
            <div v-if="artifacts.diff" class="data-table-wrap">
              <table class="data-table diff-table"><thead><tr><th>字段路径</th><th>状态</th><th>当前活动数据</th><th>新识别预览</th></tr></thead><tbody>
                <tr v-for="item in artifacts.diff.items" :key="item.path"><td><code>{{ item.path }}</code></td><td><span class="mini-badge" :class="item.status.toLowerCase()">{{ item.status }}</span></td><td>{{ displayValue(item.v1Value) }}</td><td>{{ displayValue(item.v2Value) }}</td></tr>
              </tbody></table>
            </div>
            <details class="json-details"><summary>查看 canonical 预览 JSON</summary><pre>{{ json(artifacts.canonicalPreview) }}</pre></details>
          </template>
        </template>

        <template v-else-if="activeTab === 'publication'">
          <section v-if="airport424Aggregate" class="airport-aggregate-panel">
            <div class="section-heading">
              <div><small>AIRPORT RELEASE SCOPE</small><h3>{{ airport424Aggregate.airportIcao || '当前机场' }} 424 汇总</h3><p>汇总本机场所有已生效的程序包版本；缺包、主记录未编码或语义冲突都会阻止机场级发布。</p></div>
              <span :class="airport424Aggregate.airportComplete ? 'complete' : 'partial'">{{ airport424Aggregate.airportComplete ? '机场完整' : '机场未完整' }}</span>
            </div>
            <div class="airport-aggregate-summary">
              <section><small>已生效程序包</small><strong>{{ airport424Aggregate.activeReleaseCount }} / {{ airport424Aggregate.packageCount }}</strong></section>
              <section><small>汇总记录</small><strong>{{ airport424Aggregate.lineCount }}</strong></section>
              <section><small>已去重</small><strong>{{ airport424Aggregate.duplicateLineCount }}</strong></section>
              <section><small>冲突</small><strong>{{ airport424Aggregate.conflicts.length }}</strong></section>
              <button type="button" :disabled="!airport424Aggregate.text" @click="viewAirport424">页面查看机场 424</button>
              <button type="button" :disabled="airport424Aggregate.activeReleaseCount === 0" @click="openAirportGeoJsonPreview"><Eye :size="14" />机场 GeoJSON</button>
              <button type="button" @click="refreshAirportOverview"><RefreshCw :size="14" />刷新汇总</button>
            </div>
            <div v-if="airportBatchStatus" class="airport-batch-status-summary">
              <section><small>未开始</small><strong>{{ airportBatchStatus.notStartedCount }}</strong></section>
              <section><small>运行/暂停</small><strong>{{ airportBatchStatus.runningCount + airportBatchStatus.pausedCount }}</strong></section>
              <section class="warn"><small>需程序优化</small><strong>{{ airportBatchStatus.needsOptimizationCount }}</strong></section>
              <section><small>待安全发布</small><strong>{{ airportBatchStatus.readyToPublishCount }}</strong></section>
              <section class="pass"><small>账本中有版本</small><strong>{{ airportBatchStatus.activeReleaseCount }}</strong></section>
            </div>
            <section class="airport-formal-release">
              <div>
                <strong>机场正式 424 版本</strong>
                <small v-if="!airportFormalLedger?.activeReleaseId">尚未发布机场级不可变快照</small>
                <small v-else-if="airportFormalStale">当前程序包活动版本已变化，机场正式快照需要重新发布</small>
                <small v-else>当前正式版本与已生效程序包汇总一致</small>
              </div>
              <span :class="airportFormalStale ? 'partial' : airportFormalLedger?.activeReleaseId ? 'complete' : 'partial'">{{ airportFormalStale ? '已过期' : airportFormalLedger?.activeReleaseId ? '已发布' : '未发布' }}</span>
              <button type="button" class="primary" :disabled="airportFormalBusy || !airport424Aggregate.airportComplete" @click="publishAirportFormalRelease">正式发布全机场版本</button>
              <button v-if="airportFormalLedger?.activeReleaseId" type="button" :disabled="viewing424" @click="viewAirportFormalRelease(airportFormalLedger.activeReleaseId)">页面查看正式版本</button>
              <button type="button" class="danger-button" :disabled="airportFormalBusy || !airportFormalLedger?.activeReleaseId || airportFormalLedger.releases.length < 2" @click="rollbackAirportFormalRelease">回滚机场版本</button>
            </section>
            <div v-if="airportFormalLedger?.releases.length" class="airport-formal-ledger">
              <article v-for="release in [...airportFormalLedger.releases].reverse()" :key="release.releaseId">
                <span :class="release.status.toLowerCase()">{{ release.status }}</span><code>{{ release.releaseId }}</code><small>{{ release.packageReleaseCount }} 个程序包 · {{ release.lineCount }} 行 · {{ dateTime(release.publishedAt) }}</small><button type="button" @click="viewAirportFormalRelease(release.releaseId)">查看</button>
              </article>
            </div>
            <div class="airport-batch-control">
              <div>
                <strong>全机场傻瓜式处理</strong>
                <small>自动续跑已有 Run，调用专项模型，确定性校验；只对零异常程序包完成 READY 和正式发布。</small>
              </div>
              <button v-if="!airportBatchBusy" type="button" class="primary" :disabled="!props.packages?.length" @click="runAirportPipeline"><Play :size="14" />全机场自动识别并发布安全通过项</button>
              <button v-else type="button" class="danger-button" @click="stopAirportPipeline"><Square :size="14" />当前阶段后暂停</button>
            </div>
            <div v-if="airportBatchBusy" class="airport-batch-progress">
              <div><strong>{{ airportBatchCompleted }} / {{ airportBatchTotal }}</strong><span v-if="airportBatchCurrent">正在处理：{{ airportBatchCurrent }}</span><span>本次已发布 {{ airportBatchPublished }}</span><span>异常 {{ airportBatchIssues.length }}</span></div>
              <progress :value="airportBatchCompleted" :max="Math.max(1, airportBatchTotal)"></progress>
            </div>
            <div v-if="airportBatchIssues.length" class="airport-batch-issues">
              <div class="section-heading"><div><h3>程序优化清单</h3><p>这里不是让人逐字段抄写，而是告诉开发者应优化哪个识别阶段。修复后再次运行即可续跑。</p></div><span class="partial">{{ airportBatchIssues.length }}</span></div>
              <article v-for="issue in airportBatchIssues" :key="`${issue.packageId}:${issue.phase}:${issue.message}`">
                <span>{{ issue.category }}</span><strong>{{ issue.packageName }}</strong><code>{{ issue.phase }}</code><p>{{ issue.message }}</p><button type="button" @click="emit('select-package', issue.packageId)">打开该程序包</button>
              </article>
            </div>
            <section class="reference-424-compare airport-reference-compare">
              <div class="section-heading"><div><h3>全机场 Jeppesen 424 逐字段对比</h3><p>可直接粘贴机场级文件。当前机场未完整时，Jeppesen 中尚未生成的程序会明确显示为“系统缺少”，不会被误算成字段识别错误。</p></div><button type="button" class="primary" :disabled="airportReferenceCompareBusy || !airportReference424Text.trim()" @click="compareAirportReference424"><FileDiff :size="15" />{{ airportReferenceCompareBusy ? '对比中…' : '对比机场 424' }}</button></div>
              <textarea v-model="airportReference424Text" spellcheck="false" placeholder="粘贴该机场的 Jeppesen 424 定长文本…"></textarea>
              <div v-if="airportReference424Comparison" class="reference-compare-summary">
                <span>标准字段差异 <b>{{ airportReference424Comparison.standardDifferenceCount }}</b></span>
                <span>系统缺少记录 <b>{{ airportReference424Comparison.missingSystemCount }}</b></span>
                <span>参考缺少记录 <b>{{ airportReference424Comparison.missingReferenceCount }}</b></span>
                <span>供应商元数据差异 <b>{{ airportReference424Comparison.supplierMetadataDifferenceCount }}</b></span>
              </div>
              <div v-if="airportReference424Comparison" class="reference-records">
                <p v-if="airportReferenceVisibleRecords.length < airportReference424Comparison.records.length" class="comparison-limit-note">为保证页面流畅，优先显示前 {{ airportReferenceVisibleRecords.length }} 条非一致记录；汇总数字仍基于完整文件。</p>
                <details v-for="record in airportReferenceVisibleRecords" :key="`airport:${record.recordKey}`" :class="record.status.toLowerCase()" :open="record.status === 'DIFFERENT' || record.status.startsWith('MISSING')">
                  <summary><span>{{ record.status }}</span><code>{{ record.recordKey }}</code><b>{{ record.fields.filter(field => !field.matched && field.severity === 'STANDARD').length }} 个标准差异</b></summary>
                  <div class="record-lines"><pre>{{ record.systemLine || '系统缺少此记录' }}</pre><pre>{{ record.referenceLine || '参考数据缺少此记录' }}</pre></div>
                  <table class="field-diff-table"><thead><tr><th>列</th><th>字段</th><th>系统</th><th>Jeppesen</th><th>结果</th></tr></thead><tbody>
                    <tr v-for="field in record.fields" :key="field.field" :class="{ different: !field.matched && field.severity === 'STANDARD', metadata: !field.matched && field.severity === 'SUPPLIER_METADATA' }"><td>{{ field.startColumn }}-{{ field.endColumn }}</td><td>{{ field.label }}</td><td><code>{{ field.systemValue || '∅' }}</code></td><td><code>{{ field.referenceValue || '∅' }}</code></td><td>{{ field.matched ? '一致' : field.severity === 'SUPPLIER_METADATA' ? '供应商差异' : '不同' }}</td></tr>
                  </tbody></table>
                </details>
              </div>
            </section>
            <div v-if="airport424Aggregate.missingPackages.length" class="airport-missing-packages">
              <strong>尚无正式版本的程序包（{{ airport424Aggregate.missingPackages.length }}）</strong>
              <span v-for="item in airport424Aggregate.missingPackages" :key="item.packageId">{{ item.packageName }}</span>
            </div>
            <div v-if="airport424Aggregate.masterEncodingIssues.length" class="airport-missing-packages"><strong>机场主记录提示</strong><span v-for="message in airport424Aggregate.masterEncodingIssues" :key="message">{{ message }}</span></div>
            <div class="publication-checks">
              <article v-for="item in airport424Aggregate.coverage" :key="item.category" :class="item.status === 'COMPLETE' ? 'pass' : 'warn'"><strong>{{ item.status }}</strong><code>{{ item.category }}</code><span>{{ item.message }}</span></article>
              <article v-for="conflict in airport424Aggregate.conflicts" :key="conflict.recordKey" class="block"><strong>CONFLICT</strong><code>{{ conflict.recordKey }}</code><span>{{ conflict.message }}</span></article>
            </div>
          </section>
          <div class="publication-head">
            <div><small>PHASE 6 RELEASE GATE</small><h3>424 正式发布</h3><p>每一步都检查锁定哈希；正式发布前必须人工接受零阻断的 dry-run 差异。</p></div>
            <span :class="(publicationWorkspace?.status || 'unlocked').toLowerCase()">{{ publicationWorkspace?.status || 'UNLOCKED' }}</span>
          </div>
          <div class="publication-steps">
            <button type="button" :disabled="publicationBusy || (!!publicationWorkspace && publicationWorkspace.status !== 'STALE')" @click="runPublicationAction('lock')"><b>1</b><span>锁定 READY<small>冻结 canonical 与源文件哈希</small></span></button>
            <button type="button" :disabled="publicationBusy || !publicationWorkspace || publicationWorkspace.status === 'STALE'" @click="runPublicationAction('preflight')"><b>2</b><span>发布前预检<small>身份、航段和 132 列编码</small></span></button>
            <button type="button" :disabled="publicationBusy || !publicationWorkspace?.preflight?.passed" @click="runPublicationAction('dry-run')"><b>3</b><span>424 dry-run<small>生成隔离的候选发布文件</small></span></button>
            <button type="button" :disabled="publicationBusy || !publicationWorkspace?.dryRun" @click="runPublicationAction('diff')"><b>4</b><span>回读差异<small>重新解析并逐航段比较</small></span></button>
            <button type="button" :disabled="publicationBusy || !publicationWorkspace?.diff || publicationWorkspace.diff.blockingDifferenceCount > 0 || publicationWorkspace.diff.accepted" @click="runPublicationAction('diff/accept')"><b>5</b><span>接受差异<small>仅零阻断时允许人工放行</small></span></button>
            <button type="button" class="publish-step" :disabled="publicationBusy || publicationWorkspace?.status !== 'PUBLISHABLE'" @click="runPublicationAction('publish')"><b>6</b><span>正式发布<small>更新下游 canonical 与版本账本</small></span></button>
          </div>
          <div v-if="publicationWorkspace?.preflight" class="publication-checks">
            <article v-for="check in publicationWorkspace.preflight.checks" :key="check.code" :class="check.status.toLowerCase()"><strong>{{ check.status }}</strong><code>{{ check.code }}</code><span>{{ check.message }}</span></article>
          </div>
          <div v-if="publicationWorkspace?.dryRun" class="publication-output">
            <section><small>424 记录</small><strong>{{ publicationWorkspace.dryRun.lineCount }}</strong></section>
            <section><small>源航段</small><strong>{{ publicationWorkspace.dryRun.simpleLegCount }}</strong></section>
            <section><small>文件哈希</small><code>{{ shortHash(publicationWorkspace.dryRun.textHash) }}</code></section>
            <button type="button" :disabled="viewing424" @click="viewDryRun">页面查看 dry-run</button>
          </div>
          <section v-if="publicationWorkspace?.dryRun?.coverage" class="airport-coverage-panel">
            <div class="section-heading"><div><h3>机场 424 记录覆盖率</h3><p>当前发布范围是单个程序包，不等于完整机场 424。以下记录族全部覆盖后，机场级发布才能标记为完整。</p></div><span :class="publicationWorkspace.dryRun.airportComplete ? 'complete' : 'partial'">{{ publicationWorkspace.dryRun.airportComplete ? '机场完整' : '仅程序包' }}</span></div>
            <div class="publication-checks">
              <article v-for="item in publicationWorkspace.dryRun.coverage" :key="item.category" :class="item.status === 'COMPLETE' ? 'pass' : 'warn'"><strong>{{ item.status }}</strong><code>{{ item.category }}</code><span>{{ item.message }}</span></article>
            </div>
          </section>
          <div v-if="publicationWorkspace?.diff" class="data-table-wrap">
            <table class="data-table"><thead><tr><th>程序</th><th>跑道</th><th>得分</th><th>匹配航段</th><th>阻断差异</th></tr></thead><tbody>
              <tr v-for="item in publicationWorkspace.diff.procedureResults" :key="`${item.procedureName}:${item.runway}`"><td>{{ item.procedureName }}</td><td>{{ item.runway || '—' }}</td><td>{{ item.score }}%</td><td>{{ item.matchedLegs }} / {{ item.totalLegs }}</td><td>{{ item.partialLegs + item.mismatchedLegs }}</td></tr>
            </tbody></table>
          </div>
          <section v-if="publicationWorkspace?.dryRun" class="reference-424-compare">
            <div class="section-heading"><div><h3>Jeppesen 424 逐字段对比</h3><p>粘贴同一程序记录；ARINC 语义字段不同标红。Jeppesen 2P 延续值、记录号和周期属于供应商派生/元数据，单独标灰，不冒充 AIP 识别错误。</p></div><button type="button" class="primary" :disabled="referenceCompareBusy || !reference424Text.trim()" @click="compareReference424"><FileDiff :size="15" />{{ referenceCompareBusy ? '对比中…' : '开始逐字段对比' }}</button></div>
            <textarea v-model="reference424Text" spellcheck="false" placeholder="粘贴 Jeppesen 424 定长文本…"></textarea>
            <div v-if="reference424Comparison" class="reference-compare-summary">
              <span>标准字段差异 <b>{{ reference424Comparison.standardDifferenceCount }}</b></span>
              <span>缺少系统记录 <b>{{ reference424Comparison.missingSystemCount }}</b></span>
              <span>缺少参考记录 <b>{{ reference424Comparison.missingReferenceCount }}</b></span>
              <span>供应商元数据差异 <b>{{ reference424Comparison.supplierMetadataDifferenceCount }}</b></span>
            </div>
            <div v-if="reference424Comparison" class="reference-records">
              <details v-for="record in reference424Comparison.records" :key="record.recordKey" :class="record.status.toLowerCase()" :open="record.status === 'DIFFERENT' || record.status.startsWith('MISSING')">
                <summary><span>{{ record.status }}</span><code>{{ record.recordKey }}</code><b>{{ record.fields.filter(field => !field.matched && field.severity === 'STANDARD').length }} 个标准差异</b></summary>
                <div class="record-lines"><pre>{{ record.systemLine || '系统缺少此记录' }}</pre><pre>{{ record.referenceLine || '参考数据缺少此记录' }}</pre></div>
                <table class="field-diff-table"><thead><tr><th>列</th><th>字段</th><th>系统</th><th>Jeppesen</th><th>结果</th></tr></thead><tbody>
                  <tr v-for="field in record.fields" :key="field.field" :class="{ different: !field.matched && field.severity === 'STANDARD', metadata: !field.matched && field.severity === 'SUPPLIER_METADATA' }"><td>{{ field.startColumn }}-{{ field.endColumn }}</td><td>{{ field.label }}</td><td><code>{{ field.systemValue || '∅' }}</code></td><td><code>{{ field.referenceValue || '∅' }}</code></td><td>{{ field.matched ? '一致' : field.severity === 'SUPPLIER_METADATA' ? '供应商差异' : '不同' }}</td></tr>
                </tbody></table>
              </details>
            </div>
          </section>
          <div v-if="publicationLedger?.releases.length" class="release-ledger">
            <div class="section-heading"><div><h3>发布与回滚记录</h3><p>发布文件不可覆盖；回滚只切换当前生效版本。</p></div><button type="button" class="danger-button" :disabled="publicationBusy || !publicationLedger.activeReleaseId" @click="rollbackPublication">回滚当前版本</button></div>
            <article v-for="release in [...publicationLedger.releases].reverse()" :key="release.releaseId"><span :class="release.status.toLowerCase()">{{ release.status }}</span><code>{{ release.releaseId }}</code><small>{{ dateTime(release.publishedAt) }}</small><button type="button" :disabled="viewing424" @click="viewRelease(release.releaseId)">查看 424</button></article>
          </div>
          <section v-if="viewed424Text" class="text-424-viewer">
            <header><div><small>页面内只读查看</small><h3>{{ viewed424Title }}</h3></div><button type="button" @click="viewed424Text = ''; viewed424Title = ''"><X :size="15" />关闭</button></header>
            <pre>{{ viewed424Text }}</pre>
          </section>
          <div v-if="!publicationWorkspace" class="tab-empty"><ShieldCheck :size="30" /><strong>等待 READY 数据锁定</strong><p>先在“发布审核”完成全部关键字段确认并提升为 READY，再从这里启动发布链路。</p></div>
        </template>

        <template v-else>
          <div v-if="!Object.keys(artifacts).length" class="tab-empty">阶段执行完成后，其版本化输出会显示在这里。</div>
          <details v-for="(artifact, key) in artifacts" :key="key" class="json-details"><summary><FileDiff :size="14" />{{ key }}</summary><pre>{{ json(artifact) }}</pre></details>
        </template>
      </section>
    </template>
  </section>
</template>

<style scoped>
.v2-workbench { display: grid; gap: 12px; color: #172033; }
.v2-hero { display: flex; align-items: flex-end; justify-content: space-between; gap: 20px; padding: 20px 22px; border: 1px solid #cbd5e1; border-radius: 14px; background: linear-gradient(135deg, #f8fafc 0%, #eff6ff 55%, #ecfeff 100%); box-shadow: 0 10px 28px rgba(30, 64, 175, .08); }
.v2-hero h2 { margin: 3px 0 4px; font-size: 25px; letter-spacing: -.02em; }
.v2-hero p { margin: 0; color: #526077; }
.eyebrow { display: flex; align-items: center; gap: 6px; color: #2563eb; font-size: 12px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; }
.hero-actions, .overview-actions { display: flex; align-items: flex-end; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
.hero-actions button, .overview-actions button, .stage-card-actions button { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 34px; }
.run-picker { display: grid; gap: 4px; color: #64748b; font-size: 11px; }
.run-picker select { min-width: 280px; }
.primary { border-color: #2563eb !important; background: #2563eb !important; color: #fff !important; }
.isolation-banner { display: flex; align-items: center; gap: 8px; padding: 10px 14px; border: 1px solid #bbf7d0; border-radius: 10px; background: #f0fdf4; color: #166534; }
.isolation-banner span { color: #3f6350; }
.workbench-message { display: flex; align-items: center; gap: 8px; padding: 10px 13px; border-radius: 9px; background: #eff6ff; color: #1d4ed8; }
.workbench-message.error { background: #fef2f2; color: #b91c1c; }
.empty-state, .tab-empty { display: grid; place-items: center; gap: 8px; min-height: 190px; padding: 30px; border: 1px dashed #cbd5e1; border-radius: 12px; background: #fff; color: #64748b; text-align: center; }
.empty-state strong { color: #172033; font-size: 18px; }
.run-overview { display: grid; grid-template-columns: minmax(180px, 1.4fr) repeat(4, minmax(100px, .65fr)) minmax(320px, 2fr); align-items: stretch; overflow: hidden; border: 1px solid #dbe3ef; border-radius: 12px; background: #fff; }
.run-identity, .metric, .overview-actions { padding: 13px 15px; border-right: 1px solid #e8edf5; }
.run-identity { display: flex; align-items: center; gap: 10px; }
.run-identity div, .metric { display: grid; gap: 3px; }
.run-identity small, .metric small { color: #64748b; font-size: 10px; letter-spacing: .08em; }
.run-identity strong { font-size: 15px; }
.metric strong { font-size: 20px; }.metric.danger strong { color: #dc2626; }.metric.warn strong { color: #d97706; }.metric.ready strong { color: #15803d; }
.status-dot { width: 10px; height: 10px; border-radius: 50%; background: #94a3b8; box-shadow: 0 0 0 5px #f1f5f9; }.status-dot.approved, .status-dot.completed { background: #16a34a; }.status-dot.review_required { background: #f59e0b; }.status-dot.failed, .status-dot.cancelled { background: #dc2626; }
.model-toggle { display: flex; align-items: center; gap: 6px; color: #475569; font-size: 12px; }.model-toggle input { width: auto; }
.danger-button { color: #b91c1c !important; border-color: #fecaca !important; background: #fff7f7 !important; }
.run-meta { display: flex; flex-wrap: wrap; gap: 8px 22px; padding: 8px 12px; border-radius: 8px; background: #f8fafc; color: #64748b; font-size: 11px; }.run-meta code { color: #334155; }
.stage-grid { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 9px; }
.stage-card { position: relative; display: grid; align-content: start; gap: 5px; min-height: 172px; padding: 12px; border: 1px solid #dbe3ef; border-top: 3px solid #cbd5e1; border-radius: 10px; background: #fff; }.stage-card.completed { border-top-color: #16a34a; }.stage-card.running { border-top-color: #2563eb; box-shadow: 0 0 0 2px #dbeafe; }.stage-card.skipped { border-top-color: #f59e0b; background: #fffbeb; }.stage-card.failed { border-top-color: #dc2626; }.stage-card.stale { border-top-color: #8b5cf6; }
.stage-top { display: flex; justify-content: space-between; align-items: center; }.stage-index { color: #94a3b8; font-family: ui-monospace, monospace; font-size: 11px; }.stage-status { padding: 2px 6px; border-radius: 999px; background: #f1f5f9; color: #64748b; font-size: 10px; }
.stage-card > strong { font-size: 14px; }.stage-card > small { color: #94a3b8; font-size: 9px; letter-spacing: .02em; }.dependency, .skip-note, .stage-error { margin: 2px 0 0; color: #64748b; font-size: 10px; line-height: 1.4; }.skip-note { color: #92400e; }.stage-error { color: #b91c1c; }
.stage-card-actions { display: grid; gap: 6px; margin-top: auto; padding-top: 7px; }.stage-card-actions textarea { width: 100%; min-height: 46px; resize: vertical; border: 1px solid #e2e8f0; border-radius: 6px; padding: 5px 6px; font: inherit; font-size: 10px; }.locked { display: flex; align-items: center; gap: 5px; color: #94a3b8; font-size: 11px; }
.workbench-tabs { display: flex; gap: 4px; overflow-x: auto; border-bottom: 1px solid #dbe3ef; }.workbench-tabs button { border: 0; border-bottom: 3px solid transparent; border-radius: 0; background: transparent; padding: 10px 13px; color: #64748b; }.workbench-tabs button.active { border-bottom-color: #2563eb; color: #1d4ed8; background: #eff6ff; }.workbench-tabs b { margin-left: 5px; padding: 1px 5px; border-radius: 999px; background: #e2e8f0; font-size: 10px; }
.workbench-content { display: grid; gap: 12px; min-height: 300px; }.candidate-layout { display: grid; grid-template-columns: minmax(0, 2fr) minmax(280px, .8fr); gap: 10px; align-items: start; }.data-table-wrap { overflow: auto; border: 1px solid #e2e8f0; border-radius: 9px; background: #fff; }.data-table { width: 100%; border-collapse: collapse; font-size: 12px; }.data-table th { position: sticky; top: 0; z-index: 1; background: #f8fafc; color: #64748b; text-align: left; font-size: 10px; letter-spacing: .04em; }.data-table th, .data-table td { padding: 8px 9px; border-bottom: 1px solid #edf1f7; vertical-align: top; }.data-table tbody tr { cursor: pointer; }.data-table tbody tr:hover, .data-table tbody tr.selected { background: #eff6ff; }.data-table tbody tr.review { box-shadow: inset 3px 0 #f59e0b; }.data-table td small { display: block; max-width: 180px; overflow: hidden; color: #94a3b8; text-overflow: ellipsis; white-space: nowrap; }.entity-type { display: inline-block; margin-bottom: 2px; color: #1d4ed8; font-weight: 700; }.value-cell { max-width: 220px; word-break: break-word; }
.mini-badge, .review-mark { display: inline-block; padding: 2px 5px; border-radius: 999px; background: #e2e8f0; font-size: 9px; }.mini-badge.observed, .mini-badge.same { background: #dcfce7; color: #166534; }.mini-badge.derived, .mini-badge.only_v2 { background: #dbeafe; color: #1d4ed8; }.mini-badge.unresolved, .mini-badge.changed, .review-mark { background: #fef3c7; color: #92400e; }.review-mark { margin-left: 3px; }
.evidence-panel { position: sticky; top: 0; display: grid; gap: 9px; max-height: 560px; overflow: auto; padding: 12px; border: 1px solid #dbe3ef; border-radius: 9px; background: #f8fafc; color: #64748b; }.evidence-title { display: flex; align-items: center; gap: 8px; color: #172033; }.evidence-title div { display: grid; }.evidence-title small { color: #94a3b8; font-size: 9px; }.evidence-card { display: grid; gap: 6px; padding: 9px; border: 1px solid #e2e8f0; border-radius: 7px; background: #fff; }.evidence-card div { display: flex; gap: 6px; align-items: center; }.evidence-card span { padding: 2px 5px; border-radius: 4px; background: #dbeafe; color: #1d4ed8; font-weight: 700; }.evidence-card em { margin-left: auto; color: #64748b; font-size: 9px; }.evidence-card p { margin: 0; color: #334155; line-height: 1.5; white-space: pre-wrap; }.evidence-card small { color: #94a3b8; }.missing-evidence { color: #b91c1c; }
.topology-summary { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }.topology-summary section { display: grid; gap: 3px; padding: 13px; border: 1px solid #dbe3ef; border-radius: 9px; background: #fff; }.topology-summary small { color: #64748b; }.topology-summary strong { color: #1d4ed8; font-size: 24px; }.topology-summary p { margin: 0; color: #64748b; font-size: 10px; }.topology-chain { display: grid; gap: 6px; }.topology-chain article { display: grid; grid-template-columns: 38px 1fr auto; align-items: center; gap: 10px; padding: 10px 12px; border: 1px solid #dbe3ef; border-left: 4px solid #16a34a; border-radius: 8px; background: #fff; cursor: pointer; }.topology-chain article.review { border-left-color: #f59e0b; }.topology-chain article > span { color: #94a3b8; font-family: ui-monospace, monospace; }.topology-chain article div { display: grid; gap: 2px; }.topology-chain article small, .topology-chain article em { color: #64748b; font-size: 10px; }.topology-chain article em { color: #15803d; }.topology-chain article.review em { color: #b45309; }
.section-heading { display: flex; align-items: center; justify-content: space-between; margin-top: 5px; }.section-heading h3, .section-heading p { margin: 0; }.section-heading p { color: #64748b; font-size: 11px; }.section-heading > span { display: grid; place-items: center; min-width: 30px; height: 30px; border-radius: 50%; background: #e2e8f0; font-weight: 700; }.success-empty { display: flex; align-items: center; gap: 7px; padding: 14px; border: 1px solid #bbf7d0; border-radius: 8px; background: #f0fdf4; color: #15803d; }
.issue-card, .unresolved-card, .validation-row { border: 1px solid #e2e8f0; border-left: 4px solid #f59e0b; border-radius: 8px; background: #fff; padding: 10px 12px; }.issue-card.blocking, .unresolved-card.blocking, .validation-row.blocking { border-left-color: #dc2626; }.issue-head { display: flex; align-items: center; gap: 8px; }.issue-head > span, .validation-row > span { color: #b91c1c; font-size: 10px; font-weight: 800; }.issue-head em { margin-left: auto; color: #64748b; }.candidate-choices { display: flex; gap: 8px; margin-top: 8px; }.candidate-choices > div { display: grid; gap: 2px; flex: 1; padding: 8px; border-radius: 6px; background: #f8fafc; }.candidate-choices small { color: #94a3b8; }.unresolved-card div { display: flex; gap: 8px; align-items: center; }.unresolved-card span { color: #b45309; font-size: 10px; font-weight: 800; }.unresolved-card.blocking span { color: #b91c1c; }.unresolved-card p { margin: 6px 0 0; color: #64748b; }
.decision-banner { display: flex; align-items: center; gap: 12px; padding: 15px; border: 1px solid #fecaca; border-radius: 10px; background: #fef2f2; color: #b91c1c; }.decision-banner.review_required { border-color: #fde68a; background: #fffbeb; color: #92400e; }.decision-banner.ready { border-color: #bbf7d0; background: #f0fdf4; color: #166534; }.decision-banner div { display: grid; }.decision-banner small { font-size: 9px; letter-spacing: .1em; }.decision-banner strong { font-size: 22px; }.decision-banner p { margin: 0; }.validation-row { display: grid; grid-template-columns: 80px 1fr; gap: 10px; }.validation-row.warning > span { color: #b45309; }.validation-row.info { border-left-color: #3b82f6; }.validation-row p { margin: 3px 0; }.validation-row em { color: #64748b; font-size: 10px; }.validation-row small { color: #94a3b8; }
.review-summary { display: grid; grid-template-columns: repeat(5, 1fr); gap: 8px; }.review-summary section { display: grid; gap: 3px; padding: 12px 14px; border: 1px solid #dbe3ef; border-radius: 9px; background: #fff; }.review-summary small { color: #64748b; }.review-summary strong { color: #334155; font-size: 23px; }.review-summary .pending strong { color: #b45309; }.review-summary .confirmed strong { color: #15803d; }.review-summary .corrected strong { color: #1d4ed8; }
.review-toolbar { display: flex; align-items: flex-end; gap: 10px; padding: 11px 12px; border: 1px solid #dbe3ef; border-radius: 9px; background: #f8fafc; }.review-toolbar label { display: grid; gap: 4px; color: #64748b; font-size: 10px; }.review-toolbar input, .review-toolbar select { min-width: 180px; }.review-safety { display: flex; align-items: center; gap: 5px; margin-right: auto; color: #166534; font-size: 11px; }
.review-layout { display: grid; grid-template-columns: minmax(300px, .8fr) minmax(440px, 1.2fr); gap: 10px; align-items: start; }.review-list { display: grid; gap: 6px; max-height: 760px; overflow: auto; padding-right: 4px; }.review-item { display: grid; gap: 3px; padding: 10px 12px; border: 1px solid #dbe3ef; border-left: 4px solid #f59e0b; border-radius: 8px; background: #fff; cursor: pointer; }.review-item:hover, .review-item.selected { border-color: #60a5fa; background: #eff6ff; }.review-item.confirmed { border-left-color: #16a34a; }.review-item.corrected { border-left-color: #2563eb; }.review-item-head { display: flex; align-items: center; justify-content: space-between; }.review-item-head span { color: #92400e; font-size: 10px; font-weight: 800; }.review-item.confirmed .review-item-head span { color: #15803d; }.review-item.corrected .review-item-head span { color: #1d4ed8; }.review-item-head em { color: #64748b; font-size: 9px; }.review-item small { color: #64748b; }.review-item p { overflow: hidden; margin: 2px 0; color: #172033; text-overflow: ellipsis; white-space: nowrap; }.procedure-tags { display: flex; gap: 4px; flex-wrap: wrap; }.procedure-tags i { padding: 2px 5px; border-radius: 999px; background: #e2e8f0; color: #475569; font-size: 9px; font-style: normal; }
.review-detail { display: grid; grid-template-rows: auto minmax(0, 1fr); gap: 10px; height: 760px; overflow: hidden; padding: 13px; border: 1px solid #dbe3ef; border-radius: 10px; background: #f8fafc; }.review-detail > header { display: flex; align-items: center; justify-content: space-between; }.review-detail h3, .review-detail header small { margin: 0; }.review-detail header small { color: #64748b; }.review-detail header span { padding: 3px 7px; border-radius: 999px; background: #fef3c7; color: #92400e; font-size: 10px; font-weight: 800; }.review-detail header span.confirmed { background: #dcfce7; color: #166534; }.review-detail header span.corrected { background: #dbeafe; color: #1d4ed8; }.review-detail-body { display: grid; grid-template-columns: minmax(360px, .9fr) minmax(360px, 1.1fr); gap: 10px; min-height: 0; }.review-editor, .review-evidence-column { min-height: 0; overflow: auto; }.review-editor { display: grid; align-content: start; gap: 10px; padding-right: 4px; }.review-evidence-column { display: grid; align-content: start; gap: 9px; padding: 10px; border: 1px solid #bfdbfe; border-radius: 9px; background: #eff6ff; }.review-evidence-column .section-heading { margin-top: 0; }.review-evidence-column .source-image-card { grid-template-columns: 1fr; }.review-evidence-column .source-image { min-height: 220px; }.value-comparison { display: grid; grid-template-columns: repeat(2, 1fr); gap: 7px; }.value-comparison label { display: grid; gap: 4px; padding: 9px; border-radius: 7px; background: #fff; color: #64748b; font-size: 10px; }.value-comparison strong { color: #172033; font-size: 13px; word-break: break-word; }.suggested-values { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; }.suggested-values small { width: 100%; color: #64748b; }.suggested-values button { min-height: 27px; padding: 3px 7px; background: #fff; color: #1d4ed8; font-size: 10px; }.correction-field { display: grid; gap: 4px; color: #64748b; font-size: 10px; }.correction-field textarea { width: 100%; resize: vertical; border: 1px solid #cbd5e1; border-radius: 7px; padding: 7px; font: inherit; color: #172033; }.review-actions { display: flex; gap: 7px; }.review-actions button { display: inline-flex; align-items: center; gap: 5px; }.review-reasons { display: flex; gap: 4px; flex-wrap: wrap; }.review-reasons span { padding: 3px 6px; border-radius: 4px; background: #e2e8f0; color: #475569; font: 9px ui-monospace, monospace; }
.bundle-field-list { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 5px; }.bundle-field-list button { display: grid; grid-template-columns: 1fr auto; gap: 2px 6px; min-height: 48px; padding: 7px 8px; border-color: #dbe3ef; background: #fff; text-align: left; }.bundle-field-list button.active { border-color: #2563eb; box-shadow: 0 0 0 1px #2563eb; }.bundle-field-list button.confirmed { background: #f0fdf4; }.bundle-field-list button.corrected { background: #eff6ff; }.bundle-field-list button span { color: #64748b; font-size: 10px; }.bundle-field-list button strong { overflow: hidden; color: #172033; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }.bundle-field-list button em { grid-column: 2; grid-row: 1; color: #94a3b8; font-size: 8px; }.bundle-confirm { display: inline-flex; align-items: center; justify-content: center; gap: 6px; border-color: #16a34a !important; background: #f0fdf4 !important; color: #166534 !important; }.field-editor-title { display: flex; align-items: center; gap: 8px; padding-top: 7px; border-top: 1px solid #dbe3ef; }.field-editor-title small { color: #64748b; }
.source-image-card { display: grid; grid-template-columns: minmax(180px, .85fr) 1fr; gap: 9px; padding: 9px; border: 1px solid #dbe3ef; border-radius: 8px; background: #fff; }.source-image { position: relative; overflow: hidden; min-height: 150px; border: 1px solid #cbd5e1; border-radius: 5px; background: #e2e8f0; }.source-image-card > div:last-child { display: grid; align-content: start; gap: 5px; }.source-image-card em { color: #64748b; font-size: 9px; }.source-image-card p { max-height: 120px; overflow: auto; margin: 0; color: #334155; font-size: 11px; line-height: 1.45; white-space: pre-wrap; }
.preview-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }.preview-card { display: grid; gap: 4px; padding: 13px; border: 1px solid #dbe3ef; border-radius: 8px; background: #fff; }.preview-card small { color: #64748b; }.preview-card strong { font-size: 20px; }.diff-summary { display: flex; gap: 8px; }.diff-summary span { padding: 8px 10px; border-radius: 7px; background: #f1f5f9; }.diff-summary b { margin-left: 6px; }.diff-table td:nth-child(3), .diff-table td:nth-child(4) { max-width: 340px; word-break: break-word; }
.preview-actions { display: flex; align-items: center; gap: 10px; }.preview-actions button { display: inline-flex; align-items: center; gap: 6px; }.preview-actions small { color: #64748b; }
.json-details { border: 1px solid #dbe3ef; border-radius: 8px; background: #fff; }.json-details summary { display: flex; align-items: center; gap: 6px; padding: 10px 12px; cursor: pointer; font-weight: 700; }.json-details pre { max-height: 520px; overflow: auto; margin: 0; border-top: 1px solid #e2e8f0; background: #0f172a; color: #dbeafe; padding: 12px; font: 11px/1.55 ui-monospace, monospace; white-space: pre-wrap; }
.airport-aggregate-panel { display: grid; gap: 12px; padding: 16px; border: 2px solid #0f766e; border-radius: 12px; background: #f0fdfa; }
.airport-aggregate-summary { display: grid; grid-template-columns: repeat(4, minmax(110px, 1fr)) auto auto; gap: 8px; align-items: stretch; }
.airport-aggregate-summary section { display: grid; gap: 3px; padding: 10px; border: 1px solid #99f6e4; border-radius: 8px; background: #fff; }
.airport-aggregate-summary small { color: #64748b; }.airport-aggregate-summary strong { font-size: 20px; }
.airport-missing-packages { display: flex; gap: 7px; align-items: center; flex-wrap: wrap; padding: 10px; border-radius: 8px; background: #fff7ed; color: #9a3412; }
.airport-missing-packages span { padding: 3px 7px; border-radius: 999px; background: #ffedd5; }
.airport-batch-control { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 12px; border: 1px solid #5eead4; border-radius: 9px; background: #fff; }
.airport-batch-status-summary { display: grid; grid-template-columns: repeat(5, minmax(100px, 1fr)); gap: 8px; }
.airport-batch-status-summary section { display: grid; gap: 3px; padding: 10px 12px; border: 1px solid #dbe4ef; border-radius: 8px; background: #fff; }
.airport-batch-status-summary small { color: #64748b; }.airport-batch-status-summary strong { font-size: 22px; color: #1e293b; }
.airport-batch-status-summary .warn { border-color: #fdba74; background: #fff7ed; }.airport-batch-status-summary .warn strong { color: #c2410c; }
.airport-batch-status-summary .pass { border-color: #86efac; background: #f0fdf4; }.airport-batch-status-summary .pass strong { color: #15803d; }
.airport-formal-release { display: grid; grid-template-columns: minmax(240px, 1fr) auto auto auto auto; gap: 9px; align-items: center; padding: 12px; border: 1px solid #a5b4fc; border-radius: 9px; background: #f7f7ff; }
.airport-formal-release > div { display: grid; gap: 3px; }.airport-formal-release small { color: #64748b; }.airport-formal-release button { white-space: nowrap; }
.airport-formal-ledger { display: grid; gap: 6px; }.airport-formal-ledger article { display: grid; grid-template-columns: 90px minmax(260px, 1fr) minmax(220px, auto) auto; gap: 9px; align-items: center; padding: 8px 10px; border: 1px solid #e2e8f0; border-radius: 7px; background: #fff; }
.airport-formal-ledger article > span { font-size: 10px; font-weight: 800; }.airport-formal-ledger .active { color: #15803d; }.airport-formal-ledger .superseded, .airport-formal-ledger .rolled_back { color: #64748b; }
.advanced-diagnostics { border: 1px solid #dbe4ef; border-radius: 10px; background: #f8fafc; }
.advanced-diagnostics > summary { display: flex; align-items: center; gap: 12px; padding: 11px 14px; cursor: pointer; color: #334155; }
.advanced-diagnostics > summary span { font-weight: 800; }.advanced-diagnostics > summary small { color: #64748b; }
.advanced-diagnostics[open] > summary { border-bottom: 1px solid #dbe4ef; }.advanced-diagnostics > .run-meta, .advanced-diagnostics > .stage-grid, .advanced-diagnostics > .workbench-tabs { margin: 12px; }
.empty-airport-summary { display: grid; grid-template-columns: repeat(4, minmax(90px, 1fr)); gap: 8px; width: min(620px, 100%); }
.empty-airport-summary span { display: grid; gap: 2px; padding: 9px; border: 1px solid #dbe4ef; border-radius: 7px; background: #fff; color: #64748b; }.empty-airport-summary b { color: #172033; font-size: 20px; }
.single-package-start { margin-top: 4px; color: #64748b; }.single-package-start summary { cursor: pointer; font-size: 12px; }.single-package-start button { margin-top: 8px; }
.airport-batch-control > div { display: grid; gap: 3px; }.airport-batch-control small { color: #64748b; }
.airport-batch-control button { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
.airport-batch-progress { display: grid; gap: 7px; }.airport-batch-progress > div { display: flex; gap: 14px; align-items: center; color: #475569; }.airport-batch-progress strong { color: #0f766e; font-size: 20px; }.airport-batch-progress progress { width: 100%; height: 12px; accent-color: #0f766e; }
.airport-batch-issues { display: grid; gap: 7px; padding: 12px; border: 1px solid #fdba74; border-radius: 9px; background: #fff7ed; }
.airport-batch-issues article { display: grid; grid-template-columns: 115px minmax(150px, .6fr) 150px 1fr auto; gap: 8px; align-items: center; padding: 8px; border-radius: 7px; background: #fff; }
.airport-batch-issues article > span { color: #b45309; font-size: 10px; font-weight: 800; }.airport-batch-issues article p { margin: 0; color: #7c2d12; word-break: break-word; }
@media (max-width: 1100px) { .airport-batch-status-summary { grid-template-columns: repeat(2, minmax(120px, 1fr)); }.airport-formal-release { grid-template-columns: 1fr auto; }.airport-formal-ledger article { grid-template-columns: 1fr auto; } }
.publication-head { display: flex; align-items: center; justify-content: space-between; padding: 16px; border: 1px solid #bfdbfe; border-radius: 10px; background: #eff6ff; }.publication-head h3, .publication-head p { margin: 2px 0; }.publication-head small, .publication-head p { color: #64748b; }.publication-head > span { padding: 6px 10px; border-radius: 999px; background: #e2e8f0; color: #475569; font-weight: 800; }.publication-head > span.publishable, .publication-head > span.published { background: #dcfce7; color: #166534; }.publication-head > span.preflight_blocked, .publication-head > span.rolled_back { background: #fee2e2; color: #991b1b; }
.publication-steps { display: grid; grid-template-columns: repeat(6, 1fr); gap: 7px; }.publication-steps button { display: flex; align-items: center; gap: 8px; min-height: 70px; padding: 9px; text-align: left; }.publication-steps b { display: grid; place-items: center; flex: 0 0 25px; height: 25px; border-radius: 50%; background: #dbeafe; color: #1d4ed8; }.publication-steps span { display: grid; gap: 2px; font-weight: 700; }.publication-steps small { color: #64748b; font-size: 9px; font-weight: 400; }.publication-steps .publish-step:not(:disabled) { border-color: #16a34a; background: #16a34a; color: #fff; }.publication-steps .publish-step:not(:disabled) b { background: #fff; color: #15803d; }.publication-steps .publish-step:not(:disabled) small { color: #dcfce7; }
.publication-checks { display: grid; gap: 5px; }.publication-checks article { display: grid; grid-template-columns: 55px 180px 1fr; gap: 8px; padding: 8px 10px; border-left: 4px solid #16a34a; border-radius: 6px; background: #f8fafc; }.publication-checks article.block { border-left-color: #dc2626; background: #fef2f2; }.publication-checks strong { color: #15803d; }.publication-checks .block strong { color: #b91c1c; }.publication-checks code { color: #64748b; }
.publication-checks article.warn { border-left-color: #f59e0b; background: #fffbeb; }.publication-checks .warn strong { color: #b45309; }.airport-coverage-panel { display: grid; gap: 9px; padding: 12px; border: 1px solid #fcd34d; border-radius: 9px; background: #fffdf5; }.airport-coverage-panel .section-heading > span { width: auto; min-width: 72px; padding: 0 10px; border-radius: 999px; background: #fef3c7; color: #92400e; }.airport-coverage-panel .section-heading > span.complete { background: #dcfce7; color: #166534; }
.publication-output { display: grid; grid-template-columns: 140px 140px 1fr auto; gap: 8px; align-items: stretch; }.publication-output section { display: grid; gap: 3px; padding: 10px 12px; border: 1px solid #dbe3ef; border-radius: 8px; background: #fff; }.publication-output small { color: #64748b; }.publication-output strong { font-size: 20px; }.publication-output button { align-self: stretch; }.release-ledger { display: grid; gap: 6px; padding: 12px; border: 1px solid #dbe3ef; border-radius: 9px; background: #fff; }.release-ledger article { display: grid; grid-template-columns: 100px 1fr auto auto; gap: 10px; align-items: center; padding: 8px; border-top: 1px solid #edf1f7; }.release-ledger article span { color: #64748b; font-weight: 800; }.release-ledger article span.active { color: #15803d; }.release-ledger article span.rolled_back { color: #b91c1c; }
.text-424-viewer { display: grid; min-width: 0; border: 1px solid #bfdbfe; border-radius: 10px; overflow: hidden; background: #0f172a; }.text-424-viewer header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 12px; background: #eff6ff; color: #172033; }.text-424-viewer header div { display: grid; gap: 2px; }.text-424-viewer header small { color: #64748b; }.text-424-viewer header h3 { margin: 0; font-size: 14px; }.text-424-viewer header button { display: inline-flex; align-items: center; gap: 5px; }.text-424-viewer pre { max-height: 520px; overflow: auto; margin: 0; padding: 16px; color: #dbeafe; font: 12px/1.65 ui-monospace, SFMono-Regular, Consolas, monospace; white-space: pre; }
.reference-424-compare { display: grid; gap: 10px; padding: 14px; border: 1px solid #bfdbfe; border-radius: 10px; background: #f8fbff; }.reference-424-compare textarea { width: 100%; min-height: 180px; resize: vertical; border: 1px solid #cbd5e1; border-radius: 8px; padding: 10px; font: 11px/1.55 ui-monospace, SFMono-Regular, Consolas, monospace; white-space: pre; }.reference-compare-summary { display: grid; grid-template-columns: repeat(4, 1fr); gap: 7px; }.reference-compare-summary span { display: grid; gap: 3px; padding: 9px 11px; border-radius: 7px; background: #fff; color: #64748b; }.reference-compare-summary b { color: #172033; font-size: 19px; }.reference-records { display: grid; gap: 7px; }.reference-records details { overflow: hidden; border: 1px solid #dbe3ef; border-left: 4px solid #16a34a; border-radius: 8px; background: #fff; }.reference-records details.different, .reference-records details.missing_system, .reference-records details.missing_reference { border-left-color: #dc2626; }.reference-records details.metadata_only { border-left-color: #94a3b8; }.reference-records summary { display: grid; grid-template-columns: 130px 1fr auto; gap: 10px; padding: 9px 11px; cursor: pointer; }.reference-records summary span { font-weight: 800; }.reference-records summary b { color: #b91c1c; }.record-lines { display: grid; gap: 4px; padding: 8px; background: #0f172a; }.record-lines pre { overflow: auto; margin: 0; color: #dbeafe; font: 10px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace; white-space: pre; }.field-diff-table { width: 100%; border-collapse: collapse; font-size: 11px; }.field-diff-table th, .field-diff-table td { padding: 6px 8px; border-top: 1px solid #edf1f7; text-align: left; }.field-diff-table tr.different { background: #fef2f2; color: #991b1b; }.field-diff-table tr.metadata { background: #f8fafc; color: #64748b; }
.comparison-limit-note { margin: 0; padding: 8px 10px; border-radius: 6px; background: #fff7ed; color: #9a3412; font-size: 12px; }
.spin { animation: spin .8s linear infinite; }@keyframes spin { to { transform: rotate(360deg); } }
.review-action-feedback { margin: 0; padding: 8px 10px; border: 1px solid #fecaca; border-radius: 7px; background: #fef2f2; color: #b91c1c; font-size: 11px; }.review-action-feedback.success { border-color: #bbf7d0; background: #f0fdf4; color: #166534; }
@media (max-width: 1500px) { .review-detail { height: auto; max-height: none; overflow: visible; }.review-detail-body { grid-template-columns: 1fr; }.review-evidence-column { order: -1; max-height: 420px; }.review-editor { max-height: 620px; } }
@media (max-width: 1350px) { .run-overview { grid-template-columns: repeat(5, 1fr); }.run-identity { grid-column: span 2; }.overview-actions { grid-column: 1 / -1; border-top: 1px solid #e8edf5; }.stage-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
@media (max-width: 850px) { .v2-hero { align-items: stretch; flex-direction: column; }.hero-actions { justify-content: flex-start; }.run-picker select { min-width: 0; width: 100%; }.run-overview, .stage-grid, .candidate-layout, .preview-grid, .topology-summary, .review-summary, .review-layout, .source-image-card { grid-template-columns: 1fr; }.run-identity { grid-column: auto; }.metric { border-top: 1px solid #e8edf5; }.evidence-panel { position: static; }.validation-row { grid-template-columns: 1fr; }.review-toolbar { align-items: stretch; flex-direction: column; }.review-safety { margin-right: 0; }.review-list, .review-editor, .review-evidence-column { max-height: none; } }
</style>
