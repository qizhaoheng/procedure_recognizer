import type { PublicationLedger, RecognitionV2RunManifest, RecognitionV2Stage } from '../contracts/index';

export type AirportBatchPackageState =
  | 'NOT_STARTED'
  | 'PAUSED'
  | 'RUNNING'
  | 'NEEDS_OPTIMIZATION'
  | 'READY_TO_PUBLISH'
  | 'PUBLISHED';

export type AirportBatchIssueCategory = 'MODEL_OUTPUT' | 'SOURCE_DATA' | 'VALIDATION' | 'SYSTEM';

export interface AirportBatchPackageInput {
  packageId: string;
  packageName: string;
  runs: RecognitionV2RunManifest[];
  ledger?: PublicationLedger;
  pendingReviewCount?: number;
  activeReleaseStale?: boolean;
  activeReleaseStaleReason?: string;
}

export interface AirportBatchPackageStatus {
  packageId: string;
  packageName: string;
  state: AirportBatchPackageState;
  runId?: string;
  runStatus?: RecognitionV2RunManifest['status'];
  activeStage?: RecognitionV2Stage;
  activeReleaseId?: string;
  pendingReviewCount?: number;
  completedStageCount: number;
  issue?: {
    phase: string;
    category: AirportBatchIssueCategory;
    message: string;
    retryable: boolean;
  };
  updatedAt?: string;
}

export interface AirportBatchStatus {
  taskId: string;
  packageCount: number;
  notStartedCount: number;
  runningCount: number;
  pausedCount: number;
  needsOptimizationCount: number;
  readyToPublishCount: number;
  activeReleaseCount: number;
  packages: AirportBatchPackageStatus[];
  generatedAt: string;
}

export function buildAirportBatchStatus(taskId: string, inputs: AirportBatchPackageInput[], now = new Date().toISOString()): AirportBatchStatus {
  const packages = inputs.map(buildPackageStatus);
  return {
    taskId,
    packageCount: packages.length,
    notStartedCount: packages.filter((item) => item.state === 'NOT_STARTED').length,
    runningCount: packages.filter((item) => item.state === 'RUNNING').length,
    pausedCount: packages.filter((item) => item.state === 'PAUSED').length,
    needsOptimizationCount: packages.filter((item) => item.state === 'NEEDS_OPTIMIZATION').length,
    readyToPublishCount: packages.filter((item) => item.state === 'READY_TO_PUBLISH').length,
    activeReleaseCount: packages.filter((item) => Boolean(item.activeReleaseId)).length,
    packages,
    generatedAt: now,
  };
}

function buildPackageStatus(input: AirportBatchPackageInput): AirportBatchPackageStatus {
  const runs = [...input.runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const latest = runs.find((item) => item.status !== 'CANCELLED');
  const activeRelease = input.ledger?.releases.find((item) => item.releaseId === input.ledger?.activeReleaseId && item.status === 'ACTIVE');
  const base = {
    packageId: input.packageId,
    packageName: input.packageName,
    runId: latest?.runId,
    runStatus: latest?.status,
    activeStage: latest?.activeStage,
    activeReleaseId: activeRelease?.releaseId,
    pendingReviewCount: input.pendingReviewCount,
    completedStageCount: latest?.stages.filter((item) => item.status === 'COMPLETED' || item.status === 'SKIPPED').length ?? 0,
    updatedAt: latest?.updatedAt ?? input.ledger?.updatedAt,
  };
  if (activeRelease && input.activeReleaseStale) {
    return input.activeReleaseStaleReason
      ? {
          ...base,
          state: 'NEEDS_OPTIMIZATION',
          issue: { phase: 'PUBLISH_CANONICAL', category: 'VALIDATION', message: input.activeReleaseStaleReason, retryable: true },
        }
      : { ...base, state: 'READY_TO_PUBLISH' };
  }
  if (!latest) return { ...base, state: activeRelease ? 'PUBLISHED' : 'NOT_STARTED' };

  const failedStage = latest.stages.find((item) => item.status === 'FAILED');
  if (latest.status === 'FAILED' || failedStage) {
    const message = failedStage?.error?.message ?? 'Recognition run failed without a stage diagnostic.';
    return {
      ...base,
      state: 'NEEDS_OPTIMIZATION',
      issue: {
        phase: failedStage?.stage ?? latest.activeStage ?? 'SYSTEM',
        category: classifyIssue(message),
        message,
        retryable: failedStage?.error?.retryable ?? true,
      },
    };
  }
  if (latest.status === 'REVIEW_REQUIRED' && (input.pendingReviewCount ?? 1) > 0) {
    const count = input.pendingReviewCount ?? 1;
    return {
      ...base,
      state: 'NEEDS_OPTIMIZATION',
      issue: {
        phase: 'HUMAN_REVIEW',
        category: 'VALIDATION',
        message: `仍有 ${count} 个字段无法由现有规则安全确定，需要优化识别或确定性规则。`,
        retryable: true,
      },
    };
  }
  if (latest.status === 'APPROVED') return { ...base, state: 'READY_TO_PUBLISH' };
  if (latest.status === 'COMPLETED' && activeRelease?.runId === latest.runId) return { ...base, state: 'PUBLISHED' };
  if (latest.stages.some((item) => item.status === 'RUNNING')) return { ...base, state: 'RUNNING' };
  if (latest.status === 'COMPLETED' && activeRelease) return { ...base, state: 'PUBLISHED' };
  return { ...base, state: 'PAUSED' };
}

function classifyIssue(message: string): AirportBatchIssueCategory {
  if (/contract validation|model|vision|schema/i.test(message)) return 'MODEL_OUTPUT';
  if (/missing|缺少|source|evidence|coordinate|坐标/i.test(message)) return 'SOURCE_DATA';
  if (/validation|review|preflight|diff|conflict|阻断|校验/i.test(message)) return 'VALIDATION';
  return 'SYSTEM';
}
