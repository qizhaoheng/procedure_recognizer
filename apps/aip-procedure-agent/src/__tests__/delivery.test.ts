import assert from 'node:assert/strict';
import test from 'node:test';
import { geodesicInverse } from '../coordinate';
import { arc, compile424Candidate, compileGeoJson, deriveArcCenter, lineGeometry, racetrack, transitionEntryName } from '../compiler';
import { applyQualityGate, validatePir } from '../validation';
import { carryOverManualEdits, createEmptyPir, mergeFragment } from '../fragmentMerger';
import { georeferencePage, applyAffine } from '../chartOverlay';
import { auditGrouping } from '../orchestrator';
import { profileForAirport, deriveApproachCode } from '../../../../server/src/services/jeppesen424/encodingProfile';
import { simpleLegsTo424Text } from '../../../../server/src/services/jeppesen424/simpleLegsTo424Text';
import { parseJeppesen424Text } from '../../../../server/src/services/jeppesen424/jeppesen424TextParser';
import type { PirLeg, ProcedurePIR, RecognitionPlan } from '../domain';

function basePir(category: ProcedurePIR['procedure']['category'] = 'SID'): ProcedurePIR {
  const pir = createEmptyPir({ icao: 'RKSI', name: 'Incheon' }, { category, name: 'TEST ONE ALPHA DEPARTURE', runways: ['15L'] });
  pir.fixes = [
    { fixId: 'a', identifier: 'AAAAA', type: 'WAYPOINT', role: null, latitude: 37.3, longitude: 126.5, coordinateSourceType: 'EXPLICIT_TABLE', evidence: ['e1'], confidence: 0.99, status: 'CONFIRMED', allowFor424: true },
    { fixId: 'b', identifier: 'BBBBB', type: 'WAYPOINT', role: null, latitude: 37.4, longitude: 126.6, coordinateSourceType: 'EXPLICIT_TABLE', evidence: ['e2'], confidence: 0.99, status: 'CONFIRMED', allowFor424: true },
  ];
  pir.routes = [{ routeId: 'r1', routeType: 'RUNWAY_TRANSITION', identifier: 'RW15L', runway: '15L', transitionFix: null, legIds: ['l1'], sequence: 1 }];
  pir.legs = [leg({ legId: 'l1', sequence: 10, routeId: 'r1', pathTerminator: 'TF', fromFixId: 'a', toFixId: 'b' })];
  return pir;
}
function leg(partial: Partial<PirLeg> & { legId: string; sequence: number; routeId: string; pathTerminator: string }): PirLeg {
  return { fromFixId: null, toFixId: null, centerFixId: null, recommendedNavaidId: null, course: null, courseReference: 'MAGNETIC', distanceNm: null, radiusNm: null, turnDirection: null, altitudeConstraint: null, speedConstraint: null, verticalAngle: null, holding: null, openEnded: false, evidence: [], confidence: 0.9, fieldStatus: {}, warnings: [], ...partial } as PirLeg;
}

// ============ 语义校验 ============

test('negative altitude is a BLOCKER and blocks the 424 candidate', () => {
  const pir = basePir();
  pir.legs[0].altitudeConstraint = { type: 'AT_OR_ABOVE', lowerFt: -5000, upperFt: null, rawText: '-5 000' };
  const validations = validatePir(pir);
  assert.ok(validations.some((v) => v.ruleCode === 'ALT_NEGATIVE' && v.severity === 'BLOCKER'));
  assert.ok(validations.some((v) => v.ruleCode === 'ALT_SIGN_SEMANTICS'));
  const gate = applyQualityGate(pir, validations);
  assert.equal(gate, 'REQUIRES_REVIEW');
  assert.ok(pir.quality.confidence <= 0.6);
  assert.equal(pir.quality.reviewRequired, true);
  const candidate = compile424Candidate(pir, validations);
  assert.equal(candidate.status, '424_INCOMPLETE');
  assert.ok(candidate.blockedBy?.includes('ALT_NEGATIVE'));
});

