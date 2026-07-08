import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normalizeProcedureUnderstandingResult } from '../procedureUnderstandingNormalizer';
import type { AiInputPackage, ProcedureGroup, ProcedureUnderstandingResult } from '../../types/procedure';

const group = {
  groupId: 'pkg_test',
  packageId: 'pkg_test',
  packageType: 'STAR',
  navigationType: 'DME_ARC',
  runway: 'RWY16',
  procedureNames: ['EMTUV 1G', 'OMKOM 1G', 'PIMOK 1G', 'ADLOV 1G'],
} as unknown as ProcedureGroup;

const aiInputPackage = { supportSummary: {} } as unknown as AiInputPackage;

// 复刻 1.3.3 真实运行：标签/语义完整、tableLegs 与 procedures[].legs 全空
const modelOutput = {
  airportIcao: 'WMKJ',
  navigationType: 'DME_ARC',
  runway: 'RWY16',
  procedureClassification: { navigationType: 'DME_ARC', procedureNames: ['EMTUV 1G', 'OMKOM 1G', 'PIMOK 1G', 'ADLOV 1G'] },
  chartTexts: [
    { text: '11 DME ARC VJB VOR/DME', role: 'DME_LABEL' },
    { text: '13D VJB', role: 'DME_LABEL' },
    { text: '13D VJB', role: 'DME_LABEL' },
    { text: '13D VJB', role: 'DME_LABEL' },
    { text: '13D VJB', role: 'DME_LABEL' },
  ],
  geometrySemantics: [
    { type: 'DME_ARC', labelText: '11 DME ARC VJB VOR/DME', centerNavaid: 'VJB', radiusNm: 11, relatedProcedures: ['EMTUV 1G', 'OMKOM 1G', 'PIMOK 1G', 'ADLOV 1G'] },
    { type: 'RADIAL', labelText: 'RDL016 VJB', centerNavaid: 'VJB', radialDeg: 16, inboundTrackDeg: 196, relatedProcedures: ['ADLOV 1G'] },
    { type: 'RADIAL', labelText: 'RDL114 VJB', centerNavaid: 'VJB', radialDeg: 114, inboundTrackDeg: 294, relatedProcedures: ['OMKOM 1G'] },
    { type: 'RADIAL', labelText: 'RDL236 VJB', centerNavaid: 'VJB', radialDeg: 236, inboundTrackDeg: 56, relatedProcedures: ['PIMOK 1G'] },
    { type: 'RADIAL', labelText: 'RDL275 VJB', centerNavaid: 'VJB', radialDeg: 275, inboundTrackDeg: 95, relatedProcedures: ['EMTUV 1G'] },
    { type: 'RADIAL', labelText: 'RDL295 VJB', centerNavaid: 'VJB', radialDeg: 295, inboundTrackDeg: 115, relatedProcedures: ['EMTUV 1G', 'PIMOK 1G'] },
    { type: 'RADIAL', labelText: 'RDL340 VJB', centerNavaid: 'VJB', radialDeg: 340, inboundTrackDeg: 160, relatedProcedures: ['EMTUV 1G', 'OMKOM 1G', 'PIMOK 1G', 'ADLOV 1G'] },
  ],
  tableLegs: [],
  procedures: [
    { procedureName: 'EMTUV 1G', legs: [] },
    { procedureName: 'OMKOM 1G', legs: [] },
    { procedureName: 'PIMOK 1G', legs: [] },
    { procedureName: 'ADLOV 1G', legs: [] },
  ],
  fixes: [
    { identifier: 'ADLOV', latitude: 2.0659, longitude: 103.7778 },
    { identifier: 'EMTUV', latitude: 1.6976, longitude: 103.3042 },
    { identifier: 'OSRUP', latitude: 0, longitude: 0 },
    { identifier: 'D016M', latitude: 0, longitude: 0 },
  ],
  sourceEvidence: [],
  warnings: [],
};

