import type { FeatureCollection, Geometry, GeoJsonProperties } from 'geojson';

export type TaskStatus = 'UPLOADED' | 'PARSING' | 'PARSED' | 'GROUPED' | 'AI_RUNNING' | 'AI_COMPLETED' | 'ERROR';
export type GroupStatus = 'GROUPED' | 'CANDIDATES_EXTRACTED' | 'AI_READY' | 'AI_RUNNING' | 'AI_COMPLETED' | 'ERROR';
export type ChartRole = 'CHART' | 'TABULAR_DESCRIPTION' | 'WAYPOINT_COORDINATES' | 'MINIMA_TABLE' | 'CHART_INDEX' | 'BLANK' | 'SUPPORT' | 'OTHER' | 'UNKNOWN';
export type ProcedureCategory = 'ARRIVAL' | 'DEPARTURE' | 'APPROACH' | 'AERODROME' | 'AIRSPACE' | 'UNKNOWN';
export type NavigationType = 'RNAV' | 'RNP' | 'RNP_AR' | 'ILS' | 'ILS_LOC' | 'LOC' | 'VOR' | 'NDB' | 'DME_ARC' | 'RADAR' | 'CONVENTIONAL' | 'UNKNOWN';
export type PackageType = 'STAR' | 'SID' | 'APPROACH' | 'AERODROME' | 'AIRSPACE' | 'OTHER';
export type PackageSource = 'AD_2_24_CHART_INDEX' | 'PAGE_HEADER_RULE' | 'TITLE_MATCH_RULE' | 'MANUAL';
export type SupportType = 'AIRPORT_METADATA' | 'RUNWAY_DATA' | 'RUNWAY_OPERATIONAL_DATA' | 'AIRSPACE_COMMUNICATION' | 'NAVAID' | 'FLIGHT_PROCEDURES' | 'CHART_INDEX' | 'OPTIONAL_CONTEXT_CHARTS' | 'AIRSPACE' | 'OBSTACLE' | 'OTHER';
export type SendPolicy = 'REQUIRED' | 'OPTIONAL' | 'EXCLUDED';
export type SendMode = 'SUMMARY_ONLY' | 'IMAGE_ONLY' | 'SUMMARY_AND_IMAGE' | 'NOT_SENT';
export type AiInputPageRole = 'CHART' | 'TABULAR' | 'COORDINATES' | 'MINIMA';
export type AiImageRegion = 'full_page' | 'header' | 'main_chart' | 'table' | 'notes' | 'msa' | 'profile' | 'minima';

export interface AiImageQuality {
  expectedWidthPx: number;
  expectedHeightPx: number;
  renderScale: number;
  format: 'png' | 'jpeg';
  isHighRes: boolean;
  isThumbnail: boolean;
  warning?: string;
}

export interface SupportingInfoRefs {
  airportMetadata?: number[];
  runwayData?: number[];
  runwayOperationalData?: number[];
  communication?: number[];
  navaid?: number[];
  flightProcedures?: number[];
  chartIndex?: number[];
}

export interface SupportingInfoSummary {
  airportMetadata?: Record<string, unknown>;
  runwayData?: Array<Record<string, unknown>>;
  runwayOperationalData?: Array<Record<string, unknown>>;
  communication?: Array<Record<string, unknown>>;
  navaids?: Array<Record<string, unknown>>;
  flightProcedures?: Array<Record<string, unknown>>;
  chartIndexPages?: number[];
  sourcePages: SupportingInfoRefs;
}

export interface ProcedureTask {
  taskId: string;
  fileName: string;
  filePath: string;
  status: TaskStatus;
  pages: PdfPageAsset[];
  groups: ProcedureGroup[];
  createdAt: string;
  updatedAt: string;
  error?: string;
}

export interface PdfPageAsset {
  pageNo: number;
  aipPageNo?: string;
  imageUrl?: string;
  thumbnailUrl?: string;
  textLayerText?: string;
  ocrText?: string;
  chartRole: ChartRole;
  procedureCategory: ProcedureCategory;
  navigationType: NavigationType;
  runway?: string;
  chartTitle?: string;
  procedureNames?: string[];
  confidence?: number;
  reviewRequired?: boolean;
  packageType?: PackageType;
  isTabular?: boolean;
  tabularNo?: number;
  indexMatchedPackageId?: string;
  headerMatchedPackageId?: string;
  matchedPackageId?: string;
  groupingReason?: string[];
}

