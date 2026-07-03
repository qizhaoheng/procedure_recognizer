import type { FeatureCollection, Geometry, GeoJsonProperties } from 'geojson';

export type TaskStatus = 'UPLOADED' | 'PARSING' | 'PARSED' | 'GROUPED' | 'AI_RUNNING' | 'AI_COMPLETED' | 'ERROR';
export type GroupStatus = 'GROUPED' | 'CANDIDATES_EXTRACTED' | 'AI_READY' | 'AI_RUNNING' | 'AI_COMPLETED' | 'ERROR';
export type ChartRole = 'CHART' | 'TABULAR_DESCRIPTION' | 'WAYPOINT_COORDINATES' | 'MINIMA_TABLE' | 'CHART_INDEX' | 'BLANK' | 'OTHER' | 'UNKNOWN';
export type ProcedureCategory = 'ARRIVAL' | 'DEPARTURE' | 'APPROACH' | 'AERODROME' | 'AIRSPACE' | 'UNKNOWN';
export type NavigationType = 'RNAV' | 'RNP' | 'ILS' | 'LOC' | 'VOR' | 'NDB' | 'DME_ARC' | 'RADAR' | 'CONVENTIONAL' | 'UNKNOWN';

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

export interface AiRequestPreview {
  model: string;
  prompt: string;
  schema: Record<string, unknown>;
  inputPages: Array<Pick<PdfPageAsset, 'pageNo' | 'aipPageNo' | 'chartRole' | 'imageUrl' | 'thumbnailUrl'>>;
  candidateSummary: Record<string, unknown>;
}
