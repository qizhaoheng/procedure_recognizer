import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { extractConstraintObservations } from '../recognition-v2/notes/notesConstraintsExecutor';
import { resolveCanonicalNavigationType } from '../recognition-v2/adapters/canonicalPreviewAdapter';

describe('Recognition V2 Phase 6.2 notes and constraints', () => {
  it('recovers operational constraints from imperfect raster OCR without inventing values', () => {
    const observations = extractConstraintObservations([
      'lnitial climb to 5 000 ft. Expect further climb when instructed by ATC.',
      'TERRAIN CLEARANCE M nimum climb gradient of 4.8% (292 ft/NM) until passing 1 200 ft is required.',
      'S peed restriction Of 205 KIAS or greater at PORPA and 220 KIAS until HH311.',
      'PORPA is a FLY-OVE R waypoint.',
    ].join(' '), 79, 'PROCEDURE_NOTES');
    assert.deepEqual(observations.map((item) => item.constraintType).sort(), [
      'CLIMB_GRADIENT', 'FLY_OVER', 'INITIAL_CLIMB', 'SPEED_RESTRICTION',
    ]);
    assert.ok(observations.some((item) => item.text?.includes('4.8%')));
    assert.ok(observations.some((item) => item.text?.includes('205 KIAS')));
    assert.ok(observations.every((item) => !item.text?.includes('Civil Aviation')));
  });

  it('replaces a placeholder navigation type only when reviewed legs prove RNAV/RNP navigation', () => {
    assert.equal(resolveCanonicalNavigationType('-', [{ navigationSpecification: 'RNP 1' }]), 'RNAV');
    assert.equal(resolveCanonicalNavigationType('CONVENTIONAL', [{ navigationSpecification: 'RNP 1' }]), 'CONVENTIONAL');
    assert.equal(resolveCanonicalNavigationType('-', [{ pathTerminator: 'TF' }]), undefined);
  });
});
