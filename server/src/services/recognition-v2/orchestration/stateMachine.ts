import {
  RECOGNITION_V2_CONTRACT_VERSION,
  RECOGNITION_V2_SCHEMA_IDS,
  type RecognitionV2RunManifest,
  type RecognitionV2Stage,
  type StageRunRecord,
  type V2RunStatus,
} from '../contracts/index';

export const RECOGNITION_V2_STAGES: readonly RecognitionV2Stage[] = [
  'PAGE_LAYOUT',
  'PROCEDURE_IDENTITY',
  'PROCEDURE_TABLE',
  'WAYPOINT_NAVAID',
  'NOTES_CONSTRAINTS',
  'CHART_TOPOLOGY',
  'EVIDENCE_FUSION',
  'SEMANTIC_VALIDATION',
  'HUMAN_REVIEW',
  'PUBLISH_CANONICAL',
] as const;

export const STAGE_DEPENDENCIES: Readonly<Record<RecognitionV2Stage, readonly RecognitionV2Stage[]>> = {
  PAGE_LAYOUT: [],
  PROCEDURE_IDENTITY: ['PAGE_LAYOUT'],
  PROCEDURE_TABLE: ['PAGE_LAYOUT'],
  WAYPOINT_NAVAID: ['PAGE_LAYOUT'],
  NOTES_CONSTRAINTS: ['PAGE_LAYOUT'],
  CHART_TOPOLOGY: ['PAGE_LAYOUT'],
  EVIDENCE_FUSION: [
    'PROCEDURE_IDENTITY',
    'PROCEDURE_TABLE',
    'WAYPOINT_NAVAID',
    'NOTES_CONSTRAINTS',
    'CHART_TOPOLOGY',
  ],
  SEMANTIC_VALIDATION: ['EVIDENCE_FUSION'],
  HUMAN_REVIEW: ['SEMANTIC_VALIDATION'],
  // Publishing may skip HUMAN_REVIEW when deterministic validation returns READY.
  // The publish executor must inspect ValidationStageResult before writing V1 canonical data.
  PUBLISH_CANONICAL: ['SEMANTIC_VALIDATION'],
};

export class RecognitionV2StateError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'RecognitionV2StateError';
  }
}

export function createInitialManifest(input: {
  runId: string;
  taskId: string;
  packageId: string;
  sourcePackageHash: string;
  now?: string;
}): RecognitionV2RunManifest {
  if (!input.runId.trim() || !input.taskId.trim() || !input.packageId.trim() || !input.sourcePackageHash.trim()) {
    throw new RecognitionV2StateError('RUN_IDENTITY_REQUIRED', 'Run, task, package and source hash are required.');
  }
  const now = input.now ?? new Date().toISOString();
  return {
    contractVersion: RECOGNITION_V2_CONTRACT_VERSION,
    schemaId: RECOGNITION_V2_SCHEMA_IDS.runManifest,
    runId: input.runId,
    taskId: input.taskId,
    packageId: input.packageId,
    status: 'CREATED',
    sourcePackageHash: input.sourcePackageHash,
    stages: RECOGNITION_V2_STAGES.map((stage) => ({ stage, status: 'PENDING', attempt: 0 })),
    createdAt: now,
    updatedAt: now,
  };
}

export function isRecognitionV2Stage(value: unknown): value is RecognitionV2Stage {
  return RECOGNITION_V2_STAGES.includes(String(value).toUpperCase() as RecognitionV2Stage);
}

export function assertStageCanStart(manifest: RecognitionV2RunManifest, stage: RecognitionV2Stage) {
  if (manifest.status === 'CANCELLED') {
    throw new RecognitionV2StateError('RUN_CANCELLED', `Run ${manifest.runId} has been cancelled.`);
  }
  const active = manifest.stages.find((item) => item.status === 'RUNNING');
  if (active) {
    throw new RecognitionV2StateError('STAGE_ALREADY_RUNNING', `Stage ${active.stage} is already running.`);
  }
  const missing = STAGE_DEPENDENCIES[stage].filter((dependency) => {
    const status = stageRecord(manifest, dependency).status;
    return status !== 'COMPLETED' && status !== 'SKIPPED';
  });
  if (missing.length) {
    throw new RecognitionV2StateError(
      'DEPENDENCY_NOT_COMPLETED',
      `Stage ${stage} requires completed dependencies: ${missing.join(', ')}.`,
    );
  }
}

