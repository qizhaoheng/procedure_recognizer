import crypto from 'node:crypto';
import {
  RECOGNITION_V2_CONTRACT_VERSION,
  RECOGNITION_V2_SCHEMA_IDS,
  type CanonicalEntity,
  type ExtractionStageResult,
  type FieldCandidate,
  type FusionStageResult,
  type HumanReviewItem,
  type HumanReviewItemStatus,
  type HumanReviewStageResult,
  type SourceEvidence,
  type ValidationIssue,
  type ValidationStageResult,
} from '../contracts/index';
import {
  assertValidFusionStageResult,
  assertValidHumanReviewStageResult,
  assertValidValidationStageResult,
} from '../contracts/schemaValidation';
import { executeSemanticValidation } from '../validation/semanticValidationExecutor';

interface ReviewSignal {
  signalId: string;
  reasonCode?: string;
  ruleId?: string;
  issueId?: string;
  candidateIds: string[];
  critical: boolean;
}

export async function buildHumanReviewWorkspace(input: {
  runId: string;
  packageId: string;
  baselineFusionRef: string;
  baselineValidationRef: string;
  fusion: FusionStageResult;
  validation: ValidationStageResult;
  extractions: ExtractionStageResult[];
  existing?: HumanReviewStageResult;
  now?: string;
}): Promise<HumanReviewStageResult> {
  const now = input.now ?? new Date().toISOString();
  const candidates = dedupe(input.extractions.flatMap((item) => item.candidates), (item) => item.candidateId);
  const evidence = dedupe(input.extractions.flatMap((item) => item.evidence), (item) => item.evidenceId);
  const candidateById = new Map(candidates.map((item) => [item.candidateId, item]));
  const evidenceById = new Map(evidence.map((item) => [item.evidenceId, item]));
  const entityByKey = new Map(input.fusion.entities.map((item) => [item.entityKey, item]));
  const selectedTargetByCandidate = selectedCandidateTargets(input.fusion.entities);
  const signals = new Map<string, { entity: CanonicalEntity; fieldName: string; values: ReviewSignal[] }>();

  const addSignal = (entityKey: string, fieldName: string, signal: ReviewSignal) => {
    const entity = entityByKey.get(entityKey);
    if (!entity || !fieldName) return;
    const key = `${entityKey}\u0000${fieldName}`;
    const group = signals.get(key) ?? { entity, fieldName, values: [] };
    if (!group.values.some((item) => item.signalId === signal.signalId)) group.values.push(signal);
    signals.set(key, group);
  };

  for (const unresolved of input.fusion.unresolvedItems) {
    addSignal(unresolved.entityKey, unresolved.fieldName, {
      signalId: `unresolved:${unresolved.unresolvedId}`,
      reasonCode: unresolved.reasonCode,
      candidateIds: unresolved.candidateIds,
      critical: unresolved.blockingFor424,
    });
  }
  for (const conflict of input.fusion.conflicts.filter((item) => item.resolution === 'OPEN')) {
    addSignal(conflict.entityKey, conflict.fieldName, {
      signalId: `conflict:${conflict.conflictId}`,
      reasonCode: 'OPEN_CONFLICT',
      candidateIds: conflict.candidateIds,
      critical: conflict.severity === 'BLOCKING',
    });
  }
  for (const issue of input.validation.issues.filter((item) => item.status === 'OPEN' && item.severity !== 'INFO')) {
    const coordinateRootTargets = issue.ruleId === 'LEG_FIX_COORDINATE_REQUIRED'
      ? coordinateReviewRoots(issue, input.fusion.entities, signals)
      : [];
    const targets = coordinateRootTargets.length ? coordinateRootTargets : issueTargets(issue, selectedTargetByCandidate, entityByKey);
    for (const target of targets) {
      addSignal(target.entityKey, target.fieldName, {
        signalId: `issue:${issue.issueId}:${target.entityKey}:${target.fieldName}`,
        issueId: issue.issueId,
        ruleId: issue.ruleId,
        candidateIds: issue.candidateIds,
        critical: issue.severity === 'BLOCKING',
      });
    }
  }

  const previousById = new Map(input.existing?.items.map((item) => [item.reviewItemId, item]) ?? []);
  const items = [...signals.values()].map(({ entity, fieldName, values }) => {
    const reviewItemId = stableId('review', [entity.entityKey, fieldName]);
    const candidateIds = unique(values.flatMap((item) => item.candidateIds));
    const fieldEvidence = entity.fieldEvidence[fieldName];
    const evidenceIds = unique([
      ...(fieldEvidence?.sourceEvidenceIds ?? Object.values(entity.fieldEvidence).flatMap((item) => item.sourceEvidenceIds)),
      ...candidateIds.flatMap((id) => candidateById.get(id)?.sourceEvidenceIds ?? []),
    ]);
    const suggestedValues = dedupeUnknown(candidateIds
      .map((id) => candidateById.get(id))
      .filter((item): item is FieldCandidate => Boolean(item))
      .map((item) => item.normalizedValue !== undefined ? item.normalizedValue : item.value)
      .filter((value) => value !== undefined && value !== null));
    const reviewFingerprint = fingerprint([
      entity.entityType, entity.entityKey, fieldName, entity.fields[fieldName], suggestedValues,
      evidenceIds.map((id) => {
        const item = evidenceById.get(id);
        return item ? [item.fileName, item.pageNo, item.aipPageNo, item.bbox, item.rawText, item.visualDescription, item.status] : id;
      }),
    ]);
    const previousValue = previousById.get(reviewItemId);
    const previous = previousValue?.reviewFingerprint === reviewFingerprint ? previousValue : undefined;
    const critical = values.some((item) => item.critical) || is424CriticalField(entity.entityType, fieldName);
    const autoConfirmed = !previous && autoConfirmable(values, candidateIds, candidateById, evidenceById, entity.fields[fieldName], critical);
    return {
      reviewItemId,
      reviewFingerprint,
      procedureNames: procedureNamesForEntity(entity, input.fusion.entities),
      entityType: entity.entityType,
      entityKey: entity.entityKey,
      fieldName,
      ...(entity.fields[fieldName] !== undefined ? { currentValue: entity.fields[fieldName] } : {}),
      suggestedValues,
      candidateIds,
      evidenceIds,
      issueIds: unique(values.flatMap((item) => item.issueId ? [item.issueId] : [])),
      reasonCodes: unique(values.flatMap((item) => item.reasonCode ? [item.reasonCode] : [])),
      ruleIds: unique(values.flatMap((item) => item.ruleId ? [item.ruleId] : [])),
      duplicateCount: values.length,
      critical,
      status: previous?.status ?? (autoConfirmed ? 'CONFIRMED' : 'PENDING'),
      ...(previous?.correctedValue !== undefined ? { correctedValue: previous.correctedValue } : {}),
      ...(previous?.reviewer ? { reviewer: previous.reviewer } : {}),
      ...(previous?.note !== undefined ? { note: previous.note } : {}),
      ...(previous?.decidedAt ? { decidedAt: previous.decidedAt } : {}),
      ...(!previous && autoConfirmed ? { reviewer: 'AUTO_DETERMINISTIC', note: 'Automatically confirmed from complete non-model evidence with deterministic validation.', decidedAt: now } : {}),
    } satisfies HumanReviewItem;
  }).sort((a, b) => `${a.procedureNames.join('|')}:${a.entityKey}:${a.fieldName}`.localeCompare(`${b.procedureNames.join('|')}:${b.entityKey}:${b.fieldName}`));

  const auditTrail = [...(input.existing?.auditTrail ?? [])];
  for (const item of items.filter((value) => value.reviewer === 'AUTO_DETERMINISTIC' && !input.existing?.items.some((existing) => existing.reviewItemId === value.reviewItemId))) {
    auditTrail.push({
      eventId: stableId('review_auto', [input.runId, item.reviewItemId, item.reviewFingerprint]),
      reviewItemId: item.reviewItemId,
      action: 'CONFIRMED',
      reviewer: 'AUTO_DETERMINISTIC',
      ...(item.currentValue !== undefined ? { value: item.currentValue } : {}),
      note: item.note,
      at: now,
    });
  }

  const output: HumanReviewStageResult = {
    contractVersion: RECOGNITION_V2_CONTRACT_VERSION,
    schemaId: RECOGNITION_V2_SCHEMA_IDS.humanReviewStageResult,
    runId: input.runId,
    packageId: input.packageId,
    status: 'IN_PROGRESS',
    baselineFusionRef: input.baselineFusionRef,
    baselineValidationRef: input.baselineValidationRef,
    items,
    evidence,
    auditTrail,
    summary: reviewSummary(items, auditTrail),
    createdAt: input.existing?.createdAt ?? now,
    updatedAt: now,
  };
  await assertValidHumanReviewStageResult(output);
  return output;
}

