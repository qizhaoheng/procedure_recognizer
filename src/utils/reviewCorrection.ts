export function parseReviewCorrection(text: string, currentValue: unknown): unknown {
  const value = text.trim();
  if (!value) throw new Error('修正值不能为空。');

  if (typeof currentValue === 'number') return parseNumber(value);
  if (typeof currentValue === 'boolean') return parseBoolean(value);

  if (Array.isArray(currentValue)) {
    if (value.startsWith('[') || value.startsWith('{')) return parseJson(value);
    const alternatives = currentValue.filter((item) => item !== null && item !== undefined);
    if (alternatives.length && alternatives.every((item) => typeof item === 'number')) return parseNumber(value);
    if (alternatives.length && alternatives.every((item) => typeof item === 'boolean')) return parseBoolean(value);
    return value;
  }

  if (currentValue && typeof currentValue === 'object') return parseJson(value);
  return value;
}

function parseNumber(value: string) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error('该字段需要输入有效数字。');
  return number;
}

function parseBoolean(value: string) {
  if (!/^(true|false)$/i.test(value)) throw new Error('该字段需要输入 true 或 false。');
  return value.toLowerCase() === 'true';
}

function parseJson(value: string) {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error('对象或数组修正值必须是有效 JSON。');
  }
}
