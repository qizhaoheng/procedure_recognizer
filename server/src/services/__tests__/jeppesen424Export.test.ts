import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { aiProcedureToSimpleLegs } from '../jeppesen424/aiProcedureToSimpleLegs';
import { parseJeppesen424Text } from '../jeppesen424/jeppesen424TextParser';
import { simpleLegsTo424Text } from '../jeppesen424/simpleLegsTo424Text';
import { compareSimpleProcedureLegs } from '../jeppesen424/simpleProcedureComparator';
import type { ProcedureUnderstandingResult } from '../../types/procedure';

const understanding: ProcedureUnderstandingResult = {
  airportIcao: 'WMKJ',
  runway: 'RW16',
  holdings: [{ fixIdentifier: 'ADLOV' }],
  procedures: [
    {
      procedureName: 'ADLOV 1E',
      runway: 'RW16',
      legs: [
        { sequence: 10, fixIdentifier: 'ADLOV', pathTerminator: 'IF', altitudeConstraint: { rawText: '-06000', altitudeFt: 6000 } },
        { sequence: 20, fixIdentifier: 'GOVNU', pathTerminator: 'TF', distanceNm: 14.5, altitudeConstraint: { rawText: '+03500', altitudeFt: 3500 } },
        { sequence: 30, fixIdentifier: 'OSRUP', pathTerminator: 'TF', distanceNm: 6, altitudeConstraint: { rawText: '+02000', altitudeFt: 2000 } },
      ],
    },
  ],
};

// 真实 Jeppesen 静态文本（ADLOV 1E，剔除我们不生成的 3E 续行）。
const realJeppesenLines = [
  'SSPAP WMKJWMEADLO1E2RW16  010ADLOVWMEA1E  H    IF                                 - 06000     13000       VJB   WMD    D   003302209',
  'SSPAP WMKJWMEADLO1E2RW16  010ADLOVWMEA2P                                                                                   003312209',
  'SSPAP WMKJWMEADLO1E2RW16  020GOVNUWMPC1E       TF                                 + 03500                              D   003332209',
  'SSPAP WMKJWMEADLO1E2RW16  020GOVNUWMPC2P                                  0145                                             003342209',
  'SSPAP WMKJWMEADLO1E2RW16  030OSRUPWMPC1EE      TF                                 + 02000                              D   003352209',
  'SSPAP WMKJWMEADLO1E2RW16  030OSRUPWMPC2P                                  0060                                             003362209',
];

// AI 结果中不存在的字段：第二高度(94-98)、推荐导航台 VJB(106-108)/WMD(112-114)、
// 文件记录号+周期号(123-131)。比对时将这些列抹空。
function withoutUnsupportedFields(line: string) {
  const ranges: Array<[number, number]> = [[94, 99], [106, 109], [112, 115], [123, 132]];
  const chars = [...line];
  for (const [start, end] of ranges) {
    for (let i = start; i < end; i += 1) chars[i] = ' ';
  }
  return chars.join('');
}

