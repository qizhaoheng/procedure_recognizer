import crypto from 'node:crypto';
import type { ProcedureUnderstandingResult } from '../../../types/procedure';
import { aiProcedureToSimpleLegs } from '../../jeppesen424/aiProcedureToSimpleLegs';
import { enrichArinc424References } from '../../jeppesen424/arinc424ReferenceEnricher';
import { buildArinc424Coverage } from '../../jeppesen424/arinc424Coverage';
import { parseJeppesen424Text } from '../../jeppesen424/jeppesen424TextParser';
import { alignJeppesenProcedureNames, compareSimpleProcedureLegs } from '../../jeppesen424/simpleProcedureComparator';
import { simpleLegsTo424Text } from '../../jeppesen424/simpleLegsTo424Text';
import {
  RECOGNITION_V2_CONTRACT_VERSION,
  RECOGNITION_V2_SCHEMA_IDS,
  type CanonicalPreviewArtifact,
  type PublicationCheck,
  type PublicationLedger,
  type PublicationRelease,
  type PublicationWorkspace,
} from '../contracts/index';

export function addPublishedRelease(ledger: PublicationLedger | undefined, release: PublicationRelease): PublicationLedger {
  const releases = (ledger?.releases ?? []).map((item) => item.status === 'ACTIVE' ? { ...item, status: 'SUPERSEDED' as const } : item);
  releases.push({ ...release, status: 'ACTIVE' });
  return { version: 1, activeReleaseId: release.releaseId, releases, updatedAt: release.publishedAt };
}

export function markReleaseRolledBack(ledger: PublicationLedger, activeReleaseId: string, targetReleaseId: string | undefined, now: string): PublicationLedger {
  if (ledger.activeReleaseId !== activeReleaseId) throw new Error('当前生效发布已变化，请刷新后再回滚。');
  if (targetReleaseId && !ledger.releases.some((item) => item.releaseId === targetReleaseId && item.releaseId !== activeReleaseId)) throw new Error('目标回滚版本不存在。');
  return {
    version: 1,
    activeReleaseId: targetReleaseId,
    releases: ledger.releases.map((item) => item.releaseId === activeReleaseId
      ? { ...item, status: 'ROLLED_BACK', rolledBackAt: now }
      : item.releaseId === targetReleaseId ? { ...item, status: 'ACTIVE' } : item),
    updatedAt: now,
  };
}

export function contentHash(value: unknown) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return `sha256:${crypto.createHash('sha256').update(text).digest('hex')}`;
}

export function createPublicationLock(input: {
  taskId: string; packageId: string; runId: string; sourcePackageHash: string;
  canonicalPreviewRef: string; reviewOutputRef: string; preview: CanonicalPreviewArtifact; now?: string;
}): PublicationWorkspace {
  if (input.preview.releaseDecision !== 'READY') throw new Error('只有 READY 的 canonical 数据可以锁定。');
  const now = input.now ?? new Date().toISOString();
  const canonicalHash = contentHash(input.preview.procedureUnderstanding);
  return {
    contractVersion: RECOGNITION_V2_CONTRACT_VERSION,
    schemaId: RECOGNITION_V2_SCHEMA_IDS.publicationWorkspace,
    taskId: input.taskId,
    packageId: input.packageId,
    runId: input.runId,
    status: 'LOCKED',
    lock: {
      lockId: `lock_${crypto.randomUUID()}`,
      sourcePackageHash: input.sourcePackageHash,
      canonicalHash,
      canonicalPreviewRef: input.canonicalPreviewRef,
      reviewOutputRef: input.reviewOutputRef,
      lockedAt: now,
    },
    updatedAt: now,
  };
}

