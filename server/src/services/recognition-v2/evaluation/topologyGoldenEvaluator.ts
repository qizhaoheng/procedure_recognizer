import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExtractionStageResult, FieldCandidate } from '../contracts/index';
import { assertValidTopologyGoldenCase } from '../contracts/schemaValidation';

export type TopologyGoldenCategory = 'DME_ARC' | 'RF' | 'HOLDING' | 'VECTOR' | 'MISSED_APPROACH' | 'MULTI_BRANCH_MERGE';
export type TopologyRelation = 'TRACK' | 'ARC' | 'HOLD' | 'VECTOR' | 'MISSED_APPROACH';

export interface TopologyGoldenEvidence {
  evidenceId: string;
  modality: 'PRINTED_TEXT' | 'TABULAR_ROW' | 'VISUAL_GEOMETRY';
  rawText: string;
  reviewedObservation?: string;
}

export interface TopologyGoldenEdge {
  edgeId: string;
  fromIdentifier: string | null;
  toIdentifier: string | null;
  relation: TopologyRelation;
  pathTerminator?: string;
  turnDirection?: 'L' | 'R';
  centerIdentifier?: string;
  radiusNm?: number;
  distanceNm?: number;
  inboundCourseDeg?: number;
  outboundCourseDeg?: number;
  legTimeMinutes?: number;
  minimumAltitudeFt?: number;
  openEnded?: boolean;
  evidenceIds: string[];
}

export interface TopologyGraphPoint {
  identifier: string;
  connectedIdentifiers: string[];
  evidenceIds: string[];
}

export interface TopologyGoldenCase {
  contractVersion: '2.0.0-alpha.1';
  schemaId: 'recognition-v2-topology-golden-case.schema.json';
  caseId: string;
  category: TopologyGoldenCategory;
  airportIcao: string;
  procedureName: string;
  procedureType: 'SID' | 'STAR' | 'APPROACH';
  source: {
    publisher: string;
    fileName: string;
    documentSha256: string;
    relativePath: string;
    reviewedAt: string;
    pages: Array<{
      pageNo: number;
      aipPageNo: string;
      role: 'PROCEDURE_DIAGRAM' | 'PROCEDURE_LEG_TABLE';
      evidence: TopologyGoldenEvidence[];
    }>;
  };
  expectations: {
    nodes: Array<{ identifier: string; nodeType: 'FIX' | 'NAVAID' | 'RUNWAY' | 'PSEUDO'; evidenceIds: string[] }>;
    edges: TopologyGoldenEdge[];
    branchPoints: TopologyGraphPoint[];
    mergePoints: TopologyGraphPoint[];
    requiredUnknowns: Array<{ path: string; reason: string; evidenceIds: string[] }>;
  };
}

export interface TopologyGoldenActual {
  nodes: string[];
  edges: Array<Omit<TopologyGoldenEdge, 'edgeId' | 'evidenceIds'>>;
  branchPoints: Array<{ identifier: string; connectedIdentifiers: string[] }>;
  mergePoints: Array<{ identifier: string; connectedIdentifiers: string[] }>;
}

export interface TopologyGoldenFailure {
  code: 'MISSING_NODE' | 'MISSING_EDGE' | 'MISSING_BRANCH' | 'MISSING_MERGE' | 'INVENTED_VALUE' | 'INVALID_GOLDEN_EVIDENCE';
  path: string;
  message: string;
}

const catalogDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'golden-cases', 'phase5-topology');
const numberTolerance: Partial<Record<keyof TopologyGoldenEdge, number>> = { radiusNm: 0.01, distanceNm: 0.1, inboundCourseDeg: 1, outboundCourseDeg: 1, legTimeMinutes: 0.01, minimumAltitudeFt: 1 };

export async function loadPhase5TopologyGoldenCases(): Promise<TopologyGoldenCase[]> {
  const names = (await fs.readdir(catalogDir)).filter((name) => name.endsWith('.golden.json')).sort();
  const cases: TopologyGoldenCase[] = [];
  for (const name of names) {
    const value = JSON.parse(await fs.readFile(path.join(catalogDir, name), 'utf8')) as TopologyGoldenCase;
    await assertValidTopologyGoldenCase(value);
    assertGoldenEvidenceIntegrity(value);
    cases.push(value);
  }
  return cases;
}

