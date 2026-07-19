import { callModel } from './modelGateway';
import { compile424Candidate, fieldLevelRoundTrip, type Candidate424 } from './compiler';
import { geodesicInverse } from './coordinate';
import { simpleLegsTo424Text } from '../../../server/src/services/jeppesen424/simpleLegsTo424Text';
import type { SimpleProcedureLeg } from '../../../server/src/services/jeppesen424/types';
import { parseJeppesen424Text } from '../../../server/src/services/jeppesen424/jeppesen424TextParser';
import type { AgentTask, PirFix, ProcedurePIR } from './domain';

/**
 * AI 直接产出 424 文本与地图几何，确定性代码只做核对、不改写它的输出。
 *
 * 核对方式是"往返"：把 AI 写出的 424 文本用仓库现成的解析器读回来，逐字段与 PIR 比对；
 * 把 AI 给的坐标串用测地反算回来，与 PIR 声明的航向/距离比对。对不上只如实标出差异，
 * 不拒出、不修改——产物照样保存，让偏差可见比让它消失有用。
 */

const COURSE_TOLERANCE_DEG = 20;      // 磁差 + 图注真/磁航向差异，超此才算异常
const DISTANCE_TOLERANCE_RATIO = 0.1; // 10%，与既有 DIST_BACKCHECK 的告警档一致

export interface GenerationDiff {
  kind: 'ARINC424' | 'GEOMETRY';
  code: string;
  detail: string;
}

export interface Generated424 extends Candidate424 {
  generatedBy: 'AI';
  decisionSummary: string;
  diffs: GenerationDiff[];
}

export async function generate424WithAi(
  task: AgentTask,
  pir: ProcedurePIR,
  signal: AbortSignal,
  options: { procedureId?: string; encodingContext?: unknown } = {},
): Promise<Generated424> {
  const { parsed } = await callModel(
    task,
    'arinc424-writer',
    { airport: pir.airport, pir, encodingContext: options.encodingContext ?? {} },
    [],
    `ARINC424_GENERATION:${pir.procedure.identifier || pir.procedure.name}`,
    signal,
    { planAction: 'BUILD_ARINC_424_CANDIDATE', procedureId: options.procedureId },
  );

  const missingFields: string[] = Array.isArray(parsed.missingFields) ? parsed.missingFields.map(String) : [];
  const decided = Array.isArray(parsed.legs) ? parsed.legs : [];
  if (!decided.length) {
    return { status: '424_INCOMPLETE', text: '', missingFields: missingFields.length ? missingFields : ['The model decided no legs.'], generatedBy: 'AI', decisionSummary: String(parsed.decisionSummary || ''), diffs: [{ kind: 'ARINC424', code: 'NO_LEGS_DECIDED', detail: 'The model returned no leg encodings.' }] };
  }

  // AI 定字段值，渲染器落列。三轮实测表明模型能定对编码、但对不齐 132 列定宽记录，
  // 而列算术恰恰是确定性代码的强项——分工按"决策 vs 排版"切，而不是按"AI vs 代码"切。
  const legs = decided.map((leg: Record<string, unknown>) => toSimpleLeg(leg, pir));
  let text = '';
  const diffs: GenerationDiff[] = [];
  try {
    text = simpleLegsTo424Text(legs, { airportIcao: pir.airport.icao });
  } catch (error) {
    // 渲染器抛错说明 AI 的取值违反了记录约束（负高度、跑道号非法、数值超列宽等），
    // 这正是它该报出来的事，不要吞掉。
    return { status: '424_INCOMPLETE', text: '', missingFields, generatedBy: 'AI', decisionSummary: String(parsed.decisionSummary || ''), diffs: [{ kind: 'ARINC424', code: 'RENDER_REJECTED', detail: error instanceof Error ? error.message : String(error) }] };
  }
  diffs.push(...verify424Text(text, pir));
  return {
    status: generation424Status(text, missingFields, diffs),
    text,
    missingFields,
    generatedBy: 'AI',
    decisionSummary: String(parsed.decisionSummary || ''),
    diffs,
    profile: parsed.encodingProfile ? JSON.stringify(parsed.encodingProfile) : undefined,
    roundTrip: roundTripSummary(text, pir),
  };
}

