import type { ProcedureUnderstandingResult } from '../../types/procedure';
import type { SimpleProcedureLeg } from './types';

export function aiProcedureToSimpleLegs(procedureUnderstanding: ProcedureUnderstandingResult | undefined): SimpleProcedureLeg[] {
  if (!procedureUnderstanding?.procedures?.length) return [];

  const holdingFixes = new Set(
    (procedureUnderstanding.holdings ?? [])
      .map((holding) => normalizedText((holding as Record<string, unknown>).fixIdentifier ?? (holding as Record<string, unknown>).fix ?? ''))
      .filter(Boolean),
  );
  // Jeppesen 在 IF/AF 腿上编码推荐导航台（本例为弧心 VJB）；AI 侧从 DME_ARC 语义推导
  const arcCenter = normalizedText(
    procedureUnderstanding.geometrySemantics?.find((item) => item.type === 'DME_ARC' && item.centerNavaid)?.centerNavaid ?? '',
  ) || undefined;

  return procedureUnderstanding.procedures.flatMap((procedure) => {
    const sourceProcedure = procedure as Record<string, unknown>;
    const procedureName = normalizedText(
      sourceProcedure.procedureIdentifier
        ?? sourceProcedure.name
        ?? procedure.procedureName
        ?? '',
    );
    const runway = normalizeRunway(procedure.runway ?? procedureUnderstanding.runway ?? '');
    const legs = procedure.legs ?? [];
    const sequences = legs.map((leg) => Number((leg as Record<string, unknown>).sequence)).filter(Number.isFinite);
    const firstSequence = sequences.length ? Math.min(...sequences) : undefined;
    const lastSequence = sequences.length ? Math.max(...sequences) : undefined;

    return legs.map((leg) => {
      const record = leg as Record<string, unknown>;
      const altitude = altitudeParts(record.altitudeConstraint);
      const sequenceValue = Number(record.sequence);
      const fix = normalizedText(record.fixIdentifier ?? record.toFix ?? record.fix ?? '');
      const pathTerminator = normalizedText(record.pathTerminator ?? '');
      const recommendedNavaid = normalizedText(record.recommendedNavaid ?? '')
        || (pathTerminator === 'AF' || pathTerminator === 'IF' ? arcCenter : undefined);
      return {
        procedureName,
        runway,
        routeKey: '',
        sequence: normalizeSequence(record.sequence),
        fix,
        pathTerminator,
        turnDirection: normalizeTurn(record.turnDirection),
        distanceNm: numberOrUndefined(record.distanceNm),
        altitudeRaw: altitude.raw,
        altitudeValue: altitude.value,
        altitudeSign: altitude.sign,
        altitudeUpperFt: altitude.upper,
        courseDegMag: numberOrUndefined(record.courseDegMag ?? record.courseDeg),
        holdingAtFix: holdingFixes.has(fix),
        endOfProcedure: Number.isFinite(sequenceValue) && sequenceValue === lastSequence,
        // 与导出器一致的启发式：首腿为航路入航点（EA），其余为终端点（PC）
        fixSection: Number.isFinite(sequenceValue) && sequenceValue === firstSequence ? 'EA' : 'PC',
        recommendedNavaid: recommendedNavaid || undefined,
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

interface AltitudeParts {
  raw?: string;
  value?: number;
  sign?: '+' | '-' | '';
  upper?: number;
}

function altitudeParts(value: unknown): AltitudeParts {
  if (!value) return {};
  if (typeof value === 'string') return altitudeFromRaw(value);
  if (typeof value !== 'object') return {};

  const record = value as Record<string, unknown>;
  const upperFt = numberOrUndefined(record.upperFt);
  const rawText = String(record.rawText ?? '').trim();
  if (rawText) {
    const parsed = altitudeFromRaw(rawText);
    if (parsed.raw || parsed.value !== undefined) {
      return { ...parsed, upper: upperFt !== undefined && upperFt !== parsed.value ? upperFt : parsed.upper };
    }
  }

  const altitudeValue = numberOrUndefined(record.altitudeFt ?? record.value ?? record.lowerFt ?? record.upperFt);
  const type = normalizedText(record.type);
  const sign: '+' | '-' | '' = type === 'AT_OR_ABOVE' ? '+' : type === 'AT_OR_BELOW' ? '-' : '';
  return {
    raw: altitudeValue === undefined ? undefined : `${sign}${String(Math.round(altitudeValue)).padStart(5, '0')}`,
    value: altitudeValue,
    sign: altitudeValue === undefined ? undefined : sign,
    upper: upperFt !== undefined && upperFt !== altitudeValue ? upperFt : undefined,
  };
}

function altitudeFromRaw(rawInput: string): AltitudeParts {
  const raw = rawInput.trim().toUpperCase();
  const match = raw.match(/([+-]?)\s*(\d{3,5})/);
  if (!match) return { raw };
  return {
    raw: `${match[1] || ''}${match[2]}`,
    value: Number(match[2]),
    sign: (match[1] as '+' | '-' | '') || '',
  };
}
