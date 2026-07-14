export type SimpleLegSource = 'AI' | 'JEPPESEN_424';
export type CompareStatus = 'MATCH' | 'PARTIAL' | 'MISMATCH' | 'MISSING_AI' | 'MISSING_JEPPESEN';
export type CompareSeverity = 'INFO' | 'WARNING' | 'ERROR';

export interface SimpleProcedureLeg {
  procedureName: string;
  runway: string;
  transitionName?: string;
  routeKey: string;
  sequence: string;
  fix: string;
  pathTerminator?: string;
  turnDirection?: 'L' | 'R' | '';
  distanceNm?: number;
  altitudeRaw?: string;
  altitudeValue?: number;
  /** 高度限制符号（424 第 83 列）：+ = AT_OR_ABOVE，- = AT_OR_BELOW，'' = AT/未标（B 型见 raw） */
  altitudeSign?: '+' | '-' | '';
  /** 第二高度（424 第 90-94 列，仅 B 型双高度约束；95-99 列的过渡高度不在此列） */
  altitudeUpperFt?: number;
  /** 磁航向（424 第 71-74 列 ×10，CI 的截获航向 / AF 的边界径向） */
  courseDegMag?: number;
  /** Recommended-navaid bearing/radial (ARINC 424 Theta, degrees magnetic). */
  thetaDegMag?: number;
  /** Distance from the recommended navaid (ARINC 424 Rho, nautical miles). */
  rhoNm?: number;
  /** 速度限制（424 第 100-102 列，KIAS） */
  speedLimitKias?: number;
  /** 航路点描述含 H（第 43 列）：该 Fix 有等待航线 */
  holdingAtFix?: boolean;
  /** 航路点描述含第二个 E（1EE）：程序末段腿 */
  endOfProcedure?: boolean;
  /** Fix 的 section/subsection（第 37-38 列）：EA=航路点，PC=终端点 */
  fixSection?: string;
  /** 推荐导航台（AF/CI 在 51-54 列，IF 在 107-110 列，如弧心 VJB） */
  recommendedNavaid?: string;
  source: SimpleLegSource;
  rawRecord?: string;
}

export interface ProcedureCompareResult {
  procedureName: string;
  runway: string;
  transitionName?: string;
  totalLegs: number;
  matchedLegs: number;
  partialLegs: number;
  mismatchedLegs: number;
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
  partialLegs: number;
  mismatchedLegs: number;
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
  renderSource?: {
    importedAt: string;
    procedureCount: number;
    legCount: number;
    defaultRenderMode: 'AUTO';
  };
}