function autoConfirmable(
  signals: ReviewSignal[],
  candidateIds: string[],
  candidateById: ReadonlyMap<string, FieldCandidate>,
  evidenceById: ReadonlyMap<string, SourceEvidence>,
  currentValue: unknown,
  critical: boolean,
) {
  if (currentValue === undefined || currentValue === null || !candidateIds.length) return false;
  if (signals.some((signal) => signal.reasonCode !== 'REVIEW_REQUIRED' && signal.ruleId !== 'UNRESOLVED_FUSION_ITEM')) return false;
  const candidates = candidateIds.map((id) => candidateById.get(id));
  const minimumConfidence = critical ? 0.95 : 0.75;
  if (candidates.some((candidate) => !candidate || candidate.status === 'UNRESOLVED' || candidate.status === 'CONFLICTED' || candidate.confidence < minimumConfidence)) return false;
  return candidates.every((candidate) => candidate!.sourceEvidenceIds.length > 0
    && candidate!.sourceEvidenceIds.every((id) => {
      const evidence = evidenceById.get(id);
      return Boolean(evidence && !evidence.modelExecution && evidence.status === 'OBSERVED' && evidence.confidence >= minimumConfidence);
    })
    && (candidate!.status !== 'DERIVED' || Boolean(candidate!.derivation?.inputCandidateIds.length)));
}

