import type { ProcedureUnderstandingResult } from '../../types/procedure';
import type { SimpleProcedureLeg } from './types';

export function aiProcedureToSimpleLegs(procedureUnderstanding: ProcedureUnderstandingResult | undefined): SimpleProcedureLeg[] {
  if (!procedureUnderstanding?.procedures?.length) return [];

  return procedureUnderstanding.procedures.flatMap((procedure) => {
    const sourceProcedure = procedure as Record<string, unknown>;
    const procedureName = normalizedText(
      sourceProcedure.procedureIdentifier
        ?? sourceProcedure.name
        ?? procedure.procedureName
        ?? '',
    );
    const runway = normalizeRunway(procedure.runway ?? procedureUnderstanding.runway ?? '');

    return (procedure.legs ?? []).map((leg) => {
      const record = leg as Record<string, unknown>;
      const altitude = altitudeParts(record.altitudeConstraint);
      return {
        procedureName,
        runway,
        routeKey: '',
        sequence: normalizeSequence(record.sequence),
        fix: normalizedText(record.fixIdentifier ?? record.toFix ?? record.fix ?? ''),
        pathTerminator: normalizedText(record.pathTerminator ?? ''),
        turnDirection: normalizeTurn(record.turnDirection),
        distanceNm: numberOrUndefined(record.distanceNm),
        altitudeRaw: altitude.raw,
        altitudeValue: altitude.value,
        source: 'AI' as const,
        rawRecord: JSON.stringify(record),
      };
    });
  }).filter((leg) => leg.procedureName && leg.sequence && leg.fix);
}

function normalizeSequence(value: unknown) {
  const numberValue = Number(value);
  if (Number.isFinite(numberValue)) return String(numberValue).padStart(3, '0');
  const text = normalizedText(value);
  const match = text.match(/\d+/);
  return match ? match[0].padStart(3, '0') : '';
}

function normalizeRunway(value: unknown) {
  const text = normalizedText(value).replace(/\s+/g, '').replace(/^RWY/, 'RW');
  if (!text) return '';
  return text.startsWith('RW') ? text : `RW${text}`;
}

function normalizedText(value: unknown) {
  return String(value ?? '').trim().toUpperCase();
}

function normalizeTurn(value: unknown): 'L' | 'R' | '' {
  const text = normalizedText(value);
  if (text === 'L' || text === 'LEFT') return 'L';
  if (text === 'R' || text === 'RIGHT') return 'R';
  return '';
}

function numberOrUndefined(value: unknown) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : undefined;
}

function altitudeParts(value: unknown): { raw?: string; value?: number } {
  if (!value) return {};
  if (typeof value === 'string') return altitudeFromRaw(value);
  if (typeof value !== 'object') return {};

  const record = value as Record<string, unknown>;
  const rawText = String(record.rawText ?? '').trim();
  if (rawText) {
    const parsed = altitudeFromRaw(rawText);
    if (parsed.raw || parsed.value !== undefined) return parsed;
  }

  const altitudeValue = numberOrUndefined(record.altitudeFt ?? record.value ?? record.lowerFt ?? record.upperFt);
  const type = normalizedText(record.type);
  const prefix = type === 'AT_OR_ABOVE' ? '+' : type === 'AT_OR_BELOW' ? '-' : '';
  return {
    raw: altitudeValue === undefined ? undefined : `${prefix}${String(Math.round(altitudeValue)).padStart(5, '0')}`,
    value: altitudeValue,
  };
}

function altitudeFromRaw(rawInput: string) {
  const raw = rawInput.trim().toUpperCase();
  const match = raw.match(/([+-]?)\s*(\d{3,5})/);
  if (!match) return { raw };
  return {
    raw: `${match[1] || ''}${match[2]}`,
    value: Number(match[2]),
  };
}
