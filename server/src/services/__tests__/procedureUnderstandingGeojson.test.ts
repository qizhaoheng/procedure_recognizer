import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildGeoJsonFromProcedureUnderstanding } from '../procedureUnderstandingGeojson';
import type { PdfPageAsset, ProcedureGroup, ProcedureUnderstandingResult } from '../../types/procedure';

const EARTH_RADIUS_NM = 3440.065;
const VJB = { lat: 1.6394, lon: 103.6736 };

const group = {
  groupId: 'pkg_test',
  packageId: 'pkg_test',
  groupName: 'test-group',
  packageName: 'RWY16 11 DME ARC STAR',
  chartPages: [55],
  chartPageNo: 55,
  procedureNames: ['ADLOV 1G'],
  runway: 'RWY16',
} as unknown as ProcedureGroup;

// 腿链来自 Jeppesen 424 金标准（ADLOV 1G）：IF → TF(D016M) → CI(196°) → AF(L, D340K) → TF(OSRUP)
const understanding: ProcedureUnderstandingResult = {
  airportIcao: 'WMKJ',
  runway: 'RWY16',
  navigationType: 'DME_ARC',
  geometrySemantics: [
    { type: 'DME_ARC', labelText: '11 DME ARC', centerNavaid: 'VJB', radiusNm: 11, relatedProcedures: ['ADLOV 1G'], sourcePageNo: 55, confidence: 0.9, reviewRequired: false },
  ],
  navaids: [
    { identifier: 'VJB', type: 'VOR/DME', rawCoordinate: '013822N 1034025E', latitude: VJB.lat, longitude: VJB.lon },
  ],
  fixes: [
    { identifier: 'ADLOV', latitude: destination(VJB, 16, 25)[1], longitude: destination(VJB, 16, 25)[0] },
    { identifier: 'OSRUP', latitude: destination(VJB, 340, 8.7)[1], longitude: destination(VJB, 340, 8.7)[0] },
  ],
  procedures: [
    {
      procedureName: 'ADLOV 1G',
      runway: 'RWY16',
      legs: [
        { sequence: 10, pathTerminator: 'IF', fixIdentifier: 'ADLOV', altitudeConstraint: { rawText: '-6000', altitudeFt: 6000 } },
        { sequence: 20, pathTerminator: 'TF', fixIdentifier: 'D016M', distanceNm: 12, altitudeConstraint: { rawText: '+3200', altitudeFt: 3200 } },
        { sequence: 30, pathTerminator: 'CI', fixIdentifier: null, courseDegMag: 196, distanceNm: 2 },
        { sequence: 40, pathTerminator: 'AF', fixIdentifier: 'D340K', turnDirection: 'L', distanceNm: 6.9 },
        { sequence: 50, pathTerminator: 'TF', fixIdentifier: 'OSRUP', distanceNm: 2.3, altitudeConstraint: { rawText: '+2000', altitudeFt: 2000 } },
      ],
    },
  ],
  labelPlan: [
    { text: 'ADLOV\n6000', labelKind: 'FIX_NAME', anchorType: 'FIX', anchorIdent: 'ADLOV', anchorDirection: 'AUTO', priority: 90, sourcePageNo: 55 },
    { text: 'ADLOV\n6000', labelKind: 'FIX_NAME', anchorType: 'FIX', anchorIdent: 'ADLOV', anchorDirection: 'AUTO', priority: 90, sourcePageNo: 55 },
    { text: '196°', labelKind: 'COURSE_DISTANCE', anchorType: 'LEG', procedureName: 'ADLOV 1G', legSequence: 30, placementAlongLine: 'MIDDLE', sideOfLine: 'RIGHT', sourcePageNo: 55 },
    { text: '11 DME ARC\nVJB', labelKind: 'DME_ARC', anchorType: 'DME_ARC', procedureName: 'ADLOV 1G', placementAlongLine: 'MIDDLE', sideOfLine: 'LEFT', sourcePageNo: 55 },
    { text: 'VJB 112.7', labelKind: 'NAVAID_INFO', anchorType: 'NAVAID', anchorIdent: 'VJB', anchorDirection: 'SW', sourcePageNo: 54 },
  ],
};

