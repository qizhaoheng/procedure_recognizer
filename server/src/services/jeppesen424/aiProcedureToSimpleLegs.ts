import type { ProcedureUnderstandingResult } from '../../types/procedure';
import { cleanProcedureName } from './routeCode';
import type { SimpleProcedureLeg } from './types';

export function aiProcedureToSimpleLegs(procedureUnderstanding: ProcedureUnderstandingResult | undefined): SimpleProcedureLeg[] {
  if (!procedureUnderstanding?.procedures?.length) return [];

  const isRnavStar = normalizedText(procedureUnderstanding.packageType) === 'STAR'
    && normalizedText(procedureUnderstanding.navigationType) === 'RNAV';
  const isSid = normalizedText(procedureUnderstanding.packageType) === 'SID';
  const sidInitialNavaid = isSid ? sidInitialRecommendedNavaid(procedureUnderstanding) : undefined;
  const holdingFixes = new Set(
    (procedureUnderstanding.holdings ?? [])
      .map((holding) => normalizedText((holding as Record<string, unknown>).fixIdentifier ?? (holding as Record<string, unknown>).fix ?? ''))
      .filter(Boolean),
  );
  // Jeppesen codes the arc center navaid on IF/AF legs; AI can infer it from DME_ARC geometry.
  const arcCenter = normalizedText(
    procedureUnderstanding.geometrySemantics?.find((item) => item.type === 'DME_ARC' && item.centerNavaid)?.centerNavaid ?? '',
  ) || undefined;

  return procedureUnderstanding.procedures.flatMap((procedure) => {
    const sourceProcedure = procedure as Record<string, unknown>;
    // 剥离尾部跑道后缀（如 "LARIT 1T RWY 07C" -> "LARIT 1T"），以便与 424 路线代码对齐
    const procedureName = cleanProcedureName(
      sourceProcedure.procedureIdentifier
        ?? sourceProcedure.name
        ?? procedure.procedureName
        ?? '',
    );
    // ARINC 424 transition qualifiers are five characters; retain the full
    // printed name in ProcedureUnderstanding, but use its canonical qualifier here.
    const transitionName = normalizedText(procedure.transitionName ?? '').slice(0, 5) || undefined;
    const runway = transitionName
      ? ''
      : normalizeRunway(procedure.runway ?? procedureUnderstanding.runway ?? '');
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
        || (isSidInitialNoFixCa({ isSid, fix, pathTerminator, sequenceValue, firstSequence }) ? sidInitialNavaid : undefined)
        || (pathTerminator === 'AF' || pathTerminator === 'IF' ? arcCenter : undefined);
      const courseDegMag = optionalCourse(record.courseDegMag ?? record.courseDeg);
      const holdingAtFix = Boolean(record.holdingAtFix) || holdingFixes.has(fix);
      // 过渡高度（424 第 95-99 列）是机场级信息，不映射进腿段第二高度
      const altitudeUpperFt = altitude.upper;

      return {
        procedureName,
        runway,
        transitionName,
        routeKey: '',
        sequence: normalizeSequence(record.sequence),
        fix,
        pathTerminator,
        turnDirection: cleanTurnDirection(record.turnDirection, pathTerminator, isRnavStar),
        distanceNm: optionalDistance(record.distanceNm),
        altitudeRaw: altitude.raw,
        altitudeValue: altitude.value,
        altitudeSign: altitude.sign,
        altitudeUpperFt,
        courseDegMag,
        speedLimitKias: nonZeroNumberOrUndefined(record.speedLimitKias ?? record.speedLimit),
        holdingAtFix,
        endOfProcedure: Number.isFinite(sequenceValue) && sequenceValue === lastSequence,
        fixSection: inferredFixSection({ isSid, fix, sequenceValue, firstSequence, lastSequence }),
        recommendedNavaid: recommendedNavaid || undefined,
        source: 'AI' as const,
        rawRecord: JSON.stringify(record),
      };
    });
  }).filter((leg) => leg.procedureName && leg.sequence && (leg.fix || allowsBlankFix(leg.pathTerminator)));
}

function normalizeSequence(value: unknown) {
  const numberValue = Number(value);
  if (Number.isFinite(numberValue)) return String(numberValue).padStart(3, '0');
  const text = normalizedText(value);
  const match = text.match(/\d+/);
  return match ? match[0].padStart(3, '0') : '';
}

