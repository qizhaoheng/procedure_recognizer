import assert from 'node:assert/strict';
import test from 'node:test';
import { addAirportPublicationRelease, createAirportPublicationSnapshot, rollbackAirportPublication } from '../recognition-v2/publication/airportPublicationService';
import type { Airport424Aggregate } from '../jeppesen424/airport424Aggregator';

function aggregate(overrides: Partial<Airport424Aggregate> = {}): Airport424Aggregate {
  return {
    releaseScope: 'AIRPORT', airportIcao: 'VHHH', airportComplete: true, publishable: true,
    packageCount: 1, activeReleaseCount: 1, packageReleases: [{ packageId: 'pkg', packageName: 'SID', releaseId: 'package-release', runId: 'run' }],
    missingPackages: [], conflicts: [], coverage: [{ category: 'PROCEDURE_LEG', sourceCount: 1, exportedCount: 1, status: 'COMPLETE', message: 'ok' }],
    text: `${'S'.padEnd(132, ' ')}\n`, lineCount: 1, duplicateLineCount: 0, masterEncodingIssues: [], generatedAt: '2026-07-17T00:00:00.000Z',
    ...overrides,
  };
}

test('airport formal release is immutable, versioned and rollbackable', () => {
  const first = createAirportPublicationSnapshot({ taskId: 'task', aggregate: aggregate(), releaseId: 'airport-1', now: '2026-07-17T00:00:00.000Z' });
  let ledger = addAirportPublicationRelease(undefined, first, 'airport-1.json');
  const second = createAirportPublicationSnapshot({ taskId: 'task', aggregate: aggregate({ text: `${'T'.padEnd(132, ' ')}\n` }), releaseId: 'airport-2', now: '2026-07-18T00:00:00.000Z' });
  ledger = addAirportPublicationRelease(ledger, second, 'airport-2.json');
  assert.equal(ledger.activeReleaseId, 'airport-2');
  assert.equal(ledger.releases[0].status, 'SUPERSEDED');
  ledger = rollbackAirportPublication(ledger, 'airport-1', '2026-07-19T00:00:00.000Z');
  assert.equal(ledger.activeReleaseId, 'airport-1');
  assert.equal(ledger.releases[1].status, 'ROLLED_BACK');
});

test('airport formal release rejects an incomplete live aggregate', () => {
  assert.throws(() => createAirportPublicationSnapshot({ taskId: 'task', aggregate: aggregate({ airportComplete: false, publishable: false }), releaseId: 'bad' }), /尚未完整/);
});
