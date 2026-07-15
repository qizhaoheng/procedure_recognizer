import { deriveRouteCode } from './routeCode';
import { profileForAirport, type Arinc424EncodingProfile } from './encodingProfile';
import type { SimpleProcedureLeg } from './types';

// 简化版 424 导出：按真实 Jeppesen 静态文本的 132 列定宽布局生成。
// 列位实测自仓库黄金样本：WMKJ（SSPAP…子节 E，STAR）与 RJTT（SPACP…子节 D，SID）。
// 记录身份不再硬编码：客户区代码 / 子节 / 路线类型由 Encoding Profile 按程序类别决定。
// 已覆盖：序号(26) / Fix(29) / Fix区域+section(34) / 续行号(38) / 航路点描述(39, 末腿EE, 等待H@42)
// / 转弯(43) / PT(47) / 磁航向(70,×10) / 高度(82符号+84数值) / 第二高度(89) / 速度(99, KIAS)
// / 2P续行距离(74) / 路线限定符(118)。
// 不生成（AI 结果无此数据）：theta/rho、3E 续行、文件记录号+周期号(123-131)。
const LINE_LENGTH = 132;

export interface Jeppesen424ExportOptions {
  airportIcao?: string;
  holdingFixes?: string[];
  profile?: Partial<Arinc424EncodingProfile>;
}

export function simpleLegsTo424Text(legs: SimpleProcedureLeg[], options: Jeppesen424ExportOptions = {}): string {
  const airport = normalizeAirport(options.airportIcao);
  const region = airport.slice(0, 2);
  const profile = profileForAirport(airport, options.profile);
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
      const category = leg.category ?? 'STAR';
      const context = {
        airport,
        region,
        profile,
        subsection: profile.subsectionByCategory[category] ?? 'E',
        routeCode: leg.procedureCode ?? resolveRouteCode(leg.procedureName),
        fixSection: leg.fixSection ?? fallbackFixSection(leg, index),
        isLastLeg: leg.endOfProcedure ?? (index === procedureLegs.length - 1),
        hasHolding: leg.holdingAtFix === true || holdingFixes.has(leg.fix),
      };
      lines.push(primaryRecord(leg, context));
      lines.push(continuationRecord(leg, context));
    });
  }
  return lines.join('\n');
}

interface LegContext {
  airport: string;
  region: string;
  profile: Arinc424EncodingProfile;
  subsection: string;
  routeCode: string;
  fixSection: string;
  isLastLeg: boolean;
  hasHolding: boolean;
}