function is424CriticalField(entityType: CanonicalEntity['entityType'], fieldName: string) {
  if (entityType === 'LEG') return true;
  if (entityType === 'FIX' || entityType === 'NAVAID') {
    return ['identifier', 'latitude', 'longitude', 'frequency', 'channel', 'navaidType'].includes(fieldName);
  }
  if (entityType === 'PROCEDURE') {
    return ['procedureName', 'procedureCategory', 'packageType', 'navigationType', 'runway', 'runways', 'routeType', 'transition'].includes(fieldName);
  }
  return entityType === 'AIRPORT' && ['airportIcao', 'regionCode'].includes(fieldName);
}

function coordinateReviewRoots(
  issue: ValidationIssue,
  entities: CanonicalEntity[],
  signals: Map<string, { entity: CanonicalEntity; fieldName: string; values: ReviewSignal[] }>,
) {
  const leg = entities.find((item) => issue.entityKeys.includes(item.entityKey) && item.entityType === 'LEG');
  const identifier = String(scalar(leg?.fields.toFix) ?? '').toUpperCase();
  const coordinate = entities.find((item) => (item.entityType === 'FIX' || item.entityType === 'NAVAID')
    && String(scalar(item.fields.identifier) ?? '').toUpperCase() === identifier);
  if (!coordinate) return [];
  return ['latitude', 'longitude']
    .filter((fieldName) => signals.has(`${coordinate.entityKey}\u0000${fieldName}`))
    .map((fieldName) => ({ entityKey: coordinate.entityKey, fieldName }));
}

export async function recordHumanReviewDecision(input: {
  workspace: HumanReviewStageResult;
  reviewItemId: string;
  status: Exclude<HumanReviewItemStatus, 'PENDING'>;
  correctedValue?: unknown;
  reviewer: string;
  note?: string;
  now?: string;
}): Promise<HumanReviewStageResult> {
  if (input.workspace.status !== 'IN_PROGRESS') throw new Error('Completed human review cannot be edited.');
  const reviewer = input.reviewer.trim();
  if (!reviewer) throw new Error('Reviewer is required.');
  const index = input.workspace.items.findIndex((item) => item.reviewItemId === input.reviewItemId);
  if (index < 0) throw new Error(`Review item not found: ${input.reviewItemId}`);
  const item = input.workspace.items[index];
  if (input.status === 'CONFIRMED' && item.ruleIds.includes('PROCEDURE_LEGS_REQUIRED')) {
    throw new Error('A procedure with no legs cannot be confirmed; rerun table extraction or enter actual leg entities.');
  }
  if (input.status === 'CONFIRMED' && item.currentValue === undefined && item.reasonCodes.length > 0) {
    throw new Error('This field has no selected value; enter a correction instead of confirming it.');
  }
  if (input.status === 'CONFIRMED' && item.evidenceIds.length === 0) {
    throw new Error('This field has no source evidence and cannot be confirmed.');
  }
  if (input.status === 'CORRECTED' && (input.correctedValue === undefined || input.correctedValue === null || input.correctedValue === '')) {
    throw new Error('A corrected value is required.');
  }
  const now = input.now ?? new Date().toISOString();
  const workspace = structuredClone(input.workspace);
  workspace.items[index] = {
    ...workspace.items[index],
    status: input.status,
    ...(input.status === 'CORRECTED' ? { correctedValue: input.correctedValue } : { correctedValue: undefined }),
    reviewer,
    note: input.note?.trim() ?? '',
    decidedAt: now,
  };
  workspace.auditTrail.push({
    eventId: stableId('review_event', [input.reviewItemId, input.status, reviewer, now, input.correctedValue]),
    reviewItemId: input.reviewItemId,
    action: input.status,
    reviewer,
    ...(item.status === 'CORRECTED' ? { previousValue: item.correctedValue } : item.currentValue !== undefined ? { previousValue: item.currentValue } : {}),
    ...(input.status === 'CORRECTED' ? { value: input.correctedValue } : item.currentValue !== undefined ? { value: item.currentValue } : {}),
    ...(input.note?.trim() ? { note: input.note.trim() } : {}),
    at: now,
  });
  workspace.summary = reviewSummary(workspace.items, workspace.auditTrail);
  workspace.updatedAt = now;
  await assertValidHumanReviewStageResult(workspace);
  return workspace;
}