describe('procedure understanding normalizer — DME ARC leg fallback', () => {
  const result = normalizeProcedureUnderstandingResult(modelOutput, group, aiInputPackage) as ProcedureUnderstandingResult;
  const byName = new Map((result.procedures ?? []).map((p) => [p.procedureName, p]));

  it('synthesizes legs for every procedure when tableLegs is empty', () => {
    for (const name of ['EMTUV 1G', 'OMKOM 1G', 'PIMOK 1G', 'ADLOV 1G']) {
      const legs = byName.get(name)?.legs ?? [];
      assert.ok(legs.length >= 5, `${name} should have synthesized legs, got ${legs.length}`);
      assert.ok(legs.some((leg) => leg.pathTerminator === 'AF'), `${name} missing AF leg`);
    }
  });

  it('matches the Jeppesen golden chain for ADLOV 1G (single AF, turn L)', () => {
    const legs = byName.get('ADLOV 1G')!.legs!;
    assert.deepEqual(
      legs.map((leg) => [leg.sequence, leg.pathTerminator, leg.fixIdentifier, leg.turnDirection, leg.distanceNm]),
      [
        [10, 'IF', 'ADLOV', null, null],
        [20, 'TF', 'D016M', null, null],
        [30, 'CI', null, null, 2],
        [40, 'AF', 'D340K', 'L', 6.9],
        [50, 'TF', 'OSRUP', null, null],
      ],
    );
    assert.equal(legs[2].courseDegMag, 196);
    assert.equal(legs[4].courseDegMag, 160);
  });

  it('splits the arc at the RDL295 crossing for EMTUV 1G (two AF legs, turn R)', () => {
    const legs = byName.get('EMTUV 1G')!.legs!;
    assert.deepEqual(
      legs.map((leg) => [leg.sequence, leg.pathTerminator, leg.fixIdentifier, leg.turnDirection, leg.distanceNm]),
      [
        [10, 'IF', 'EMTUV', null, null],
        [20, 'TF', 'D275M', null, null],
        [30, 'CI', null, null, 2],
        [40, 'AF', 'D295K', 'R', 3.8],
        [50, 'AF', 'D340K', 'R', 8.6],
        [60, 'TF', 'OSRUP', null, null],
      ],
    );
  });

  it('computes the long counterclockwise arc for OMKOM 1G', () => {
    const legs = byName.get('OMKOM 1G')!.legs!;
    const af = legs.find((leg) => leg.pathTerminator === 'AF')!;
    assert.equal(af.turnDirection, 'L');
    assert.equal(af.distanceNm, 25.7);
  });

  it('splits PIMOK 1G at RDL295 with turn R', () => {
    const legs = byName.get('PIMOK 1G')!.legs!;
    const afs = legs.filter((leg) => leg.pathTerminator === 'AF');
    assert.deepEqual(afs.map((leg) => [leg.fixIdentifier, leg.turnDirection, leg.distanceNm]), [
      ['D295K', 'R', 11.3],
      ['D340K', 'R', 8.6],
    ]);
  });

  it('marks synthesized legs as reviewRequired and nulls (0,0) coordinates', () => {
    const legs = byName.get('ADLOV 1G')!.legs!;
    assert.ok(legs.every((leg) => leg.reviewRequired === true));
    const osrup = (result.fixes ?? []).find((fix) => fix.identifier === 'OSRUP');
    assert.equal(osrup?.latitude, null);
    assert.equal(osrup?.longitude, null);
  });

  it('surfaces the fallback explicitly: warning appended and overall reviewRequired', () => {
    assert.equal(result.reviewRequired, true);
    const fallbackWarning = (result.warnings ?? []).find((warning) => /几何合成兜底/.test(String((warning as Record<string, unknown>).message ?? '')));
    assert.ok(fallbackWarning, 'fallback warning missing from warnings');
    assert.equal((fallbackWarning as Record<string, unknown>).fieldName, 'tableLegs');
    const legs = byName.get('ADLOV 1G')!.legs!;
    assert.ok(legs.every((leg) => String((leg as Record<string, unknown>).derivationMethod).startsWith('synthesized')));
  });

  it('does not synthesize when tableLegs is present', () => {
    const withTable = normalizeProcedureUnderstandingResult(
      {
        ...modelOutput,
        tableLegs: [
          { procedureName: 'ADLOV 1G', sequence: 10, pathTerminator: 'IF', toFix: 'ADLOV', altitudeConstraint: '-6000' },
        ],
      },
      group,
      aiInputPackage,
    ) as ProcedureUnderstandingResult;
    const adlov = (withTable.procedures ?? []).find((p) => p.procedureName === 'ADLOV 1G');
    assert.equal(adlov?.legs?.length, 1);
    assert.equal((adlov?.legs?.[0] as Record<string, unknown>).derivationMethod, 'tableLegs');
    assert.ok(!(withTable.warnings ?? []).some((warning) => /几何合成兜底/.test(String((warning as Record<string, unknown>).message ?? ''))));
    assert.equal(withTable.reviewRequired, false);
  });

  it('parses dual-altitude table constraints without concatenating numbers', () => {
    const withDualAltitude = normalizeProcedureUnderstandingResult(
      {
        ...modelOutput,
        tableLegs: [
          { procedureName: 'ADLOV 1G', sequence: 10, pathTerminator: 'IF', toFix: 'ADLOV', altitudeConstraint: '-06000 13000' },
        ],
      },
      group,
      aiInputPackage,
    ) as ProcedureUnderstandingResult;
    const leg = (withDualAltitude.procedures ?? []).find((p) => p.procedureName === 'ADLOV 1G')?.legs?.[0] as Record<string, any>;
    assert.equal(leg.altitudeConstraint.altitudeFt, 6000);
    assert.equal(leg.altitudeConstraint.upperFt, 13000);
    assert.equal(leg.altitudeConstraint.rawText, '-06000 13000');
  });
});
