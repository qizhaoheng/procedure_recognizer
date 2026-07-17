import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ProcedureUnderstandingResult } from '../../types/procedure';
import { aggregateAirport424 } from '../jeppesen424/airport424Aggregator';

function procedureLine(value = '0740', metadata = '') {
  const chars = Array(132).fill(' ');
  write(chars, 0, 'SPACP');
  write(chars, 6, 'VHHH');
  chars[12] = 'D';
  write(chars, 13, 'BEKO5A');
  write(chars, 20, 'RW07R');
  write(chars, 26, '010');
  write(chars, 29, 'HH301');
  write(chars, 34, 'VHPC');
  write(chars, 38, '1E');
  write(chars, 47, 'CF');
  write(chars, 70, value);
  write(chars, 123, metadata);
  return chars.join('');
}

function write(chars: string[], offset: number, value: string) {
  [...value].forEach((character, index) => { chars[offset + index] = character; });
}

function canonical(): ProcedureUnderstandingResult {
  return {
    airportIcao: 'VHHH',
    runways: [{ identifier: 'RW07R' }],
    fixes: [{ identifier: 'HH301' }],
    navaids: [{ identifier: 'SMT', navaidType: 'DVOR/DME' }],
    procedures: [{ procedureName: 'BEKOL 5A', runway: 'RW07R', legs: [{ fixIdentifier: 'HH301', pathTerminator: 'CF' }] }],
  };
}

describe('airport-wide 424 aggregation', () => {
  it('does not call a procedure-package collection airport-complete while master record families are absent', () => {
    const result = aggregateAirport424({
      packages: [{ packageId: 'pkg-bekol', packageName: 'BEKOL 5A' }],
      releases: [{ packageId: 'pkg-bekol', packageName: 'BEKOL 5A', releaseId: 'release-1', runId: 'run-1', text: `${procedureLine()}\n`, canonical: canonical() }],
      now: '2026-07-17T00:00:00.000Z',
    });
    assert.equal(result.releaseScope, 'AIRPORT');
    assert.equal(result.airportIcao, 'VHHH');
    assert.equal(result.airportComplete, false);
    assert.equal(result.publishable, false);
    assert.equal(result.coverage.find((item) => item.category === 'PROCEDURE_LEG')?.status, 'COMPLETE');
    assert.equal(result.coverage.find((item) => item.category === 'AIRPORT_PRIMARY')?.status, 'NOT_EXPORTED');
  });

  it('reports every airport package that has no active immutable release', () => {
    const result = aggregateAirport424({
      packages: [
        { packageId: 'pkg-bekol', packageName: 'BEKOL 5A' },
        { packageId: 'pkg-lampi', packageName: 'LAMPI 3A' },
      ],
      releases: [{ packageId: 'pkg-bekol', packageName: 'BEKOL 5A', releaseId: 'release-1', runId: 'run-1', text: `${procedureLine()}\n`, canonical: canonical() }],
    });
    assert.deepEqual(result.missingPackages, [{ packageId: 'pkg-lampi', packageName: 'LAMPI 3A', reason: 'NO_ACTIVE_RELEASE' }]);
    assert.equal(result.activeReleaseCount, 1);
    assert.equal(result.packageCount, 2);
  });

  it('deduplicates supplier metadata but preserves semantic conflicts as blockers', () => {
    const same = aggregateAirport424({
      packages: [{ packageId: 'a', packageName: 'A' }, { packageId: 'b', packageName: 'B' }],
      releases: [
        { packageId: 'a', packageName: 'A', releaseId: 'ra', runId: 'r1', text: `${procedureLine('0740', '000012507')}\n`, canonical: canonical() },
        { packageId: 'b', packageName: 'B', releaseId: 'rb', runId: 'r2', text: `${procedureLine('0740', '999992507')}\n`, canonical: canonical() },
      ],
    });
    assert.equal(same.lineCount, 1);
    assert.equal(same.duplicateLineCount, 1);
    assert.equal(same.conflicts.length, 0);
    assert.equal(same.text.split('\n')[0].slice(123), ' '.repeat(9));

    const conflict = aggregateAirport424({
      packages: [{ packageId: 'a', packageName: 'A' }, { packageId: 'b', packageName: 'B' }],
      releases: [
        { packageId: 'a', packageName: 'A', releaseId: 'ra', runId: 'r1', text: `${procedureLine('0740')}\n`, canonical: canonical() },
        { packageId: 'b', packageName: 'B', releaseId: 'rb', runId: 'r2', text: `${procedureLine('0750')}\n`, canonical: canonical() },
      ],
    });
    assert.equal(conflict.lineCount, 2);
    assert.equal(conflict.conflicts.length, 1);
    assert.deepEqual(conflict.conflicts[0].packageIds, ['a', 'b']);
    assert.equal(conflict.publishable, false);
  });
});
