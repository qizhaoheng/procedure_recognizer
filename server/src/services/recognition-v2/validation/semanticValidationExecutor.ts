import crypto from 'node:crypto';
import {
  RECOGNITION_V2_CONTRACT_VERSION,
  RECOGNITION_V2_SCHEMA_IDS,
  type CanonicalEntity,
  type FusionStageResult,
  type ValidationIssue,
  type ValidationSeverity,
  type ValidationStageResult,
} from '../contracts/index';
import { assertValidValidationStageResult } from '../contracts/schemaValidation';
import type { StageAuditArtifact } from '../layout/pageLayoutExecutor';

export const SEMANTIC_RULESET_VERSION = '2.1.0';
export const GEOMETRY_CROSSCHECK_VERSION = '2.0.0';
export const TOPOLOGY_CROSSCHECK_VERSION = '1.1.0';

const KNOWN_PATH_TERMINATORS = new Set([
  'AF', 'CA', 'CD', 'CF', 'CI', 'CR', 'DF', 'FA', 'FC', 'FD', 'FM', 'HA', 'HF', 'HM',
  'IF', 'PI', 'RF', 'TF', 'VA', 'VD', 'VI', 'VM', 'VR',
]);
const ENDPOINT_OPTIONAL = new Set(['CA', 'CI', 'FA', 'FM', 'VA', 'VI', 'VM']);

export interface SemanticValidationExecutionResult {
  output: ValidationStageResult;
  auditArtifacts: StageAuditArtifact[];
}