export function startStage(
  manifestValue: RecognitionV2RunManifest,
  stage: RecognitionV2Stage,
  input: { inputHash: string; now?: string },
): RecognitionV2RunManifest {
  if (!input.inputHash.trim()) throw new RecognitionV2StateError('INPUT_HASH_REQUIRED', `Stage ${stage} requires an input hash.`);
  assertStageCanStart(manifestValue, stage);
  const manifest = cloneManifest(manifestValue);
  const now = input.now ?? new Date().toISOString();
  invalidateDescendants(manifest, stage);
  const record = stageRecord(manifest, stage);
  record.status = 'RUNNING';
  record.attempt += 1;
  record.inputHash = input.inputHash;
  record.outputRef = undefined;
  record.startedAt = now;
  record.completedAt = undefined;
  record.skipReason = undefined;
  record.error = undefined;
  manifest.activeStage = stage;
  manifest.status = runningStatus(stage);
  manifest.updatedAt = now;
  manifest.canonicalRef = stage === 'PUBLISH_CANONICAL' ? undefined : manifest.canonicalRef;
  return manifest;
}

export function completeStage(
  manifestValue: RecognitionV2RunManifest,
  stage: RecognitionV2Stage,
  input: { outputRef: string; canonicalRef?: string; now?: string },
): RecognitionV2RunManifest {
  if (!input.outputRef.trim()) throw new RecognitionV2StateError('OUTPUT_REF_REQUIRED', `Stage ${stage} requires an output reference.`);
  if (stage === 'PUBLISH_CANONICAL' && !input.canonicalRef?.trim()) {
    throw new RecognitionV2StateError('CANONICAL_REF_REQUIRED', 'Publishing requires a canonical artifact reference.');
  }
  const manifest = cloneManifest(manifestValue);
  const record = stageRecord(manifest, stage);
  if (record.status !== 'RUNNING') {
    throw new RecognitionV2StateError('STAGE_NOT_RUNNING', `Stage ${stage} is ${record.status}, not RUNNING.`);
  }
  const now = input.now ?? new Date().toISOString();
  record.status = 'COMPLETED';
  record.outputRef = input.outputRef;
  record.completedAt = now;
  record.skipReason = undefined;
  record.error = undefined;
  manifest.activeStage = undefined;
  manifest.status = completedRunStatus(stage);
  manifest.updatedAt = now;
  if (input.canonicalRef) manifest.canonicalRef = input.canonicalRef;
  return manifest;
}

export function skipStage(
  manifestValue: RecognitionV2RunManifest,
  stage: RecognitionV2Stage,
  input: { reason: string; now?: string },
): RecognitionV2RunManifest {
  assertStageCanStart(manifestValue, stage);
  if (!input.reason.trim()) throw new RecognitionV2StateError('SKIP_REASON_REQUIRED', `Stage ${stage} requires a skip reason.`);
  const manifest = cloneManifest(manifestValue);
  const now = input.now ?? new Date().toISOString();
  invalidateDescendants(manifest, stage);
  const record = stageRecord(manifest, stage);
  record.status = 'SKIPPED';
  record.skipReason = input.reason.trim();
  record.attempt += 1;
  record.startedAt = now;
  record.completedAt = now;
  record.outputRef = undefined;
  record.error = undefined;
  manifest.activeStage = undefined;
  manifest.status = 'CREATED';
  manifest.updatedAt = now;
  return manifest;
}