export function runPublicationPreflight(input: {
  workspace: PublicationWorkspace; preview: CanonicalPreviewArtifact; currentSourcePackageHash: string; runApproved: boolean; now?: string;
}): PublicationWorkspace {
  const checks: PublicationCheck[] = [];
  check(checks, 'RUN_APPROVED', input.runApproved, 'V2 Run 已通过发布审核', 'V2 Run 尚未进入 APPROVED');
  check(checks, 'SOURCE_UNCHANGED', input.currentSourcePackageHash === input.workspace.lock.sourcePackageHash, '源文件自锁定后未变化', '源文件或分组已变化，必须重新审核并锁定');
  check(checks, 'CANONICAL_UNCHANGED', contentHash(input.preview.procedureUnderstanding) === input.workspace.lock.canonicalHash, 'canonical 快照哈希一致', 'canonical 数据已变化，锁定失效');
  check(checks, 'READY_DECISION', input.preview.releaseDecision === 'READY', '审核结论为 READY', '审核结论不是 READY');
  const canonical = input.preview.procedureUnderstanding as ProcedureUnderstandingResult;
  check(checks, 'AIRPORT_ICAO', /^[A-Z]{4}$/.test(String(canonical.airportIcao ?? '').toUpperCase()), '机场 ICAO 有效', '机场 ICAO 缺失或格式错误');
  const navigationType = String(canonical.navigationType ?? '').trim().toUpperCase();
  check(checks, 'NAVIGATION_TYPE', Boolean(navigationType && navigationType !== '-' && navigationType !== 'UNKNOWN'), '导航类型已明确', '导航类型缺失或仍为占位值');
  check(checks, 'PROCEDURES', Boolean(canonical.procedures?.length), '存在可发布程序', '没有程序实体');
  const referenceEnrichment = enrichArinc424References(canonical, aiProcedureToSimpleLegs(canonical));
  const legs = referenceEnrichment.legs;
  const invalidMetricAltitudes = legs.filter((leg) => leg.altitudeSourceUnit === 'M' && !/^FL\d{3}$/.test(leg.altitudeCode ?? ''));
  check(
    checks,
    'ALTITUDE_UNIT_ENCODING',
    invalidMetricAltitudes.length === 0,
    'Metric altitudes are deterministically encoded as flight levels.',
    `${invalidMetricAltitudes.length} metric altitude(s) are not encoded as flight levels.`,
  );
  check(checks, '424_LEGS', legs.length > 0, `已实体化 ${legs.length} 条 424 航段`, '没有可编码的 424 航段');
  check(
    checks,
    'CF_REFERENCE_GEOMETRY',
    referenceEnrichment.unresolvedCfLegs.length === 0,
    '全部 CF 航段已具备可追溯的推荐导航台与 theta/rho 几何数据',
    referenceEnrichment.unresolvedCfLegs.map((item) => `${item.procedureName} ${item.sequence} ${item.fix}: ${item.reason}`).join('；'),
  );
  const chartTexts = canonical.chartTexts ?? [];
  check(checks, 'NOTES_CONSTRAINTS', chartTexts.length > 0, `已保留 ${chartTexts.length} 条注记/约束`, '没有经过审核的注记与约束');
  if (['RNAV', 'RNP', 'RNP_AR'].includes(navigationType)) {
    const sourceLegs = canonical.procedures?.flatMap((procedure) => procedure.legs ?? []) ?? [];
    const missingNavSpec = sourceLegs.filter((leg) => !String((leg as Record<string, unknown>).navigationSpecification ?? '').trim());
    check(checks, 'NAVIGATION_SPECIFICATION', sourceLegs.length > 0 && missingNavSpec.length === 0, '全部航段具有导航规范', `${missingNavSpec.length} 条航段缺少导航规范`);
  }
  const speedNoteValues = chartTexts
    .filter((item) => String(item.role ?? '').toUpperCase() === 'SPEED_RESTRICTION')
    .flatMap((item) => [...item.text.matchAll(/(\d{2,3})\s*KIAS/gi)].map((match) => Number(match[1])));
  if (speedNoteValues.length) {
    const legSpeeds = new Set(legs.map((leg) => leg.speedLimitKias).filter((value): value is number => value !== undefined));
    const missing = [...new Set(speedNoteValues)].filter((value) => !legSpeeds.has(value));
    check(checks, 'SPEED_RESTRICTIONS_LINKED', missing.length === 0, '注记速度限制已关联到航段', `速度限制 ${missing.join(', ')} KIAS 尚未关联到航段`);
  }
  const flyOverFixes = chartTexts
    .filter((item) => String(item.role ?? '').toUpperCase() === 'FLY_OVER')
    .map((item) => item.text.match(/^([A-Z0-9]{2,8})\s+IS\s+A\s+FLY/i)?.[1])
    .filter((value): value is string => Boolean(value));
  if (flyOverFixes.length) {
    const missing = flyOverFixes.filter((fix) => !legs.some((leg) => leg.fix === fix && leg.flyOver));
    check(checks, 'FLY_OVER_LINKED', missing.length === 0, 'Fly-over 注记已关联并编码', `Fly-over 定位点 ${missing.join(', ')} 尚未关联到航段`);
  }
  let exportText = '';
  if (legs.length) {
    try {
      exportText = exportCanonical424Text(canonical, legs);
      const lines = exportText.split(/\r?\n/).filter(Boolean);
      check(checks, 'RECORD_WIDTH', lines.length > 0 && lines.every((line) => line.length === 132), `全部 ${lines.length} 条记录均为 132 列`, '导出记录不是严格 132 列');
    } catch (error) {
      checks.push({ code: 'ENCODABLE', status: 'BLOCK', message: error instanceof Error ? error.message : String(error) });
    }
  }
  const now = input.now ?? new Date().toISOString();
  const passed = !checks.some((item) => item.status === 'BLOCK');
  return { ...input.workspace, status: passed ? 'PREFLIGHT_PASSED' : 'PREFLIGHT_BLOCKED', preflight: { passed, checks, checkedAt: now }, dryRun: undefined, diff: undefined, publishedReleaseId: undefined, updatedAt: now };
}

