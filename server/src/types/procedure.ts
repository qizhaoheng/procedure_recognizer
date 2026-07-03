import type { FeatureCollection, Geometry, GeoJsonProperties } from 'geojson';

export type TaskStatus = 'UPLOADED' | 'PARSING' | 'PARSED' | 'GROUPED' | 'AI_RUNNING' | 'AI_COMPLETED' | 'ERROR';

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

export type GroupStatus = 'GROUPED' | 'CANDIDATES_EXTRACTED' | 'AI_READY' | 'AI_RUNNING' | 'AI_COMPLETED' | 'ERROR';
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
  | 'AIRSPACE'
  | 'OBSTACLE'
  | 'OTHER';

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
  groupingReason?: string[];
  status: GroupStatus;
  textCandidates?: TextCandidate[];
  geometryCandidates?: GeometryCandidate[];
  waypointCandidates?: WaypointCandidate[];
  tableCandidates?: TableCandidate[];
  aiRequest?: AiRequestRecord;
  aiResponse?: AiResponseRecord;
  geojson?: FeatureCollection<Geometry | null, GeoJsonProperties>;
  reviewRequired?: boolean;
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
  inputPageNos: number[];
  createdAt: string;
}

export interface AiResponseRecord {
  rawText: string;
  parsedJson?: unknown;
  geojson?: FeatureCollection<Geometry | null, GeoJsonProperties>;
  errors?: string[];
  createdAt: string;
}

export interface CandidateExtractionResult {
  groupId: string;
  textCandidates: TextCandidate[];
  geometryCandidates: GeometryCandidate[];
  waypointCandidates: WaypointCandidate[];
  tableCandidates: TableCandidate[];
}