test('course/distance back-check flags impossible values', () => {
  const pir = basePir();
  pir.legs[0].course = 220; // 实际方位约 38°
  pir.legs[0].distanceNm = 30; // 实际约 8.3NM
  const validations = validatePir(pir);
  assert.ok(validations.some((v) => v.ruleCode === 'COURSE_BACKCHECK' && v.severity === 'ERROR'));
  assert.ok(validations.some((v) => v.ruleCode === 'DIST_BACKCHECK' && v.severity === 'ERROR'));
});

test('plan consistency: promised holdings must exist in the result', () => {
  const pir = basePir('STAR');
  const plan = { detectedStructure: { hasRunwayTransition: false, hasCommonRoute: true, hasEnrouteTransitions: true, hasMissedApproach: false, hasCoordinateTable: true, hasProcedureTable: true }, geometryStrategy: '', arinc424Strategy: 'Encode holding at BOPKI using HF', recognitionPlan: [], risks: [], missingInformation: [], requiredTools: [], decisionSummary: '', packageId: '', procedureType: 'STAR', promptVersion: '1' } as unknown as RecognitionPlan;
  const validations = validatePir(pir, plan);
  assert.ok(validations.some((v) => v.ruleCode === 'PLAN_CONSISTENCY' && /holding/i.test(v.message) && v.severity === 'ERROR'));
});

test('approach structure rules: final/missed/FAF/MAPT are required', () => {
  const pir = basePir('APPROACH');
  const validations = validatePir(pir);
  const messages = validations.filter((v) => v.ruleCode === 'APPROACH_STRUCTURE').map((v) => v.message).join(' ');
  assert.match(messages, /FINAL_APPROACH/);
  assert.match(messages, /MISSED_APPROACH/);
  assert.match(messages, /FAF/);
  assert.match(messages, /MAPT/);
});

// ============ Fragment Merger ============

test('merger keeps both candidates as a conflict when coordinates differ', () => {
  const pir = basePir();
  mergeFragment(pir, { fixes: [{ fixId: 'x', identifier: 'AAAAA', type: 'WAYPOINT', role: null, latitude: 37.35, longitude: 126.55, coordinateSourceType: 'EXPLICIT_TEXT', evidence: ['e9'], confidence: 0.8, status: 'CONFIRMED', allowFor424: true }] }, { action: 'EXTRACT_FIX_COORDINATES' });
  const fix = pir.fixes.find((f) => f.identifier === 'AAAAA')!;
  assert.equal(fix.status, 'CONFLICTED');
  assert.equal(pir.conflicts.length, 1);
  assert.equal(pir.conflicts[0].candidates.length, 2);
  // 原值不被静默覆盖
  assert.equal(fix.latitude, 37.3);
});

test('merger applies constraints to known legs and attaches holdings by fix', () => {
  const pir = basePir('STAR');
  mergeFragment(pir, { legConstraints: [{ legId: 'l1', altitudeConstraint: { type: 'AT_OR_BELOW', lowerFt: null, upperFt: 5000, rawText: '-5 000' }, speedConstraint: { type: 'AT_OR_BELOW', valueKias: 250 }, verticalAngle: null, evidence: ['e3'] }] }, { action: 'EXTRACT_CONSTRAINTS' });
  assert.equal(pir.legs[0].altitudeConstraint?.type, 'AT_OR_BELOW');
  assert.equal(pir.legs[0].speedConstraint?.valueKias, 250);
  mergeFragment(pir, { holdings: [{ fixIdentifier: 'BBBBB', legId: null, pathTerminator: 'HF', holding: { holdingFixId: null, inboundCourse: 218, courseReference: 'MAGNETIC', turnDirection: 'R', legTimeMin: 1, legDistanceNm: null, minimumAltitudeFt: 5000, maximumAltitudeFt: null, speedLimitKias: 230, rawText: null } }] }, { action: 'EXTRACT_HOLDING' });
  assert.equal(pir.legs[0].holding?.turnDirection, 'R');
  assert.equal(pir.legs[0].pathTerminator, 'HF');
});