export async function recordHumanReviewDecisions(input: {
  workspace: HumanReviewStageResult;
  decisions: Array<{
    reviewItemId: string;
    status: Exclude<HumanReviewItemStatus, 'PENDING'>;
    correctedValue?: unknown;
    note?: string;
  }>;
  reviewer: string;
  now?: string;
}) {
  if (!input.decisions.length) throw new Error('At least one review decision is required.');
  if (new Set(input.decisions.map((item) => item.reviewItemId)).size !== input.decisions.length) throw new Error('A review batch cannot contain duplicate items.');
  let workspace = input.workspace;
  const now = input.now ?? new Date().toISOString();
  for (const decision of input.decisions) {
    workspace = await recordHumanReviewDecision({ ...decision, workspace, reviewer: input.reviewer, now });
  }
  return workspace;
}

export interface HumanReviewReuseLedger {
  version: '1.0.0';
  decisions: Record<string, {
    sourcePackageHash: string;
    sourceRunId: string;
    reviewFingerprint: string;
    status: Exclude<HumanReviewItemStatus, 'PENDING'>;
    correctedValue?: unknown;
    reviewer: string;
    note?: string;
    decidedAt: string;
  }>;
  updatedAt: string;
}

export async function applyReusableReviewDecisions(input: {
  workspace: HumanReviewStageResult;
  ledger?: HumanReviewReuseLedger;
  sourcePackageHash: string;
  now?: string;
}) {
  if (!input.ledger) return input.workspace;
  const now = input.now ?? new Date().toISOString();
  const workspace = structuredClone(input.workspace);
  for (const item of workspace.items) {
    if (item.status !== 'PENDING') continue;
    const decision = input.ledger.decisions[item.reviewFingerprint];
    if (!decision || decision.sourcePackageHash !== input.sourcePackageHash || decision.reviewFingerprint !== item.reviewFingerprint) continue;
    item.status = decision.status;
    if (decision.status === 'CORRECTED') item.correctedValue = decision.correctedValue;
    item.reviewer = decision.reviewer;
    item.note = decision.note ?? '';
    item.decidedAt = decision.decidedAt;
    workspace.auditTrail.push({
      eventId: stableId('review_reuse', [workspace.runId, item.reviewItemId, decision.sourceRunId, decision.decidedAt]),
      reviewItemId: item.reviewItemId,
      action: decision.status,
      reviewer: decision.reviewer,
      ...(decision.status === 'CORRECTED' ? { value: decision.correctedValue } : item.currentValue !== undefined ? { value: item.currentValue } : {}),
      ...(decision.note ? { note: decision.note } : {}),
      at: now,
      reusedFromRunId: decision.sourceRunId,
    });
  }
  workspace.updatedAt = now;
  workspace.summary = reviewSummary(workspace.items, workspace.auditTrail);
  await assertValidHumanReviewStageResult(workspace);
  return workspace;
}

