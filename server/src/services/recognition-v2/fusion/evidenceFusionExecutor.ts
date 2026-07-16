import crypto from 'node:crypto';
import {
  RECOGNITION_V2_CONTRACT_VERSION,
  RECOGNITION_V2_SCHEMA_IDS,
  type CanonicalEntity,
  type EvidenceConflict,
  type ExtractionStageResult,
  type FieldCandidate,
  type FieldProvenance,
  type FusionStageResult,
  type SourceEvidence,
  type UnresolvedItem,
} from '../contracts/index';
import { assertValidFusionStageResult } from '../contracts/schemaValidation';
import type { StageAuditArtifact } from '../layout/pageLayoutExecutor';
import {
  FUSION_ENTITY_MATCH_POLICY_VERSION,
  FUSION_SOURCE_POLICY_VERSION,
  candidateSourceScore,
  independentSourceCount,
  isBlocking424Field,
  isMultiValueField,
  logicalEntityKey,
  requiresReview,
} from './sourcePolicy';

export interface EvidenceFusionExecutionResult {
  output: FusionStageResult;
  auditArtifacts: StageAuditArtifact[];
}

export async function executeEvidenceFusion(input: {
  packageId: string;
  extractions: ExtractionStageResult[];
  now?: string;
}): Promise<EvidenceFusionExecutionResult> {
  const evidence = dedupe(input.extractions.flatMap((item) => item.evidence), (item) => item.evidenceId);
  const candidates = dedupe(input.extractions.flatMap((item) => item.candidates), (item) => item.candidateId);
  const evidenceById = new Map(evidence.map((item) => [item.evidenceId, item]));
  const candidatesById = new Map(candidates.map((item) => [item.candidateId, item]));
  const groups = groupCandidates(candidates, input.packageId);
  const entities = new Map<string, CanonicalEntity>();
  const conflicts: EvidenceConflict[] = [];
  const unresolvedItems: UnresolvedItem[] = [];
  const selectedCandidateIds = new Set<string>();

  for (const group of [...groups.values()].sort((a, b) => `${a.entityKey}:${a.fieldName}`.localeCompare(`${b.entityKey}:${b.fieldName}`))) {
    const entity = entities.get(group.entityKey) ?? {
      entityType: group.entityType,
      entityKey: group.entityKey,
      fields: {},
      fieldEvidence: {},
    };
    entities.set(group.entityKey, entity);
    const invalidEvidence = group.candidates.filter((candidate) => !hasAuditableEvidence(candidate, candidatesById, evidenceById));
    const eligible = group.candidates.filter((candidate) => !invalidEvidence.includes(candidate));
    const usable = eligible.filter((candidate) => candidate.value !== null && candidate.normalizedValue !== null && candidate.status !== 'UNRESOLVED' && candidate.status !== 'CONFLICTED');
    if (invalidEvidence.length) {
      unresolvedItems.push(unresolved(
        group.entityKey,
        group.fieldName,
        'MISSING_SOURCE_EVIDENCE',
        invalidEvidence,
        !usable.length && isBlocking424Field(group.fieldName),
      ));
    }
    const byValue = new Map<string, FieldCandidate[]>();
    for (const candidate of usable) {
      const key = stableValue(candidate.normalizedValue !== undefined ? candidate.normalizedValue : candidate.value);
      const values = byValue.get(key) ?? [];
      values.push(candidate);
      byValue.set(key, values);
    }

    if (!byValue.size) {
      unresolvedItems.push(unresolved(group.entityKey, group.fieldName, 'NO_USABLE_CANDIDATE', eligible, isBlocking424Field(group.fieldName)));
      entity.fieldEvidence[group.fieldName] = provenance(eligible, undefined, evidenceById, 'UNRESOLVED');
      continue;
    }

    if (isMultiValueField(group.fieldName)) {
      const representatives = [...byValue.values()].map((items) => selectRepresentative(items, evidenceById));
      entity.fields[group.fieldName] = representatives.map((candidate) => canonicalValue(candidate));
      for (const representative of representatives) selectedCandidateIds.add(representative.candidateId);
      entity.fieldEvidence[group.fieldName] = provenance(usable, representatives[0], evidenceById, 'OBSERVED');
      const reviewCandidates = representatives.filter((candidate) => requiresReview(candidate, evidenceById));
      if (reviewCandidates.length) {
        unresolvedItems.push(unresolved(group.entityKey, group.fieldName, 'REVIEW_REQUIRED', reviewCandidates, isBlocking424Field(group.fieldName)));
      }
      continue;
    }

    if (byValue.size > 1) {
      const conflicting = [...byValue.values()].flat();
      conflicts.push({
        conflictId: stableId('conflict', [group.entityKey, group.fieldName, conflicting.map((item) => item.candidateId).sort()]),
        entityKey: group.entityKey,
        fieldName: group.fieldName,
        candidateIds: conflicting.map((item) => item.candidateId).sort(),
        severity: isBlocking424Field(group.fieldName) ? 'BLOCKING' : 'WARNING',
        resolution: 'OPEN',
      });
      unresolvedItems.push(unresolved(group.entityKey, group.fieldName, 'CONFLICTING_VALUES', conflicting, isBlocking424Field(group.fieldName)));
      entity.fieldEvidence[group.fieldName] = provenance(conflicting, undefined, evidenceById, 'CONFLICTED');
      continue;
    }

    const agreeing = [...byValue.values()][0];
    const representative = selectRepresentative(agreeing, evidenceById);
    entity.fields[group.fieldName] = canonicalValue(representative);
    entity.fieldEvidence[group.fieldName] = provenance(agreeing, representative, evidenceById, representative.status);
    selectedCandidateIds.add(representative.candidateId);
    if (agreeing.every((candidate) => requiresReview(candidate, evidenceById))) {
      const reason = agreeing.every((candidate) => candidate.sourceEvidenceIds.every((id) => evidenceById.get(id)?.modelExecution)) ? 'MODEL_ONLY' : 'REVIEW_REQUIRED';
      unresolvedItems.push(unresolved(group.entityKey, group.fieldName, reason, agreeing, isBlocking424Field(group.fieldName)));
    }
  }

  const output: FusionStageResult = {
    contractVersion: RECOGNITION_V2_CONTRACT_VERSION,
    schemaId: RECOGNITION_V2_SCHEMA_IDS.fusionStageResult,
    entities: [...entities.values()].sort((a, b) => a.entityKey.localeCompare(b.entityKey)),
    conflicts,
    unresolvedItems: dedupe(unresolvedItems, (item) => item.unresolvedId),
    selectedCandidateIds: [...selectedCandidateIds].sort(),
    policyVersions: {
      sourcePriority: FUSION_SOURCE_POLICY_VERSION,
      entityMatching: FUSION_ENTITY_MATCH_POLICY_VERSION,
    },
    completedAt: input.now ?? new Date().toISOString(),
  };
  await assertValidFusionStageResult(output);
  return {
    output,
    auditArtifacts: [{
      fileName: 'fusion-policy.json',
      value: {
        policyVersions: output.policyVersions,
        extractionTaskTypes: input.extractions.map((item) => item.taskType),
        evidenceCount: evidence.length,
        candidateCount: candidates.length,
        independentSourceCount: independentSourceCount(candidates.map((item) => item.candidateId), candidatesById, evidenceById),
        rule: 'Equal normalized values merge evidence; distinct single-valued candidates remain OPEN conflicts.',
      },
    }],
  };
}

