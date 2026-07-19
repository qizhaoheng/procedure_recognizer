import { ROUTE_CODE_TO_PROCEDURE } from "./jeppesen424TextParser";

// 424 程序代码（6 字符，如 LARI1T / ADLO1E）是 AI 程序名与 Jeppesen 记录之间
// 最可靠的对齐键：名字两侧写法常不一致（AI 带跑道后缀、424 截断 5 字母 Fix 名），
// 但 名字 -> 代码 的推导是确定的。
const PROCEDURE_TO_ROUTE_CODE = new Map(
  Object.entries(ROUTE_CODE_TO_PROCEDURE).map(([code, name]) => [name, code]),
);

/** 归一化程序名：合并空白、大写、剥离尾部跑道后缀（如 "LARIT 1T RWY 07C" -> "LARIT 1T"）。 */
export function cleanProcedureName(name: unknown) {
  return String(name ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toUpperCase()
    .replace(
      /\s+RWY?\s*\d{2}[LRCB]?(?:\s*\/\s*(?:RWY?\s*)?\d{2}[LRCB]?)*$/,
      "",
    );
}

/** 程序名 -> 424 路线代码；推导不了返回 undefined（不抛错，供对齐场景使用）。 */
export function deriveRouteCode(procedureName: unknown): string | undefined {
  const normalized = cleanProcedureName(procedureName).replace(
    /^(?:RNAV|RNP)\s+/,
    "",
  );
  if (!normalized) return undefined;
  const mapped = PROCEDURE_TO_ROUTE_CODE.get(normalized);
  if (mapped) return mapped;

  // ICAO chart titles commonly spell out the designator while ARINC 424 stores
  // its digit: "VAMOS FOUR DEPARTURE" -> VAMOS4 and
  // "TIARA TWO A DEPARTURE" -> TIAR2A.
  const withoutTransition = normalized.replace(
    /\s*\/\s*[A-Z0-9 -]+\s+TRANSITION$/,
    "",
  );
  const title = withoutTransition.replace(/\s+(?:DEPARTURE|ARRIVAL)$/, "");
  const titleWithLetter = title.replace(
    /\s+(ALPHA|ALFA|BRAVO|CHARLIE|DELTA|ECHO|FOXTROT|GOLF|HOTEL|INDIA|JULIETT|JULIET|KILO|LIMA|MIKE|NOVEMBER|OSCAR|PAPA|QUEBEC|ROMEO|SIERRA|TANGO|UNIFORM|VICTOR|WHISKEY|WHISKY|XRAY|X-RAY|YANKEE|ZULU)$/,
    (_, word: string) => ` ${PHONETIC_LETTERS[word]}`,
  );
  const wordDesignator = titleWithLetter.match(
    /^([A-Z]{2,5})\s+(ZERO|ONE|TWO|THREE|FOUR|FIVE|SIX|SEVEN|EIGHT|NINE)(?:\s+([A-Z]))?$/,
  );
  if (wordDesignator) {
    const suffix = `${WORD_DIGITS[wordDesignator[2]]}${wordDesignator[3] ?? ""}`;
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
  ZERO: "0",
  ONE: "1",
  TWO: "2",
  THREE: "3",
  FOUR: "4",
  FIVE: "5",
  SIX: "6",
  SEVEN: "7",
  EIGHT: "8",
  NINE: "9",
};

// 同一个字母在各国 AIP 里拼法不统一：ICAO 官方是 ALFA/JULIETT/WHISKY，
// 而实际印刷中 ALPHA/JULIET/WHISKEY 同样常见。只收官方拼法会让整类程序解不出路线代码——
// WMKJ 的 AIP 印 "AROSO ONE JULIET DEPARTURE"，8 条 SID 因此全被判为身份不明。
const PHONETIC_LETTERS: Record<string, string> = {
  ALPHA: "A", ALFA: "A", BRAVO: "B", CHARLIE: "C", DELTA: "D", ECHO: "E",
  FOXTROT: "F", GOLF: "G", HOTEL: "H", INDIA: "I", JULIETT: "J", JULIET: "J",
  KILO: "K", LIMA: "L", MIKE: "M", NOVEMBER: "N", OSCAR: "O",
  PAPA: "P", QUEBEC: "Q", ROMEO: "R", SIERRA: "S", TANGO: "T",
  UNIFORM: "U", VICTOR: "V", WHISKEY: "W", WHISKY: "W", XRAY: "X", "X-RAY": "X",
  YANKEE: "Y", ZULU: "Z",
};