export async function executeSemanticValidation(input: { fusion: FusionStageResult; now?: string }): Promise<SemanticValidationExecutionResult> {
  const issues: ValidationIssue[] = [];
  const add = (ruleId: string, severity: ValidationSeverity, entityKeys: string[], fieldNames: string[], candidateIds: string[], message: string) => {
    issues.push({
      issueId: stableId('issue', [ruleId, entityKeys, fieldNames, candidateIds, message]),
      ruleId,
      ruleVersion: ruleId.startsWith('GEOMETRY_')
        ? GEOMETRY_CROSSCHECK_VERSION
        : ruleId.startsWith('TOPOLOGY_')
          ? TOPOLOGY_CROSSCHECK_VERSION
          : SEMANTIC_RULESET_VERSION,
      severity,
      status: 'OPEN',
      entityKeys: [...new Set(entityKeys)],
      fieldNames: [...new Set(fieldNames)],
      candidateIds: [...new Set(candidateIds)],
      message,
    });
  };

  for (const conflict of input.fusion.conflicts.filter((item) => item.resolution === 'OPEN')) {
    add('OPEN_EVIDENCE_CONFLICT', conflict.severity, [conflict.entityKey], [conflict.fieldName], conflict.candidateIds, `字段 ${conflict.fieldName} 存在未裁决的来源冲突。`);
  }
  for (const unresolved of input.fusion.unresolvedItems.filter((item) => item.reasonCode !== 'CONFLICTING_VALUES')) {
    add('UNRESOLVED_FUSION_ITEM', unresolved.blockingFor424 ? 'BLOCKING' : 'WARNING', [unresolved.entityKey], [unresolved.fieldName], unresolved.candidateIds, `字段 ${unresolved.fieldName} 尚未满足证据要求（${unresolved.reasonCode}）。`);
  }

  const airport = input.fusion.entities.find((item) => item.entityType === 'AIRPORT');
  const procedure = input.fusion.entities.find((item) => item.entityType === 'PROCEDURE');
  requireField(airport, 'airportIcao', 'REQUIRED_AIRPORT_ICAO', add);
  requireField(procedure, 'procedureName', 'REQUIRED_PROCEDURE_NAME', add);
  requireField(procedure, 'procedureCategory', 'REQUIRED_PROCEDURE_CATEGORY', add);
  requireField(procedure, 'packageType', 'REQUIRED_PACKAGE_TYPE', add);
  if (!procedure || !values(procedure.fields.navigationType).length) {
    add('NAVIGATION_TYPE_REVIEW', 'WARNING', [procedure?.entityKey ?? 'PACKAGE:UNKNOWN'], ['navigationType'], [], '缺少导航类型；在发布 424 前需要确认。');
  }
  const airportIcao = scalar(airport?.fields.airportIcao);
  if (airport && airportIcao !== undefined && !/^[A-Z]{4}$/.test(String(airportIcao))) {
    add('AIRPORT_ICAO_SYNTAX', 'BLOCKING', [airport!.entityKey], ['airportIcao'], candidateIds(airport, 'airportIcao'), `机场 ICAO “${airportIcao}” 不是 4 位大写字母。`);
  }
  for (const runway of input.fusion.entities.filter((item) => item.entityType === 'RUNWAY').flatMap((item) => values(item.fields.runway).map((value) => [item, value] as const))) {
    if (!/^(?:RW)?(?:0[1-9]|[12][0-9]|3[0-6])[LCR]?(?:\/(?:RW)?(?:0[1-9]|[12][0-9]|3[0-6])[LCR]?)*$/.test(String(runway[1]).toUpperCase())) {
      add('RUNWAY_SYNTAX', 'BLOCKING', [runway[0].entityKey], ['runway'], candidateIds(runway[0], 'runway'), `跑道标识“${runway[1]}”不符合 01–36 可带 L/C/R 的格式。`);
    }
  }

  const coordinateEntities = input.fusion.entities.filter((item) => item.entityType === 'FIX' || item.entityType === 'NAVAID');
  const coordinateByIdent = new Map<string, { entity: CanonicalEntity; latitude: number; longitude: number }>();
  for (const entity of coordinateEntities) {
    const latitude = number(entity.fields.latitude);
    const longitude = number(entity.fields.longitude);
    if ((latitude === undefined) !== (longitude === undefined)) {
      add('COORDINATE_PAIR_REQUIRED', 'BLOCKING', [entity.entityKey], ['latitude', 'longitude'], [...candidateIds(entity, 'latitude'), ...candidateIds(entity, 'longitude')], '纬度和经度必须成对出现。');
    }
    if (latitude !== undefined && (latitude < -90 || latitude > 90)) {
      add('LATITUDE_RANGE', 'BLOCKING', [entity.entityKey], ['latitude'], candidateIds(entity, 'latitude'), `纬度 ${latitude} 超出 -90 到 90。`);
    }
    if (longitude !== undefined && (longitude < -180 || longitude > 180)) {
      add('LONGITUDE_RANGE', 'BLOCKING', [entity.entityKey], ['longitude'], candidateIds(entity, 'longitude'), `经度 ${longitude} 超出 -180 到 180。`);
    }
    const identifier = scalar(entity.fields.identifier);
    if (identifier && latitude !== undefined && longitude !== undefined && latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180) {
      coordinateByIdent.set(String(identifier).toUpperCase(), { entity, latitude, longitude });
    }
  }

  const legs = input.fusion.entities.filter((item) => item.entityType === 'LEG').sort(legOrder);
  if (!legs.length) add('PROCEDURE_LEGS_REQUIRED', 'BLOCKING', [procedure?.entityKey ?? `PROCEDURE:UNKNOWN`], ['legs'], [], '没有可用于 424 的程序航段。');
  const procedureNames = values(procedure?.fields.procedureName);
  if (procedureNames.length > 1) {
    for (const leg of legs.filter((item) => !values(item.fields.procedureName).length)) {
      add('LEG_PROCEDURE_ASSOCIATION_REQUIRED', 'BLOCKING', [leg.entityKey, procedure!.entityKey], ['procedureName'], candidateIds(leg, 'procedureName'), '程序包含多个程序名，航段必须明确归属程序。');
    }
  }
  const seenSequence = new Map<string, CanonicalEntity>();
  const knownIdentifiers = new Set(coordinateEntities.flatMap((entity) => values(entity.fields.identifier).map((value) => String(value).toUpperCase())));
  const knownNavaids = new Set(input.fusion.entities.filter((item) => item.entityType === 'NAVAID').flatMap((entity) => values(entity.fields.identifier).map((value) => String(value).toUpperCase())));
  for (const leg of legs) {
    const sequence = number(leg.fields.sequence);
    if (sequence === undefined) add('LEG_SEQUENCE_REQUIRED', 'BLOCKING', [leg.entityKey], ['sequence'], candidateIds(leg, 'sequence'), '航段缺少确定的序号。');
    else {
      const sequenceKey = `${legValidationScope(leg)}\u0000${sequence}`;
      if (seenSequence.has(sequenceKey)) add('LEG_SEQUENCE_UNIQUE', 'BLOCKING', [seenSequence.get(sequenceKey)!.entityKey, leg.entityKey], ['sequence'], [...candidateIds(seenSequence.get(sequenceKey)!, 'sequence'), ...candidateIds(leg, 'sequence')], `航段序号 ${sequence} 重复。`);
      else seenSequence.set(sequenceKey, leg);
    }
    const pathTerminator = scalar(leg.fields.pathTerminator)?.toString().toUpperCase();
    if (!pathTerminator) add('PATH_TERMINATOR_REQUIRED', 'BLOCKING', [leg.entityKey], ['pathTerminator'], candidateIds(leg, 'pathTerminator'), '航段缺少 Path Terminator。');
    else if (!KNOWN_PATH_TERMINATORS.has(pathTerminator)) add('PATH_TERMINATOR_KNOWN', 'BLOCKING', [leg.entityKey], ['pathTerminator'], candidateIds(leg, 'pathTerminator'), `未知 Path Terminator：${pathTerminator}。`);
    const toFix = scalar(leg.fields.toFix)?.toString().toUpperCase();
    if (pathTerminator && !ENDPOINT_OPTIONAL.has(pathTerminator) && !toFix) add('LEG_ENDPOINT_REQUIRED', 'BLOCKING', [leg.entityKey], ['toFix'], candidateIds(leg, 'toFix'), `${pathTerminator} 航段必须有终点定位点。`);
    if (toFix && !knownIdentifiers.has(toFix)) add('LEG_FIX_REFERENCE', 'BLOCKING', [leg.entityKey], ['toFix'], candidateIds(leg, 'toFix'), `航段引用的定位点 ${toFix} 不在已识别 FIX/NAVAID 中。`);
    if (toFix && knownIdentifiers.has(toFix) && !coordinateByIdent.has(toFix)) add('LEG_FIX_COORDINATE_REQUIRED', 'BLOCKING', [leg.entityKey], ['toFix', 'latitude', 'longitude'], candidateIds(leg, 'toFix'), `航段引用的定位点 ${toFix} 缺少有效坐标。`);
    const recommended = scalar(leg.fields.recommendedNavaid)?.toString().toUpperCase();
    if (recommended && !knownNavaids.has(recommended)) add('LEG_NAVAID_REFERENCE', 'BLOCKING', [leg.entityKey], ['recommendedNavaid'], candidateIds(leg, 'recommendedNavaid'), `推荐导航台 ${recommended} 不在已识别 NAVAID 中。`);
    const course = number(leg.fields.courseDegMag);
    if (course !== undefined && (course < 0 || course >= 360)) add('COURSE_RANGE', 'BLOCKING', [leg.entityKey], ['courseDegMag'], candidateIds(leg, 'courseDegMag'), `航向 ${course} 超出 [0, 360)。`);
    const distance = number(leg.fields.distanceNm);
    if (distance !== undefined && distance <= 0) add('DISTANCE_POSITIVE', 'BLOCKING', [leg.entityKey], ['distanceNm'], candidateIds(leg, 'distanceNm'), `距离 ${distance} NM 必须大于 0。`);
    const speed = number(leg.fields.speedLimitKias);
    if (speed !== undefined && (speed <= 0 || speed > 999)) add('SPEED_RANGE', 'BLOCKING', [leg.entityKey], ['speedLimitKias'], candidateIds(leg, 'speedLimitKias'), `速度限制 ${speed} KIAS 超出有效范围。`);
    const turn = scalar(leg.fields.turnDirection)?.toString().toUpperCase();
    if (turn && turn !== 'L' && turn !== 'R') add('TURN_DIRECTION_SYNTAX', 'BLOCKING', [leg.entityKey], ['turnDirection'], candidateIds(leg, 'turnDirection'), `转弯方向 ${turn} 不是 L 或 R。`);
    validateAltitudeWindow(leg, add);
    if (pathTerminator === 'RF') {
      for (const fieldName of ['centerFix', 'radiusNm', 'turnDirection']) {
        if (!values(leg.fields[fieldName]).length) add('RF_GEOMETRY_REQUIRED', 'BLOCKING', [leg.entityKey], [fieldName], candidateIds(leg, fieldName), `RF 航段缺少 ${fieldName} 几何依据。`);
      }
    }
    if (pathTerminator && ['HA', 'HF', 'HM'].includes(pathTerminator)) {
      for (const fieldName of ['courseDegMag', 'turnDirection']) {
        if (!values(leg.fields[fieldName]).length) add('HOLDING_GEOMETRY_REQUIRED', 'BLOCKING', [leg.entityKey], [fieldName], candidateIds(leg, fieldName), `${pathTerminator} 等待航段缺少 ${fieldName}。`);
      }
    }
  }
  geometryCrossChecks(legs, coordinateByIdent, add);
  topologyCrossChecks(legs, input.fusion.entities.filter((item) => item.entityType === 'TOPOLOGY'), add);

  const uniqueIssues = [...new Map(issues.map((item) => [item.issueId, item])).values()];
  const blockingIssueCount = uniqueIssues.filter((item) => item.severity === 'BLOCKING' && item.status === 'OPEN').length;
  const reviewIssueCount = uniqueIssues.filter((item) => item.severity === 'WARNING' && item.status === 'OPEN').length;
  const output: ValidationStageResult = {
    contractVersion: RECOGNITION_V2_CONTRACT_VERSION,
    schemaId: RECOGNITION_V2_SCHEMA_IDS.validationStageResult,
    issues: uniqueIssues,
    releaseDecision: blockingIssueCount ? 'BLOCKED' : reviewIssueCount ? 'REVIEW_REQUIRED' : 'READY',
    blockingIssueCount,
    reviewIssueCount,
    ruleVersions: {
      semantic: SEMANTIC_RULESET_VERSION,
      geometryCrosscheck: GEOMETRY_CROSSCHECK_VERSION,
      topologyCrosscheck: TOPOLOGY_CROSSCHECK_VERSION,
    },
    completedAt: input.now ?? new Date().toISOString(),
  };
  await assertValidValidationStageResult(output);
  return { output, auditArtifacts: [{ fileName: 'semantic-validation-rules.json', value: { ruleVersions: output.ruleVersions, issueCount: output.issues.length, releaseDecision: output.releaseDecision } }] };
}

