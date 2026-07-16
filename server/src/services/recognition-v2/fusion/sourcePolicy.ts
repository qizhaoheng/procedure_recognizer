import type { FieldCandidate, SourceEvidence } from '../contracts/index';

export const FUSION_SOURCE_POLICY_VERSION = '1.0.0';
export const FUSION_ENTITY_MATCH_POLICY_VERSION = '1.0.0';

const MULTI_VALUE_FIELDS = new Set(['procedureName', 'transitionName', 'runway']);
const BLOCKING_424_FIELDS = new Set([
  'airportIcao',
  'procedureName',
  'runway',
  'pathTerminator',
  'toFix',
  'latitude',
  'longitude',
]);

const SOURCE_SCORES: Record<string, number> = {
  PROCEDURE_TITLE: 100,
  WAYPOINT_COORDINATE_TABLE: 100,
  PROCEDURE_LEG_TABLE: 100,
  TEXT_LAYER: 90,
  DOCUMENT_METADATA: 60,
  SUPPORTING_INFORMATION: 75,
  PROCEDURE_DIAGRAM: 70,
  PROCEDURE_NOTES: 70,
  PROFILE_VIEW: 65,
  MINIMA_TABLE: 65,
  MSA: 65,
  UNKNOWN: 40,
};

export function logicalEntityKey(candidate: FieldCandidate, packageId: string) {
  if (candidate.entityType === 'AIRPORT') return `AIRPORT:${packageId}`;
  if (candidate.entityType === 'RUNWAY') return `RUNWAY:${packageId}`;
  if (candidate.entityType === 'PROCEDURE') return `PROCEDURE:${packageId}`;
  return candidate.entityKey;
}

export function isMultiValueField(fieldName: string) {
  return MULTI_VALUE_FIELDS.has(fieldName);
}

export function isBlocking424Field(fieldName: string) {
  return BLOCKING_424_FIELDS.has(fieldName);
}

export function candidateSourceScore(candidate: FieldCandidate, evidenceById: ReadonlyMap<string, SourceEvidence>) {
  const evidence = candidate.sourceEvidenceIds.map((id) => evidenceById.get(id)).filter((item): item is SourceEvidence => Boolean(item));
  const sourceScore = Math.max(0, ...evidence.map((item) => SOURCE_SCORES[item.sourceType] ?? 50));
  const nonModelBonus = evidence.some((item) => !item.modelExecution) ? 20 : 0;
  const reviewPenalty = candidate.reviewRequired ? 15 : 0;
  return sourceScore + nonModelBonus + candidate.confidence * 10 - reviewPenalty;
}

export function requiresReview(candidate: FieldCandidate, evidenceById: ReadonlyMap<string, SourceEvidence>) {
  if (candidate.reviewRequired || candidate.status === 'UNRESOLVED' || candidate.status === 'CONFLICTED') return true;
  const evidence = candidate.sourceEvidenceIds.map((id) => evidenceById.get(id)).filter((item): item is SourceEvidence => Boolean(item));
  return evidence.length > 0 && evidence.every((item) => Boolean(item.modelExecution));
}

export function independentSourceCount(candidateIds: readonly string[], candidatesById: ReadonlyMap<string, FieldCandidate>, evidenceById: ReadonlyMap<string, SourceEvidence>) {
  const sources = new Set<string>();
  for (const candidateId of candidateIds) {
    const candidate = candidatesById.get(candidateId);
    for (const evidenceId of candidate?.sourceEvidenceIds ?? []) {
      const evidence = evidenceById.get(evidenceId);
      if (evidence) sources.add(`${evidence.fileName}\u0000${evidence.pageNo}`);
    }
  }
  return sources.size;
}