export function updateReuseLedger(input: {
  ledger?: HumanReviewReuseLedger;
  workspace: HumanReviewStageResult;
  sourcePackageHash: string;
  now?: string;
}) {
  const now = input.now ?? new Date().toISOString();
  const ledger: HumanReviewReuseLedger = structuredClone(input.ledger ?? { version: '1.0.0', decisions: {}, updatedAt: now });
  for (const item of input.workspace.items.filter((value) => value.status !== 'PENDING' && value.reviewer && value.decidedAt)) {
    ledger.decisions[item.reviewFingerprint] = {
      sourcePackageHash: input.sourcePackageHash,
      sourceRunId: input.workspace.runId,
      reviewFingerprint: item.reviewFingerprint,
      status: item.status,
      ...(item.status === 'CORRECTED' ? { correctedValue: item.correctedValue } : {}),
      reviewer: item.reviewer!,
      ...(item.note ? { note: item.note } : {}),
      decidedAt: item.decidedAt!,
    };
  }
  ledger.updatedAt = now;
  return ledger;
}

export async function applyCompletedHumanReview(input: {
  workspace: HumanReviewStageResult;
  fusion: FusionStageResult;
  now?: string;
}): Promise<{ workspace: HumanReviewStageResult; fusion: FusionStageResult; validation: ValidationStageResult }> {
  if (input.workspace.summary.criticalPending > 0) throw new Error(`There are ${input.workspace.summary.criticalPending} critical review fields still pending.`);
  const now = input.now ?? new Date().toISOString();
  const fusion = structuredClone(input.fusion);
  const decidedKeys = new Set<string>();
  for (const item of input.workspace.items.filter((value) => value.status !== 'PENDING')) {
    const entity = fusion.entities.find((value) => value.entityKey === item.entityKey);
    if (!entity) continue;
    const value = item.status === 'CORRECTED' ? item.correctedValue : item.currentValue;
    const syntheticCandidateId = item.status === 'CORRECTED' ? stableId('human_candidate', [item.reviewItemId, value]) : entity.fieldEvidence[item.fieldName]?.selectedCandidateId;
    if (value !== undefined) {
      entity.fields[item.fieldName] = value;
      entity.fieldEvidence[item.fieldName] = {
        ...(syntheticCandidateId ? { selectedCandidateId: syntheticCandidateId } : {}),
        sourceEvidenceIds: item.evidenceIds,
        status: 'OBSERVED',
        confidence: 1,
      };
    }
    if (syntheticCandidateId && !fusion.selectedCandidateIds.includes(syntheticCandidateId)) fusion.selectedCandidateIds.push(syntheticCandidateId);
    decidedKeys.add(`${item.entityKey}\u0000${item.fieldName}`);
    for (const conflict of fusion.conflicts.filter((value) => value.entityKey === item.entityKey && value.fieldName === item.fieldName && value.resolution === 'OPEN')) {
      const selectedCandidateId = syntheticCandidateId ?? conflict.candidateIds[0];
      conflict.resolution = 'HUMAN_RESOLVED';
      conflict.selectedCandidateId = selectedCandidateId;
      conflict.selectionReason = `${item.status} by ${item.reviewer ?? 'human reviewer'} in HUMAN_REVIEW.`;
    }
  }
  fusion.unresolvedItems = fusion.unresolvedItems.filter((item) => !decidedKeys.has(`${item.entityKey}\u0000${item.fieldName}`));
  fusion.selectedCandidateIds = unique(fusion.selectedCandidateIds).sort();
  fusion.completedAt = now;
  await assertValidFusionStageResult(fusion);

  const validationExecution = await executeSemanticValidation({ fusion, now });
  const validation = validationExecution.output;
  const nonWaivableRules = new Set(['PROCEDURE_LEGS_REQUIRED']);
  for (const issue of validation.issues) {
    if (issue.status !== 'OPEN' || issue.severity === 'INFO') continue;
    if (!nonWaivableRules.has(issue.ruleId) && issueWasExplicitlyConfirmed(issue, input.workspace.items)) issue.status = 'HUMAN_RESOLVED';
  }
  validation.blockingIssueCount = validation.issues.filter((item) => item.status === 'OPEN' && item.severity === 'BLOCKING').length;
  validation.reviewIssueCount = validation.issues.filter((item) => item.status === 'OPEN' && item.severity === 'WARNING').length;
  validation.releaseDecision = validation.blockingIssueCount ? 'BLOCKED' : validation.reviewIssueCount ? 'REVIEW_REQUIRED' : 'READY';
  await assertValidValidationStageResult(validation);

  const workspace = structuredClone(input.workspace);
  workspace.reviewedValidation = validation;
  workspace.updatedAt = now;
  if (validation.releaseDecision === 'READY') {
    workspace.status = 'COMPLETED';
    workspace.completedAt = now;
  }
  await assertValidHumanReviewStageResult(workspace);
  return { workspace, fusion, validation };
}