function normalizeRunway(value: unknown) {
  const text = normalizedText(value).replace(/\s+/g, '').replace(/RWY/g, 'RW');
  if (!text) return '';
  const normalized = text.startsWith('RW') ? text : `RW${text}`;
  const members = normalized.split('/').map((member) => member.replace(/^RW/, ''));
  const runwayNumbers = [...new Set(members.map((member) => member.match(/^\d{2}/)?.[0]).filter(Boolean))];
  if (members.length > 1 && runwayNumbers.length === 1) return `RW${runwayNumbers[0]}B`;
  return normalized;
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

function cleanTurnDirection(value: unknown, pathTerminator: string, isRnavStar: boolean): 'L' | 'R' | '' {
  const turn = normalizeTurn(value);
  if (isRnavStar && pathTerminator === 'TF') return '';
  return turn;
}

interface FixSectionInput {
  isSid: boolean;
  fix: string;
  sequenceValue: number;
  firstSequence?: number;
  lastSequence?: number;
}

function inferredFixSection(input: FixSectionInput): string {
  const { isSid, fix, sequenceValue, firstSequence, lastSequence } = input;
  if (!Number.isFinite(sequenceValue)) return '';

  if (isSid) {
    if (!fix) return '';
    return sequenceValue === lastSequence ? 'EA' : 'PC';
  }

  return sequenceValue === firstSequence ? 'EA' : 'PC';
}

function isSidInitialNoFixCa(input: Pick<FixSectionInput, 'isSid' | 'fix' | 'sequenceValue' | 'firstSequence'> & { pathTerminator: string }) {
  return input.isSid
    && !input.fix
    && input.pathTerminator === 'CA'
    && Number.isFinite(input.sequenceValue)
    && input.sequenceValue === input.firstSequence;
}

function sidInitialRecommendedNavaid(understanding: ProcedureUnderstandingResult) {
  const explicit = [...candidateTexts(understanding)]
    .map((text) => text.toUpperCase())
    .find((text) => /\bVJB\b/.test(text) && /\b(?:VOR|DME|VOR\/DME|MSA|NAVAID)\b/.test(text));
  if (explicit) return 'VJB';

  const navaid = firstIdent(understanding.navaids)
    ?? firstIdent(understanding.supportObjects?.filter((item) => normalizedText(item.type) === 'NAVAID'));
  return navaid;
}

function firstIdent(items: unknown) {
  if (!Array.isArray(items)) return undefined;
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const ident = normalizedText((item as Record<string, unknown>).ident ?? (item as Record<string, unknown>).identifier);
    if (/^[A-Z0-9]{2,5}$/.test(ident)) return ident;
  }
  return undefined;
}

function candidateTexts(value: unknown): string[] {
  const texts: string[] = [];
  collectTexts(value, texts, 0);
  return texts;
}

function collectTexts(value: unknown, texts: string[], depth: number) {
  if (depth > 5 || texts.length > 1000) return;
  if (typeof value === 'string') {
    if (/[A-Z0-9]/i.test(value)) texts.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectTexts(item, texts, depth + 1);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (/rawResponse|parsedJson|geojson/i.test(key)) continue;
    collectTexts(child, texts, depth + 1);
  }
}

function allowsBlankFix(pathTerminator: unknown) {
  return ['CA', 'CI', 'CR', 'VA', 'VI'].includes(normalizedText(pathTerminator));
}

function numberOrUndefined(value: unknown) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : undefined;
}

function optionalDistance(value: unknown) {
  const numberValue = numberOrUndefined(value);
  if (numberValue === undefined || numberValue === 0) return undefined;
  return numberValue;
}

function optionalCourse(value: unknown) {
  const numberValue = numberOrUndefined(value);
  if (numberValue === undefined || numberValue === 0) return undefined;
  return numberValue;
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
  const upperFt = nonZeroNumberOrUndefined(record.upperFt);
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
  // rawText 里跟在主高度后的第二个数字（如 "+01000 11000"）是机场过渡高度，
  // 不是腿段第二高度——真正的 B 型双高度经 upperFt 字段传入。
  return {
    raw: `${match[1] || ''}${match[2]}`,
    value: Number(match[2]),
    sign: (match[1] as '+' | '-' | '') || '',
  };
}

function nonZeroNumberOrUndefined(value: unknown) {
  const numberValue = numberOrUndefined(value);
  if (numberValue === undefined || numberValue === 0) return undefined;
  return numberValue;
}