export interface ProcedureGroup {
  groupId: string;
  groupName: string;
  packageId?: string;
  packageName?: string;
  packageType?: PackageType;
  procedureCategory: 'ARRIVAL' | 'DEPARTURE' | 'APPROACH' | 'UNKNOWN';
  navigationType: string;
  runway?: string;
  chartTitle?: string;
  normalizedTitle?: string;
  chartNo?: string;
  chartPageNo?: number;
  relatedChartNos?: string[];
  relatedPageNos?: number[];
  chartPages: number[];
  tabularPages: number[];
  coordinatePages: number[];
  minimaPages: number[];
  textSupplementPages?: number[];
  supportingPages?: number[];
  otherPages: number[];
  procedureNames: string[];
  source?: PackageSource;
  confidence?: number;
  supportingInfoRefs?: SupportingInfoRefs;
  supportingInfoDetails?: SupportPageRef[];
  supportingInfoSummary?: SupportingInfoSummary;
  aiInputOverrides?: Record<string, AiInputOverride>;
  manualOverride?: boolean;
  groupingReason?: string[];
  status: GroupStatus;
  textCandidates?: TextCandidate[];
  geometryCandidates?: GeometryCandidate[];
  waypointCandidates?: WaypointCandidate[];
  tableCandidates?: TableCandidate[];
  aiRequest?: AiRequestRecord;
  aiResponse?: AiResponseRecord;
  procedureUnderstanding?: ProcedureUnderstandingResult;
  visionRunRecord?: VisionRunRecord;
  recognitionEvaluation?: EvaluationResult;
  geojson?: FeatureCollection<Geometry | null, GeoJsonProperties>;
  geojsonStatus?: 'NOT_GENERATED' | 'GENERATING' | 'GENERATED' | 'GENERATED_WITHOUT_GEOMETRY' | 'ERROR';
  geojsonGeneratedAt?: string;
  geojsonError?: string;
  reviewRequired?: boolean;
  /** 人工标记的识别问题类型，用于后续 Prompt 打磨 */
  recognitionIssueTags?: string[];
}

export interface PackageWorkflowState {
  groupingReady: boolean;
  aiRequestReady: boolean;
  recognitionStatus: 'NOT_STARTED' | 'RUNNING' | 'COMPLETED' | 'ERROR';
  geojsonStatus: 'NOT_GENERATED' | 'GENERATING' | 'GENERATED' | 'GENERATED_WITHOUT_GEOMETRY' | 'ERROR';
  recognitionSummary?: {
    procedureCount: number;
    chartTextCount: number;
    tableLegCount: number;
    geometrySemanticCount: number;
    warningCount: number;
  };
  geojsonSummary?: {
    featureCount: number;
    renderableCount: number;
    pointCount: number;
    lineStringCount: number;
    polygonCount: number;
    nullGeometryCount: number;
  };
}

export interface SupportPageRef {
  pageNo: number;
  aipPageNo?: string;
  supportType: SupportType;
  label?: string;
  extracted?: Record<string, unknown>;
  summary?: string;
}

export interface AiInputOverride {
  sendPolicy?: SendPolicy;
  sendMode?: SendMode;
}

export interface SupportingInfoRef {
  id: string;
  supportType: SupportType;
  pageNos: number[];
  aipPageNos: string[];
  title: string;
  aipSection?: string;
  sendPolicy: SendPolicy;
  sendMode: SendMode;
  reason: string;
  summary: Record<string, unknown>;
  confidence: number;
  reviewRequired: boolean;
  manualOverride?: boolean;
}

export interface AiInputPage {
  pageNo: number;
  aipPageNo?: string;
  role: AiInputPageRole;
  region?: AiImageRegion;
  imageUrl?: string;
  thumbnailUrl?: string;
  sendMode: Extract<SendMode, 'IMAGE_ONLY' | 'SUMMARY_AND_IMAGE'>;
  reason: string;
  confidence: number;
  reviewRequired: boolean;
  imageQuality?: AiImageQuality;
}

export interface AiInputPackage {
  packageId: string;
  packageName: string;
  model: string;
  promptTemplate: string;
  promptTemplateName?: string;
  promptVersion?: string;
  outputSchemaName: string;
  outputSchemaVersion?: string;
  corePages: AiInputPage[];
  supportingInfo: SupportingInfoRef[];
  supportSummary: Record<string, unknown>;
  includedImages: AiInputPage[];
  includedSummaries: SupportingInfoRef[];
  excludedSupport: SupportingInfoRef[];
  ocrTextLayerIncluded: boolean;
  promptPreview?: string;
}

export interface TextCandidate {
  id: string;
  pageNo: number;
  text: string;
  typeCandidate: string;
  confidence: number;
}

