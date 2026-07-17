import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CanonicalPreviewArtifact } from '../recognition-v2/contracts/index';
import { RECOGNITION_V2_CONTRACT_VERSION, RECOGNITION_V2_SCHEMA_IDS } from '../recognition-v2/contracts/index';
import { assertValidPublicationWorkspace } from '../recognition-v2/contracts/schemaValidation';
import {
  acceptDryRunDiff,
  assertPublishable,
  createDryRun,
  createPublicationLock,
  inspectDryRunDiff,
  runPublicationPreflight,
  addPublishedRelease,
  markReleaseRolledBack,
} from '../recognition-v2/publication/publicationService';

const preview: CanonicalPreviewArtifact = {
  contractVersion: RECOGNITION_V2_CONTRACT_VERSION,
  schemaId: RECOGNITION_V2_SCHEMA_IDS.canonicalPreview,
  releaseDecision: 'READY', warnings: [], generatedAt: '2026-07-16T00:00:00.000Z',
  procedureUnderstanding: {
    airportIcao: 'WMKJ', packageType: 'STAR', navigationType: 'RNAV', runway: 'RW16',
    chartTexts: [{ text: 'Maintain RNAV 1.', role: 'NAVIGATION_REQUIREMENT', usedInProcedure: true }],
    procedures: [{ procedureName: 'ADLOV 1E', runway: 'RW16', legs: [
      { sequence: 10, fixIdentifier: 'ADLOV', pathTerminator: 'IF', navigationSpecification: 'RNAV 1', altitudeConstraint: { rawText: '-06000', altitudeFt: 6000 } },
      { sequence: 20, fixIdentifier: 'GOVNU', pathTerminator: 'TF', navigationSpecification: 'RNAV 1', distanceNm: 14.5, altitudeConstraint: { rawText: '+03500', altitudeFt: 3500 } },
    ] }],
  },
};

function locked() {
  return createPublicationLock({ taskId: 'task-1', packageId: 'pkg-1', runId: 'run-1', sourcePackageHash: 'sha256:source', canonicalPreviewRef: 'artifacts/preview.json', reviewOutputRef: 'artifacts/review.json', preview, now: '2026-07-16T00:00:01.000Z' });
}

