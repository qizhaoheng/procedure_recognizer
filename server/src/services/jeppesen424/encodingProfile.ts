// ARINC 424 导出 Encoding Profile：把“数据提供方方言”从导出器中拆出来。
// 列位与已验证值来自仓库内真实 Jeppesen 静态文本（WMKJ=SSPAP…E、RJTT=SPACP…D 黄金样本）。
// 未被真实样本覆盖的部分（进近路线类型字母、进近程序代码规则）按 ARINC 424 通行约定实现，
// 并在 profile 中显式声明 assumptions，禁止对外宣称为“正式可生产数据”。

export interface Arinc424EncodingProfile {
  name: string;
  /** 记录头客户/区域代码（第 2-4 列），如 Jeppesen 的 SPA / PAC。 */
  customerAreaCode: string;
  /** 子节代码（第 13 列，0 基 12）：D=SID，E=STAR，F=APPROACH。 */
  subsectionByCategory: Record<'SID' | 'STAR' | 'APPROACH', string>;
  /** SID/STAR 路线类型（第 20 列，0 基 19）：跑道/公共记录与命名过渡记录。 */
  runwayOrCommonRouteType: string;
  namedTransitionRouteType: string;
  /** 进近过渡路线类型与最后进近（含复飞续段）路线类型映射。 */
  approachTransitionRouteType: string;
  finalRouteTypeByApproachType: Record<string, string>;
  /** 本 profile 未经真实样本验证、按标准假定的部分。 */
  assumptions: string[];
}

const ICAO_PREFIX_TO_AREA: Record<string, string> = {
  RJ: 'PAC', RK: 'PAC', RO: 'PAC', RC: 'PAC', RP: 'PAC',
  WM: 'SPA', WS: 'SPA', WB: 'SPA', WA: 'SPA', WI: 'SPA', VT: 'SPA', VV: 'SPA',
};

export function profileForAirport(airportIcao: string, overrides: Partial<Arinc424EncodingProfile> = {}): Arinc424EncodingProfile {
  const prefix = airportIcao.slice(0, 2).toUpperCase();
  return {
    name: `JEPPESEN_${ICAO_PREFIX_TO_AREA[prefix] ?? 'SPA'}`,
    customerAreaCode: ICAO_PREFIX_TO_AREA[prefix] ?? 'SPA',
    subsectionByCategory: { SID: 'D', STAR: 'E', APPROACH: 'F' },
    runwayOrCommonRouteType: '2',
    namedTransitionRouteType: '3',
    approachTransitionRouteType: 'A',
    finalRouteTypeByApproachType: { ILS: 'I', LOC: 'L', RNP: 'R', RNP_AR: 'H', VOR: 'V', NDB: 'N', GLS: 'J', VISUAL: 'Q', OTHER: 'R' },
    assumptions: [
      'Approach transition route type "A" and final route-type letters follow ARINC 424 convention; no in-repo Jeppesen approach sample verifies them yet.',
      'Speed limit column 100-102 verified against parser column map, not against a Jeppesen sample containing speeds.',
    ],
    ...overrides,
  };
}

/** 进近程序代码：类型字母 + 跑道 + 可选后缀（ILS Z RWY 15L → I15LZ）。 */
export function deriveApproachCode(approachType: string | null | undefined, runway: string, procedureName: string): string | undefined {
  const letter = { ILS: 'I', LOC: 'L', RNP: 'R', RNP_AR: 'H', VOR: 'V', NDB: 'N', GLS: 'J', VISUAL: 'Q', OTHER: 'R' }[String(approachType || '').toUpperCase()];
  const designator = runway.trim().toUpperCase().replace(/^RWY?\s*/, '').replace(/^RW/, '');
  if (!letter || !/^\d{2}[LRC]?$/.test(designator)) return undefined;
  const suffix = procedureName.toUpperCase().match(/\b([XYZ])\b/)?.[1] ?? '';
  const code = `${letter}${designator}${suffix}`;
  return code.length <= 6 ? code : undefined;
}
