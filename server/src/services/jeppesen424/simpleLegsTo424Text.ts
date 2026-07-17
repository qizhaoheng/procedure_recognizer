import { deriveRouteCode } from './routeCode';
import type { SimpleProcedureLeg } from './types';
import { resolveArinc424Profile, type Arinc424Profile } from './arinc424Profile';

// 简化版 424 导出：按真实 Jeppesen 静态文本的 132 列定宽布局生成（列位实测自 WMKJ 数据）。
// 已覆盖：序号(26) / Fix(29) / Fix区域+section(34, 首腿EA其余PC) / 续行号(38) /
// 航路点描述(39, 末腿EE, 等待H@42) / 转弯(43) / PT(47) / 高度(82符号+84数值) /
// 2P续行距离(74) / 路线限定符(118, 1G→DG其余␠D)。
// 不生成（AI 结果无此数据）：推荐导航台/theta/rho、磁航向、第二高度、3E 续行、
// 文件记录号+周期号(123-131)。无 Fix 的腿段（如 CI）在转换为 SimpleProcedureLeg 时
// 已被过滤，因此不会出现在导出结果中。
const LINE_LENGTH = 132;

export interface Jeppesen424ExportOptions {
  airportIcao?: string;
  holdingFixes?: string[];
  packageType?: string;
  navigationType?: string;
  transitionAltitudeFt?: number;
}

export function simpleLegsTo424Text(legs: SimpleProcedureLeg[], options: Jeppesen424ExportOptions = {}): string {
  const airport = normalizeAirport(options.airportIcao);
  const region = airport.slice(0, 2);
  const profile = options.packageType
    ? resolveArinc424Profile({ airportIcao: airport, packageType: options.packageType, navigationType: options.navigationType })
    : undefined;
  const holdingFixes = new Set(
    (options.holdingFixes ?? []).map((fix) => fix.trim().toUpperCase()).filter(Boolean),
  );

  const procedures = new Map<string, SimpleProcedureLeg[]>();
  const sorted = [...legs].sort(
    (a, b) => a.procedureName.localeCompare(b.procedureName) || Number(a.sequence) - Number(b.sequence),
  );
  for (const leg of sorted) {
    const key = `${leg.procedureName}|${leg.runway}|${leg.transitionName ?? ''}`;
    const list = procedures.get(key) ?? [];
    list.push(leg);
    procedures.set(key, list);
  }

  const lines: string[] = [];
  for (const procedureLegs of procedures.values()) {
    procedureLegs.forEach((leg, index) => {
      const context = {
        airport,
        region,
        routeCode: resolveRouteCode(leg.procedureName),
        fixSection: leg.fixSection ?? fallbackFixSection(leg, index),
        fixRegion: profile?.fixRegionOverrides[leg.fix] ?? region,
        profile,
        isLastLeg: leg.endOfProcedure ?? (index === procedureLegs.length - 1),
        isFirstLeg: index === 0,
        transitionAltitudeFt: options.transitionAltitudeFt,
        hasHolding: leg.holdingAtFix === true || holdingFixes.has(leg.fix),
      };
      lines.push(primaryRecord(leg, context));
      lines.push(continuationRecord(leg, context));
      if (context.isFirstLeg && leg.magneticVariationDeg !== undefined) {
        lines.push(controlledMagneticVariationRecord(leg, context));
      }
    });
  }
  return lines.join('\n');
}

interface LegContext {
  airport: string;
  region: string;
  routeCode: string;
  fixSection: string;
  fixRegion: string;
  profile?: Arinc424Profile;
  isLastLeg: boolean;
  isFirstLeg: boolean;
  transitionAltitudeFt?: number;
  hasHolding: boolean;
}

