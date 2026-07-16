/**
 * Recognition V2 contracts are deliberately independent from V1's prompt output.
 * Stage implementations may only exchange these versioned, evidence-carrying values.
 */

export const RECOGNITION_V2_CONTRACT_VERSION = '2.0.0-alpha.1' as const;
export const RECOGNITION_V2_SCHEMA_IDS = {
  runManifest: 'recognition-v2-run-manifest.schema.json',
  pageLayoutResult: 'recognition-v2-page-layout-result.schema.json',
  pageLayoutStageResult: 'recognition-v2-page-layout-stage-result.schema.json',
  extractionStageResult: 'recognition-v2-extraction-stage-result.schema.json',
  fusionStageResult: 'recognition-v2-fusion-stage-result.schema.json',
  validationStageResult: 'recognition-v2-validation-stage-result.schema.json',
} as const;

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

export type V2RunStatus =
  | 'CREATED'
  | 'LAYOUT_RUNNING'
  | 'EXTRACTION_RUNNING'
  | 'FUSION_RUNNING'
  | 'VALIDATION_RUNNING'
  | 'REVIEW_REQUIRED'
  | 'APPROVED'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'FAILED';

export type StageRunStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'SKIPPED' | 'CANCELLED' | 'FAILED' | 'STALE';

export interface ContractVersionRef<TSchemaId extends string = string> {
  contractVersion: typeof RECOGNITION_V2_CONTRACT_VERSION;
  schemaId: TSchemaId;
}

export interface ModelExecutionRef {
  provider?: string;
  model: string;
  promptId: string;
  promptVersion: string;
  schemaId: string;
  schemaVersion: string;
  inputHash: string;
  runId: string;
}

export interface StageRunRecord {
  stage: RecognitionV2Stage;
  status: StageRunStatus;
  attempt: number;
  inputHash?: string;
  outputRef?: string;
  startedAt?: string;
  completedAt?: string;
  skipReason?: string;
  modelExecution?: ModelExecutionRef;
  ruleVersions?: Record<string, string>;
  error?: {
    code: string;
    message: string;
    retryable: boolean;
  };
}