test('manual edits survive re-recognition as the kept value with a conflict record', () => {
  const previous = basePir();
  previous.legs[0].course = 45;
  previous.legs[0].fieldStatus.course = 'MANUALLY_EDITED';
  const next = basePir();
  next.legs[0].course = 52;
  carryOverManualEdits(previous, next);
  assert.equal(next.legs[0].course, 45);
  assert.equal(next.legs[0].fieldStatus.course, 'MANUALLY_EDITED');
  assert.ok(next.conflicts.some((c) => c.candidates.some((x) => x.source === 'RE_RECOGNITION')));
});

// ============ 专业几何 ============

test('racetrack holding produces a closed loop on the correct turn side', () => {
  const fix: [number, number] = [126.5, 37.3];
  const points = racetrack(fix, 360, 'R', 3.5, 1.1); // 入航向北，右转 → 跑马场在东侧
  assert.ok(points.length > 20);
  assert.ok(geodesicInverse(points[0], fix).distanceNm < 0.05, 'starts at fix');
  assert.ok(geodesicInverse(points.at(-1)!, fix).distanceNm < 0.05, 'ends at fix');
  const lons = points.map((p) => p[0]);
  assert.ok(Math.max(...lons) > fix[0] + 0.01, 'racetrack extends east of the fix for a right-hand hold');
  assert.ok(Math.min(...lons) > fix[0] - 0.01, 'racetrack stays on the holding side');
});

test('RF geometry uses radius and reports radius mismatch', () => {
  const pir = basePir();
  pir.fixes.push({ fixId: 'c', identifier: 'CENTR', type: 'WAYPOINT', role: null, latitude: 37.3, longitude: 126.6, coordinateSourceType: 'EXPLICIT_TABLE', evidence: [], confidence: 0.9, status: 'CONFIRMED', allowFor424: true });
  pir.legs = [leg({ legId: 'l1', sequence: 10, routeId: 'r1', pathTerminator: 'RF', fromFixId: 'a', toFixId: 'b', centerFixId: 'c', turnDirection: 'L', radiusNm: 20 })];
  pir.routes[0].legIds = ['l1'];
  const geo = compileGeoJson(pir) as any;
  const rf = geo.features.find((f: any) => f.properties.featureType === 'LEG');
  assert.equal(rf.properties.geometryQuality, 'DERIVED');
  assert.ok(flatCoords(rf.geometry).length >= 9, 'arc is sampled');
  assert.ok(geo.metadata.warnings.some((w: string) => /radius/i.test(w)), 'charted radius 20NM mismatch is reported');
  const validations = validatePir(pir);
  assert.ok(validations.some((v) => v.ruleCode === 'RF_RADIUS_VALUE' || v.ruleCode === 'RF_RADIUS_CONSISTENCY'));
});

test('RF center derived from radius+turn renders a real arc (RNP AR case, no named centre)', () => {
  const pir = basePir('APPROACH');
  // from/to ~3NM apart, radius 3NM → valid minor arc
  pir.fixes = [
    { fixId: 'a', identifier: 'KJ480', type: 'WAYPOINT', role: null, latitude: 2.80, longitude: 103.90, coordinateSourceType: 'EXPLICIT_TABLE', evidence: [], confidence: 1, status: 'CONFIRMED', allowFor424: true },
    { fixId: 'b', identifier: 'KJ485', type: 'WAYPOINT', role: null, latitude: 2.83, longitude: 103.93, coordinateSourceType: 'EXPLICIT_TABLE', evidence: [], confidence: 1, status: 'CONFIRMED', allowFor424: true },
  ];
  pir.routes = [{ routeId: 'r1', routeType: 'FINAL_APPROACH', identifier: 'FINAL', runway: '16', transitionFix: null, legIds: ['l1'], sequence: 1 }];
  pir.legs = [leg({ legId: 'l1', sequence: 10, routeId: 'r1', pathTerminator: 'RF', fromFixId: 'a', toFixId: 'b', centerFixId: null, radiusNm: 3.5, turnDirection: 'L' })];
  const geo = compileGeoJson(pir) as any;
  const rf = geo.features.find((f: any) => f.properties.featureType === 'LEG');
  assert.equal(rf.properties.geometryQuality, 'DERIVED', 'RF with derivable centre must be DERIVED, not DISPLAY_ONLY');
  const pts = flatCoords(rf.geometry);
  assert.ok(pts.length >= 9, 'derived arc is sampled');
  assert.ok(geodesicInverse(pts[0], [103.90, 2.80]).distanceNm < 0.05, 'arc starts at from-fix');
  assert.ok(geodesicInverse(pts.at(-1)!, [103.93, 2.83]).distanceNm < 0.05, 'arc ends at to-fix');
});