export function assertGoldenEvidenceIntegrity(golden: TopologyGoldenCase): void {
  const evidenceIds = new Set(golden.source.pages.flatMap((page) => page.evidence.map((item) => item.evidenceId)));
  const references = [
    ...golden.expectations.nodes.flatMap((item) => item.evidenceIds),
    ...golden.expectations.edges.flatMap((item) => item.evidenceIds),
    ...golden.expectations.branchPoints.flatMap((item) => item.evidenceIds),
    ...golden.expectations.mergePoints.flatMap((item) => item.evidenceIds),
    ...golden.expectations.requiredUnknowns.flatMap((item) => item.evidenceIds),
  ];
  const missing = references.filter((id) => !evidenceIds.has(id));
  if (missing.length) throw new Error(`${golden.caseId} references missing golden evidence: ${[...new Set(missing)].join(', ')}`);
  if (golden.category === 'VECTOR') {
    const open = golden.expectations.edges.find((edge) => edge.relation === 'VECTOR' && edge.openEnded);
    if (!open || open.toIdentifier !== null) throw new Error(`${golden.caseId} must preserve the unpublished vector endpoint as null.`);
  }
  if (golden.category === 'DME_ARC' || golden.category === 'RF') {
    if (!golden.expectations.edges.some((edge) => edge.relation === 'ARC' && edge.centerIdentifier && edge.radiusNm)) {
      throw new Error(`${golden.caseId} requires an ARC edge with printed center and radius evidence.`);
    }
  }
  if (golden.category === 'HOLDING') {
    if (!golden.expectations.edges.some((edge) => edge.relation === 'HOLD' && edge.inboundCourseDeg !== undefined && edge.turnDirection)) {
      throw new Error(`${golden.caseId} requires holding course and turn-direction evidence.`);
    }
  }
  if (golden.category === 'MISSED_APPROACH' && !golden.expectations.edges.some((edge) => edge.relation === 'MISSED_APPROACH')) {
    throw new Error(`${golden.caseId} requires a missed-approach edge.`);
  }
  if (golden.category === 'MULTI_BRANCH_MERGE' && !golden.expectations.mergePoints.length) {
    throw new Error(`${golden.caseId} requires at least one explicit merge point.`);
  }
}

export function evaluateTopologyGoldenCase(actual: TopologyGoldenActual, golden: TopologyGoldenCase) {
  const failures: TopologyGoldenFailure[] = [];
  const actualNodes = new Set(actual.nodes.map(normalizeIdentifier));
  for (const expected of golden.expectations.nodes) {
    if (!actualNodes.has(normalizeIdentifier(expected.identifier))) {
      failures.push({ code: 'MISSING_NODE', path: `nodes.${expected.identifier}`, message: `Missing published node ${expected.identifier}.` });
    }
  }
  for (const expected of golden.expectations.edges) {
    if (!actual.edges.some((edge) => edgeMatches(edge, expected))) {
      failures.push({ code: 'MISSING_EDGE', path: `edges.${expected.edgeId}`, message: `Missing ${expected.relation} edge ${expected.fromIdentifier ?? 'START'} -> ${expected.toIdentifier ?? 'UNKNOWN'}.` });
    }
  }
  compareGraphPoints(actual.branchPoints, golden.expectations.branchPoints, 'MISSING_BRANCH', 'branchPoints', failures);
  compareGraphPoints(actual.mergePoints, golden.expectations.mergePoints, 'MISSING_MERGE', 'mergePoints', failures);
  for (const unknown of golden.expectations.requiredUnknowns) {
    if (unknown.path === 'vector.toIdentifier') {
      const invented = actual.edges.find((edge) => edge.relation === 'VECTOR' && edge.openEnded && edge.toIdentifier !== null);
      if (invented) failures.push({ code: 'INVENTED_VALUE', path: unknown.path, message: `Vector endpoint must remain unknown; received ${invented.toIdentifier}.` });
    }
  }
  const expectedCount = golden.expectations.nodes.length + golden.expectations.edges.length + golden.expectations.branchPoints.length + golden.expectations.mergePoints.length + golden.expectations.requiredUnknowns.length;
  return {
    caseId: golden.caseId,
    category: golden.category,
    passed: failures.length === 0,
    score: expectedCount ? Math.round(((expectedCount - failures.length) / expectedCount) * 1000) / 1000 : 1,
    failures,
  };
}