function primaryRecord(leg: SimpleProcedureLeg, context: LegContext) {
  const chars = baseRecord(leg, context);
  put(chars, 38, '1');
  put(chars, 39, context.isLastLeg ? 'EE' : leg.flyOver ? 'EY' : 'E');
  put(chars, 118, context.routeCode.endsWith('G') ? 'DG' : ' D');
  if (context.hasHolding) put(chars, 42, 'H');
  if (leg.turnDirection === 'L' || leg.turnDirection === 'R') put(chars, 43, leg.turnDirection);
  if (leg.pathTerminator) put(chars, 47, leg.pathTerminator);
  if (leg.requiredNavigationPerformance !== undefined) {
    const encoded = Math.round(leg.requiredNavigationPerformance * 10);
    if (encoded < 1 || encoded > 999) throw new Error(`Cannot export 424: RNP value ${leg.requiredNavigationPerformance} is outside the supported range.`);
    put(chars, 44, String(encoded).padStart(3, '0'));
  }
  // 磁航向（71-74 列，×10）：与 Jeppesen 一致，只在 CI/AF 腿上编码
  const pathTerminator = String(leg.pathTerminator ?? '').toUpperCase();
  if (['AF', 'CA', 'CF', 'CI', 'CR'].includes(pathTerminator) && leg.courseDegMag !== undefined) {
    put(chars, 70, String(Math.round(leg.courseDegMag * 10)).padStart(4, '0'));
  }
  // 推荐导航台：AF/CI 在 51-56 列（导航台+区域），IF 在 107-110/113-115 列（导航台+区域+D）
  if (leg.recommendedNavaid) {
    if (pathTerminator === 'AF' || pathTerminator === 'CI' || pathTerminator === 'CR' || pathTerminator === 'CF') {
      put(chars, 50, leg.recommendedNavaid.slice(0, 4));
      put(chars, 54, context.region);
    } else if (pathTerminator === 'IF' || pathTerminator === 'CA') {
      put(chars, 106, leg.recommendedNavaid.slice(0, 4));
      put(chars, 112, `${context.region}D`);
    }
  }
  if (leg.centerFix) {
    put(chars, 106, leg.centerFix.slice(0, 5));
    put(chars, 112, context.region);
    put(chars, 114, 'PC');
  } else if (context.isFirstLeg && pathTerminator === 'CF') {
    // A runway-transition CF originates at the airport record. ARINC stores
    // that source reference in the center-fix field even though it is not a
    // radio navaid.
    put(chars, 106, context.airport);
    put(chars, 112, context.region);
    put(chars, 114, 'PA');
  }
  if (leg.altitudeValue !== undefined) {
    const sign = leg.altitudeSign ?? (leg.altitudeRaw?.startsWith('+') ? '+' : leg.altitudeRaw?.startsWith('-') ? '-' : '');
    if (sign) put(chars, 82, sign);
    const altitudeCode = leg.altitudeCode ?? String(Math.round(leg.altitudeValue)).padStart(5, '0');
    if (!/^(?:\d{5}|FL\d{3})$/.test(altitudeCode)) {
      throw new Error(`Cannot export 424: leg ${leg.procedureName} ${leg.sequence} altitude code ${altitudeCode} is invalid.`);
    }
    put(chars, 84, altitudeCode);
  }
  if (leg.altitudeUpperFt !== undefined) {
    // 第二高度（B 型双高度）在第 90-94 列；95-99 列是过渡高度，导出不生成
    put(chars, 89, String(Math.round(leg.altitudeUpperFt)).padStart(5, '0'));
  }
  if (leg.thetaDegMag !== undefined) put(chars, 62, fixedTenths(leg.thetaDegMag, 4, 'Theta'));
  if (leg.rhoNm !== undefined) put(chars, 66, fixedTenths(leg.rhoNm, 4, 'Rho'));
  if (['AF', 'CD', 'CF', 'FD', 'RF'].includes(pathTerminator) && leg.distanceNm !== undefined && leg.distanceNm > 0) {
    put(chars, 74, fixedTenths(leg.distanceNm, 4, 'leg distance'));
    put(chars, 78, 'D');
  }
  if (leg.speedLimitKias !== undefined) {
    const speed = Math.round(leg.speedLimitKias);
    if (speed < 100 || speed > 400) {
      throw new Error(`Cannot export 424: leg ${leg.procedureName} ${leg.sequence} speed ${leg.speedLimitKias} KIAS is outside the supported 100-400 range.`);
    }
    put(chars, 99, String(speed).padStart(3, '0'));
  }
  if (context.isFirstLeg && context.transitionAltitudeFt !== undefined) {
    const altitude = Math.round(context.transitionAltitudeFt);
    if (altitude < 0 || altitude > 99999) throw new Error(`Cannot export 424: transition altitude ${altitude} ft is outside the five-column range.`);
    put(chars, 94, String(altitude).padStart(5, '0'));
  }
  return chars.join('');
}