function primaryRecord(leg: SimpleProcedureLeg, context: LegContext) {
  const chars = baseRecord(leg, context);
  put(chars, 38, '1');
  put(chars, 39, context.isLastLeg ? 'EE' : 'E');
  put(chars, 118, context.routeCode.endsWith('G') ? 'DG' : ' D');
  if (context.hasHolding) put(chars, 42, 'H');
  if (leg.turnDirection === 'L' || leg.turnDirection === 'R') put(chars, 43, leg.turnDirection);
  if (leg.pathTerminator) put(chars, 47, leg.pathTerminator);
  // 磁航向（71-74 列，×10）：与 Jeppesen 一致，只在需要航向语义的 PT 上编码
  const pathTerminator = String(leg.pathTerminator ?? '').toUpperCase();
  if (['AF', 'CA', 'CF', 'CI', 'CR', 'VA', 'VI', 'VM', 'FA', 'HA', 'HF', 'HM'].includes(pathTerminator) && leg.courseDegMag !== undefined) {
    put(chars, 70, String(Math.round(leg.courseDegMag * 10)).padStart(4, '0'));
  }
  // 推荐导航台：AF/CI 在 51-56 列（导航台+区域），IF 在 107-110/113-115 列（导航台+区域+D）
  if (leg.recommendedNavaid) {
    if (pathTerminator === 'AF' || pathTerminator === 'CI' || pathTerminator === 'CR' || pathTerminator === 'CF') {
      put(chars, 50, leg.recommendedNavaid.slice(0, 4));
      put(chars, 54, context.region);
    } else if (pathTerminator === 'IF' || pathTerminator === 'CA' || pathTerminator === 'RF') {
      put(chars, 106, leg.recommendedNavaid.slice(0, 5));
      put(chars, 112, `${context.region}D`);
    }
  }
  if (leg.altitudeValue !== undefined) {
    if (leg.altitudeValue < 0) {
      throw new Error(`无法导出 424：腿段 ${leg.procedureName} ${leg.sequence} 的高度 ${leg.altitudeValue}ft 为负值（AIP 的 "-N" 表示 AT_OR_BELOW N）。`);
    }
    const sign = leg.altitudeSign ?? (leg.altitudeRaw?.startsWith('+') ? '+' : leg.altitudeRaw?.startsWith('-') ? '-' : '');
    if (sign) put(chars, 82, sign);
    put(chars, 84, String(Math.round(leg.altitudeValue)).padStart(5, '0'));
  }
  if (leg.altitudeUpperFt !== undefined) {
    if (leg.altitudeUpperFt < 0) {
      throw new Error(`无法导出 424：腿段 ${leg.procedureName} ${leg.sequence} 的第二高度 ${leg.altitudeUpperFt}ft 为负值。`);
    }
    // 第二高度（B 型双高度）在第 90-94 列；95-99 列是过渡高度，导出不生成
    put(chars, 89, String(Math.round(leg.altitudeUpperFt)).padStart(5, '0'));
  }
  // 速度限制：第 100-102 列（0 基 99-101），3 位 KIAS —— 与解析器列位一致
  if (leg.speedLimitKias !== undefined) {
    const speed = Math.round(leg.speedLimitKias);
    if (speed < 0 || speed > 999) throw new Error(`无法导出 424：腿段 ${leg.procedureName} ${leg.sequence} 的速度 ${leg.speedLimitKias} 超出 3 位记录范围。`);
    put(chars, 99, String(speed).padStart(3, '0'));
  }
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
  const category = leg.category ?? 'STAR';
  if (category !== 'APPROACH' && !transitionName && !/^RW\d{2}[A-Z]?$/.test(leg.runway)) {
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

  const routeTypeChar = leg.routeTypeChar
    ?? (category === 'APPROACH'
      ? (transitionName ? context.profile.approachTransitionRouteType : context.profile.finalRouteTypeByApproachType.OTHER)
      : (transitionName ? context.profile.namedTransitionRouteType : context.profile.runwayOrCommonRouteType));
  const qualifier = transitionName || (category === 'APPROACH' ? '' : leg.runway);

  const chars = new Array<string>(LINE_LENGTH).fill(' ');
  put(chars, 0, `S${context.profile.customerAreaCode}P`);
  put(chars, 6, context.airport);
  put(chars, 10, context.region);
  put(chars, 12, context.subsection);
  put(chars, 13, context.routeCode);
  put(chars, 19, routeTypeChar);
  if (qualifier) put(chars, 20, qualifier);
  put(chars, 26, sequence);
  put(chars, 29, leg.fix);
  if (leg.fix || context.fixSection) {
    put(chars, 34, context.region);
    put(chars, 36, context.fixSection);
  }
  return chars;
}

function put(chars: string[], pos: number, text: string) {
  for (let i = 0; i < text.length; i += 1) chars[pos + i] = text[i];
}

function fallbackFixSection(leg: SimpleProcedureLeg, index: number) {
  const pathTerminator = String(leg.pathTerminator ?? '').toUpperCase();
  if (!leg.fix && ['CA', 'CI', 'CR', 'VA', 'VI'].includes(pathTerminator)) return '';
  return index === 0 ? 'EA' : 'PC';
}

function resolveRouteCode(procedureName: string) {
  const code = deriveRouteCode(procedureName);
  if (code && code.length >= 4 && code.length <= 6) return code;
  throw new Error(`无法导出 424：无法从程序名 "${procedureName}" 推导 6 位路线代码。`);
}

function normalizeAirport(value: string | undefined) {
  const airport = String(value ?? '').trim().toUpperCase();
  if (!/^[A-Z]{4}$/.test(airport)) {
    throw new Error(`无法导出 424：缺少有效的机场 ICAO 代码（当前值 "${value ?? ''}"）。`);
  }
  return airport;
}
