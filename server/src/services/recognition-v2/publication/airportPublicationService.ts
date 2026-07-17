import crypto from 'node:crypto';
import type { Airport424Aggregate } from '../../jeppesen424/airport424Aggregator';

export interface AirportPublicationSnapshot {
  version: 1;
  releaseId: string;
  taskId: string;
  airportIcao: string;
  text: string;
  textHash: string;
  lineCount: number;
  packageReleases: Airport424Aggregate['packageReleases'];
  coverage: Airport424Aggregate['coverage'];
  publishedAt: string;
}

export interface AirportPublicationRelease {
  releaseId: string;
  artifactFile: string;
  textHash: string;
  lineCount: number;
  packageReleaseCount: number;
  status: 'ACTIVE' | 'SUPERSEDED' | 'ROLLED_BACK';
  publishedAt: string;
  rolledBackAt?: string;
}

export interface AirportPublicationLedger {
  version: 1;
  activeReleaseId?: string;
  releases: AirportPublicationRelease[];
  updatedAt: string;
}

export function createAirportPublicationSnapshot(input: {
  taskId: string;
  aggregate: Airport424Aggregate;
  releaseId: string;
  now?: string;
}): AirportPublicationSnapshot {
  assertAirportAggregatePublishable(input.aggregate);
  const publishedAt = input.now ?? new Date().toISOString();
  return {
    version: 1,
    releaseId: input.releaseId,
    taskId: input.taskId,
    airportIcao: input.aggregate.airportIcao!,
    text: input.aggregate.text,
    textHash: airportTextHash(input.aggregate.text),
    lineCount: input.aggregate.lineCount,
    packageReleases: input.aggregate.packageReleases,
    coverage: input.aggregate.coverage,
    publishedAt,
  };
}

export function addAirportPublicationRelease(
  current: AirportPublicationLedger | undefined,
  snapshot: AirportPublicationSnapshot,
  artifactFile: string,
): AirportPublicationLedger {
  const releases = (current?.releases ?? []).map((item) => item.status === 'ACTIVE' ? { ...item, status: 'SUPERSEDED' as const } : item);
  releases.push({
    releaseId: snapshot.releaseId,
    artifactFile,
    textHash: snapshot.textHash,
    lineCount: snapshot.lineCount,
    packageReleaseCount: snapshot.packageReleases.length,
    status: 'ACTIVE',
    publishedAt: snapshot.publishedAt,
  });
  return { version: 1, activeReleaseId: snapshot.releaseId, releases, updatedAt: snapshot.publishedAt };
}

export function rollbackAirportPublication(
  ledger: AirportPublicationLedger,
  targetReleaseId: string | undefined,
  now = new Date().toISOString(),
): AirportPublicationLedger {
  const active = ledger.releases.find((item) => item.releaseId === ledger.activeReleaseId && item.status === 'ACTIVE');
  if (!active) throw new Error('当前没有可回滚的机场正式版本。');
  const target = targetReleaseId
    ? ledger.releases.find((item) => item.releaseId === targetReleaseId && item.releaseId !== active.releaseId)
    : [...ledger.releases].reverse().find((item) => item.releaseId !== active.releaseId && item.status !== 'ROLLED_BACK');
  if (!target) throw new Error('没有可切换的历史机场正式版本。');
  return {
    ...ledger,
    activeReleaseId: target.releaseId,
    releases: ledger.releases.map((item) => item.releaseId === active.releaseId
      ? { ...item, status: 'ROLLED_BACK' as const, rolledBackAt: now }
      : item.releaseId === target.releaseId ? { ...item, status: 'ACTIVE' as const, rolledBackAt: undefined } : item),
    updatedAt: now,
  };
}

export function assertAirportAggregatePublishable(aggregate: Airport424Aggregate) {
  if (!aggregate.airportComplete || !aggregate.publishable) throw new Error('机场 424 尚未完整，不能正式发布机场版本。');
  if (!aggregate.airportIcao) throw new Error('机场 ICAO 缺失，不能正式发布机场版本。');
  if (!aggregate.text.trim() || aggregate.lineCount === 0) throw new Error('机场 424 内容为空。');
  if (aggregate.missingPackages.length || aggregate.conflicts.length) throw new Error('机场 424 仍有缺包或语义冲突。');
  if (aggregate.coverage.some((item) => item.status !== 'COMPLETE')) throw new Error('机场 424 记录族覆盖尚未完整。');
}

export function airportTextHash(text: string) {
  return `sha256:${crypto.createHash('sha256').update(text).digest('hex')}`;
}