export function topologyActualFromExtraction(extraction: ExtractionStageResult): TopologyGoldenActual {
  const edges = extraction.candidates.filter((item) => item.entityType === 'TOPOLOGY' && item.fieldName === 'edge').map(edgeFromCandidate).filter((item): item is TopologyGoldenActual['edges'][number] => Boolean(item));
  const nodes = [...new Set([
    ...extraction.candidates.filter((item) => item.entityType === 'TOPOLOGY' && item.fieldName === 'presentOnChart' && item.normalizedValue === true)
      .map((item) => item.entityKey.split(':NODE:')[1]).filter((item): item is string => Boolean(item)),
    ...edges.flatMap((edge) => [edge.fromIdentifier, edge.toIdentifier, edge.centerIdentifier]).filter((item): item is string => Boolean(item)),
  ])];
  return {
    nodes,
    edges,
    branchPoints: graphPointsFromCandidates(extraction.candidates, 'branchTargets'),
    mergePoints: graphPointsFromCandidates(extraction.candidates, 'mergeSources'),
  };
}

export async function verifyGoldenSourceFingerprint(golden: TopologyGoldenCase, workspaceRoot: string) {
  const filePath = path.resolve(workspaceRoot, golden.source.relativePath);
  try {
    const bytes = await fs.readFile(filePath);
    const actualSha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    return { available: true, matches: actualSha256 === golden.source.documentSha256, filePath, actualSha256 };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { available: false, matches: false, filePath };
    throw error;
  }
}

function edgeFromCandidate(candidate: FieldCandidate): TopologyGoldenActual['edges'][number] | undefined {
  const value = (candidate.value ?? candidate.normalizedValue) as Partial<TopologyGoldenEdge> & { from?: string | null; to?: string | null };
  if (!value || typeof value !== 'object' || !value.relation) return undefined;
  return {
    fromIdentifier: value.fromIdentifier ?? value.from ?? null,
    toIdentifier: value.toIdentifier ?? value.to ?? null,
    relation: value.relation,
    pathTerminator: value.pathTerminator,
    turnDirection: value.turnDirection,
    centerIdentifier: value.centerIdentifier,
    radiusNm: value.radiusNm,
    distanceNm: value.distanceNm,
    inboundCourseDeg: value.inboundCourseDeg,
    outboundCourseDeg: value.outboundCourseDeg,
    legTimeMinutes: value.legTimeMinutes,
    minimumAltitudeFt: value.minimumAltitudeFt,
    openEnded: value.openEnded,
  };
}

function graphPointsFromCandidates(candidates: FieldCandidate[], fieldName: 'branchTargets' | 'mergeSources') {
  return candidates.filter((item) => item.entityType === 'TOPOLOGY' && item.fieldName === fieldName).map((item) => ({
    identifier: item.entityKey.split(':NODE:')[1] ?? item.entityKey,
    connectedIdentifiers: Array.isArray(item.normalizedValue) ? item.normalizedValue.map(String) : [],
  }));
}

function edgeMatches(actual: TopologyGoldenActual['edges'][number], expected: TopologyGoldenEdge) {
  const keys: Array<keyof Omit<TopologyGoldenEdge, 'edgeId' | 'evidenceIds'>> = ['fromIdentifier', 'toIdentifier', 'relation', 'pathTerminator', 'turnDirection', 'centerIdentifier', 'radiusNm', 'distanceNm', 'inboundCourseDeg', 'outboundCourseDeg', 'legTimeMinutes', 'minimumAltitudeFt', 'openEnded'];
  return keys.every((key) => {
    const wanted = expected[key];
    if (wanted === undefined) return true;
    const received = actual[key];
    const tolerance = numberTolerance[key as keyof TopologyGoldenEdge];
    if (typeof wanted === 'number' && typeof received === 'number' && tolerance !== undefined) return Math.abs(wanted - received) <= tolerance;
    if (typeof wanted === 'string' && typeof received === 'string') return normalizeIdentifier(wanted) === normalizeIdentifier(received);
    return received === wanted;
  });
}

function compareGraphPoints(
  actual: Array<{ identifier: string; connectedIdentifiers: string[] }>,
  expected: TopologyGraphPoint[],
  code: 'MISSING_BRANCH' | 'MISSING_MERGE',
  pathPrefix: string,
  failures: TopologyGoldenFailure[],
) {
  for (const point of expected) {
    const found = actual.find((item) => normalizeIdentifier(item.identifier) === normalizeIdentifier(point.identifier));
    const connections = new Set(found?.connectedIdentifiers.map(normalizeIdentifier));
    if (!found || point.connectedIdentifiers.some((identifier) => !connections.has(normalizeIdentifier(identifier)))) {
      failures.push({ code, path: `${pathPrefix}.${point.identifier}`, message: `Missing ${pathPrefix === 'mergePoints' ? 'merge' : 'branch'} connections at ${point.identifier}.` });
    }
  }
}

function normalizeIdentifier(value: string) {
  return value.trim().toUpperCase().replace(/\s+/g, '_');
}