describe('Jeppesen 424 export', () => {
  it('matches the real Jeppesen 132-column layout on every field we emit', () => {
    const aiLegs = aiProcedureToSimpleLegs(understanding);
    const exported = simpleLegsTo424Text(aiLegs, { airportIcao: 'WMKJ', holdingFixes: ['ADLOV'] });
    assert.deepEqual(exported.split('\n'), realJeppesenLines.map(withoutUnsupportedFields));
  });

  it('round-trips: exported text parses back and matches AI legs at 100%', () => {
    const aiLegs = aiProcedureToSimpleLegs(understanding);
    const exported = simpleLegsTo424Text(aiLegs, { airportIcao: 'WMKJ', holdingFixes: ['ADLOV'] });
    const reparsedLegs = parseJeppesen424Text(exported);
    assert.equal(reparsedLegs.length, aiLegs.length);

    const [result] = compareSimpleProcedureLegs(aiLegs, reparsedLegs);
    assert.equal(result.procedureName, 'ADLOV 1E');
    assert.equal(result.score, 100);
    assert.equal(result.matchedLegs, aiLegs.length);
  });

  it('preserves RNAV STAR entry coding and strips inferred TF turns', () => {
    const aiLegs = aiProcedureToSimpleLegs({
      airportIcao: 'WMKJ',
      runway: 'RW16',
      packageType: 'STAR',
      navigationType: 'RNAV',
      procedures: [
        {
          procedureName: 'ADLOV 1E',
          runway: 'RW16',
          legs: [
            {
              sequence: 10,
              fixIdentifier: 'ADLOV',
              pathTerminator: 'IF',
              altitudeConstraint: { rawText: '-06000 13000' },
              holdingAtFix: true,
              recommendedNavaid: 'VJB',
            },
            {
              sequence: 20,
              fixIdentifier: 'OSRUP',
              pathTerminator: 'TF',
              turnDirection: 'R',
              distanceNm: 6,
              altitudeConstraint: { rawText: '+02000' },
            },
          ],
        },
      ],
    });

    const exported = simpleLegsTo424Text(aiLegs, { airportIcao: 'WMKJ' });
    const [entry, final] = parseJeppesen424Text(exported);

    assert.equal(entry.holdingAtFix, true);
    assert.equal(entry.altitudeSign, '-');
    assert.equal(entry.altitudeValue, 6000);
    // rawText 里跟随的 13000 是过渡高度层，不再作为腿段第二高度导出/解析
    assert.equal(entry.altitudeUpperFt, undefined);
    assert.equal(entry.recommendedNavaid, 'VJB');
    assert.equal(final.turnDirection, '');
  });

  it('exports RNAV SID no-fix CA coding used by the static Jeppesen comparison', () => {
    const aiLegs = aiProcedureToSimpleLegs({
      airportIcao: 'WMKJ',
      runway: 'RW16',
      packageType: 'SID',
      navigationType: 'RNAV',
      procedures: [
        {
          procedureName: 'ADLOV 1J',
          runway: 'RW16',
          legs: [
            {
              sequence: 10,
              pathTerminator: 'CA',
              courseDegMag: 160,
              distanceNm: 2,
              altitudeConstraint: { rawText: '+01000 11000', altitudeFt: 1000, upperFt: 11000 },
              recommendedNavaid: 'VJB',
            },
            {
              sequence: 20,
              fixIdentifier: 'INVOV',
              pathTerminator: 'DF',
              turnDirection: 'R',
              distanceNm: 12,
              altitudeConstraint: { rawText: '+06000', altitudeFt: 6000 },
            },
          ],
        },
      ],
    });

    const [first] = parseJeppesen424Text(simpleLegsTo424Text(aiLegs, { airportIcao: 'WMKJ' }));
    assert.equal(first.fix, '');
    assert.equal(first.pathTerminator, 'CA');
    assert.equal(first.fixSection, undefined);
    assert.equal(first.courseDegMag, 160);
    assert.equal(first.distanceNm, 2);
    assert.equal(first.altitudeValue, 1000);
    assert.equal(first.altitudeUpperFt, 11000);
    assert.equal(first.recommendedNavaid, 'VJB');
  });

  it('marks DME ARC (1G) procedures with the DG qualifier and turn direction', () => {
    const aiLegs = aiProcedureToSimpleLegs({
      airportIcao: 'WMKJ',
      runway: 'RW16',
      procedures: [
        {
          procedureName: 'EMTUV 1G',
          runway: 'RW16',
          legs: [
            { sequence: 10, fixIdentifier: 'EMTUV', pathTerminator: 'IF' },
            { sequence: 20, fixIdentifier: 'D295K', pathTerminator: 'AF', turnDirection: 'R', distanceNm: 3.8 },
          ],
        },
      ],
    });
    const [first, , second] = simpleLegsTo424Text(aiLegs, { airportIcao: 'WMKJ' }).split('\n');
    assert.equal(first.slice(118, 120), 'DG');
    assert.equal(second[43], 'R');
    assert.equal(second.slice(47, 49), 'AF');
  });

  it('derives route codes for procedures outside the explicit map', () => {
    const aiLegs = aiProcedureToSimpleLegs({
      airportIcao: 'WMKJ',
      runway: 'RW16',
      procedures: [
        {
          procedureName: 'MABIX 2A',
          runway: 'RW16',
          legs: [{ sequence: 10, fixIdentifier: 'MABIX', pathTerminator: 'IF', altitudeConstraint: { rawText: '+05000', altitudeFt: 5000 } }],
        },
      ],
    });
    const exported = simpleLegsTo424Text(aiLegs, { airportIcao: 'WMKJ' });
    assert.match(exported, /WMKJWMEMABI2A2RW16  010MABIX/);
  });

  it('rejects legs it cannot encode with a descriptive error', () => {
    const aiLegs = aiProcedureToSimpleLegs({
      airportIcao: 'WMKJ',
      runway: 'RW16',
      procedures: [
        {
          procedureName: 'ARRIVAL ONE',
          runway: 'RW16',
          legs: [{ sequence: 10, fixIdentifier: 'ADLOV', pathTerminator: 'IF' }],
        },
      ],
    });
    assert.throws(() => simpleLegsTo424Text(aiLegs, { airportIcao: 'WMKJ' }), /路线代码/);
  });
});
