import { ROUTE_CODE_TO_PROCEDURE } from './jeppesen424TextParser';

// 424 程序代码（6 字符，如 LARI1T / ADLO1E）是 AI 程序名与 Jeppesen 记录之间
// 最可靠的对齐键：名字两侧写法常不一致（AI 带跑道后缀、424 截断 5 字母 Fix 名），
// 但 名字 -> 代码 的推导是确定的。
const PROCEDURE_TO_ROUTE_CODE = new Map(
  Object.entries(ROUTE_CODE_TO_PROCEDURE).map(([code, name]) => [name, code]),
);

/** 归一化程序名：合并空白、大写、剥离尾部跑道后缀（如 "LARIT 1T RWY 07C" -> "LARIT 1T"）。 */
export function cleanProcedureName(name: unknown) {
  return String(name ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toUpperCase()
    .replace(/\s+RWY?\s*\d{2}[LRCB]?(?:\s*\/\s*(?:RWY?\s*)?\d{2}[LRCB]?)*$/, '');
}

/** 程序名 -> 424 路线代码；推导不了返回 undefined（不抛错，供对齐场景使用）。 */
export function deriveRouteCode(procedureName: unknown): string | undefined {
  const normalized = cleanProcedureName(procedureName);
  if (!normalized) return undefined;
  const mapped = PROCEDURE_TO_ROUTE_CODE.get(normalized);
  if (mapped) return mapped;

  // ICAO chart titles commonly spell out the designator while ARINC 424 stores
  // its digit: "VAMOS FOUR DEPARTURE" -> VAMOS4 and
  // "TIARA TWO A DEPARTURE" -> TIAR2A.
  const withoutTransition = normalized.replace(/\s*\/\s*[A-Z0-9 -]+\s+TRANSITION$/, '');
  const title = withoutTransition.replace(/\s+(?:DEPARTURE|ARRIVAL)$/, '');
  const wordDesignator = title.match(
    /^([A-Z]{2,5})\s+(ZERO|ONE|TWO|THREE|FOUR|FIVE|SIX|SEVEN|EIGHT|NINE)(?:\s+([A-Z]))?$/,
  );
  if (wordDesignator) {
    const suffix = `${WORD_DIGITS[wordDesignator[2]]}${wordDesignator[3] ?? ''}`;
    const code = `${wordDesignator[1].slice(0, 6 - suffix.length)}${suffix}`;
    return code.length >= 4 ? code : undefined;
  }

  // 通用规则：如 "LARIT 1T" -> "LARI1T"（Fix 名截断到 6 - 后缀长度）
  const match = title.match(/^([A-Z]{2,5})\s*(\d[A-Z]?)$/);
  if (!match) return undefined;
  const code = `${match[1].slice(0, 6 - match[2].length)}${match[2]}`;
  return code.length >= 4 ? code : undefined;
}

const WORD_DIGITS: Record<string, string> = {
  ZERO: '0',
  ONE: '1',
  TWO: '2',
  THREE: '3',
  FOUR: '4',
  FIVE: '5',
  SIX: '6',
  SEVEN: '7',
  EIGHT: '8',
  NINE: '9',
};
