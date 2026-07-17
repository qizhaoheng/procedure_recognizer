export type RecognitionV2Stage =
  | 'PAGE_LAYOUT'
  | 'PROCEDURE_IDENTITY'
  | 'PROCEDURE_TABLE'
  | 'WAYPOINT_NAVAID'
  | 'NOTES_CONSTRAINTS'
  | 'CHART_TOPOLOGY'
  | 'EVIDENCE_FUSION'
  | 'SEMANTIC_VALIDATION'
  | 'HUMAN_REVIEW'
  | 'PUBLISH_CANONICAL';

export type StageRunStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'SKIPPED' | 'CANCELLED' | 'FAILED' | 'STALE';
export type V2RunStatus = 'CREATED' | 'LAYOUT_RUNNING' | 'EXTRACTION_RUNNING' | 'FUSION_RUNNING' | 'VALIDATION_RUNNING' | 'REVIEW_REQUIRED' | 'APPROVED' | 'COMPLETED' | 'CANCELLED' | 'FAILED';

export interface StageRunRecord {
  stage: RecognitionV2Stage;
  status: StageRunStatus;
  attempt: number;
  inputHash?: string;
  outputRef?: string;
  startedAt?: string;
  completedAt?: string;
  skipReason?: string;
  ruleVersions?: Record<string, string>;
  error?: { code: string; message: string; retryable: boolean };
}