export interface GeometryCandidate {
  id: string;
  pageNo: number;
  geometryType: string;
  imageCoords: number[][];
  confidence: number;
  reviewRequired?: boolean;
}

export interface WaypointCandidate {
  ident: string;
  latText?: string;
  lonText?: string;
  sourcePage: number;
  sourceText?: string;
  confidence: number;
}

export interface TableCandidate {
  id: string;
  pageNo: number;
  text: string;
  columns: string[];
  confidence: number;
}

export interface AiRequestRecord {
  model: string;
  prompt: string;
  schemaName: string;
  schemaVersion?: string;
  promptRunId?: string;
  promptTemplateId?: string;
  promptVersion?: string;
  inputPageNos: number[];
  createdAt: string;
}

export interface AiResponseRecord {
  rawText: string;
  parsedJson?: unknown;
  provider?: string;
  baseUrl?: string;
  endpointType?: string;
  imageMode?: 'base64' | 'url';
  structuredOutputModeUsed?: 'json_schema' | 'json_object' | 'text_json_extract';
  rawProviderResponse?: unknown;
  latencyMs?: number;
  geojson?: FeatureCollection<Geometry | null, GeoJsonProperties>;
  errors?: string[];
  createdAt: string;
}

export interface VisionRunRecord {
  runId: string;
  provider?: string;
  model: string;
  baseUrl?: string;
  endpointType?: string;
  imageMode?: 'base64' | 'url';
  structuredOutputModeUsed?: 'json_schema' | 'json_object' | 'text_json_extract';
  schemaValidation?: {
    valid: boolean;
    errors: string[];
  };
  promptTemplateId: string;
  promptVersion: string;
  schemaName: string;
  schemaVersion: string;
  inputPackageHash: string;
  imagePages: VisionRunImagePage[];
  supportSummaryPages: number[];
  startedAt: string;
  completedAt: string;
  rawResponse: string;
  parsedJson?: unknown;
  validationResult: {
    schemaValid: boolean;
    errors: string[];
  };
  errorType?: string;
  errorMessage?: string;
  rawError?: string;
}

export interface VisionRunImagePage {
  pageNo: number;
  aipPageNo?: string;
  role: AiInputPageRole;
  region?: AiImageRegion;
  imageMode: 'base64' | 'url';
  widthPx?: number;
  heightPx?: number;
  fileSizeBytes?: number;
  renderScale?: number;
  isHighRes?: boolean;
}

export interface ProcedureClassificationResult {
  packageType?: string | null;
  procedureCategory?: string | null;
  navigationType?: string | null;
  runway?: string | null;
  chartPurpose?: string | null;
  procedureNames?: string[];
  confidence?: number;
}

export interface ChartTextItem {
  text: string;
  normalizedText?: string | null;
  role?: string;
  region?: string;
  sourcePageNo?: number | null;
  usedInProcedure?: boolean;
  confidence?: number;
}

export interface GeometrySemanticItem {
  type: string;
  labelText?: string | null;
  centerNavaid?: string | null;
  radiusNm?: number | null;
  radialDeg?: number | null;
  inboundTrackDeg?: number | null;
  direction?: string | null;
  relatedProcedures?: string[];
  sourcePageNo?: number | null;
  confidence?: number;
  reviewRequired?: boolean;
}

export interface SupportObjectItem {
  ident: string;
  type?: string;
  sourcePageNo?: number | null;
  usedInProcedure?: boolean;
  supportOnly?: boolean;
  reason?: string | null;
  confidence?: number;
}

export interface TableLegItem {
  procedureName?: string | null;
  sequence?: number | null;
  pathTerminator?: string | null;
  fromFix?: string | null;
  toFix?: string | null;
  courseDeg?: number | null;
  distanceNm?: number | null;
  altitudeConstraint?: string | null;
  turnDirection?: string | null;
  remarks?: string | null;
  sourcePageNo?: number | null;
  confidence?: number;
}

export interface ProcedureUnderstandingResult {
  airportIcao?: string | null;
  airportName?: string | null;
  packageType?: string | null;
  procedureCategory?: string | null;
  navigationType?: string | null;
  runway?: string | null;
  procedureClassification?: ProcedureClassificationResult | null;
  chartTexts?: ChartTextItem[];
  geometrySemantics?: GeometrySemanticItem[];
  supportObjects?: SupportObjectItem[];
  tableLegs?: TableLegItem[];
  procedures?: ProcedureUnderstandingProcedure[];
  fixes?: Array<Record<string, unknown>>;
  navaids?: Array<Record<string, unknown>>;
  runways?: Array<Record<string, unknown>>;
  communications?: Array<Record<string, unknown>>;
  holdings?: Array<Record<string, unknown>>;
  msa?: Array<Record<string, unknown>>;
  sourceEvidence?: Array<Record<string, unknown>>;
  warnings?: Array<Record<string, unknown>>;
  confidence?: number;
  reviewRequired?: boolean;
}

