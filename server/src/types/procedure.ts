import type { FeatureCollection, Geometry, GeoJsonProperties } from 'geojson';

export type TaskStatus = 'UPLOADED' | 'PARSING' | 'PARSED' | 'GROUPED' | 'AI_RUNNING' | 'AI_COMPLETED' | 'ERROR';

export type ChartRole =
  | 'CHART'
  | 'TABULAR_DESCRIPTION'
  | 'WAYPOINT_COORDINATES'
  | 'MINIMA_TABLE'
  | 'CHART_INDEX'
  | 'BLANK'
  | 'OTHER'
  | 'UNKNOWN';

export type ProcedureCategory = 'ARRIVAL' | 'DEPARTURE' | 'APPROACH' | 'AERODROME' | 'AIRSPACE' | 'UNKNOWN';

export type NavigationType =
  | 'RNAV'
  | 'RNP'
  | 'ILS'
  | 'LOC'
  | 'VOR'
  | 'NDB'
  | 'DME_ARC'
  | 'RADAR'
  | 'CONVENTIONAL'
  | 'UNKNOWN';

export type GroupStatus = 'GROUPED' | 'CANDIDATES_EXTRACTED' | 'AI_READY' | 'AI_RUNNING' | 'AI_COMPLETED' | 'ERROR';

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
}

export interface ProcedureGroup {
  groupId: string;
  groupName: string;
  procedureCategory: 'ARRIVAL' | 'DEPARTURE' | 'APPROACH' | 'UNKNOWN';
  navigationType: string;
  runway?: string;
  chartPages: number[];
  tabularPages: number[];
  coordinatePages: number[];
  minimaPages: number[];
  otherPages: number[];
  procedureNames: string[];
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