describe('procedure understanding GeoJSON — DME ARC legs', () => {
  const geojson = buildGeoJsonFromProcedureUnderstanding(understanding, group);
  const legs = geojson.features.filter((f) => f.properties?.object_type === 'ProcedureLeg');
  const bySeq = new Map(legs.map((f) => [f.properties?.leg_seq, f]));

  it('renders TF/CI/AF/TF legs as line features', () => {
    assert.deepEqual([...bySeq.keys()].sort((a, b) => Number(a) - Number(b)), [20, 30, 40, 50]);
  });

  it('synthesizes D-fix coordinates from radial + DME distance naming', () => {
    const d016m = geojson.features.find((f) => f.properties?.object_type === 'ProcedureFix' && f.properties?.ident === 'D016M');
    const d340k = geojson.features.find((f) => f.properties?.object_type === 'ProcedureFix' && f.properties?.ident === 'D340K');
    assert.ok(d016m && d340k, 'synthetic D-fix features missing');
    assert.equal(d016m?.properties?.coordinate_quality, 'derived_from_dme_fix_name');
    const [lon, lat] = (d016m?.geometry as GeoJSON.Point).coordinates;
    assertClose([lon, lat], destination(VJB, 16, 13), 0.002);
    const [lon2, lat2] = (d340k?.geometry as GeoJSON.Point).coordinates;
    assertClose([lon2, lat2], destination(VJB, 340, 11), 0.002);
  });

  it('renders the CI leg by dead-reckoning course and distance to the arc', () => {
    const ci = bySeq.get(30);
    const coords = (ci?.geometry as GeoJSON.LineString).coordinates;
    assert.equal(coords.length, 2);
    assert.equal(ci?.properties?.coordinate_quality, 'derived_from_course_intercept');
    // CI 终点应落在 11 DME 弧附近
    assert.ok(Math.abs(distanceNm(VJB, coords[1]) - 11) < 0.6, `CI end should be near the 11 DME arc, got ${distanceNm(VJB, coords[1])}`);
  });

  it('renders the AF leg as a counterclockwise arc around VJB ending at D340K', () => {
    const af = bySeq.get(40);
    const coords = (af?.geometry as GeoJSON.LineString).coordinates;
    assert.ok(coords.length >= 8, `AF leg should be sampled as an arc, got ${coords.length} points`);
    assert.equal(af?.properties?.coordinate_quality, 'derived_from_dme_arc_semantics');
    assertClose(coords[coords.length - 1] as [number, number], destination(VJB, 340, 11), 0.002);
    // 逆时针（L）：016 -> 360/000 -> 340,中途方位应在 340~016 区间外侧经过 358 附近
    const mid = coords[Math.floor(coords.length / 2)];
    const midBearing = bearing(VJB, mid);
    assert.ok(midBearing > 330 || midBearing < 20, `arc should pass north of VJB (ccw), mid bearing ${midBearing}`);
    // 弧上各点到 VJB 距离恒等于 11NM
    for (const point of coords.slice(1, -1)) {
      assert.ok(Math.abs(distanceNm(VJB, point) - 11) < 0.3, `arc point off radius: ${distanceNm(VJB, point)}`);
    }
  });

  it('builds the full procedure track chain including arc points', () => {
    const track = geojson.features.find((f) => f.properties?.object_type === 'ProcedureTrack' && f.properties?.procedure === 'ADLOV 1G');
    assert.ok(track, 'track feature missing');
    assert.equal(track?.properties?.coordinate_quality, 'derived_from_leg_chain');
    assert.ok((track?.geometry as GeoJSON.LineString).coordinates.length > 10);
  });
});