function topologyCrossChecks(legs: CanonicalEntity[], topology: CanonicalEntity[], add: AddIssue) {
  if (!legs.length) return;
  const edges = topology.map((entity) => ({ entity, edge: topologyEdge(entity.fields.edge) }))
    .filter((item): item is { entity: CanonicalEntity; edge: TopologyEdge } => Boolean(item.edge));
  if (!edges.length) {
    add('TOPOLOGY_EDGES_REQUIRED', 'INFO', legs.map((leg) => leg.entityKey), ['edge'], [], '已有程序航段，但本次运行没有拓扑产物；未执行航迹连通性交叉校验。');
    return;
  }
  const edgeKeys = new Set(edges.map(({ edge }) => topologyEdgeKey(edge.from, edge.to)));
  const legsByScope = new Map<string, CanonicalEntity[]>();
  for (const leg of legs) {
    const scope = legValidationScope(leg);
    const scoped = legsByScope.get(scope) ?? [];
    scoped.push(leg);
    legsByScope.set(scope, scoped);
  }
  for (const scopedLegs of legsByScope.values()) {
    let prior: string | null = null;
    for (const leg of scopedLegs.sort(legOrder)) {
      const toFix = scalar(leg.fields.toFix)?.toString().toUpperCase();
      if (!toFix) continue;
      const explicitFrom = scalar(leg.fields.fromFix)?.toString().toUpperCase();
      const from = explicitFrom ?? prior;
      const key = topologyEdgeKey(from, toFix);
      if (!edgeKeys.has(key)) {
        add('TOPOLOGY_LEG_EDGE_MISMATCH', 'BLOCKING', [leg.entityKey], ['toFix', 'edge'], candidateIds(leg, 'toFix'), `表格航段 ${from ?? 'START'} → ${toFix} 在拓扑结果中不存在。`);
      }
      prior = toFix;
    }
  }
  const duplicateEdges = new Map<string, CanonicalEntity[]>();
  for (const { entity, edge } of edges) {
    const key = topologyEdgeKey(edge.from, edge.to);
    const values = duplicateEdges.get(key) ?? [];
    values.push(entity);
    duplicateEdges.set(key, values);
  }
  for (const [key, entities] of duplicateEdges) {
    if (entities.length > 1) add('TOPOLOGY_DUPLICATE_EDGE', 'WARNING', entities.map((item) => item.entityKey), ['edge'], entities.flatMap((item) => candidateIds(item, 'edge')), `拓扑边 ${key} 重复出现。`);
  }
  const adjacency = new Map<string, Set<string>>();
  for (const { edge } of edges) {
    if (!edge.from || edge.relation === 'HOLD' || edge.from === edge.to) continue;
    const targets = adjacency.get(edge.from) ?? new Set<string>();
    targets.add(edge.to);
    adjacency.set(edge.from, targets);
  }
  if (hasDirectedCycle(adjacency)) {
    add('TOPOLOGY_UNEXPECTED_CYCLE', 'BLOCKING', edges.map((item) => item.entity.entityKey), ['edge'], edges.flatMap((item) => candidateIds(item.entity, 'edge')), '程序航迹拓扑存在未被 Holding/Procedure Turn 语义解释的闭环。');
  }
  const chartNodes = new Set(topology.filter((entity) => scalar(entity.fields.presentOnChart) === true).map((entity) => entity.entityKey.split(':').at(-1)?.toUpperCase()).filter(Boolean));
  for (const fix of [...new Set(legs.flatMap((leg) => values(leg.fields.toFix).map((value) => String(value).toUpperCase())))]) {
    if (!chartNodes.has(fix)) add('TOPOLOGY_NODE_NOT_CONFIRMED_ON_CHART', 'WARNING', [`FIX:${fix}`], ['presentOnChart'], [], `表格定位点 ${fix} 未在程序主图文本/视觉证据中确认；保留表格值并要求复核。`);
  }
}