test('deriveArcCenter: L and R turns mirror; oversize chord rejected', () => {
  const from: [number, number] = [103.9, 2.8];
  const to: [number, number] = [103.93, 2.83];
  const left = deriveArcCenter(from, to, 3.5, 'L');
  const right = deriveArcCenter(from, to, 3.5, 'R');
  assert.ok(left && right);
  assert.notDeepEqual(left, right, 'turn direction picks opposite centres');
  // both centres are equidistant (=radius) from both endpoints
  for (const c of [left!, right!]) {
    assert.ok(Math.abs(geodesicInverse(c, from).distanceNm - 3.5) < 0.05);
    assert.ok(Math.abs(geodesicInverse(c, to).distanceNm - 3.5) < 0.05);
  }
  assert.equal(deriveArcCenter(from, to, 0.5, 'L'), undefined, 'chord > 2×radius cannot form an arc');
});

test('holding leg becomes a racetrack feature, not a straight line', () => {
  const pir = basePir('STAR');
  pir.legs = [leg({ legId: 'l1', sequence: 10, routeId: 'r1', pathTerminator: 'HM', toFixId: 'b', holding: { holdingFixId: 'b', inboundCourse: 90, courseReference: 'MAGNETIC', turnDirection: 'L', legTimeMin: 1, legDistanceNm: null, minimumAltitudeFt: null, maximumAltitudeFt: null, speedLimitKias: null, rawText: null } })];
  pir.routes[0].legIds = ['l1'];
  const geo = compileGeoJson(pir) as any;
  const hm = geo.features.find((f: any) => f.properties.featureType === 'LEG');
  assert.equal(hm.properties.geometryQuality, 'DERIVED');
  assert.ok(flatCoords(hm.geometry).length > 20, 'racetrack has arc sampling, not 2 points');
});

test('runway and DER features are emitted and SID first leg connects to DER', () => {
  const pir = basePir();
  pir.runwayData = [{ runwayId: 'RWY-15L', designator: '15L', thresholdLatitude: 37.28, thresholdLongitude: 126.44, derLatitude: 37.26, derLongitude: 126.47, elevationFt: 23, thresholdCrossingHeightFt: 55, trueBearing: 150, evidence: [], status: 'CONFIRMED' }];
  pir.legs = [leg({ legId: 'l1', sequence: 10, routeId: 'r1', pathTerminator: 'CF', toFixId: 'b', course: 140 })];
  pir.routes[0].legIds = ['l1'];
  const geo = compileGeoJson(pir) as any;
  assert.ok(geo.features.some((f: any) => f.properties.featureType === 'RUNWAY'));
  assert.ok(geo.features.some((f: any) => f.properties.featureType === 'RUNWAY_END' && f.properties.kind === 'DER'));
  const first = geo.features.find((f: any) => f.properties.featureType === 'LEG');
  assert.ok(first.geometry, 'first SID leg has geometry anchored at DER');
  assert.equal(first.properties.geometryQuality, 'DERIVED');
  const start = flatCoords(first.geometry)[0];
  assert.ok(Math.abs(start[0] - 126.47) < 1e-6 && Math.abs(start[1] - 37.26) < 1e-6);
});

test('LEG properties carry the full professional attribute set and labels exist', () => {
  const pir = basePir();
  pir.legs[0].course = 38;
  pir.legs[0].distanceNm = 8.3;
  pir.legs[0].altitudeConstraint = { type: 'AT_OR_ABOVE', lowerFt: 5000, upperFt: null, rawText: '+5000' };
  pir.legs[0].speedConstraint = { type: 'AT_OR_BELOW', valueKias: 250 };
  const geo = compileGeoJson(pir) as any;
  const legFeature = geo.features.find((f: any) => f.properties.featureType === 'LEG');
  for (const key of ['fromFix', 'toFix', 'course', 'distanceNm', 'turnDirection', 'altitudeConstraint', 'speedConstraint', 'procedureName', 'routeType', 'geometryQuality', 'isStart', 'isEnd']) assert.ok(key in legFeature.properties, `missing ${key}`);
  assert.equal(legFeature.properties.altitudeText, '+5000');
  assert.ok(geo.features.some((f: any) => f.properties.featureType === 'PROCEDURE'));
  assert.ok(geo.features.some((f: any) => f.properties.featureType === 'LABEL' && f.properties.labelKind === 'CONSTRAINT'));
});