describe('procedure understanding GeoJSON — label plan', () => {
  const geojson = buildGeoJsonFromProcedureUnderstanding(understanding, group);
  const labels = geojson.features.filter((f) => f.properties?.object_type === 'LabelPoint');

  it('emits LabelPoint features and drops duplicate plan entries', () => {
    assert.equal(labels.length, 4, `expected 4 planned labels, got ${labels.length}: ${labels.map((f) => f.properties?.label_text).join(' | ')}`);
  });

  it('anchors the fix label at the fix on a clear side away from the track', () => {
    const fixLabel = labels.find((f) => f.properties?.label_text === 'ADLOV\n6000');
    assert.ok(fixLabel, 'fix label missing');
    assert.equal(fixLabel?.properties?.parent_feature_id, 'fix_ADLOV');
    assert.equal(fixLabel?.properties?.label_type, 'ProcedureFix');
    const [lon, lat] = (fixLabel?.geometry as GeoJSON.Point).coordinates;
    assertClose([lon, lat], destination(VJB, 16, 25), 0.001);
    // ADLOV 只有向南（约196°方向）的出航腿，标签应放在北侧半平面
    assert.ok(['bottom', 'bottom-left', 'bottom-right'].includes(String(fixLabel?.properties?.text_anchor)), `unexpected anchor ${fixLabel?.properties?.text_anchor}`);
  });

  it('places the course label at the leg midpoint with a perpendicular offset', () => {
    const courseLabel = labels.find((f) => f.properties?.label_text === '196°');
    assert.ok(courseLabel, 'course label missing');
    assert.equal(courseLabel?.properties?.parent_object_type, 'ProcedureLeg');
    assert.equal(courseLabel?.properties?.text_anchor, 'center');
    const offset = Math.hypot(Number(courseLabel?.properties?.text_offset_x), Number(courseLabel?.properties?.text_offset_y));
    assert.ok(Math.abs(offset - 1.2) < 0.05, `offset should be ~1.2em, got ${offset}`);
  });

  it('rides the DME ARC label on the AF leg geometry', () => {
    const arcLabel = labels.find((f) => f.properties?.label_text?.toString().includes('DME ARC'));
    assert.ok(arcLabel, 'arc label missing');
    assert.equal(arcLabel?.properties?.parent_object_type, 'ProcedureLeg');
    const [lon, lat] = (arcLabel?.geometry as GeoJSON.Point).coordinates;
    assert.ok(Math.abs(distanceNm(VJB, [lon, lat]) - 11) < 0.5, 'arc label should sit near the 11 DME arc');
  });

  it('honors the explicit navaid label direction', () => {
    const navaidLabel = labels.find((f) => f.properties?.label_text === 'VJB 112.7');
    assert.equal(navaidLabel?.properties?.text_anchor, 'top-right');
    assert.equal(navaidLabel?.properties?.source_page, 54);
  });
});

describe('procedure understanding GeoJSON — no-leg fallback entry radial', () => {
  it('joins the arc at the radial farthest from the exit radial (RDL275, not the RDL295 crossing)', () => {
    const fallbackUnderstanding: ProcedureUnderstandingResult = {
      airportIcao: 'WMKJ',
      runway: 'RWY16',
      navigationType: 'DME_ARC',
      geometrySemantics: [
        { type: 'DME_ARC', labelText: '11 DME ARC', centerNavaid: 'VJB', radiusNm: 11, relatedProcedures: ['EMTUV 1G'], sourcePageNo: 55, confidence: 0.9, reviewRequired: false },
        { type: 'RADIAL', labelText: 'RDL-340 VJB / 160', centerNavaid: 'VJB', radialDeg: 340, inboundTrackDeg: 160, relatedProcedures: ['EMTUV 1G'], sourcePageNo: 55, confidence: 0.9, reviewRequired: false },
        { type: 'RADIAL', labelText: 'RDL-275 VJB', centerNavaid: 'VJB', radialDeg: 275, relatedProcedures: ['EMTUV 1G'], sourcePageNo: 55, confidence: 0.9, reviewRequired: false },
        { type: 'RADIAL', labelText: 'RDL-295 VJB', centerNavaid: 'VJB', radialDeg: 295, relatedProcedures: ['EMTUV 1G'], sourcePageNo: 55, confidence: 0.9, reviewRequired: false },
      ],
      navaids: [{ identifier: 'VJB', type: 'VOR/DME', latitude: VJB.lat, longitude: VJB.lon }],
      fixes: [{ identifier: 'EMTUV', latitude: destination(VJB, 275, 24)[1], longitude: destination(VJB, 275, 24)[0] }],
      procedures: [{ procedureName: 'EMTUV 1G', runway: 'RWY16', legs: [] }],
    };
    const geojson = buildGeoJsonFromProcedureUnderstanding(fallbackUnderstanding, group);
    const track = geojson.features.find((f) => f.properties?.feature_id === 'track_EMTUV_1G_dme_arc');
    assert.ok(track, 'fallback track missing');
    const coords = (track?.geometry as GeoJSON.LineString).coordinates;
    // 轨迹第二点是入弧径向线上的 13 DME 点，应位于 RDL275 而不是 RDL295
    const entryBearing = bearing(VJB, coords[1]);
    assert.ok(Math.abs(entryBearing - 275) < 1.5, `entry radial should be 275, got bearing ${entryBearing}`);
  });
});

