import type { JeppesenLegExtension } from '../../types/procedure';

export type SimpleLegSource = 'AI' | 'JEPPESEN_424';
export type CompareStatus = 'MATCH' | 'PARTIAL' | 'MISMATCH' | 'MISSING_AI' | 'MISSING_JEPPESEN';
export type CompareSeverity = 'INFO' | 'WARNING' | 'ERROR';

export interface SimpleProcedureLeg {
  procedureName: string;
  runway: string;
  transitionName?: string;
  routeKey: string;
  /** 424 路线类型列（第 20 列，0 基 19）：区分 runway/common/enroute transition 记录 */
  routeType?: string;
  /** 记录所属分支角色（由路线段限定符解析而来） */
  branchRole?: 'RUNWAY' | 'COMMON' | 'ENROUTE';
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
  /** 程序类别：决定 424 子节（D=SID / E=STAR / F=APPROACH）。缺省按历史行为视为 STAR(E)。 */
  category?: 'SID' | 'STAR' | 'APPROACH';
  /** 预先推导好的 424 程序代码（进近如 I15L/R15LZ；SID/STAR 缺省由程序名推导）。 */
  procedureCode?: string;
  /** 显式路线类型字符（进近过渡 A、最后进近按类型 I/R/V/N/L 等）；缺省按 2/3 规则。 */
  routeTypeChar?: string;
  /**
   * Continuation 记录（2P/3E 等）的结构化保留：原文、解释值、是否可与 AIP 对比。
   * 注意 distanceNm 来自 2P 供应商扩展时不能直接视为 AIP 发布距离。
   */
  extensions?: JeppesenLegExtension[];
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
  /** 程序身份未匹配时为 null，禁止显示总体匹配率 */
  overallScore: number | null;
  comparisonStatus?: 'MATCHED' | 'PARTIAL_COMPARISON' | 'PARTIALLY_IDENTIFIED' | 'NOT_COMPARABLE' | 'SOURCE_MISMATCH';
  reason?: string;
}

export interface Jeppesen424CompareResponse {
  ok: true;
  summary: Jeppesen424CompareSummary;
  /** 四阶段程序图对比结果（身份/拓扑/腿段/字段 + 覆盖率），每个 AI 程序一条 */
  graphComparisons?: import('../procedureGraph/graphComparator').GraphCompareResult[];
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