test('antimeridian crossing splits into MultiLineString', () => {
  const geometry = lineGeometry([[179.5, 10], [-179.5, 10.2]]);
  assert.equal(geometry.type, 'MultiLineString');
  const segments = (geometry as any).coordinates;
  assert.equal(segments.length, 2);
  assert.equal(Math.abs(segments[0].at(-1)[0]), 180);
});

test('arc turn direction matters', () => {
  const right = arc([126.6, 37.3], [126.6, 37.4], [126.7, 37.3], 'R');
  const left = arc([126.6, 37.3], [126.6, 37.4], [126.7, 37.3], 'L');
  assert.ok(right.length < left.length, 'right turn is the short way, left turn sweeps the long way');
});

// ============ 424 Encoding Profile 与字段级 Round-trip ============

test('subsection and customer area follow the category and airport region', () => {
  assert.equal(profileForAirport('WMKJ').customerAreaCode, 'SPA');
  assert.equal(profileForAirport('RJTT').customerAreaCode, 'PAC');
  assert.equal(deriveApproachCode('RNP', '15L', 'RNP RWY 15L'), 'R15L');
  assert.equal(deriveApproachCode('ILS', 'RWY 15L', 'ILS Z or LOC Z RWY 15L'), 'I15LZ');
});

test('RJTT SID identity columns match the real Jeppesen sample (SPACP …D)', () => {
  const text = simpleLegsTo424Text([
    { procedureName: 'VAMOS 4', category: 'SID', runway: '', transitionName: 'DRAKY', routeKey: 'r', sequence: '010', fix: 'VAMOS', pathTerminator: 'IF', turnDirection: '', altitudeValue: 9000, altitudeSign: '+', source: 'AI' },
  ], { airportIcao: 'RJTT' });
  const line = text.split('\n')[0];
  // 真实样本：'SPACP RJTTRJDVAMOS43DRAKY 010VAMOSRJPC1E …'
  assert.equal(line.slice(0, 5), 'SPACP');
  assert.equal(line[12], 'D');
  assert.equal(line.slice(13, 19).trim(), 'VAMOS4');
  assert.equal(line[19], '3');
  assert.equal(line.slice(20, 25), 'DRAKY');
  assert.equal(line.length, 132);
});

test('STAR keeps the WMKJ dialect (SSPAP …E) for backward compatibility', () => {
  const text = simpleLegsTo424Text([
    { procedureName: 'ADLOV 1E', category: 'STAR', runway: 'RW16', routeKey: 'r', sequence: '010', fix: 'ADLOV', pathTerminator: 'IF', turnDirection: '', source: 'AI' },
  ], { airportIcao: 'WMKJ' });
  const line = text.split('\n')[0];
  assert.equal(line.slice(0, 5), 'SSPAP');
  assert.equal(line[12], 'E');
  assert.equal(line[19], '2');
  assert.equal(line.slice(20, 24), 'RW16');
});

test('speed limit is encoded and survives the parse round-trip', () => {
  const text = simpleLegsTo424Text([
    { procedureName: 'ADLOV 1E', category: 'STAR', runway: 'RW16', routeKey: 'r', sequence: '010', fix: 'ADLOV', pathTerminator: 'TF', turnDirection: '', speedLimitKias: 250, distanceNm: 8.3, source: 'AI' },
  ], { airportIcao: 'WMKJ' });
  const parsed = parseJeppesen424Text(text);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].speedLimitKias, 250);
  assert.equal(parsed[0].distanceNm, 8.3);
});