export interface RecognitionV2RunManifest {
  contractVersion: string;
  schemaId: string;
  runId: string;
  taskId: string;
  packageId: string;
  status: V2RunStatus;
  sourcePackageHash: string;
  stages: StageRunRecord[];
  activeStage?: RecognitionV2Stage;
  canonicalRef?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SourceEvidence {
  evidenceId: string;
  fileName: string;
  pageNo: number;
  aipPageNo?: string;
  regionId?: string;
  bbox?: [number, number, number, number];
  sourceType: string;
  rawText?: string;
  visualDescription?: string;
  confidence: number;
  status: string;
  modelExecution?: { model: string; runId: string };
}

export interface FieldCandidate {
  candidateId: string;
  entityType: string;
  entityKey: string;
  fieldName: string;
  value: unknown;
  normalizedValue?: unknown;
  status: string;
  sourceEvidenceIds: string[];
  confidence: number;
  reviewRequired: boolean;
}

export interface ExtractionStageResult {
  taskType: string;
  evidence: SourceEvidence[];
  candidates: FieldCandidate[];
  warnings: string[];
  completedAt: string;
}

export interface FusionStageResult {
  entities: Array<{
    entityType: string;
    entityKey: string;
    fields: Record<string, unknown>;
    fieldEvidence: Record<string, { selectedCandidateId?: string; sourceEvidenceIds: string[]; status: string; confidence: number }>;
  }>;
  conflicts: Array<{
    conflictId: string;
    entityKey: string;
    fieldName: string;
    candidateIds: string[];
    severity: 'INFO' | 'WARNING' | 'BLOCKING';
    resolution: string;
  }>;
  unresolvedItems: Array<{
    unresolvedId: string;
    entityKey: string;
    fieldName: string;
    reasonCode: string;
    candidateIds: string[];
    requiredEvidence?: string;
    blockingFor424: boolean;
  }>;
  selectedCandidateIds: string[];
  policyVersions: Record<string, string>;
  completedAt: string;
}

export interface ValidationStageResult {
  issues: Array<{
    issueId: string;
    ruleId: string;
    ruleVersion: string;
    severity: 'INFO' | 'WARNING' | 'BLOCKING';
    status: string;
    entityKeys: string[];
    fieldNames: string[];
    candidateIds: string[];
    message: string;
  }>;
  releaseDecision: 'BLOCKED' | 'REVIEW_REQUIRED' | 'READY';
  blockingIssueCount: number;
  reviewIssueCount: number;
  ruleVersions: Record<string, string>;
  completedAt: string;
}

export type HumanReviewItemStatus = 'PENDING' | 'CONFIRMED' | 'CORRECTED';

export interface HumanReviewItem {
  reviewItemId: string;
  reviewFingerprint: string;
  procedureNames: string[];
  entityType: string;
  entityKey: string;
  fieldName: string;
  currentValue?: unknown;
  suggestedValues: unknown[];
  candidateIds: string[];
  evidenceIds: string[];
  issueIds: string[];
  reasonCodes: string[];
  ruleIds: string[];
  duplicateCount: number;
  critical: boolean;
  status: HumanReviewItemStatus;
  correctedValue?: unknown;
  reviewer?: string;
  note?: string;
  decidedAt?: string;
}

export interface HumanReviewStageResult {
  runId: string;
  packageId: string;
  status: 'IN_PROGRESS' | 'COMPLETED';
  baselineFusionRef: string;
  baselineValidationRef: string;
  items: HumanReviewItem[];
  evidence: SourceEvidence[];
  auditTrail: Array<{
    eventId: string;
    reviewItemId: string;
    action: 'CONFIRMED' | 'CORRECTED';
    reviewer: string;
    previousValue?: unknown;
    value?: unknown;
    note?: string;
    at: string;
    reusedFromRunId?: string;
  }>;
  summary: {
    total: number;
    pending: number;
    confirmed: number;
    corrected: number;
    criticalPending: number;
    mergedSignalCount: number;
    reusedDecisionCount: number;
  };
  reviewedValidation?: ValidationStageResult;
  reviewedFusionRef?: string;
  reviewedValidationRef?: string;
  canonicalPreviewRef?: string;
  diffRef?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface CanonicalPreviewArtifact {
  procedureUnderstanding: Record<string, unknown>;
  releaseDecision: 'BLOCKED' | 'REVIEW_REQUIRED' | 'READY';
  warnings: string[];
  generatedAt: string;
}

export interface V1V2DiffReport {
  items: Array<{ path: string; status: 'SAME' | 'CHANGED' | 'ONLY_V1' | 'ONLY_V2'; v1Value?: unknown; v2Value?: unknown }>;
  summary: { same: number; changed: number; onlyV1: number; onlyV2: number };
  generatedAt: string;
}

export interface PublicationWorkspace {
  taskId: string;
  packageId: string;
  runId: string;
  status: 'STALE' | 'LOCKED' | 'PREFLIGHT_BLOCKED' | 'PREFLIGHT_PASSED' | 'DRY_RUN_READY' | 'DIFF_REVIEW_REQUIRED' | 'PUBLISHABLE' | 'PUBLISHED' | 'ROLLED_BACK';
  lock: { lockId: string; sourcePackageHash: string; canonicalHash: string; canonicalPreviewRef: string; reviewOutputRef: string; lockedAt: string };
  preflight?: { passed: boolean; checks: Array<{ code: string; status: 'PASS' | 'WARN' | 'BLOCK'; message: string }>; checkedAt: string };
  dryRun?: {
    text: string; textHash: string; lineCount: number; simpleLegCount: number;
    releaseScope?: 'PROCEDURE_PACKAGE'; airportComplete?: boolean;
    coverage?: Array<{ category: 'AIRPORT_PRIMARY' | 'RUNWAY' | 'VHF_NAVAID' | 'ILS_NAVAID' | 'TERMINAL_WAYPOINT' | 'PROCEDURE_LEG'; sourceCount: number; exportedCount: number; status: 'COMPLETE' | 'NOT_EXTRACTED' | 'NOT_EXPORTED' | 'PARTIAL'; message: string }>;
    generatedAt: string;
  };
  diff?: { accepted: boolean; blockingDifferenceCount: number; procedureResults: Array<{ procedureName: string; runway: string; score: number; totalLegs: number; matchedLegs: number; partialLegs: number; mismatchedLegs: number }>; checkedAt: string; acceptedAt?: string };
  publishedReleaseId?: string;
  updatedAt: string;
}

export interface PublicationLedger {
  version: 1;
  activeReleaseId?: string;
  releases: Array<{ releaseId: string; runId: string; artifactRef: string; canonicalHash: string; textHash: string; status: 'ACTIVE' | 'SUPERSEDED' | 'ROLLED_BACK'; publishedAt: string; rolledBackAt?: string }>;
  updatedAt: string;
}
