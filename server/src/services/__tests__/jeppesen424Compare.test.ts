import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { aiProcedureToSimpleLegs } from '../jeppesen424/aiProcedureToSimpleLegs';
import { parseJeppesen424Text } from '../jeppesen424/jeppesen424TextParser';
import { compareSimpleProcedureLegs } from '../jeppesen424/simpleProcedureComparator';
import type { ProcedureUnderstandingResult } from '../../types/procedure';

const sampleText = [
  'SSPAP WMKJWMEADLO1E2RW16010ADLOVWMEA1E       IF                    +06000',
  'SSPAP WMKJWMEADLO1E2RW16020GOVNUWMPC1E       TF                    +03500',
  'SSPAP WMKJWMEADLO1E2RW16020GOVNUWMPC2P                                  0145',
  'SSPAP WMKJWMEADLO1E2RW16030OSRUPWMPC1EE      R  TF                 +02000',
  'SSPAP WMKJWMEADLO1E2RW16030OSRUPWMPC2P                                  0060',
  'SSPAP WMKJWMEEMTU1E2RW16010EMTUVWMEA1E       IF                    +06000',
  'SSPAP WMKJWMEEMTU1E2RW16020UDOSUWMPC1EE      TF                    +03500',
  'SSPAP WMKJWMEEMTU1E2RW16020UDOSUWMPC2P                                  0134',
].join('\n');

describe('Jeppesen 424 text compare MVP', () => {
  it('parses 1E records and merges 2P distances', () => {
    const legs = parseJeppesen424Text(sampleText);
    assert.equal(legs.length, 5);
    assert.deepEqual(
      legs
        .filter((leg) => leg.procedureName === 'ADLOV 1E')
        .map((leg) => ({
          sequence: leg.sequence,
          fix: leg.fix,
          pathTerminator: leg.pathTerminator,
          distanceNm: leg.distanceNm,
          altitudeRaw: leg.altitudeRaw,
          altitudeValue: leg.altitudeValue,
        })),
      [
        { sequence: '010', fix: 'ADLOV', pathTerminator: 'IF', distanceNm: undefined, altitudeRaw: '+06000', altitudeValue: 6000 },
        { sequence: '020', fix: 'GOVNU', pathTerminator: 'TF', distanceNm: 14.5, altitudeRaw: '+03500', altitudeValue: 3500 },
        { sequence: '030', fix: 'OSRUP', pathTerminator: 'TF', distanceNm: 6, altitudeRaw: '+02000', altitudeValue: 2000 },
      ],
    );
  });

  it('extracts extended fields (course/alt2/hold/EE/fix section) from full-width records', () => {
    const fullWidthText = [
      'SSPAP WMKJWMEADLO1E2RW16  010ADLOVWMEA1E  H    IF                                 - 06000     13000       VJB   WMD    D   003302209',
      'SSPAP WMKJWMEADLO1G2RW16  040D340KWMPC1E   L   AF VJB WM      340001100160    D                                       DG   003432213',
      'SSPAP WMKJWMEADLO1G2RW16  050OSRUPWMPC1EE      TF                                 + 02000                             DG   003452209',
    ].join('\n');
    const legs = parseJeppesen424Text(fullWidthText);
    const byKey = new Map(legs.map((leg) => [`${leg.procedureName}|${leg.sequence}`, leg]));

    const entry = byKey.get('ADLOV 1E|010');
    assert.equal(entry?.altitudeSign, '-');
    assert.equal(entry?.altitudeValue, 6000);
    assert.equal(entry?.altitudeUpperFt, 13000);
    assert.equal(entry?.holdingAtFix, true);
    assert.equal(entry?.fixSection, 'EA');
    assert.equal(entry?.courseDegMag, undefined);
    assert.equal(entry?.recommendedNavaid, 'VJB');

    const arc = byKey.get('ADLOV 1G|040');
    assert.equal(arc?.pathTerminator, 'AF');
    assert.equal(arc?.turnDirection, 'L');
    assert.equal(arc?.courseDegMag, 16);
    assert.equal(arc?.fixSection, 'PC');
    assert.equal(arc?.recommendedNavaid, 'VJB');

    const final = byKey.get('ADLOV 1G|050');
    assert.equal(final?.endOfProcedure, true);
    assert.equal(final?.altitudeSign, '+');
  });

  it('compares AI procedure legs against parsed Jeppesen legs', () => {
    const understanding: ProcedureUnderstandingResult = {
      runway: 'RW16',
      procedures: [
        {
          procedureName: 'ADLOV 1E',
          runway: 'RW16',
          legs: [
            { sequence: 10, fixIdentifier: 'ADLOV', pathTerminator: 'IF', altitudeConstraint: { rawText: '+06000', altitudeFt: 6000 } },
            { sequence: 20, fixIdentifier: 'GOVNU', pathTerminator: 'TF', distanceNm: 14.5, altitudeConstraint: { rawText: '+03500', altitudeFt: 3500 } },
            { sequence: 30, fixIdentifier: 'OSRUP', pathTerminator: 'TF', distanceNm: 6, turnDirection: 'R', altitudeConstraint: { rawText: '+02000', altitudeFt: 2000 } },
          ],
        },
      ],
      fixes: [],
      sourceEvidence: [],
      warnings: [],
      confidence: 1,
      reviewRequired: false,
    };

    const aiLegs = aiProcedureToSimpleLegs(understanding);
    const jeppesenLegs = parseJeppesen424Text(sampleText).filter((leg) => leg.procedureName === 'ADLOV 1E');
    const [result] = compareSimpleProcedureLegs(aiLegs, jeppesenLegs);
    assert.equal(result.procedureName, 'ADLOV 1E');
    assert.equal(result.score, 100);
    assert.equal(result.matchedLegs, 3);
  });
});