test('STAR transition name comes from the transition entry fix, not the merge point', () => {
  const pir = basePir('STAR');
  pir.procedure.name = 'RNAV GUKDO 3C';
  pir.fixes.push({ fixId: 'g', identifier: 'GUKDO', type: 'WAYPOINT', role: null, latitude: 37.9, longitude: 127.2, coordinateSourceType: 'EXPLICIT_TABLE', evidence: [], confidence: 1, status: 'CONFIRMED', allowFor424: true });
  pir.routes = [{ routeId: 'rt', routeType: 'ENROUTE_TRANSITION', identifier: 'GUKDO 3C', runway: null, transitionFix: 'LASIG', legIds: ['t1'], sequence: 1 }];
  pir.legs = [leg({ legId: 't1', sequence: 1, routeId: 'rt', pathTerminator: 'TF', fromFixId: 'g', toFixId: 'a' })];
  const fixes = new Map(pir.fixes.map((f) => [f.fixId, f]));
  assert.equal(transitionEntryName(pir, pir.routes[0], fixes), 'GUKDO');
  const candidate = compile424Candidate(pir, []);
  assert.match(candidate.text, /3GUKDO/);
  assert.doesNotMatch(candidate.text, /3LASIG/);
});

test('APPROACH compiles with approach code, transition A records, and clean field round-trip', () => {
  const pir = basePir('APPROACH');
  pir.procedure.name = 'RNP RWY 15L';
  pir.procedure.approachType = 'RNP';
  pir.fixes = [
    fix('iaf', 'MUNAN', 37.9, 127.0, 'IAF'), fix('if', 'PUDIM', 37.7, 126.8, 'IF'),
    fix('faf', 'NOPEN', 37.5, 126.6, 'FAF'), fix('mapt', 'RW15L', 37.3, 126.45, 'MAPT'), fix('mahf', 'SI950', 37.1, 126.3, 'MAHF'),
  ];
  pir.routes = [
    { routeId: 'tr', routeType: 'APPROACH_TRANSITION', identifier: 'MUNAN', runway: null, transitionFix: 'MUNAN', legIds: ['t1'], sequence: 1 },
    { routeId: 'fa', routeType: 'FINAL_APPROACH', identifier: 'FINAL', runway: '15L', transitionFix: null, legIds: ['f1', 'f2'], sequence: 2 },
    { routeId: 'ma', routeType: 'MISSED_APPROACH', identifier: 'MISSED', runway: '15L', transitionFix: null, legIds: ['m1'], sequence: 3 },
  ];
  pir.legs = [
    leg({ legId: 't1', sequence: 1, routeId: 'tr', pathTerminator: 'TF', fromFixId: 'iaf', toFixId: 'if' }),
    leg({ legId: 'f1', sequence: 1, routeId: 'fa', pathTerminator: 'TF', fromFixId: 'if', toFixId: 'faf', altitudeConstraint: { type: 'AT_OR_ABOVE', lowerFt: 1800, upperFt: null, rawText: '+1800' } }),
    leg({ legId: 'f2', sequence: 2, routeId: 'fa', pathTerminator: 'TF', fromFixId: 'faf', toFixId: 'mapt', verticalAngle: -3.0 }),
    leg({ legId: 'm1', sequence: 1, routeId: 'ma', pathTerminator: 'HM', toFixId: 'mahf', holding: { holdingFixId: 'mahf', inboundCourse: 150, courseReference: 'MAGNETIC', turnDirection: 'R', legTimeMin: 1, legDistanceNm: null, minimumAltitudeFt: 5000, maximumAltitudeFt: null, speedLimitKias: null, rawText: null } }),
  ];
  pir.minima = [{ minimaId: 'm', type: 'DA', valueFt: 260, valueMeters: null, aircraftCategory: 'C', runway: '15L', condition: 'LNAV/VNAV', rawText: 'DA 260', evidence: [], status: 'CONFIRMED' }];
  const validations = validatePir(pir).filter((v) => v.severity === 'BLOCKER');
  assert.equal(validations.length, 0);
  const candidate = compile424Candidate(pir, []);
  assert.notEqual(candidate.status, '424_INCOMPLETE', JSON.stringify(candidate.missingFields));
  const lines = candidate.text.split('\n');
  assert.ok(lines.every((l) => l.length === 132));
  assert.ok(lines.some((l) => l[12] === 'F' && l.slice(13, 19).trim() === 'R15L' && l[19] === 'A' && l.slice(20, 25) === 'MUNAN'), 'approach transition record with entry fix');
  assert.ok(lines.some((l) => l[12] === 'F' && l[19] === 'R'), 'final approach record uses RNP route type letter');
  assert.equal(candidate.roundTrip?.fieldMismatches.length, 0, JSON.stringify(candidate.roundTrip?.fieldMismatches));
  assert.equal(candidate.status, '424_CANDIDATE');
});