function groupCandidates(candidates: FieldCandidate[], packageId: string) {
  const groups = new Map<string, { entityType: FieldCandidate['entityType']; entityKey: string; fieldName: string; candidates: FieldCandidate[] }>();
  for (const candidate of candidates) {
    const entityKey = logicalEntityKey(candidate, packageId);
    const key = `${entityKey}\u0000${candidate.fieldName}`;
    const group = groups.get(key) ?? { entityType: candidate.entityType, entityKey, fieldName: candidate.fieldName, candidates: [] };
    group.candidates.push(candidate);
    groups.set(key, group);
  }
  return groups;
}

function selectRepresentative(candidates: FieldCandidate[], evidenceById: ReadonlyMap<string, SourceEvidence>) {
  return [...candidates].sort((a, b) => candidateSourceScore(b, evidenceById) - candidateSourceScore(a, evidenceById) || a.candidateId.localeCompare(b.candidateId))[0];
}

function canonicalValue(candidate: FieldCandidate) {
  return candidate.normalizedValue !== undefined ? candidate.normalizedValue : candidate.value;
}

function hasAuditableEvidence(candidate: FieldCandidate, candidatesById: ReadonlyMap<string, FieldCandidate>, evidenceById: ReadonlyMap<string, SourceEvidence>) {
  if (!candidate.sourceEvidenceIds.length || candidate.sourceEvidenceIds.some((id) => !evidenceById.has(id))) return false;
  if (candidate.status === 'DERIVED') {
    return Boolean(candidate.derivation?.inputCandidateIds.length) && candidate.derivation!.inputCandidateIds.every((id) => candidatesById.has(id));
  }
  return true;
}

function provenance(candidates: FieldCandidate[], selected: FieldCandidate | undefined, evidenceById: ReadonlyMap<string, SourceEvidence>, status: FieldProvenance['status']): FieldProvenance {
  return {
    ...(selected ? { selectedCandidateId: selected.candidateId } : {}),
    sourceEvidenceIds: [...new Set(candidates.flatMap((item) => item.sourceEvidenceIds).filter((id) => evidenceById.has(id)))].sort(),
    status,
    confidence: selected?.confidence ?? Math.max(0, ...candidates.map((item) => item.confidence)),
  };
}

function unresolved(entityKey: string, fieldName: string, reasonCode: string, candidates: FieldCandidate[], blockingFor424: boolean): UnresolvedItem {
  const candidateIds = candidates.map((item) => item.candidateId).sort();
  return {
    unresolvedId: stableId('unresolved', [entityKey, fieldName, reasonCode, candidateIds]),
    entityKey,
    fieldName,
    reasonCode,
    candidateIds,
    requiredEvidence: reasonCode === 'CONFLICTING_VALUES' ? 'Independent source evidence or human adjudication.' : 'Human-confirmed source evidence.',
    blockingFor424,
  };
}

function stableValue(value: unknown) {
  if (typeof value === 'string') return JSON.stringify(value.trim().toUpperCase());
  return JSON.stringify(value);
}

function stableId(prefix: string, value: unknown) {
  return `${prefix}_${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 20)}`;
}

function dedupe<T>(values: T[], key: (value: T) => string) {
  return [...new Map(values.map((value) => [key(value), value])).values()];
}