/** 把模型的编码决策映射成渲染器的输入。只做取值搬运，不替它做判断。 */
function toSimpleLeg(decided: Record<string, unknown>, pir: ProcedurePIR): SimpleProcedureLeg {
  const text = (key: string) => (typeof decided[key] === 'string' && decided[key] ? String(decided[key]) : undefined);
  const num = (key: string) => (typeof decided[key] === 'number' && Number.isFinite(decided[key]) ? Number(decided[key]) : undefined);
  const procedureName = text('procedureName') || pir.procedure.name;
  const procedureCode = text('procedureCode');
  return {
    procedureName,
    procedureCode,
    routeKey: procedureCode || procedureName,
    category: (text('category') as SimpleProcedureLeg['category']) ?? pir.procedure.category,
    runway: text('runway') || '',
    transitionName: text('transitionName'),
    branchRole: text('branchRole') as SimpleProcedureLeg['branchRole'],
    routeTypeChar: text('routeTypeChar'),
    sequence: text('sequence') || '010',
    fix: text('fix') || '',
    fixSection: text('fixSection'),
    pathTerminator: text('pathTerminator'),
    turnDirection: text('turnDirection') as SimpleProcedureLeg['turnDirection'],
    courseDegMag: num('courseDegMag'),
    distanceNm: num('distanceNm'),
    altitudeSign: text('altitudeSign') as SimpleProcedureLeg['altitudeSign'],
    altitudeValue: num('altitudeValue'),
    altitudeUpperFt: num('altitudeUpperFt'),
    speedLimitKias: num('speedLimitKias'),
    recommendedNavaid: text('recommendedNavaid'),
    holdingAtFix: decided.holdingAtFix === true,
    endOfProcedure: decided.endOfProcedure === true,
    source: 'AI',
  };
}

function generation424Status(text: string, missingFields: string[], diffs: GenerationDiff[]): Candidate424['status'] {
  if (!text.trim()) return '424_INCOMPLETE';
  if (missingFields.length) return '424_INCOMPLETE';
  return diffs.length ? '424_DERIVED' : '424_CANDIDATE';
}

/**
 * 把 AI 写的 424 文本解析回来，与确定性编译器基于同一 PIR 得到的腿逐字段比对。
 * 编译器在这里不再是生成者，而是唯一一个独立于模型的参照物——没有它，
 * 第 5 点就变成 AI 校验 AI，同源错误会一起漏过去。
 */
export function verify424Text(text: string, pir: ProcedurePIR): GenerationDiff[] {
  const diffs: GenerationDiff[] = [];
  if (!text.trim()) return [{ kind: 'ARINC424', code: 'EMPTY_OUTPUT', detail: 'The model returned no 424 records.' }];

  let reparsed;
  try {
    reparsed = parseJeppesen424Text(text);
  } catch (error) {
    return [{ kind: 'ARINC424', code: 'UNPARSEABLE', detail: `Emitted 424 text could not be parsed back: ${error instanceof Error ? error.message : String(error)}` }];
  }
  if (!reparsed.length) return [{ kind: 'ARINC424', code: 'NO_RECORDS_PARSED', detail: 'Emitted text parsed to zero records — column alignment is likely wrong.' }];

  diffs.push(...compareLegCoverage(reparsed, pir));

  const reference = compile424Candidate(pir);
  if (reference.status === '424_INCOMPLETE' || !reference.text.trim()) return diffs;
  const referenceLegs = parseJeppesen424Text(reference.text);
  for (const mismatch of fieldLevelRoundTrip(referenceLegs, reparsed)) {
    diffs.push({ kind: 'ARINC424', code: `FIELD_${mismatch.field.toUpperCase()}`, detail: `${mismatch.key}: reference ${JSON.stringify(mismatch.emitted)} vs emitted ${JSON.stringify(mismatch.reparsed)}.` });
  }
  return diffs;
}

/**
 * 按覆盖度比对，不比记录总数。
 *
 * 424 要求每条路线自带完整记录集，公共段会在各路线代码下重复出现——WMKJ 的四条 1J SID
 * 共用起始段，12 条记录对 9 条 PIR 腿是**正确编码**，早先按总数比会把它误报成差异。
 * 真正该问的是两件事：PIR 里的腿有没有都被编出来，编出来的记录有没有 PIR 里不存在的点。
 */