export interface RecognitionV2RunManifest extends ContractVersionRef<typeof RECOGNITION_V2_SCHEMA_IDS.runManifest> {
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

export type PageRole =
  | 'PROCEDURE_DIAGRAM'
  | 'PROCEDURE_LEG_TABLE'
  | 'WAYPOINT_COORDINATE_TABLE'
  | 'PROCEDURE_TITLE'
  | 'PROCEDURE_NOTES'
  | 'PROFILE_VIEW'
  | 'MINIMA_TABLE'
  | 'MSA'
  | 'SUPPORTING_INFORMATION'
  | 'UNKNOWN';

export type NormalizedBbox = [number, number, number, number];

export interface PageRegion {
  regionId: string;
  pageNo: number;
  type: PageRole;
  bbox: NormalizedBbox;
  rotationDeg: 0 | 90 | 180 | 270;
  readingOrder: number;
  confidence: number;
  reviewRequired: boolean;
}

export interface PageLayoutResult extends ContractVersionRef<typeof RECOGNITION_V2_SCHEMA_IDS.pageLayoutResult> {
  pageNo: number;
  pageRoles: PageRole[];
  regions: PageRegion[];
  missingExpectedRoles: PageRole[];
  analysisMethod: 'RULES_ONLY' | 'VISION_MODEL' | 'HYBRID';
  warnings: string[];
  layoutProfileId?: string;
  modelExecution?: ModelExecutionRef;
}

export interface PageLayoutStageResult extends ContractVersionRef<typeof RECOGNITION_V2_SCHEMA_IDS.pageLayoutStageResult> {
  pages: PageLayoutResult[];
  warnings: string[];
  completedAt: string;
}

export type ExtractionTaskType =
  | 'PROCEDURE_IDENTITY'
  | 'PROCEDURE_TABLE'
  | 'WAYPOINT_NAVAID'
  | 'NOTES_CONSTRAINTS'
  | 'CHART_TOPOLOGY';

export type EvidenceStatus = 'OBSERVED' | 'DERIVED' | 'CONFLICTED' | 'UNRESOLVED';

export type EvidenceSourceType = PageRole | 'TEXT_LAYER' | 'DOCUMENT_METADATA';

/** Immutable description of what was visible in the source document. */
export interface SourceEvidence {
  evidenceId: string;
  fileName: string;
  pageNo: number;
  aipPageNo?: string;
  regionId?: string;
  bbox?: NormalizedBbox;
  sourceType: EvidenceSourceType;
  rawText?: string;
  visualDescription?: string;
  extractionTask: ExtractionTaskType;
  confidence: number;
  status: EvidenceStatus;
  modelExecution?: ModelExecutionRef;
}

export type CandidateEntityType =
  | 'AIRPORT'
  | 'RUNWAY'
  | 'FIX'
  | 'NAVAID'
  | 'PROCEDURE'
  | 'LEG'
  | 'CONSTRAINT'
  | 'TOPOLOGY';

export interface CandidateDerivation {
  ruleId: string;
  ruleVersion: string;
  inputCandidateIds: string[];
}

export interface FieldCandidate<T = unknown> {
  candidateId: string;
  entityType: CandidateEntityType;
  entityKey: string;
  fieldName: string;
  value: T | null;
  normalizedValue?: T | null;
  unit?: string;
  status: EvidenceStatus;
  sourceEvidenceIds: string[];
  derivation?: CandidateDerivation;
  confidence: number;
  reviewRequired: boolean;
}

export interface ExtractionStageResult extends ContractVersionRef<typeof RECOGNITION_V2_SCHEMA_IDS.extractionStageResult> {
  taskType: ExtractionTaskType;
  pageNos: number[];
  regionIds: string[];
  evidence: SourceEvidence[];
  candidates: FieldCandidate[];
  warnings: string[];
  completedAt: string;
}

export type ConflictSeverity = 'INFO' | 'WARNING' | 'BLOCKING';
export type ConflictResolution = 'AUTO_RESOLVED' | 'HUMAN_RESOLVED' | 'OPEN';

export interface EvidenceConflict {
  conflictId: string;
  entityKey: string;
  fieldName: string;
  candidateIds: string[];
  severity: ConflictSeverity;
  selectedCandidateId?: string;
  selectionReason?: string;
  resolution: ConflictResolution;
}

export interface UnresolvedItem {
  unresolvedId: string;
  entityKey: string;
  fieldName: string;
  reasonCode: string;
  candidateIds: string[];
  requiredEvidence?: string;
  blockingFor424: boolean;
}

export interface FieldProvenance {
  selectedCandidateId?: string;
  sourceEvidenceIds: string[];
  status: EvidenceStatus;
  confidence: number;
}

export interface CanonicalEntity {
  entityType: CandidateEntityType;
  entityKey: string;
  fields: Record<string, unknown>;
  fieldEvidence: Record<string, FieldProvenance>;
}

export interface FusionStageResult extends ContractVersionRef<typeof RECOGNITION_V2_SCHEMA_IDS.fusionStageResult> {
  entities: CanonicalEntity[];
  conflicts: EvidenceConflict[];
  unresolvedItems: UnresolvedItem[];
  selectedCandidateIds: string[];
  completedAt: string;
}

export type ValidationSeverity = 'INFO' | 'WARNING' | 'BLOCKING';
export type ValidationIssueStatus = 'OPEN' | 'AUTO_RESOLVED' | 'HUMAN_RESOLVED' | 'WAIVED';

export interface ValidationIssue {
  issueId: string;
  ruleId: string;
  ruleVersion: string;
  severity: ValidationSeverity;
  status: ValidationIssueStatus;
  entityKeys: string[];
  fieldNames: string[];
  candidateIds: string[];
  message: string;
}

export type ReleaseDecision = 'BLOCKED' | 'REVIEW_REQUIRED' | 'READY';

export interface ValidationStageResult extends ContractVersionRef<typeof RECOGNITION_V2_SCHEMA_IDS.validationStageResult> {
  issues: ValidationIssue[];
  releaseDecision: ReleaseDecision;
  blockingIssueCount: number;
  reviewIssueCount: number;
  ruleVersions: Record<string, string>;
  completedAt: string;
}
