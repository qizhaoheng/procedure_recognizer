import type { FeatureCollection, Geometry, GeoJsonProperties } from 'geojson';

export type TaskStatus = 'UPLOADED' | 'PARSING' | 'PARSED' | 'GROUPED' | 'AI_RUNNING' | 'AI_COMPLETED' | 'AI_CANCELLED' | 'ERROR';

export type ChartRole =
  | 'CHART'
  | 'TABULAR_DESCRIPTION'
  | 'WAYPOINT_COORDINATES'
  | 'MINIMA_TABLE'
  | 'CHART_INDEX'
  | 'BLANK'
  | 'SUPPORT'
  | 'OTHER'
  | 'UNKNOWN';

export type ProcedureCategory = 'ARRIVAL' | 'DEPARTURE' | 'APPROACH' | 'AERODROME' | 'AIRSPACE' | 'UNKNOWN';

export type NavigationType =
  | 'RNAV'
  | 'RNP'
  | 'RNP_AR'
  | 'ILS'
  | 'ILS_LOC'
  | 'LOC'
  | 'VOR'
  | 'NDB'
  | 'DME_ARC'
  | 'RADAR'
  | 'CONVENTIONAL'
  | 'UNKNOWN';

export type GroupStatus = 'GROUPED' | 'CANDIDATES_EXTRACTED' | 'AI_READY' | 'AI_RUNNING' | 'AI_COMPLETED' | 'AI_CANCELLED' | 'ERROR';
export type PackageType = 'STAR' | 'SID' | 'APPROACH' | 'AERODROME' | 'AIRSPACE' | 'OTHER';
export type PackageSource = 'AD_2_24_CHART_INDEX' | 'PAGE_HEADER_RULE' | 'TITLE_MATCH_RULE' | 'MANUAL';
export type SupportType =
  | 'AIRPORT_METADATA'
  | 'RUNWAY_DATA'
  | 'RUNWAY_OPERATIONAL_DATA'
  | 'AIRSPACE_COMMUNICATION'
  | 'NAVAID'
  | 'FLIGHT_PROCEDURES'
  | 'CHART_INDEX'
  | 'OPTIONAL_CONTEXT_CHARTS'
  | 'AIRSPACE'
  | 'OBSTACLE'
  | 'OTHER';
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

export interface TaskSourceFile {
  fileName: string;
  startPageNo: number;
  pageCount: number;
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
  // 日/韩式 AIP 一个机场拆成多份 PDF，上传时合并为单文件；此处保留原始文件与页码区间的映射
  sourceFiles?: TaskSourceFile[];
}

export interface PdfPageAsset {
  pageNo: number;
  aipPageNo?: string;
  imageUrl?: string;
  thumbnailUrl?: string;
  sourceWidthPt?: number;
  sourceHeightPt?: number;
  textLayerText?: string;
  ocrText?: string;
  textLayerQuality?: 'USABLE' | 'DECODED' | 'SUSPECT' | 'EMPTY';
  textLayerWarnings?: string[];
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
  // 多文件合并任务里该页来自哪个原始文件（日式 AIP 文件名承载 AD 2.24 小节结构）
  sourceFileName?: string;
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
  jeppesen424Source?: Jeppesen424PackageSource;
  geojsonRenderMode?: GeoJsonRenderMode;
  geojsonRenderSummary?: GeoJsonRenderSummary;
  geojson?: FeatureCollection<Geometry | null, GeoJsonProperties>;
  geojsonStatus?: 'NOT_GENERATED' | 'GENERATING' | 'GENERATED' | 'ERROR';
  geojsonGeneratedAt?: string;
  geojsonError?: string;
  reviewRequired?: boolean;
  /** 人工标记的识别问题类型，用于后续 Prompt 打磨 */
  recognitionIssueTags?: string[];
}

export type GeoJsonRenderMode = 'AUTO' | 'JEPPESEN_424' | 'AI';
export type GeoJsonRenderSource = 'JEPPESEN_424' | 'HYBRID' | 'AI';

export interface Jeppesen424PackageSource {
  text: string;
  parsedLegs: import('../services/jeppesen424/types').SimpleProcedureLeg[];
  importedAt: string;
  procedureCount: number;
  legCount: number;
}

export interface GeoJsonRenderSummary {
  requestedMode: GeoJsonRenderMode;
  source: GeoJsonRenderSource;
  canonicalProcedureCount: number;
  canonicalLegCount: number;
  aiProcedureCount: number;
  warnings: string[];
}

export interface AipAdStructure {
  airportIcao?: string;
  airportName?: string;
  sections: AipSection[];
  chartIndexItems: ChartIndexItem[];
  globalSupportPages: SupportPageRef[];
  pages: PdfPageAsset[];
}

export interface AipSection {
  sectionNo: string;
  title: string;
  startPageNo: number;
  endPageNo?: number;
  role:
    | 'AERODROME_DATA'
    | 'RUNWAY_DATA'
    | 'COMMUNICATION'
    | 'NAVAID'
    | 'FLIGHT_PROCEDURES'
    | 'CHART_INDEX'
    | 'CHART_PAGE'
    | 'OTHER';
}

export interface ChartIndexItem {
  chartName: string;
  chartNo: string;
  procedureCategory: ProcedureCategory;
  packageType: PackageType;
  navigationType: NavigationType;
  runway?: string;
  procedureNames: string[];
  isTabular: boolean;
  tabularNo?: number;
  normalizedGroupKey: string;
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
  typeCandidate:
    | 'chart_title'
    | 'procedure_name'
    | 'runway'
    | 'course'
    | 'distance'
    | 'altitude'
    | 'speed'
    | 'frequency'
    | 'waypoint'
    | 'holding'
    | 'msa'
    | 'navigation_spec'
    | 'equipment_requirement'
    | 'note'
    | 'unknown';
  bbox?: [number, number, number, number];
  confidence: number;
  linkedFeatureIds?: string[];
}

export interface GeometryCandidate {
  id: string;
  pageNo: number;
  geometryType: 'point' | 'line' | 'polyline' | 'arc' | 'circle' | 'holding' | 'runway' | 'arrow' | 'polygon' | 'unknown';
  imageCoords: number[][];
  geoCoords?: number[][];
  relatedTextIds?: string[];
  confidence: number;
  reviewRequired?: boolean;
}

export interface WaypointCandidate {
  ident: string;
  lat?: number;
  lon?: number;
  latText?: string;
  lonText?: string;
  sourcePage: number;
  sourceText?: string;
  bbox?: [number, number, number, number];
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

export interface PromptRunRecord {
  runId: string;
  taskId: string;
  packageId: string;
  model: string;
  promptTemplateId: string;
  promptVersion: string;
  outputSchemaName: string;
  outputSchemaVersion: string;
  inputPackageHash: string;
  renderedPrompt: {
    systemPrompt: string;
    userPrompt: string;
  };
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
  imagePages?: VisionRunImagePage[];
  geojson?: FeatureCollection<Geometry | null, GeoJsonProperties>;
  errors?: string[];
  createdAt: string;
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
  recommendedNavaid?: string | null;
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
  /** 识别阶段规划的图面标签：文字、类型、锚定节点/航段、放置方位 */
  labelPlan?: Array<Record<string, unknown>>;
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
  /** Named enroute transition for a runway-independent route branch. */
  transitionName?: string | null;
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

export interface CandidateExtractionResult {
  groupId: string;
  textCandidates: TextCandidate[];
  geometryCandidates: GeometryCandidate[];
  waypointCandidates: WaypointCandidate[];
  tableCandidates: TableCandidate[];
}