function controlledMagneticVariationRecord(leg: SimpleProcedureLeg, context: LegContext) {
  const variation = leg.magneticVariationDeg!;
  if (!Number.isFinite(variation) || Math.abs(variation) > 30) {
    throw new Error(`Cannot export 424: controlled magnetic variation ${variation} is invalid.`);
  }
  const chars = baseRecord(leg, context);
  put(chars, 38, '3');
  put(chars, 39, 'E');
  put(chars, 60, `${variation >= 0 ? 'W' : 'E'}${String(Math.round(Math.abs(variation) * 10)).padStart(4, '0')}P`);
  put(chars, 118, context.routeCode.endsWith('G') ? 'DG' : ' D');
  return chars.join('');
}

function continuationRecord(leg: SimpleProcedureLeg, context: LegContext) {
  const chars = baseRecord(leg, context);
  put(chars, 38, '2');
  put(chars, 39, 'P');
  if (leg.distanceNm !== undefined && leg.distanceNm > 0) {
    const distance = String(Math.round(leg.distanceNm * 10)).padStart(4, '0');
    if (distance.length !== 4) {
      throw new Error(`无法导出 424：腿段 ${leg.procedureName} ${leg.sequence} 的距离 ${leg.distanceNm}NM 超出 4 位记录范围。`);
    }
    put(chars, 74, distance);
  }
  return chars.join('');
}

function baseRecord(leg: SimpleProcedureLeg, context: LegContext) {
  const transitionName = String(leg.transitionName ?? '').trim().toUpperCase();
  if (!transitionName && !/^RW\d{2}[A-Z]?$/.test(leg.runway)) {
    throw new Error(`无法导出 424：腿段 ${leg.procedureName} ${leg.sequence} 缺少有效跑道（当前值 "${leg.runway}"）。`);
  }
  if (transitionName && !/^[A-Z0-9]{2,5}$/.test(transitionName)) {
    throw new Error(`无法导出 424：腿段 ${leg.procedureName} ${leg.sequence} 的转场名 "${transitionName}" 无效。`);
  }
  const sequence = leg.sequence.padStart(3, '0');
  if (!/^\d{3}$/.test(sequence)) {
    throw new Error(`无法导出 424：腿段 ${leg.procedureName} 的序号 "${leg.sequence}" 不是 3 位数字。`);
  }
  if (leg.fix.length > 5) {
    throw new Error(`无法导出 424：腿段 ${leg.procedureName} ${sequence} 的 Fix "${leg.fix}" 超过 5 个字符。`);
  }

  const chars = new Array<string>(LINE_LENGTH).fill(' ');
  put(chars, 0, context.profile ? `S${context.profile.areaCode}P` : 'SSPAP');
  put(chars, 6, context.airport);
  put(chars, 10, context.region);
  put(chars, 12, context.profile?.terminalSection ?? 'E');
  put(chars, 13, context.routeCode);
  put(chars, 19, transitionName ? '3' : context.profile?.runwayRouteType ?? '2');
  put(chars, 20, transitionName || leg.runway);
  put(chars, 26, sequence);
  put(chars, 29, leg.fix);
  if (leg.fix || context.fixSection) {
    put(chars, 34, context.fixRegion);
    put(chars, 36, context.fixSection);
  }
  return chars;
}

function put(chars: string[], pos: number, text: string) {
  for (let i = 0; i < text.length; i += 1) chars[pos + i] = text[i];
}

function fixedTenths(value: number, width: number, label: string) {
  const encoded = String(Math.round(value * 10)).padStart(width, '0');
  if (!Number.isFinite(value) || value < 0 || encoded.length !== width) {
    throw new Error(`Cannot export 424: ${label} ${value} is outside the ${width}-column range.`);
  }
  return encoded;
}

function fallbackFixSection(leg: SimpleProcedureLeg, index: number) {
  const pathTerminator = String(leg.pathTerminator ?? '').toUpperCase();
  if (!leg.fix && ['CA', 'CI', 'CR', 'VA', 'VI'].includes(pathTerminator)) return '';
  return index === 0 ? 'EA' : 'PC';
}

function resolveRouteCode(procedureName: string) {
  const code = deriveRouteCode(procedureName);
  if (code && code.length === 6) return code;
  throw new Error(`无法导出 424：无法从程序名 "${procedureName}" 推导 6 位路线代码。`);
}

function normalizeAirport(value: string | undefined) {
  const airport = String(value ?? '').trim().toUpperCase();
  if (!/^[A-Z]{4}$/.test(airport)) {
    throw new Error(`无法导出 424：缺少有效的机场 ICAO 代码（当前值 "${value ?? ''}"）。`);
  }
  return airport;
}
