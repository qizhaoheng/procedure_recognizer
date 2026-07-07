import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { aiProcedureToSimpleLegs } from '../jeppesen424/aiProcedureToSimpleLegs';
import { parseJeppesen424Text } from '../jeppesen424/jeppesen424TextParser';
import { compareSimpleProcedureLegs } from '../jeppesen424/simpleProcedureComparator';
import type { ProcedureUnderstandingResult } from '../../types/procedure';

const sampleText = [
  'SSPAP WMKJWMEADLO1E2RW16010ADLOVWMPC1E       IF                    +06000',
  'SSPAP WMKJWMEADLO1E2RW16020GOVNUWMPC1E       TF                    +03500',
  'SSPAP WMKJWMEADLO1E2RW16020GOVNUWMPC2P                                  0145',
  'SSPAP WMKJWMEADLO1E2RW16030OSRUPWMPC1E       R  TF                 +02000',
  'SSPAP WMKJWMEADLO1E2RW16030OSRUPWMPC2P                                  0060',
  'SSPAP WMKJWMEEMTU1E2RW16010EMTUVWMPC1E       IF                    +06000',
  'SSPAP WMKJWMEEMTU1E2RW16020UDOSUWMPC1E       TF                    +03500',
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