interface TopologyEdge {
  from: string | null;
  to: string;
  relation: string;
}

function topologyEdge(value: unknown): TopologyEdge | undefined {
  const item = scalar(value);
  if (!item || typeof item !== 'object') return undefined;
  const edge = item as Record<string, unknown>;
  const from = edge.from === null ? null : typeof edge.from === 'string' ? edge.from.toUpperCase() : undefined;
  const to = typeof edge.to === 'string' ? edge.to.toUpperCase() : undefined;
  const relation = typeof edge.relation === 'string' ? edge.relation.toUpperCase() : undefined;
  if (from === undefined || !to || !relation) return undefined;
  return { from, to, relation };
}

function topologyEdgeKey(from: string | null, to: string) {
  return `${from ?? 'START'}>${to}`;
}

function hasDirectedCycle(adjacency: Map<string, Set<string>>) {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (node: string): boolean => {
    if (visiting.has(node)) return true;
    if (visited.has(node)) return false;
    visiting.add(node);
    for (const target of adjacency.get(node) ?? []) if (visit(target)) return true;
    visiting.delete(node);
    visited.add(node);
    return false;
  };
  return [...adjacency.keys()].some(visit);
}

function geometryCrossChecks(legs: CanonicalEntity[], coordinates: Map<string, { entity: CanonicalEntity; latitude: number; longitude: number }>, add: AddIssue) {
  let priorFix: string | undefined;
  for (const leg of legs) {
    const pathTerminator = scalar(leg.fields.pathTerminator)?.toString().toUpperCase();
    const fromFix = scalar(leg.fields.fromFix)?.toString().toUpperCase() ?? priorFix;
    const toFix = scalar(leg.fields.toFix)?.toString().toUpperCase();
    if (fromFix && toFix) {
      const start = coordinates.get(fromFix);
      const end = coordinates.get(toFix);
      if (start && end) {
        const calculatedDistance = haversineNm(start.latitude, start.longitude, end.latitude, end.longitude);
        const publishedDistance = number(leg.fields.distanceNm);
        if (publishedDistance !== undefined && Math.abs(publishedDistance - calculatedDistance) > Math.max(2, publishedDistance * 0.3)) {
          add('GEOMETRY_DISTANCE_MISMATCH', 'WARNING', [leg.entityKey, start.entity.entityKey, end.entity.entityKey], ['distanceNm', 'latitude', 'longitude'], candidateIds(leg, 'distanceNm'), `发布距离 ${publishedDistance} NM 与坐标估算 ${calculatedDistance.toFixed(1)} NM 差异较大；保留发布值，不自动改写。`);
        }
        const publishedCourse = number(leg.fields.courseDegMag);
        const calculatedCourse = initialBearing(start.latitude, start.longitude, end.latitude, end.longitude);
        // A TF track is defined by the two fixes, so coordinate bearing is a
        // meaningful independent check. CF is an inbound course-to-fix and may
        // be intercepted or referenced to a navaid; the previous-fix bearing is
        // not equivalent and must not create a false review blocker.
        if (pathTerminator === 'TF' && publishedCourse !== undefined && angularDifference(publishedCourse, calculatedCourse) > 20) {
          add('GEOMETRY_COURSE_MISMATCH', 'WARNING', [leg.entityKey, start.entity.entityKey, end.entity.entityKey], ['courseDegMag', 'latitude', 'longitude'], candidateIds(leg, 'courseDegMag'), `发布磁航向 ${publishedCourse}° 与坐标真方位估算 ${calculatedCourse.toFixed(0)}° 差异较大；仅提示，不自动改写。`);
        }
      }
    }
    if (toFix) priorFix = toFix;
  }
}

