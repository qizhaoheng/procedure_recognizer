import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseReviewCorrection } from '../../../../src/utils/reviewCorrection';

describe('review correction input', () => {
  it('allows one scalar to resolve an array of conflicting string candidates', () => {
    assert.equal(parseReviewCorrection('MABIX 2A', ['MABIX 2A', 'MABIX']), 'MABIX 2A');
  });

  it('still accepts real arrays and objects as JSON', () => {
    assert.deepEqual(parseReviewCorrection('["09L","09R"]', ['09L']), ['09L', '09R']);
    assert.deepEqual(parseReviewCorrection('{"from":"A","to":"B"}', { from: 'A' }), { from: 'A', to: 'B' });
  });
});