function compareLegCoverage(reparsed: SimpleProcedureLeg[], pir: ProcedurePIR): GenerationDiff[] {
  const diffs: GenerationDiff[] = [];
  const upper = (value?: string | null) => String(value ?? '').trim().toUpperCase();
  const emittedByFixAndPt = new Set(reparsed.map((leg) => `${upper(leg.fix)}|${upper(leg.pathTerminator)}`));
  const emittedPathTerminators = new Set(reparsed.map((leg) => upper(leg.pathTerminator)));
  const fixNameById = new Map(pir.fixes.map((fix) => [fix.fixId, upper(fix.identifier)]));

  for (const leg of pir.legs) {
    const pathTerminator = upper(leg.pathTerminator);
    const fixName = leg.toFixId ? fixNameById.get(leg.toFixId) : undefined;
    if (fixName) {
      if (!emittedByFixAndPt.has(`${fixName}|${pathTerminator}`)) {
        diffs.push({ kind: 'ARINC424', code: 'LEG_NOT_ENCODED', detail: `PIR leg ${leg.legId} (${pathTerminator} to ${fixName}) has no matching 424 record.` });
      }
    } else if (!emittedPathTerminators.has(pathTerminator)) {
      // 开放腿（CA/VA 等）没有终点 fix，只能核对该路径终止符是否出现过。
      diffs.push({ kind: 'ARINC424', code: 'LEG_NOT_ENCODED', detail: `PIR leg ${leg.legId} (open-ended ${pathTerminator}) has no matching 424 record.` });
    }
  }

  const knownFixes = new Set(fixNameById.values());
  const reported = new Set<string>();
  for (const record of reparsed) {
    const fix = upper(record.fix);
    if (!fix || knownFixes.has(fix) || reported.has(fix)) continue;
    reported.add(fix);
    diffs.push({ kind: 'ARINC424', code: 'RECORD_FIX_NOT_IN_PIR', detail: `Emitted a record terminating at ${fix}, which is not a fix in the PIR.` });
  }
  return diffs;
}

function roundTripSummary(text: string, pir: ProcedurePIR): Candidate424['roundTrip'] {
  try {
    const reparsed = parseJeppesen424Text(text);
    return { emittedLegs: pir.legs.length, parsedLegs: reparsed.length, matched: reparsed.length === pir.legs.length, fieldMismatches: [] };
  } catch {
    return { emittedLegs: pir.legs.length, parsedLegs: 0, matched: false, fieldMismatches: [] };
  }
}

export interface GeneratedGeometry {
  featureCollection: unknown;
  unresolvedLegs: Array<{ legId: string; reason: string }>;
  decisionSummary: string;
  generatedBy: 'AI';
  diffs: GenerationDiff[];
}

export async function generateGeometryWithAi(
  task: AgentTask,
  pir: ProcedurePIR,
  signal: AbortSignal,
  options: { procedureId?: string; referenceData?: unknown } = {},
): Promise<GeneratedGeometry> {
  const { parsed } = await callModel(
    task,
    'geometry-writer',
    { airport: pir.airport, pir, referenceData: options.referenceData ?? {} },
    [],
    `GEOMETRY_GENERATION:${pir.procedure.identifier || pir.procedure.name}`,
    signal,
    { planAction: 'BUILD_GEOJSON', procedureId: options.procedureId },
  );

  const featureCollection = parsed.featureCollection ?? { type: 'FeatureCollection', features: [] };
  const unresolvedLegs = Array.isArray(parsed.unresolvedLegs) ? parsed.unresolvedLegs : [];
  return {
    featureCollection,
    unresolvedLegs,
    decisionSummary: String(parsed.decisionSummary || ''),
    generatedBy: 'AI',
    diffs: verifyGeometry(featureCollection, pir),
  };
}

/**
 * 用测地反算核对 AI 给的坐标串：每条腿的首尾点算出来的航向/距离，应与 PIR 声明的一致。
 * 同时核对顶点是否锚定在 PIR 的 fix 上——模型凭记忆摆点时，这一项会立刻暴露。
 */
