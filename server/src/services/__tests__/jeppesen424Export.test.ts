import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { aiProcedureToSimpleLegs } from '../jeppesen424/aiProcedureToSimpleLegs';
import { enrichArinc424References } from '../jeppesen424/arinc424ReferenceEnricher';
import { buildArinc424Coverage } from '../jeppesen424/arinc424Coverage';
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

  it('preserves reviewed fly-over coding through the 424 round trip', () => {
    const legs = aiProcedureToSimpleLegs({
      airportIcao: 'WMKJ',
      runway: 'RW16',
      packageType: 'SID',
      navigationType: 'RNAV',
      procedures: [{
        procedureName: 'ADLOV 1E',
        runway: 'RW16',
        legs: [
          { sequence: 10, fixIdentifier: 'PORPA', pathTerminator: 'TF', flyOver: true, speedLimitKias: 205 },
          { sequence: 20, fixIdentifier: 'GOVNU', pathTerminator: 'TF' },
        ],
      }],
    });
    const text = simpleLegsTo424Text(legs, { airportIcao: 'WMKJ' });
    assert.equal(text.split('\n')[0].slice(39, 41), 'EY');
    const reparsed = parseJeppesen424Text(text);
    assert.equal(reparsed[0].flyOver, true);
    assert.equal(reparsed[0].speedLimitKias, 205);
    assert.equal(compareSimpleProcedureLegs(legs, reparsed)[0].score, 100);
  });

  it('converts a published metric altitude to a deterministic flight-level token', () => {
    const legs = aiProcedureToSimpleLegs({
      airportIcao: 'VHHH',
      packageType: 'SID',
      navigationType: 'RNP',
      procedures: [{
        procedureName: 'BEKOL 5A',
        runway: 'RW07R',
        legs: [{ sequence: 80, fixIdentifier: 'BEKOL', pathTerminator: 'TF', altitudeConstraint: '+4800m' }],
      }],
    });
    assert.equal(legs[0].altitudeSourceUnit, 'M');
    assert.equal(legs[0].altitudeCode, 'FL157');
    assert.equal(legs[0].altitudeValue, 15700);
    const [primary] = simpleLegsTo424Text(legs, { airportIcao: 'VHHH' }).split('\n');
    assert.equal(primary.slice(84, 89), 'FL157');
    assert.equal(parseJeppesen424Text(primary)[0].altitudeValue, 15700);
  });

  it('uses the production VHHH terminal profile instead of hard-coded SPA/E/2 fields', () => {
    const legs = aiProcedureToSimpleLegs({
      airportIcao: 'VHHH', packageType: 'SID', navigationType: 'RNAV',
      procedures: [{ procedureName: 'BEKOL 5A', runway: 'RW07R', legs: [
        { sequence: 10, fixIdentifier: 'HH301', pathTerminator: 'CF' },
        { sequence: 80, fixIdentifier: 'BEKOL', pathTerminator: 'TF', altitudeConstraint: '+4800m' },
      ] }],
    });
    const [first, , last] = simpleLegsTo424Text(legs, {
      airportIcao: 'VHHH', packageType: 'SID', navigationType: 'RNAV',
    }).split('\n');
    assert.equal(first.slice(0, 5), 'SPACP');
    assert.equal(first[12], 'D');
    assert.equal(first[19], 'N');
    assert.equal(first.slice(34, 38), 'VHPC');
    assert.equal(last.slice(34, 38), 'ZGEA');
    assert.equal(last.slice(84, 89), 'FL157');
  });

  it('encodes RNP, transition altitude, turn, true-course variation and the controlled-magnetic-variation continuation', () => {
    const canonical: ProcedureUnderstandingResult = {
      airportIcao: 'VHHH', packageType: 'SID', navigationType: 'RNAV', transitionAltitudeFt: 9000, magneticVariationDeg: 3,
      procedures: [{ procedureName: 'BEKOL 5A', runway: 'RW07R', legs: [{
        sequence: 10, fixIdentifier: 'HH301', pathTerminator: 'CF', courseDeg: 74, courseTrueDeg: 71,
        turnDirection: 'R', navigationSpecification: 'RNP 1', recommendedNavaid: 'SMT',
      }] }],
    };
    const legs = aiProcedureToSimpleLegs(canonical);
    const [primary, continuation, variation] = simpleLegsTo424Text(legs, {
      airportIcao: 'VHHH', packageType: 'SID', navigationType: 'RNAV', transitionAltitudeFt: canonical.transitionAltitudeFt!,
    }).split('\n');
    assert.equal(primary[43], 'R');
    assert.equal(primary.slice(44, 47), '010');
    assert.equal(primary.slice(47, 49), 'CF');
    assert.equal(primary.slice(50, 56), 'SMT VH');
    assert.equal(primary.slice(70, 74), '0740');
    assert.equal(primary.slice(94, 99), '09000');
    assert.equal(primary.slice(106, 116), 'VHHH  VHPA');
    assert.equal(continuation.slice(38, 40), '2P');
    assert.equal(variation.slice(38, 40), '3E');
    assert.equal(variation.slice(60, 66), 'W0030P');
    assert.equal(variation.slice(118, 120), ' D');
    assert.ok([primary, continuation, variation].every((line) => line.length === 132));
  });

  it('encodes an RF center fix independently from the recommended navaid field', () => {
    const legs = aiProcedureToSimpleLegs({
      airportIcao: 'VHHH', packageType: 'SID', navigationType: 'RNAV',
      procedures: [{ procedureName: 'BEKOL 1X', runway: 'RW07R', legs: [
        { sequence: 30, fixIdentifier: 'HH341', pathTerminator: 'RF', centerFix: 'HH941', turnDirection: 'R', distanceNm: 3.1 },
      ] }],
    });
    const [primary] = simpleLegsTo424Text(legs, { airportIcao: 'VHHH', packageType: 'SID', navigationType: 'RNAV' }).split('\n');
    assert.equal(primary.slice(50, 56), '      ');
    assert.equal(primary.slice(106, 116), 'HH941 VHPC');
  });

  it('never labels a procedure-only export as a complete airport 424 dataset', () => {
    const canonical: ProcedureUnderstandingResult = {
      airportIcao: 'VHHH', packageType: 'SID', navigationType: 'RNAV',
      runways: [{ identifier: 'RW07R' }], fixes: [{ identifier: 'HH301' }],
      navaids: [{ identifier: 'SMT', navaidType: 'DVOR/DME' }],
      procedures: [{ procedureName: 'BEKOL 5A', runway: 'RW07R', legs: [{ sequence: 10, fixIdentifier: 'HH301', pathTerminator: 'CF' }] }],
    };
    const legs = aiProcedureToSimpleLegs(canonical);
    const text = simpleLegsTo424Text(legs, { airportIcao: 'VHHH', packageType: 'SID', navigationType: 'RNAV' });
    const coverage = buildArinc424Coverage(canonical, legs, text, '2026-07-17T00:00:00.000Z');
    assert.equal(coverage.releaseScope, 'PROCEDURE_PACKAGE');
    assert.equal(coverage.airportComplete, false);
    assert.equal(coverage.items.find((item) => item.category === 'PROCEDURE_LEG')?.status, 'COMPLETE');
    assert.equal(coverage.items.find((item) => item.category === 'RUNWAY')?.status, 'NOT_EXPORTED');
    assert.equal(coverage.items.find((item) => item.category === 'AIRPORT_PRIMARY')?.status, 'NOT_EXPORTED');
  });

  it('derives CF recommended-navaid theta/rho from AIP coordinates and refuses ambiguous station selection', () => {
    const canonical: ProcedureUnderstandingResult = {
      airportIcao: 'VHHH', packageType: 'SID', navigationType: 'RNAV', magneticVariationDeg: 3,
      fixes: [
        { identifier: 'HH301', latitude: 22.324725, longitude: 113.986558333 },
        { identifier: 'HH311', latitude: 22.247872222, longitude: 114.086869444 },
      ],
      navaids: [{ identifier: 'SMT', navaidType: 'DVOR/DME', latitude: 22.337619444, longitude: 113.982072222 }],
      procedures: [{ procedureName: 'BEKOL 5A', runway: 'RW07R', legs: [
        { sequence: 10, fixIdentifier: 'HH301', pathTerminator: 'CF' },
        { sequence: 30, fixIdentifier: 'HH311', pathTerminator: 'CF' },
      ] }],
    };
    const enriched = enrichArinc424References(canonical, aiProcedureToSimpleLegs(canonical));
    assert.equal(enriched.unresolvedCfLegs.length, 0);
    assert.deepEqual(
      enriched.legs.map((leg) => [leg.recommendedNavaid, leg.thetaDegMag, leg.rhoNm]),
      [['SMT', 165.1, 0.8], ['SMT', 135.6, 7.9]],
    );
    assert.equal(enriched.legs[0].arincReferenceDerivation?.method, 'AIP_COORDINATE_GEOMETRY');

    const ambiguous = structuredClone(canonical);
    ambiguous.navaids!.push({ identifier: 'ITFR', navaidType: 'DVOR/DME', latitude: 22.3, longitude: 113.9 });
    const unresolved = enrichArinc424References(ambiguous, aiProcedureToSimpleLegs(ambiguous));
    assert.equal(unresolved.unresolvedCfLegs.length, 2);
    assert.equal(unresolved.legs[0].recommendedNavaid, undefined);
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

  it('exports and reparses named enroute transitions as route-type 3 records', () => {
    const aiLegs = aiProcedureToSimpleLegs({
      airportIcao: 'RJTT',
      packageType: 'SID',
      procedures: [{
        procedureName: 'VAMOS FOUR DEPARTURE',
        runway: null,
        transitionName: 'DRAKY',
        legs: [
          { sequence: 10, fixIdentifier: 'VAMOS', pathTerminator: 'IF', altitudeConstraint: { rawText: '+09000', altitudeFt: 9000 } },
          { sequence: 15, fixIdentifier: 'DRAKY', pathTerminator: 'TF', distanceNm: 22.2 },
        ],
      }],
    });
    const exported = simpleLegsTo424Text(aiLegs, { airportIcao: 'RJTT' });
    assert.match(exported, /RJTTRJEVAMOS43DRAKY 010VAMOS/);
    const reparsed = parseJeppesen424Text(exported);
    assert.equal(reparsed.length, 2);
    assert.ok(reparsed.every((leg) => leg.transitionName === 'DRAKY' && leg.runway === ''));
  });

  it('encodes same-number parallel runway lists as the ARINC B runway group', () => {
    const aiLegs = aiProcedureToSimpleLegs({
      airportIcao: 'RJTT',
      procedures: [{
        procedureName: 'VAMOS FOUR DEPARTURE RWY34L/RWY34R',
        runway: 'RWY34L/RWY34R',
        legs: [{ sequence: 10, pathTerminator: 'VA', courseDegMag: 338, altitudeConstraint: { rawText: '+00700', altitudeFt: 700 } }],
      }],
    });
    assert.equal(aiLegs[0].runway, 'RW34B');
    const exported = simpleLegsTo424Text(aiLegs, { airportIcao: 'RJTT' });
    assert.match(exported, /VAMOS42RW34B/);
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