describe('procedure understanding GeoJSON — RNAV regression', () => {
  it('still renders straight fix-to-fix legs with the original quality label', () => {
    const rnav: ProcedureUnderstandingResult = {
      airportIcao: 'WMKJ',
      runway: 'RWY16',
      navigationType: 'RNAV',
      chartTexts: [
        { text: 'ADLOV 6000', role: 'ALTITUDE', region: 'MAIN_CHART', usedInProcedure: true, confidence: 0.9 },
        { text: 'GOVNU (IAF) 3500', role: 'FIX', region: 'MAIN_CHART', usedInProcedure: true, confidence: 0.9 },
      ],
      fixes: [
        { identifier: 'ADLOV', latitude: 2.04, longitude: 103.79 },
        { identifier: 'GOVNU', latitude: 1.85, longitude: 103.71 },
      ],
      procedures: [
        {
          procedureName: 'ADLOV 1E',
          runway: 'RWY16',
          legs: [
            { sequence: 10, pathTerminator: 'IF', fixIdentifier: 'ADLOV', altitudeConstraint: { rawText: '-6000', altitudeFt: 6000 } },
            { sequence: 20, pathTerminator: 'TF', fixIdentifier: 'GOVNU', courseDegMag: 198, distanceNm: 14.5, altitudeConstraint: { rawText: '+3500', altitudeFt: 3500 }, remarks: 'airway A224' },
          ],
        },
      ],
    };
    const geojson = buildGeoJsonFromProcedureUnderstanding(rnav, group);
    const leg = geojson.features.find((f) => f.properties?.object_type === 'ProcedureLeg');
    assert.ok(leg, 'leg feature missing');
    assert.equal(leg?.properties?.coordinate_quality, 'derived_from_fix_coordinates');
    assert.equal(leg?.properties?.review_required, false);
    assert.equal(leg?.properties?.course_deg_mag, 198);
    assert.equal(leg?.properties?.distance_nm, 14.5);
    assert.equal(leg?.properties?.airway_ref, undefined);
    const entryFix = geojson.features.find((f) => f.properties?.object_type === 'ProcedureFix' && f.properties?.ident === 'ADLOV');
    assert.equal(entryFix?.properties?.chart_altitude_ft, 6000);
    assert.equal(entryFix?.properties?.chart_fix_role, null);
    assert.equal(entryFix?.properties?.procedure_labels, undefined);
    const commonFix = geojson.features.find((f) => f.properties?.object_type === 'ProcedureFix' && f.properties?.ident === 'GOVNU');
    assert.equal(commonFix?.properties?.chart_fix_role, 'IAF');
    assert.equal(commonFix?.properties?.chart_altitude_ft, 3500);
    assert.equal(commonFix?.properties?.final_track_mag, 160);
    const track = geojson.features.find((f) => f.properties?.object_type === 'ProcedureTrack');
    assert.equal(track?.properties?.coordinate_quality, 'derived_from_fix_coordinates');
  });

  it('adds a final common segment from the shared IF toward the runway', () => {
    const rnav: ProcedureUnderstandingResult = {
      airportIcao: 'WMKJ',
      runway: 'RWY16',
      navigationType: 'RNAV',
      chartTexts: [
        { text: 'OSRUP (IF) 2000', role: 'FIX', region: 'MAIN_CHART', usedInProcedure: true, confidence: 0.9 },
      ],
      fixes: [
        { identifier: 'ADLOV', latitude: 2.04, longitude: 103.79 },
        { identifier: 'EMTUV', latitude: 1.69, longitude: 103.3 },
        { identifier: 'GOVNU', latitude: 1.85, longitude: 103.71 },
        { identifier: 'UDOSU', latitude: 1.76, longitude: 103.52 },
        { identifier: 'OSRUP', latitude: 1.8, longitude: 103.61 },
      ],
      procedures: [
        {
          procedureName: 'ADLOV 1E',
          runway: 'RWY16',
          legs: [
            { sequence: 10, pathTerminator: 'IF', fixIdentifier: 'ADLOV' },
            { sequence: 20, pathTerminator: 'TF', fromFix: 'ADLOV', fixIdentifier: 'GOVNU', courseDegMag: 198, distanceNm: 14.5 },
            { sequence: 30, pathTerminator: 'TF', fromFix: 'GOVNU', fixIdentifier: 'OSRUP', courseDegMag: 250, distanceNm: 6, altitudeConstraint: { rawText: '+2000', altitudeFt: 2000 } },
          ],
        },
        {
          procedureName: 'EMTUV 1E',
          runway: 'RWY16',
          legs: [
            { sequence: 10, pathTerminator: 'IF', fixIdentifier: 'EMTUV' },
            { sequence: 20, pathTerminator: 'TF', fromFix: 'EMTUV', fixIdentifier: 'UDOSU', courseDegMag: 72, distanceNm: 13.4 },
            { sequence: 30, pathTerminator: 'TF', fromFix: 'UDOSU', fixIdentifier: 'OSRUP', courseDegMag: 70, distanceNm: 6, altitudeConstraint: { rawText: '+2000', altitudeFt: 2000 } },
          ],
        },
      ],
    };

    const geojson = buildGeoJsonFromProcedureUnderstanding(rnav, group);
    const final = geojson.features.find((f) => f.properties?.leg_type === 'FINAL_COMMON_SEGMENT');
    assert.ok(final, 'final common segment missing');
    assert.equal(final?.properties?.from_fix, 'OSRUP');
    assert.equal(final?.properties?.to_fix, 'RW16');
    assert.equal(final?.properties?.course_deg_mag, 160);
    assert.equal(final?.properties?.altitude_ft, 2000);
    assert.ok((final?.geometry as GeoJSON.LineString).coordinates.length >= 2);
  });

  it('enriches SID fixes from coordinate pages and renders CA initial climb legs', () => {
    const sidGroup = {
      ...group,
      packageName: 'RWY16 RNAV SID ADLOV 1J',
      packageType: 'SID',
      procedureCategory: 'DEPARTURE',
      navigationType: 'RNAV',
      coordinatePages: [35],
      relatedPageNos: [33, 35],
      procedureNames: ['ADLOV 1J'],
      waypointCandidates: [{ ident: 'INVOV' }, { ident: 'ADLOV' }],
    } as unknown as ProcedureGroup;
    const sid: ProcedureUnderstandingResult = {
      airportIcao: 'WMKJ',
      runway: 'RWY16',
      navigationType: 'RNAV',
      runways: [
        {
          identifier: 'RWY16',
          thresholdLatitude: 1.6555083333333331,
          thresholdLongitude: 103.66396944444445,
          endLatitude: 1.6086111111111112,
          endLongitude: 103.67527777777778,
        },
      ],
      fixes: [
        { identifier: 'INVOV' },
        { identifier: 'ADLOV' },
      ],
      procedures: [
        {
          procedureName: 'ADLOV 1J',
          runway: 'RWY16',
          legs: [
            { sequence: 10, pathTerminator: 'CA', courseDegMag: 160, distanceNm: 0, altitudeConstraint: { rawText: '+1000', altitudeFt: 1000 } },
            { sequence: 20, pathTerminator: 'DF', fixIdentifier: 'INVOV', turnDirection: 'R', altitudeConstraint: { rawText: '+6000', altitudeFt: 6000 } },
            { sequence: 30, pathTerminator: 'TF', fromFix: 'INVOV', fixIdentifier: 'ADLOV', courseDegMag: 41, distanceNm: 23.8 },
          ],
        },
      ],
    };
    const pages = [{
      pageNo: 35,
      chartRole: 'WAYPOINT_COORDINATES',
      procedureCategory: 'DEPARTURE',
      navigationType: 'RNAV',
      textLayerText: 'COORDINATE INVOV 01 40 31.40 N 103 32 26.40 E ADLOV 02 03 57.10 N 103 46 40.10 E',
    }] as unknown as PdfPageAsset[];

    const geojson = buildGeoJsonFromProcedureUnderstanding(sid, sidGroup, pages);
    const invov = geojson.features.find((f) => f.properties?.object_type === 'ProcedureFix' && f.properties?.ident === 'INVOV');
    const adlov = geojson.features.find((f) => f.properties?.object_type === 'ProcedureFix' && f.properties?.ident === 'ADLOV');
    assertClose((invov?.geometry as GeoJSON.Point).coordinates as [number, number], [103.54066666666667, 1.6753888888888888], 0.00001);
    assertClose((adlov?.geometry as GeoJSON.Point).coordinates as [number, number], [103.77780555555556, 2.065861111111111], 0.00001);

    const ca = geojson.features.find((f) => f.properties?.object_type === 'ProcedureLeg' && f.properties?.leg_seq === 10);
    assert.ok(ca, 'CA leg feature missing');
    assert.equal(ca?.properties?.coordinate_quality, 'derived_from_sid_course_to_altitude');
    const coords = (ca?.geometry as GeoJSON.LineString).coordinates;
    assert.equal(coords.length, 2);
    assert.ok(distanceNm({ lat: coords[0][1], lon: coords[0][0] }, coords[1]) > 1.9, 'CA leg should use fallback distance when input is zero');

    const altitudePoint = geojson.features.find((f) => f.properties?.object_type === 'SIDAltitudePoint');
    assert.ok(altitudePoint, 'SID altitude point missing');
    assert.equal(altitudePoint?.properties?.altitude_ft, 1000);
    assert.equal(altitudePoint?.properties?.course_deg_mag, 160);
    assertClose((altitudePoint?.geometry as GeoJSON.Point).coordinates as [number, number], coords[1] as [number, number], 0.00001);

    const df = geojson.features.find((f) => f.properties?.object_type === 'ProcedureLeg' && f.properties?.leg_seq === 20);
    assert.ok(df, 'DF turn leg feature missing');
    assert.equal(df?.properties?.coordinate_quality, 'derived_from_sid_chart_turn');
    assert.ok((df?.geometry as GeoJSON.LineString).coordinates.length > 3, 'DF leg should be sampled as a charted turn, not a direct two-point line');
  });
});