export function verifyGeometry(featureCollection: unknown, pir: ProcedurePIR): GenerationDiff[] {
  const diffs: GenerationDiff[] = [];
  const features = (featureCollection as { features?: unknown[] })?.features;
  if (!Array.isArray(features)) return [{ kind: 'GEOMETRY', code: 'NO_FEATURE_COLLECTION', detail: 'The model returned no usable FeatureCollection.' }];

  const legFeatures = features.filter((feature) => (feature as any)?.properties?.featureType === 'LEG');
  const anchorable = pir.legs.filter((leg) => hasCoordinates(findFix(pir, leg.fromFixId)) && hasCoordinates(findFix(pir, leg.toFixId)));
  const covered = new Set(legFeatures.map((feature) => (feature as any)?.properties?.legId).filter(Boolean));
  for (const leg of anchorable) {
    if (!covered.has(leg.legId)) diffs.push({ kind: 'GEOMETRY', code: 'LEG_NOT_DRAWN', detail: `Leg ${leg.legId} has resolved endpoints but no geometry was emitted for it.` });
  }

  for (const feature of legFeatures) {
    const properties = (feature as any).properties || {};
    const leg = pir.legs.find((item) => item.legId === properties.legId);
    if (!leg) continue;
    const coordinates = flattenLineCoordinates((feature as any).geometry);
    if (coordinates.length < 2) { diffs.push({ kind: 'GEOMETRY', code: 'DEGENERATE_LINE', detail: `Leg ${leg.legId} geometry has fewer than two vertices.` }); continue; }

    const from = findFix(pir, leg.fromFixId);
    const to = findFix(pir, leg.toFixId);
    if (hasCoordinates(from)) assertVertexOnFix(diffs, leg.legId, 'start', coordinates[0], from!);
    if (hasCoordinates(to) && !properties.openEnded) assertVertexOnFix(diffs, leg.legId, 'end', coordinates[coordinates.length - 1], to!);
    // 端点 fix 没有坐标却把这条腿画了出来，说明锚点是模型自己造的——
    // 顶点核对在这种情况下无从比对（没有真值），必须单独拦一道，否则编造的锚点会静默通过。
    // 实测：WMKJ 的 RWY16 无坐标，模型"derived approximate DER location"后照画不误，核对却报 0 差异。
    for (const [end, fix] of [['start', from], ['end', to]] as const) {
      // 这里不能用 hasCoordinates 取反：它是类型谓词 `fix is PirFix`，否定分支会被收窄成
      // never，而"没有坐标的 fix"依然是个 PirFix。直接判坐标本身。
      if (fix && !(Number.isFinite(fix.latitude) && Number.isFinite(fix.longitude))) {
        diffs.push({ kind: 'GEOMETRY', code: 'ANCHORED_ON_UNRESOLVED_FIX', detail: `Leg ${leg.legId} was drawn although its ${end} fix ${fix.identifier} has no resolved coordinates — the anchor was invented, not sourced.` });
      }
    }

    // 直线腿才反算航向/距离：RF/AF/等待的首尾连线本就不等于其航迹。
    if (['TF', 'CF', 'DF', 'IF'].includes(leg.pathTerminator) && !properties.openEnded) {
      const inverse = geodesicInverse(coordinates[0], coordinates[coordinates.length - 1]);
      if (leg.course != null) {
        const delta = angleDiff(inverse.initialBearing, leg.course);
        if (delta > COURSE_TOLERANCE_DEG) diffs.push({ kind: 'GEOMETRY', code: 'COURSE_MISMATCH', detail: `Leg ${leg.legId}: drawn bearing ${inverse.initialBearing.toFixed(1)}° vs PIR course ${leg.course}° (${delta.toFixed(1)}° apart).` });
      }
      if (leg.distanceNm != null) {
        const delta = Math.abs(inverse.distanceNm - leg.distanceNm);
        if (delta > Math.max(0.5, leg.distanceNm * DISTANCE_TOLERANCE_RATIO)) diffs.push({ kind: 'GEOMETRY', code: 'DISTANCE_MISMATCH', detail: `Leg ${leg.legId}: drawn ${inverse.distanceNm.toFixed(2)}NM vs PIR ${leg.distanceNm}NM.` });
      }
    }
  }
  return diffs;
}

function assertVertexOnFix(diffs: GenerationDiff[], legId: string, end: 'start' | 'end', vertex: [number, number], fix: PirFix) {
  const offsetNm = geodesicInverse(vertex, [fix.longitude as number, fix.latitude as number]).distanceNm;
  if (offsetNm > 0.1) diffs.push({ kind: 'GEOMETRY', code: 'VERTEX_OFF_FIX', detail: `Leg ${legId} ${end} vertex sits ${offsetNm.toFixed(2)}NM from fix ${fix.identifier}; geometry must be anchored on PIR coordinates.` });
}

function flattenLineCoordinates(geometry: unknown): Array<[number, number]> {
  const value = geometry as { type?: string; coordinates?: unknown };
  if (value?.type === 'LineString' && Array.isArray(value.coordinates)) return value.coordinates as Array<[number, number]>;
  if (value?.type === 'MultiLineString' && Array.isArray(value.coordinates)) return (value.coordinates as Array<Array<[number, number]>>).flat();
  return [];
}

function findFix(pir: ProcedurePIR, fixId?: string | null) { return fixId ? pir.fixes.find((fix) => fix.fixId === fixId) : undefined; }
function hasCoordinates(fix?: PirFix): fix is PirFix { return !!fix && Number.isFinite(fix.latitude) && Number.isFinite(fix.longitude); }
function angleDiff(a: number, b: number) { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; }
