// 程序名称标准化：显示名（"RUTAS FOUR DEPARTURE"）→ 标准化标识（"RUTAS4"）。
// 标准化标识用于分组键、程序身份对比和 424 对齐；原始显示名必须另行保留。
// 注意与 jeppesen424/routeCode.deriveRouteCode 的区别：路线代码受 424 的 6 字符限制
// 会截断 Fix 名（TIARA TWO A -> TIAR2A），标准化标识不受此限（-> TIARA2A）。

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

const PROCEDURE_SUFFIX_WORDS = /\s+(?:DEPARTURE|ARRIVAL|DEP|ARR)\.?$/;
const RUNWAY_SUFFIX = /\s+RWY?\s*\d{2}[LRCB]?(?:\s*\/\s*(?:RWY?\s*)?\d{2}[LRCB]?)*$/;

/**
 * 归一化程序名为标准化标识：
 * - 'VAMOS FOUR DEPARTURE' -> 'VAMOS4'
 * - 'RUTAS FOUR DEPARTURE' -> 'RUTAS4'
 * - 'TIARA TWO A DEPARTURE' -> 'TIARA2A'
 * - 'LARIT 1T RWY 07C' -> 'LARIT1T'
 * 无法解析出代号结构时返回 undefined（调用方保留原始名，不得猜测）。
 */
export function normalizeProcedureName(name: unknown): string | undefined {
  const cleaned = cleanDisplayName(name);
  if (!cleaned) return undefined;
  const base = cleaned.replace(PROCEDURE_SUFFIX_WORDS, '');

  // 字词型代号：RUTAS FOUR / TIARA TWO A
  const wordForm = base.match(
    /^([A-Z]{2,8})\s+(ZERO|ONE|TWO|THREE|FOUR|FIVE|SIX|SEVEN|EIGHT|NINE)(?:\s+([A-Z]))?$/,
  );
  if (wordForm) {
    return `${wordForm[1]}${WORD_DIGITS[wordForm[2]]}${wordForm[3] ?? ''}`;
  }

  // 紧凑型代号：LARIT 1T / VAMOS4 / BINIL 3C
  const compact = base.match(/^([A-Z]{2,8})\s*(\d[A-Z]?)$/);
  if (compact) return `${compact[1]}${compact[2]}`;

  return undefined;
}

/** 清理显示名：合并空白、大写、剥离跑道后缀。保留 DEPARTURE/ARRIVAL 字样。 */
export function cleanDisplayName(name: unknown): string {
  return String(name ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toUpperCase()
    .replace(RUNWAY_SUFFIX, '');
}

/**
 * 过渡名 → 标准化过渡标识（424 的 5 字符限制）：
 * - 'TATEYAMA TRANSITION' -> 'TATEY'
 * - 'DRAKY TRANSITION' -> 'DRAKY'
 * 过渡名不是 waypoint：调用方不得据此创建 Fix。
 */
export function normalizeTransitionId(name: unknown): string | undefined {
  const cleaned = String(name ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toUpperCase()
    .replace(/\s+TRANSITION\.?$/, '');
  if (!cleaned) return undefined;
  const word = cleaned.match(/^([A-Z]{2,})$/)?.[1];
  return word ? word.slice(0, 5) : undefined;
}

/** 两个程序名（任意写法）是否指同一程序。任一侧无法标准化则不可判定，返回 false。 */
export function procedureIdsMatch(left: unknown, right: unknown): boolean {
  const a = normalizeProcedureName(left);
  const b = normalizeProcedureName(right);
  if (!a || !b) return false;
  if (a === b) return true;
  // 424 侧可能截断 Fix 名（TIAR2A vs TIARA2A）：数字后缀一致且 Fix 前缀相容视为同一程序
  const [, aFix, aSuffix] = a.match(/^([A-Z]+)(\d[A-Z]?)$/) ?? [];
  const [, bFix, bSuffix] = b.match(/^([A-Z]+)(\d[A-Z]?)$/) ?? [];
  if (!aFix || !bFix || aSuffix !== bSuffix) return false;
  return aFix.startsWith(bFix) || bFix.startsWith(aFix);
}