export function createDryRun(workspace: PublicationWorkspace, preview: CanonicalPreviewArtifact, nowValue?: string): PublicationWorkspace {
  if (!workspace.preflight?.passed) throw new Error('发布前预检尚未通过。');
  assertCanonicalStillLocked(workspace, preview);
  const canonical = preview.procedureUnderstanding as ProcedureUnderstandingResult;
  const legs = enrichArinc424References(canonical, aiProcedureToSimpleLegs(canonical)).legs;
  const text = exportCanonical424Text(canonical, legs);
  const now = nowValue ?? new Date().toISOString();
  const coverage = buildArinc424Coverage(canonical, legs, text, now);
  return { ...workspace, status: 'DRY_RUN_READY', dryRun: { text, textHash: contentHash(text), lineCount: text.split(/\r?\n/).filter(Boolean).length, simpleLegCount: legs.length, releaseScope: coverage.releaseScope, airportComplete: coverage.airportComplete, coverage: coverage.items, generatedAt: now }, diff: undefined, updatedAt: now };
}

export function inspectDryRunDiff(workspace: PublicationWorkspace, preview: CanonicalPreviewArtifact, nowValue?: string): PublicationWorkspace {
  if (!workspace.dryRun) throw new Error('请先生成 424 dry-run。');
  assertCanonicalStillLocked(workspace, preview);
  if (contentHash(workspace.dryRun.text) !== workspace.dryRun.textHash) throw new Error('dry-run 文件哈希不一致。');
  const canonical = preview.procedureUnderstanding as ProcedureUnderstandingResult;
  const sourceLegs = enrichArinc424References(canonical, aiProcedureToSimpleLegs(canonical)).legs;
  const parsed = alignJeppesenProcedureNames(sourceLegs, parseJeppesen424Text(workspace.dryRun.text));
  const procedureResults = compareSimpleProcedureLegs(sourceLegs, parsed);
  const blockingDifferenceCount = procedureResults.reduce((sum, procedure) => sum + procedure.legResults.filter((leg) => leg.status !== 'MATCH').length, 0);
  const now = nowValue ?? new Date().toISOString();
  return { ...workspace, status: 'DIFF_REVIEW_REQUIRED', diff: { accepted: false, blockingDifferenceCount, procedureResults, checkedAt: now }, updatedAt: now };
}

export function acceptDryRunDiff(workspace: PublicationWorkspace, nowValue?: string): PublicationWorkspace {
  if (!workspace.diff) throw new Error('请先执行 dry-run 差异检查。');
  if (workspace.diff.blockingDifferenceCount > 0) throw new Error(`仍有 ${workspace.diff.blockingDifferenceCount} 条阻断差异，不能放行。`);
  const now = nowValue ?? new Date().toISOString();
  return { ...workspace, status: 'PUBLISHABLE', diff: { ...workspace.diff, accepted: true, acceptedAt: now }, updatedAt: now };
}

export function assertPublishable(workspace: PublicationWorkspace, preview: CanonicalPreviewArtifact, currentSourceHash: string) {
  if (workspace.status !== 'PUBLISHABLE' || !workspace.diff?.accepted || !workspace.dryRun) throw new Error('发布门禁未全部通过。');
  if (workspace.lock.sourcePackageHash !== currentSourceHash) throw new Error('源文件已变化，发布锁失效。');
  assertCanonicalStillLocked(workspace, preview);
  if (contentHash(workspace.dryRun.text) !== workspace.dryRun.textHash) throw new Error('dry-run 内容被修改。');
}

function assertCanonicalStillLocked(workspace: PublicationWorkspace, preview: CanonicalPreviewArtifact) {
  if (contentHash(preview.procedureUnderstanding) !== workspace.lock.canonicalHash) throw new Error('canonical 快照已变化，必须重新锁定。');
}

export function exportCanonical424Text(canonical: ProcedureUnderstandingResult, legs = aiProcedureToSimpleLegs(canonical)) {
  const enrichedLegs = enrichArinc424References(canonical, legs).legs;
  return simpleLegsTo424Text(enrichedLegs, {
    airportIcao: canonical.airportIcao ?? undefined,
    packageType: canonical.packageType ?? undefined,
    navigationType: canonical.navigationType ?? undefined,
    transitionAltitudeFt: canonical.transitionAltitudeFt ?? undefined,
    holdingFixes: (canonical.holdings ?? []).map((item) => String((item as Record<string, unknown>).fixIdentifier ?? (item as Record<string, unknown>).fix ?? '')).filter(Boolean),
  });
}

function check(checks: PublicationCheck[], code: string, passed: boolean, success: string, failure: string) {
  checks.push({ code, status: passed ? 'PASS' : 'BLOCK', message: passed ? success : failure });
}