function destination(origin: { lat: number; lon: number }, bearingDeg: number, distanceNmValue: number): [number, number] {
  const lat1 = toRad(origin.lat);
  const lon1 = toRad(origin.lon);
  const angular = distanceNmValue / EARTH_RADIUS_NM;
  const brng = toRad(bearingDeg);
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(angular) + Math.cos(lat1) * Math.sin(angular) * Math.cos(brng));
  const lon2 = lon1 + Math.atan2(
    Math.sin(brng) * Math.sin(angular) * Math.cos(lat1),
    Math.cos(angular) - Math.sin(lat1) * Math.sin(lat2),
  );
  return [toDeg(lon2), toDeg(lat2)];
}

function bearing(origin: { lat: number; lon: number }, target: number[]) {
  const lat1 = toRad(origin.lat);
  const lon1 = toRad(origin.lon);
  const lat2 = toRad(target[1]);
  const lon2 = toRad(target[0]);
  const y = Math.sin(lon2 - lon1) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(lon2 - lon1);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

function distanceNm(origin: { lat: number; lon: number }, target: number[]) {
  const lat1 = toRad(origin.lat);
  const lat2 = toRad(target[1]);
  const dLat = lat2 - lat1;
  const dLon = toRad(target[0]) - toRad(origin.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * Math.asin(Math.sqrt(h)) * EARTH_RADIUS_NM;
}

function assertClose(actual: [number, number], expected: [number, number], tolerance: number) {
  assert.ok(
    Math.abs(actual[0] - expected[0]) < tolerance && Math.abs(actual[1] - expected[1]) < tolerance,
    `expected [${expected}] got [${actual}]`,
  );
}

function toRad(value: number) {
  return (value * Math.PI) / 180;
}

function toDeg(value: number) {
  return (value * 180) / Math.PI;
}