export function failStage(
  manifestValue: RecognitionV2RunManifest,
  stage: RecognitionV2Stage,
  input: { code: string; message: string; retryable: boolean; now?: string },
): RecognitionV2RunManifest {
  const manifest = cloneManifest(manifestValue);
  const record = stageRecord(manifest, stage);
  if (record.status !== 'RUNNING') {
    throw new RecognitionV2StateError('STAGE_NOT_RUNNING', `Stage ${stage} is ${record.status}, not RUNNING.`);
  }
  const now = input.now ?? new Date().toISOString();
  record.status = 'FAILED';
  record.completedAt = now;
  record.error = { code: input.code, message: input.message, retryable: input.retryable };
  manifest.activeStage = undefined;
  manifest.status = 'FAILED';
  manifest.updatedAt = now;
  return manifest;
}

export function cancelRun(manifestValue: RecognitionV2RunManifest, nowValue?: string): RecognitionV2RunManifest {
  if (manifestValue.status === 'CANCELLED') return cloneManifest(manifestValue);
  if (manifestValue.status === 'COMPLETED') {
    throw new RecognitionV2StateError('RUN_COMPLETED', `Completed run ${manifestValue.runId} cannot be cancelled.`);
  }
  const manifest = cloneManifest(manifestValue);
  const now = nowValue ?? new Date().toISOString();
  for (const stage of manifest.stages) {
    if (stage.status === 'RUNNING') {
      stage.status = 'CANCELLED';
      stage.completedAt = now;
      stage.error = { code: 'RUN_CANCELLED', message: 'Recognition V2 run was cancelled.', retryable: true };
    }
  }
  manifest.status = 'CANCELLED';
  manifest.activeStage = undefined;
  manifest.updatedAt = now;
  return manifest;
}

export function stageDescendants(stage: RecognitionV2Stage): RecognitionV2Stage[] {
  const descendants = new Set<RecognitionV2Stage>();
  const visit = (parent: RecognitionV2Stage) => {
    for (const candidate of RECOGNITION_V2_STAGES) {
      if (!STAGE_DEPENDENCIES[candidate].includes(parent) || descendants.has(candidate)) continue;
      descendants.add(candidate);
      visit(candidate);
    }
  };
  visit(stage);
  return [...descendants];
}

function invalidateDescendants(manifest: RecognitionV2RunManifest, stage: RecognitionV2Stage) {
  for (const descendant of stageDescendants(stage)) {
    const record = stageRecord(manifest, descendant);
    if (record.status === 'PENDING') continue;
    record.status = 'STALE';
    record.error = undefined;
    record.completedAt = undefined;
    record.skipReason = undefined;
  }
  if (stageDescendants(stage).includes('PUBLISH_CANONICAL')) manifest.canonicalRef = undefined;
}

function stageRecord(manifest: RecognitionV2RunManifest, stage: RecognitionV2Stage): StageRunRecord {
  const record = manifest.stages.find((item) => item.stage === stage);
  if (!record) throw new RecognitionV2StateError('STAGE_RECORD_MISSING', `Manifest is missing stage ${stage}.`);
  return record;
}

function runningStatus(stage: RecognitionV2Stage): V2RunStatus {
  if (stage === 'PAGE_LAYOUT') return 'LAYOUT_RUNNING';
  if (stage === 'EVIDENCE_FUSION') return 'FUSION_RUNNING';
  if (stage === 'SEMANTIC_VALIDATION') return 'VALIDATION_RUNNING';
  if (stage === 'HUMAN_REVIEW') return 'REVIEW_REQUIRED';
  return 'EXTRACTION_RUNNING';
}

function completedRunStatus(stage: RecognitionV2Stage): V2RunStatus {
  if (stage === 'SEMANTIC_VALIDATION') return 'REVIEW_REQUIRED';
  if (stage === 'HUMAN_REVIEW') return 'APPROVED';
  if (stage === 'PUBLISH_CANONICAL') return 'COMPLETED';
  return 'CREATED';
}

function cloneManifest(manifest: RecognitionV2RunManifest): RecognitionV2RunManifest {
  return structuredClone(manifest);
}