type AddIssue = (ruleId: string, severity: ValidationSeverity, entityKeys: string[], fieldNames: string[], candidateIds: string[], message: string) => void;

function requireField(entity: CanonicalEntity | undefined, fieldName: string, ruleId: string, add: AddIssue) {
  if (!entity || !values(entity.fields[fieldName]).length) add(ruleId, 'BLOCKING', [entity?.entityKey ?? 'PACKAGE:UNKNOWN'], [fieldName], entity ? candidateIds(entity, fieldName) : [], `缺少 424 所需字段 ${fieldName}。`);
}

function validateAltitudeWindow(leg: CanonicalEntity, add: AddIssue) {
  const lower = number(leg.fields.altitudeLowerFt);
  const upper = number(leg.fields.altitudeUpperFt);
  if (lower !== undefined && upper !== undefined && lower > upper) {
    add('ALTITUDE_WINDOW_ORDER', 'BLOCKING', [leg.entityKey], ['altitudeLowerFt', 'altitudeUpperFt'], [...candidateIds(leg, 'altitudeLowerFt'), ...candidateIds(leg, 'altitudeUpperFt')], `高度下限 ${lower} ft 高于上限 ${upper} ft。`);
  }
}

function candidateIds(entity: CanonicalEntity, fieldName: string) {
  const selected = entity.fieldEvidence[fieldName]?.selectedCandidateId;
  return selected ? [selected] : [];
}

