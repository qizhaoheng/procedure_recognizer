export type SimpleLegSource = 'AI' | 'JEPPESEN_424';
export type CompareStatus = 'MATCH' | 'PARTIAL' | 'MISMATCH' | 'MISSING_AI' | 'MISSING_JEPPESEN';
export type CompareSeverity = 'INFO' | 'WARNING' | 'ERROR';

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
  source: SimpleLegSource;
  rawRecord?: string;
}

export interface ProcedureCompareResult {
  procedureName: string;
  runway: string;
  totalLegs: number;
  matchedLegs: number;
  score: number;
  legResults: LegCompareResult[];
}

export interface LegCompareResult {
  procedureName: string;
  sequence: string;
  ai?: SimpleProcedureLeg;
  jeppesen?: SimpleProcedureLeg;
  fieldResults: FieldCompareResult[];
  score: number;
  status: CompareStatus;
}

export interface FieldCompareResult {
  field: string;
  aiValue: unknown;
  jeppesenValue: unknown;
  matched: boolean;
  severity: CompareSeverity;
}

export interface Jeppesen424CompareSummary {
  totalProcedures: number;
  matchedProcedures: number;
  totalLegs: number;
  matchedLegs: number;
  missingAiLegs: number;
  missingJeppesenLegs: number;
  fieldMismatchCount: number;
  issueCount: number;
  overallScore: number;
}

export interface Jeppesen424CompareResponse {
  ok: true;
  summary: Jeppesen424CompareSummary;
  procedureResults: ProcedureCompareResult[];
  parsedJeppesenLegs: SimpleProcedureLeg[];
  aiLegs: SimpleProcedureLeg[];
}