export interface ProcedureUnderstandingProcedure {
  procedureName?: string | null;
  runway?: string | null;
  navigationSpec?: string | null;
  legs?: Array<Record<string, unknown>>;
  sourceEvidenceIds?: string[];
  confidence?: number;
  reviewRequired?: boolean;
}

export interface EvaluationResult {
  totalScore: number;
  procedureNameAccuracy: number;
  legCountAccuracy: number;
  pathTerminatorAccuracy: number;
  fixAccuracy: number;
  courseAccuracy: number;
  distanceAccuracy: number;
  altitudeAccuracy: number;
  coordinateAccuracy: number;
  sourceEvidenceCoverage: number;
  schemaValid: boolean;
  errors: EvaluationError[];
  warnings: EvaluationWarning[];
}

export interface EvaluationError {
  code: string;
  message: string;
  procedureName?: string;
  sequence?: number;
  fieldName?: string;
  expected?: unknown;
  actual?: unknown;
}

export interface EvaluationWarning {
  code: string;
  message: string;
  procedureName?: string;
  sequence?: number;
  fieldName?: string;
}

export type Jeppesen424CompareStatus = 'MATCH' | 'PARTIAL' | 'MISMATCH' | 'MISSING_AI' | 'MISSING_JEPPESEN';
export type Jeppesen424CompareSeverity = 'INFO' | 'WARNING' | 'ERROR';

export interface SimpleProcedureLeg {
  procedureName: string;
  runway: string;
  routeKey: string;
  sequence: string;
  fix: string;
  pathTerminator?: string;
  turnDirection?: 'L' | 'R' | '';
  distanceNm?: number;
  altitudeRaw?: string;
  altitudeValue?: number;
  altitudeSign?: '+' | '-' | '';
  altitudeUpperFt?: number;
  courseDegMag?: number;
  holdingAtFix?: boolean;
  endOfProcedure?: boolean;
  fixSection?: string;
  recommendedNavaid?: string;
  source: 'AI' | 'JEPPESEN_424';
  rawRecord?: string;
}

export interface FieldCompareResult {
  field: string;
  aiValue: unknown;
  jeppesenValue: unknown;
  matched: boolean;
  severity: Jeppesen424CompareSeverity;
}

export interface LegCompareResult {
  procedureName: string;
  sequence: string;
  ai?: SimpleProcedureLeg;
  jeppesen?: SimpleProcedureLeg;
  fieldResults: FieldCompareResult[];
  score: number;
  status: Jeppesen424CompareStatus;
}

export interface ProcedureCompareResult {
  procedureName: string;
  runway: string;
  totalLegs: number;
  matchedLegs: number;
  partialLegs: number;
  mismatchedLegs: number;
  score: number;
  legResults: LegCompareResult[];
}

export interface Jeppesen424CompareResponse {
  ok: true;
  summary: {
    totalProcedures: number;
    matchedProcedures: number;
    totalLegs: number;
    matchedLegs: number;
    partialLegs: number;
    mismatchedLegs: number;
    missingAiLegs: number;
    missingJeppesenLegs: number;
    fieldMismatchCount: number;
    issueCount: number;
    overallScore: number;
  };
  procedureResults: ProcedureCompareResult[];
  parsedJeppesenLegs: SimpleProcedureLeg[];
  aiLegs: SimpleProcedureLeg[];
}

export interface AiRequestPreview {
  model: string;
  prompt: string;
  schema: Record<string, unknown>;
  inputPages: Array<Pick<PdfPageAsset, 'pageNo' | 'aipPageNo' | 'chartRole' | 'imageUrl' | 'thumbnailUrl'>>;
  supportPages: Array<Pick<PdfPageAsset, 'pageNo' | 'aipPageNo' | 'chartRole' | 'imageUrl' | 'thumbnailUrl'>>;
  candidateSummary: Record<string, unknown>;
  aiInputPackage?: AiInputPackage;
}

export interface BuiltPromptPreview {
  promptTemplateId: string;
  promptTemplateName?: string;
  promptVersion: string;
  outputSchemaName: string;
  outputSchemaVersion: string;
  systemPrompt: string;
  userPrompt: string;
  responseSchema: unknown;
  inputImages: AiInputPage[];
  supportSummaries: SupportingInfoRef[];
  excludedSupport: SupportingInfoRef[];
  renderedAt?: string;
}