function values(value: unknown): unknown[] {
  return value === undefined || value === null ? [] : Array.isArray(value) ? value.filter((item) => item !== null && item !== undefined) : [value];
}

function scalar(value: unknown) {
  return Array.isArray(value) ? (value.length === 1 ? value[0] : undefined) : value;
}

function number(value: unknown) {
  const parsed = Number(scalar(value));
  return scalar(value) !== undefined && Number.isFinite(parsed) ? parsed : undefined;
}

function legOrder(a: CanonicalEntity, b: CanonicalEntity) {
  return (number(a.fields.sequence) ?? Number.MAX_SAFE_INTEGER) - (number(b.fields.sequence) ?? Number.MAX_SAFE_INTEGER) || a.entityKey.localeCompare(b.entityKey);
}

function legValidationScope(leg: CanonicalEntity) {
  const procedureNames = values(leg.fields.procedureName).map((value) => String(value).toUpperCase()).sort();
  const transitionNames = values(leg.fields.transitionName).map((value) => String(value).toUpperCase()).sort();
  return `${procedureNames.join('|') || 'PACKAGE'}\u0000${transitionNames.join('|') || 'DEFAULT'}`;
}

function haversineNm(lat1: number, lon1: number, lat2: number, lon2: number) {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 3440.065 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function initialBearing(lat1: number, lon1: number, lat2: number, lon2: number) {
  const rad = Math.PI / 180;
  const y = Math.sin((lon2 - lon1) * rad) * Math.cos(lat2 * rad);
  const x = Math.cos(lat1 * rad) * Math.sin(lat2 * rad) - Math.sin(lat1 * rad) * Math.cos(lat2 * rad) * Math.cos((lon2 - lon1) * rad);
  return (Math.atan2(y, x) / rad + 360) % 360;
}

function angularDifference(a: number, b: number) {
  return Math.abs(((a - b + 540) % 360) - 180);
}

function stableId(prefix: string, value: unknown) {
  return `${prefix}_${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 20)}`;
}