describe('Recognition V2 Phase 6 publication gate', () => {
  it('locks READY data and validates the persisted contract', async () => {
    const workspace = locked();
    assert.equal(workspace.status, 'LOCKED');
    await assert.doesNotReject(assertValidPublicationWorkspace(workspace));
  });

  it('blocks preflight when source data changed after locking', () => {
    const workspace = runPublicationPreflight({ workspace: locked(), preview, currentSourcePackageHash: 'sha256:changed', runApproved: true });
    assert.equal(workspace.status, 'PREFLIGHT_BLOCKED');
    assert.equal(workspace.preflight?.checks.find((item) => item.code === 'SOURCE_UNCHANGED')?.status, 'BLOCK');
  });

  it('requires every gate and round-trips the 132-column dry-run without differences', () => {
    const preflight = runPublicationPreflight({ workspace: locked(), preview, currentSourcePackageHash: 'sha256:source', runApproved: true });
    assert.equal(preflight.status, 'PREFLIGHT_PASSED');
    const dryRun = createDryRun(preflight, preview);
    assert.ok(dryRun.dryRun?.text.split('\n').every((line) => line.length === 132));
    assert.equal(dryRun.dryRun?.releaseScope, 'PROCEDURE_PACKAGE');
    assert.equal(dryRun.dryRun?.airportComplete, false);
    assert.ok(dryRun.dryRun?.coverage?.some((item) => item.category === 'AIRPORT_PRIMARY' && item.status === 'NOT_EXPORTED'));
    assert.throws(() => assertPublishable(dryRun, preview, 'sha256:source'), /门禁/);
    const inspected = inspectDryRunDiff(dryRun, preview);
    assert.equal(inspected.diff?.blockingDifferenceCount, 0);
    assert.throws(() => assertPublishable(inspected, preview, 'sha256:source'), /门禁/);
    const accepted = acceptDryRunDiff(inspected);
    assert.equal(accepted.status, 'PUBLISHABLE');
    assert.doesNotThrow(() => assertPublishable(accepted, preview, 'sha256:source'));
  });

  it('invalidates a lock if canonical data is changed', () => {
    const preflight = runPublicationPreflight({ workspace: locked(), preview, currentSourcePackageHash: 'sha256:source', runApproved: true });
    const changed = structuredClone(preview);
    changed.procedureUnderstanding.airportIcao = 'VHHH';
    assert.throws(() => createDryRun(preflight, changed), /快照已变化/);
  });

  it('blocks placeholder navigation types and missing reviewed notes', () => {
    const incomplete = structuredClone(preview);
    incomplete.procedureUnderstanding.navigationType = '-';
    incomplete.procedureUnderstanding.chartTexts = [];
    const workspace = createPublicationLock({ taskId: 'task-1', packageId: 'pkg-1', runId: 'run-1', sourcePackageHash: 'sha256:source', canonicalPreviewRef: 'artifacts/preview.json', reviewOutputRef: 'artifacts/review.json', preview: incomplete });
    const preflight = runPublicationPreflight({ workspace, preview: incomplete, currentSourcePackageHash: 'sha256:source', runApproved: true });
    assert.equal(preflight.status, 'PREFLIGHT_BLOCKED');
    assert.equal(preflight.preflight?.checks.find((item) => item.code === 'NAVIGATION_TYPE')?.status, 'BLOCK');
    assert.equal(preflight.preflight?.checks.find((item) => item.code === 'NOTES_CONSTRAINTS')?.status, 'BLOCK');
  });

  it('blocks CF publication when the recommended navaid cannot be selected without guessing', () => {
    const incomplete = structuredClone(preview);
    incomplete.procedureUnderstanding.fixes = [{ identifier: 'HH301', latitude: 22.32, longitude: 113.98 }];
    incomplete.procedureUnderstanding.navaids = [
      { identifier: 'SMT', navaidType: 'DVOR/DME', latitude: 22.33, longitude: 113.98 },
      { identifier: 'ITFR', navaidType: 'DVOR/DME', latitude: 22.30, longitude: 113.90 },
    ];
    incomplete.procedureUnderstanding.procedures![0].legs![0] = {
      sequence: 10, fixIdentifier: 'HH301', pathTerminator: 'CF', navigationSpecification: 'RNAV 1',
    };
    const workspace = createPublicationLock({ taskId: 'task-1', packageId: 'pkg-1', runId: 'run-1', sourcePackageHash: 'sha256:source', canonicalPreviewRef: 'artifacts/preview.json', reviewOutputRef: 'artifacts/review.json', preview: incomplete });
    const preflight = runPublicationPreflight({ workspace, preview: incomplete, currentSourcePackageHash: 'sha256:source', runApproved: true });
    assert.equal(preflight.preflight?.checks.find((item) => item.code === 'CF_REFERENCE_GEOMETRY')?.status, 'BLOCK');
  });

  it('keeps immutable release history while superseding and rolling back the active version', () => {
    const first = { releaseId: 'release-1', runId: 'run-1', artifactRef: 'artifacts/release-1.json', canonicalHash: 'sha256:c1', textHash: 'sha256:t1', status: 'ACTIVE' as const, publishedAt: '2026-07-16T01:00:00.000Z' };
    const second = { ...first, releaseId: 'release-2', runId: 'run-2', artifactRef: 'artifacts/release-2.json', canonicalHash: 'sha256:c2', textHash: 'sha256:t2', publishedAt: '2026-07-16T02:00:00.000Z' };
    const one = addPublishedRelease(undefined, first);
    const two = addPublishedRelease(one, second);
    assert.equal(two.releases.find((item) => item.releaseId === 'release-1')?.status, 'SUPERSEDED');
    const rolledBack = markReleaseRolledBack(two, 'release-2', 'release-1', '2026-07-16T03:00:00.000Z');
    assert.equal(rolledBack.activeReleaseId, 'release-1');
    assert.equal(rolledBack.releases.find((item) => item.releaseId === 'release-2')?.status, 'ROLLED_BACK');
    assert.equal(rolledBack.releases.find((item) => item.releaseId === 'release-1')?.status, 'ACTIVE');
    assert.throws(() => markReleaseRolledBack(rolledBack, 'release-2', undefined, '2026-07-16T04:00:00.000Z'), /已变化/);
  });
});