function fix(id: string, ident: string, lat: number, lon: number, role: any) {
  return { fixId: id, identifier: ident, type: 'WAYPOINT', role, latitude: lat, longitude: lon, coordinateSourceType: 'EXPLICIT_TABLE' as const, evidence: [], confidence: 1, status: 'CONFIRMED' as const, allowFor424: true };
}

// ============ 原图配准 ============

test('georeference solves an affine transform from fix label spans', () => {
  const pir = basePir();
  pir.fixes.push({ fixId: 'c', identifier: 'CCCCC', type: 'WAYPOINT', role: null, latitude: 37.5, longitude: 126.4, coordinateSourceType: 'EXPLICIT_TABLE', evidence: [], confidence: 1, status: 'CONFIRMED', allowFor424: true });
  // 构造线性映射：px = (lon-126)*1000, py = (38-lat)*1000（72dpi 坐标 ×200/72 后仍线性）
  const scale = 72 / 200;
  const page: any = { pageNumber: 1, width: 595, height: 842, quality: { renderDpi: 200 }, textSpans: pir.fixes.map((f) => ({ text: f.identifier, bbox: [((f.longitude! - 126) * 1000) * scale - 5, ((38 - f.latitude!) * 1000) * scale - 5, ((f.longitude! - 126) * 1000) * scale + 5, ((38 - f.latitude!) * 1000) * scale + 5] })) };
  const result = georeferencePage(page, pir);
  assert.equal(result.ok, true, result.reason);
  const [px, py] = applyAffine(result.transform!, 126.5, 37.3);
  assert.ok(Math.abs(px - 500) < 2 && Math.abs(py - 700) < 2);
});

test('georeference refuses collinear or insufficient control points', () => {
  const pir = basePir(); // 只有 2 个 fix
  const page: any = { pageNumber: 1, width: 595, height: 842, quality: { renderDpi: 200 }, textSpans: [{ text: 'AAAAA', bbox: [10, 10, 30, 20] }, { text: 'BBBBB', bbox: [100, 100, 130, 110] }] };
  const result = georeferencePage(page, pir);
  assert.equal(result.ok, false);
  assert.match(result.reason!, /control points/i);
});

// ============ 分组完整性审计 ============

test('grouping audit flags claimed-vs-actual count mismatches and unassigned charts', () => {
  const task: any = { pages: [ { documentId: 'd1', pageNumber: 1, fileName: 'x.pdf', title: 'ILS or LOC RWY 33R INSTRUMENT APPROACH CHART', summary: '' } ] };
  const analysis: any = {
    packages: [ { procedureCategory: 'SID', procedureName: 'A 1', runways: ['15L'], procedureKey: 'k1', sources: [], sharedSources: [], groupingReason: '' } ],
    unassignedPages: [],
    decisionSummary: 'Identified 2 SID packages and 1 approach.',
    warnings: [],
  };
  const warnings = auditGrouping(task, analysis);
  assert.ok(warnings.some((w) => w.startsWith('GROUPING_COUNT_MISMATCH') && w.includes('SID')));
  assert.ok(warnings.some((w) => w.startsWith('GROUPING_HIGH_VALUE_UNASSIGNED')));
  assert.ok(warnings.some((w) => w.startsWith('GROUPING_PAGE_ACCOUNTING')));
});

function flatCoords(geometry: any): [number, number][] {
  if (!geometry) return [];
  if (geometry.type === 'LineString') return geometry.coordinates;
  if (geometry.type === 'MultiLineString') return geometry.coordinates.flat();
  return [];
}
