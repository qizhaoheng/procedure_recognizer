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

const sidSampleText = [
  'SSPAP WMKJWMDADLO1J2RW16  010         1        CA                     1600        + 01000     11000       VJB   WMD    D   001572209',
  'SSPAP WMKJWMDADLO1J2RW16  010         2P                                  0020                                             001582209',
  'SSPAP WMKJWMDADLO1J2RW16  020INVOVWMPC1E   R   DF                                 + 06000                              D   001602209',
  'SSPAP WMKJWMDADLO1J2RW16  020INVOVWMPC2P                                  0120                                             001612209',
  'SSPAP WMKJWMDADLO1J2RW16  030UDOSUWMPC1E       TF                                                                      D   001622209',
  'SSPAP WMKJWMDADLO1J2RW16  030UDOSUWMPC2P                                  0056                                             001632209',
  'SSPAP WMKJWMDADLO1J2RW16  040ADLOVWMEA1EE      TF                                 + 06000                              D   001642209',
  'SSPAP WMKJWMDADLO1J2RW16  040ADLOVWMEA2P                                  0238                                             001652209',
].join('\n');

const conventionalSid1LSampleText = [
  'SSPAP WMKJWMDAROS1L2RW16  010         1        CA                     1600        + 01000     11000       VJB   WMD   DG   002062209',
  'SSPAP WMKJWMDAROS1L2RW16  010         2P                                  0020                                             002072209',
  'SSPAP WMKJWMDAROS1L2RW16  020         1    R   CRYVJB WM      2700    3500    D   + 06000                             DG   002082209',
  'SSPAP WMKJWMDAROS1L2RW16  020         2P                                  0090                                             002092209',
  'SSPAP WMKJWMDAROS1L2RW16  030         1        CI                     3500                                            DG   002102209',
  'SSPAP WMKJWMDAROS1L2RW16  030         2P                                  0110                                             002112209',
  'SSPAP WMKJWMDAROS1L2RW16  040AROSOWMEA1EE      CF VJB WM      3320032633200220D   + 06000                             DG   002122209',
  'SSPAP WMKJWMDAROS1L2RW16  040AROSOWMEA2P                                  0220                                             002132209',
  'SSPAP WMKJWMDPIMO1L2RW16  010         1        CA                     1600        + 01000     11000       VJB   WMD   DG   002832209',
  'SSPAP WMKJWMDPIMO1L2RW16  010         2P                                  0020                                             002842209',
  'SSPAP WMKJWMDPIMO1L2RW16  020         1    R   CI                     2660                                            DG   002852209',
  'SSPAP WMKJWMDPIMO1L2RW16  020         2P                                  0110                                             002862209',
  'SSPAP WMKJWMDPIMO1L2RW16  030PIMOKWMEA1EE      CF VJB WM      2364023523600150D   + 06000                             DG   002872209',
  'SSPAP WMKJWMDPIMO1L2RW16  030PIMOKWMEA2P                                  0150                                             002882209',
  'SSPAP WMKJWMDSABK1L2RW16  010         1        CA                     1600        + 01000     11000       VJB   WMD   DG   003072209',
  'SSPAP WMKJWMDSABK1L2RW16  010         2P                                  0020                                             003082209',
  'SSPAP WMKJWMDSABK1L2RW16  020         1    R   CRYVJB WM      2700    3330    D   + 06000                             DG   003092209',
  'SSPAP WMKJWMDSABK1L2RW16  020         2P                                  0100                                             003102209',
  'SSPAP WMKJWMDSABK1L2RW16  030         1        CI                     3330                                            DG   003112209',
  'SSPAP WMKJWMDSABK1L2RW16  030         2P                                  0030                                             003122209',
  'SSPAP WMKJWMDSABK1L2RW16  040SABKAWMEA1EE      CF VJB WM      2960025029600190D   + 06000                             DG   003132209',
  'SSPAP WMKJWMDSABK1L2RW16  040SABKAWMEA2P                                  0190                                             003142209',
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

  it('parses WMD SID records including no-fix CA legs', () => {
    const legs = parseJeppesen424Text(sidSampleText);
    assert.deepEqual(
      legs.map((leg) => ({
        procedureName: leg.procedureName,
        runway: leg.runway,
        sequence: leg.sequence,
        fix: leg.fix,
        pathTerminator: leg.pathTerminator,
        turnDirection: leg.turnDirection,
        distanceNm: leg.distanceNm,
        altitudeValue: leg.altitudeValue,
        altitudeUpperFt: leg.altitudeUpperFt,
        courseDegMag: leg.courseDegMag,
        recommendedNavaid: leg.recommendedNavaid,
        endOfProcedure: leg.endOfProcedure,
      })),
      [
        {
          procedureName: 'ADLOV 1J',
          runway: 'RW16',
          sequence: '010',
          fix: '',
          pathTerminator: 'CA',
          turnDirection: '',
          distanceNm: 2,
          altitudeValue: 1000,
          altitudeUpperFt: 11000,
          courseDegMag: 160,
          recommendedNavaid: 'VJB',
          endOfProcedure: false,
        },
        {
          procedureName: 'ADLOV 1J',
          runway: 'RW16',
          sequence: '020',
          fix: 'INVOV',
          pathTerminator: 'DF',
          turnDirection: 'R',
          distanceNm: 12,
          altitudeValue: 6000,
          altitudeUpperFt: undefined,
          courseDegMag: undefined,
          recommendedNavaid: undefined,
          endOfProcedure: false,
        },
        {
          procedureName: 'ADLOV 1J',
          runway: 'RW16',
          sequence: '030',
          fix: 'UDOSU',
          pathTerminator: 'TF',
          turnDirection: '',
          distanceNm: 5.6,
          altitudeValue: undefined,
          altitudeUpperFt: undefined,
          courseDegMag: undefined,
          recommendedNavaid: undefined,
          endOfProcedure: false,
        },
        {
          procedureName: 'ADLOV 1J',
          runway: 'RW16',
          sequence: '040',
          fix: 'ADLOV',
          pathTerminator: 'TF',
          turnDirection: '',
          distanceNm: 23.8,
          altitudeValue: 6000,
          altitudeUpperFt: undefined,
          courseDegMag: undefined,
          recommendedNavaid: undefined,
          endOfProcedure: true,
        },
      ],
    );
  });

  it('parses compact no-fix CR legs with embedded VJB navaid fields', () => {
    const legs = parseJeppesen424Text(conventionalSid1LSampleText);
    assert.deepEqual(
      legs
        .filter((leg) => ['AROSO 1L', 'SABKA 1L'].includes(leg.procedureName) && leg.sequence === '020')
        .map((leg) => ({
          procedureName: leg.procedureName,
          fix: leg.fix,
          pathTerminator: leg.pathTerminator,
          turnDirection: leg.turnDirection,
          distanceNm: leg.distanceNm,
          altitudeRaw: leg.altitudeRaw,
          courseDegMag: leg.courseDegMag,
          recommendedNavaid: leg.recommendedNavaid,
        })),
      [
        {
          procedureName: 'AROSO 1L',
          fix: '',
          pathTerminator: 'CR',
          turnDirection: 'R',
          distanceNm: 9,
          altitudeRaw: '+06000',
          courseDegMag: 350,
          recommendedNavaid: 'VJB',
        },
        {
          procedureName: 'SABKA 1L',
          fix: '',
          pathTerminator: 'CR',
          turnDirection: 'R',
          distanceNm: 10,
          altitudeRaw: '+06000',
          courseDegMag: 333,
          recommendedNavaid: 'VJB',
        },
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

  it('does not misread the second altitude as alt1 when alt1 is blank (OMKOM-style entry)', () => {
    const line = 'SSPAP WMKJWMEOMKO1E2RW16  010OMKOMWMEA1E       IF                                             13000       VJB   WMD    D   003662209';
    const [leg] = parseJeppesen424Text(line);
    assert.equal(leg.altitudeValue, undefined);
    assert.equal(leg.altitudeRaw, undefined);
    assert.equal(leg.altitudeUpperFt, 13000);
    assert.equal(leg.recommendedNavaid, 'VJB');
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

  it('treats altitude text with different zero padding as the same value', () => {
    const [result] = compareSimpleProcedureLegs(
      [{
        procedureName: 'AROSO 1J',
        runway: 'RW16',
        routeKey: '',
        sequence: '010',
        fix: '',
        pathTerminator: 'CA',
        altitudeRaw: '+1000',
        altitudeValue: 1000,
        altitudeSign: '+',
        source: 'AI',
      }],
      [{
        procedureName: 'AROSO 1J',
        runway: 'RW16',
        routeKey: '',
        sequence: '010',
        fix: '',
        pathTerminator: 'CA',
        altitudeRaw: '+01000',
        altitudeValue: 1000,
        altitudeSign: '+',
        source: 'JEPPESEN_424',
      }],
    );

    assert.equal(result.score, 100);
    assert.equal(result.matchedLegs, 1);
    assert.equal(result.legResults[0].fieldResults.find((field) => field.field === 'altitudeValue')?.matched, true);
    assert.equal(result.legResults[0].fieldResults.find((field) => field.field === 'altitudeSign')?.matched, true);
  });

  it('ignores extra AI turn direction on terminal SID transition fixes when 424 leaves it blank', () => {
    const [result] = compareSimpleProcedureLegs(
      [
        {
          procedureName: 'ADLOV 1K',
          runway: 'RW34',
          routeKey: '',
          sequence: '020',
          fix: 'ADLOV',
          pathTerminator: 'DF',
          turnDirection: 'R',
          distanceNm: 25,
          fixSection: 'EA',
          endOfProcedure: true,
          source: 'AI',
        },
      ],
      [
        {
          procedureName: 'ADLOV 1K',
          runway: 'RW34',
          routeKey: '',
          sequence: '020',
          fix: 'ADLOV',
          pathTerminator: 'DF',
          turnDirection: '',
          distanceNm: 25,
          fixSection: 'EA',
          endOfProcedure: true,
          source: 'JEPPESEN_424',
        },
      ],
    );

    assert.equal(result.score, 100);
    assert.equal(result.legResults[0].fieldResults.find((field) => field.field === 'turnDirection')?.matched, true);
  });

  it('still requires AI turn direction when Jeppesen 424 codes one', () => {
    const [result] = compareSimpleProcedureLegs(
      [
        {
          procedureName: 'ADLOV 1J',
          runway: 'RW16',
          routeKey: '',
          sequence: '020',
          fix: 'INVOV',
          pathTerminator: 'DF',
          turnDirection: '',
          distanceNm: 12,
          fixSection: 'PC',
          source: 'AI',
        },
      ],
      [
        {
          procedureName: 'ADLOV 1J',
          runway: 'RW16',
          routeKey: '',
          sequence: '020',
          fix: 'INVOV',
          pathTerminator: 'DF',
          turnDirection: 'R',
          distanceNm: 12,
          fixSection: 'PC',
          source: 'JEPPESEN_424',
        },
      ],
    );

    assert.equal(result.legResults[0].fieldResults.find((field) => field.field === 'turnDirection')?.matched, false);
  });

  it('keeps no-fix AI CA legs so SID comparisons include the initial climb leg', () => {
    const understanding: ProcedureUnderstandingResult = {
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
              altitudeConstraint: { rawText: '+01000 11000' },
              recommendedNavaid: 'VJB',
            },
            {
              sequence: 20,
              fixIdentifier: 'INVOV',
              pathTerminator: 'DF',
              turnDirection: 'R',
              distanceNm: 12,
              altitudeConstraint: { rawText: '+06000' },
            },
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
    assert.deepEqual(aiLegs.map((leg) => [leg.sequence, leg.fix, leg.pathTerminator]), [
      ['010', '', 'CA'],
      ['020', 'INVOV', 'DF'],
    ]);
  });

  it('maps RNAV SID no-fix CA and final transition fix sections like Jeppesen 424', () => {
    const understanding: ProcedureUnderstandingResult = {
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
            {
              sequence: 30,
              fixIdentifier: 'UDOSU',
              pathTerminator: 'TF',
              distanceNm: 5.6,
            },
            {
              sequence: 40,
              fixIdentifier: 'ADLOV',
              pathTerminator: 'TF',
              distanceNm: 23.8,
              altitudeConstraint: { rawText: '+06000', altitudeFt: 6000 },
            },
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
    assert.deepEqual(
      aiLegs.map((leg) => ({
        sequence: leg.sequence,
        fix: leg.fix,
        pathTerminator: leg.pathTerminator,
        distanceNm: leg.distanceNm,
        altitudeUpperFt: leg.altitudeUpperFt,
        recommendedNavaid: leg.recommendedNavaid,
        fixSection: leg.fixSection,
        turnDirection: leg.turnDirection,
      })),
      [
        {
          sequence: '010',
          fix: '',
          pathTerminator: 'CA',
          distanceNm: 2,
          altitudeUpperFt: 11000,
          recommendedNavaid: 'VJB',
          fixSection: '',
          turnDirection: '',
        },
        {
          sequence: '020',
          fix: 'INVOV',
          pathTerminator: 'DF',
          distanceNm: 12,
          altitudeUpperFt: undefined,
          recommendedNavaid: undefined,
          fixSection: 'PC',
          turnDirection: 'R',
        },
        {
          sequence: '030',
          fix: 'UDOSU',
          pathTerminator: 'TF',
          distanceNm: 5.6,
          altitudeUpperFt: undefined,
          recommendedNavaid: undefined,
          fixSection: 'PC',
          turnDirection: '',
        },
        {
          sequence: '040',
          fix: 'ADLOV',
          pathTerminator: 'TF',
          distanceNm: 23.8,
          altitudeUpperFt: undefined,
          recommendedNavaid: undefined,
          fixSection: 'EA',
          turnDirection: '',
        },
      ],
    );
  });

  it('fills RNAV SID first CA Alt2 and Nav from chart transition altitude and VJB text', () => {
    const understanding: ProcedureUnderstandingResult = {
      runway: 'RW16',
      packageType: 'SID',
      navigationType: 'RNAV',
      chartTexts: [
        { text: 'TRANSITION ALTITUDE 11000FT', role: 'ALTITUDE', region: 'HEADER' },
        { text: 'MSA 25 NM VJB', role: 'MSA', region: 'MAIN_CHART' },
      ],
      procedures: [
        {
          procedureName: 'AROSO 1J',
          runway: 'RW16',
          legs: [
            {
              sequence: 10,
              pathTerminator: 'CA',
              courseDegMag: 160,
              altitudeConstraint: { rawText: '+01000', altitudeFt: 1000 },
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
      fixes: [],
      sourceEvidence: [],
      warnings: [],
      confidence: 1,
      reviewRequired: false,
    };

    const [first] = aiProcedureToSimpleLegs(understanding);
    assert.equal(first.pathTerminator, 'CA');
    assert.equal(first.fix, '');
    assert.equal(first.altitudeValue, 1000);
    assert.equal(first.altitudeUpperFt, 11000);
    assert.equal(first.recommendedNavaid, 'VJB');
  });

  it('matches RWY16 conventional SID 1L when AI preserves CA/CR/CI/CF decomposition', () => {
    const understanding: ProcedureUnderstandingResult = {
      runway: 'RW16',
      packageType: 'SID',
      navigationType: 'CONVENTIONAL',
      procedures: [
        {
          procedureName: 'AROSO 1L',
          runway: 'RW16',
          legs: [
            { sequence: 10, pathTerminator: 'CA', courseDegMag: 160, distanceNm: 2, altitudeConstraint: { rawText: '+01000 11000' }, recommendedNavaid: 'VJB' },
            { sequence: 20, pathTerminator: 'CR', turnDirection: 'R', courseDegMag: 350, distanceNm: 9, altitudeConstraint: { rawText: '+06000' }, recommendedNavaid: 'VJB' },
            { sequence: 30, pathTerminator: 'CI', courseDegMag: 350, distanceNm: 11 },
            { sequence: 40, fixIdentifier: 'AROSO', pathTerminator: 'CF', courseDegMag: 332, distanceNm: 22, altitudeConstraint: { rawText: '+06000' }, recommendedNavaid: 'VJB' },
          ],
        },
        {
          procedureName: 'PIMOK 1L',
          runway: 'RW16',
          legs: [
            { sequence: 10, pathTerminator: 'CA', courseDegMag: 160, distanceNm: 2, altitudeConstraint: { rawText: '+01000 11000' }, recommendedNavaid: 'VJB' },
            { sequence: 20, pathTerminator: 'CI', turnDirection: 'R', courseDegMag: 266, distanceNm: 11 },
            { sequence: 30, fixIdentifier: 'PIMOK', pathTerminator: 'CF', courseDegMag: 236, distanceNm: 15, altitudeConstraint: { rawText: '+06000' }, recommendedNavaid: 'VJB' },
          ],
        },
        {
          procedureName: 'SABKA 1L',
          runway: 'RW16',
          legs: [
            { sequence: 10, pathTerminator: 'CA', courseDegMag: 160, distanceNm: 2, altitudeConstraint: { rawText: '+01000 11000' }, recommendedNavaid: 'VJB' },
            { sequence: 20, pathTerminator: 'CR', turnDirection: 'R', courseDegMag: 333, distanceNm: 10, altitudeConstraint: { rawText: '+06000' }, recommendedNavaid: 'VJB' },
            { sequence: 30, pathTerminator: 'CI', courseDegMag: 333, distanceNm: 3 },
            { sequence: 40, fixIdentifier: 'SABKA', pathTerminator: 'CF', courseDegMag: 296, distanceNm: 19, altitudeConstraint: { rawText: '+06000' }, recommendedNavaid: 'VJB' },
          ],
        },
      ],
      fixes: [],
      sourceEvidence: [],
      warnings: [],
      confidence: 1,
      reviewRequired: false,
    };

    const results = compareSimpleProcedureLegs(
      aiProcedureToSimpleLegs(understanding),
      parseJeppesen424Text(conventionalSid1LSampleText),
    );

    assert.deepEqual(results.map((result) => [result.procedureName, result.score, result.matchedLegs, result.partialLegs]), [
      ['AROSO 1L', 100, 4, 0],
      ['PIMOK 1L', 100, 3, 0],
      ['SABKA 1L', 100, 4, 0],
    ]);
  });
});