function issueTargets(
  issue: ValidationIssue,
  selectedTargetByCandidate: Map<string, { entityKey: string; fieldName: string }>,
  entityByKey: Map<string, CanonicalEntity>,
) {
  const selectedTargets = unique(issue.candidateIds.map((id) => selectedTargetByCandidate.get(id)).filter((item): item is { entityKey: string; fieldName: string } => Boolean(item)), (item) => `${item.entityKey}\u0000${item.fieldName}`);
  if (selectedTargets.length) return selectedTargets;
  for (const entityKey of issue.entityKeys) {
    const entity = entityByKey.get(entityKey);
    if (!entity) continue;
    const fieldName = issue.fieldNames.find((field) => Object.prototype.hasOwnProperty.call(entity.fields, field)) ?? issue.fieldNames[0];
    if (fieldName) return [{ entityKey, fieldName }];
  }
  return [];
}

function selectedCandidateTargets(entities: CanonicalEntity[]) {
  const output = new Map<string, { entityKey: string; fieldName: string }>();
  for (const entity of entities) {
    for (const [fieldName, provenance] of Object.entries(entity.fieldEvidence)) {
      if (provenance.selectedCandidateId) output.set(provenance.selectedCandidateId, { entityKey: entity.entityKey, fieldName });
    }
  }
  return output;
}

function procedureNamesForEntity(entity: CanonicalEntity, entities: CanonicalEntity[]) {
  const direct = values(entity.fields.procedureName).map(String).filter(Boolean);
  if (direct.length) return unique(direct).sort();
  const identifier = String(scalar(entity.fields.identifier) ?? entity.entityKey.split(':').at(-1) ?? '').toUpperCase();
  if (identifier && (entity.entityType === 'FIX' || entity.entityType === 'NAVAID')) {
    const consumers = entities.filter((item) => item.entityType === 'LEG' && ['fromFix', 'toFix', 'centerFix', 'recommendedNavaid']
      .some((field) => values(item.fields[field]).some((value) => String(value).toUpperCase() === identifier)))
      .flatMap((item) => values(item.fields.procedureName).map(String));
    if (consumers.length) return unique(consumers).sort();
  }
  const packageProcedures = entities.filter((item) => item.entityType === 'PROCEDURE').flatMap((item) => values(item.fields.procedureName).map(String));
  return unique(packageProcedures).sort();
}

function issueWasExplicitlyConfirmed(issue: ValidationIssue, items: HumanReviewItem[]) {
  return items.some((item) => item.status === 'CONFIRMED' && item.ruleIds.includes(issue.ruleId)
    && issue.entityKeys.includes(item.entityKey) && issue.fieldNames.includes(item.fieldName));
}

function reviewSummary(items: HumanReviewItem[], auditTrail: HumanReviewStageResult['auditTrail'] = []) {
  return {
    total: items.length,
    pending: items.filter((item) => item.status === 'PENDING').length,
    confirmed: items.filter((item) => item.status === 'CONFIRMED').length,
    corrected: items.filter((item) => item.status === 'CORRECTED').length,
    criticalPending: items.filter((item) => item.critical && item.status === 'PENDING').length,
    mergedSignalCount: items.reduce((sum, item) => sum + item.duplicateCount, 0),
    reusedDecisionCount: new Set(auditTrail.filter((item) => item.reusedFromRunId).map((item) => item.reviewItemId)).size,
  };
}

function values(value: unknown): unknown[] {
  return value === undefined || value === null ? [] : Array.isArray(value) ? value : [value];
}

function scalar(value: unknown) {
  return Array.isArray(value) ? value[0] : value;
}

function unique(values: string[]): string[];
function unique<T>(values: T[], key: (value: T) => string): T[];
function unique<T>(values: T[], key: (value: T) => string = (value) => String(value)): T[] {
  return [...new Map(values.map((value) => [key(value), value])).values()];
}

function dedupe<T>(values: T[], key: (value: T) => string) {
  return unique(values, key);
}

function dedupeUnknown(values: unknown[]) {
  return [...new Map(values.map((value) => [JSON.stringify(value), value])).values()];
}

function stableId(prefix: string, value: unknown) {
  return `${prefix}_${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 20)}`;
}

function fingerprint(value: unknown) {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}
