import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PdfPageAsset } from '../../types/procedure';
import { extractAirportMasterData } from '../jeppesen424/airportMasterDataExtractor';
import { encodeAirportMasterRecords, encodeTerminalWaypointRecords } from '../jeppesen424/airportMasterRecordEncoder';

function page(pageNo: number, textLayerText: string): PdfPageAsset {
  return {
    pageNo, textLayerText, chartRole: 'OTHER', procedureCategory: 'UNKNOWN',
    navigationType: 'UNKNOWN',
  };
}

describe('airport master data extraction', () => {
  it('extracts auditable airport, runway and landing-aid entities from ICAO AD 2 tables', () => {
    const result = extractAirportMasterData([
      page(1, 'VHHH AD 2.1 AERODROME LOCATION INDICATOR AND NAME VHHH - HONG KONG/ INTERNATIONAL VHHH AD 2.2 AERODROME GEOGRAPHICAL AND ADMINISTRATIVE DATA ARP co-ordinates and site at AD 221832N 1135453E Elevation/Reference temperature 28 ft/34°C MAG VAR / Annual change 3°W (2020) / 4’W'),
      page(15, 'VHHH AD 2.12 RUNWAY PHYSICAL CHARACTERISTICS RWY 07L 070.90°T 073.90°M 3800 x 60 PCR 720/F/B/W/T Asphalt 221917.72N 1135256.26E 23.3FT 23.2FT RWY 25R 250.90°T 253.90°M 3800 x 60 PCR 720/F/B/W/T Asphalt 221954.45N 1135450.24E 23.1FT 23.0FT'),
      page(22, 'VHHH AD 2.19 RADIO NAVIGATION AND LANDING AIDS DME25R ITFR CH 24Y H24 221955.16N 1135438.56E 6.36M GP25R CAT I ITFR 330.35 MHZ H24 221955.16N 1135438.56E LOC25R CAT I ITFR 108.75 MHZ H24 221912.67N 1135240.61E'),
      page(31, 'SID Navigation Aids Navaid Frequency Coordinates SMT DVOR/DME 114.8 MHZ (CH 95X) 222015.43N 1135855.46E'),
    ]);
    assert.equal(result.airport?.icao, 'VHHH');
    assert.equal(result.airport?.name, 'HONG KONG/ INTERNATIONAL');
    assert.equal(result.airport?.elevationFt, 28);
    assert.equal(result.airport?.magneticVariationDeg, 3);
    assert.equal(result.airport?.latitude, 22.308888889);
    assert.deepEqual(result.runways.map((item) => item.identifier), ['RW07L', 'RW25R']);
    assert.equal(result.runways[0].surface, 'ASPHALT');
    assert.equal(result.runways[0].thresholdElevationFt, 23.3);
    assert.deepEqual(result.navaids.map((item) => [item.facility, item.identifier, item.channel, item.frequencyMhz]), [
      ['DME25R', 'ITFR', 'CH24Y', undefined],
      ['GP25R', 'ITFR', undefined, 330.35],
      ['LOC25R', 'ITFR', undefined, 108.75],
      ['DVOR/DME', 'SMT', 'CH95X', 114.8],
    ]);
    assert.deepEqual(result.warnings, []);

    const encoded = encodeAirportMasterRecords(result);
    assert.equal(encoded.records.length, 5);
    assert.ok(encoded.records.every((record) => record.line.length === 132));
    const airport = encoded.records.find((record) => record.category === 'AIRPORT_PRIMARY')!.line;
    assert.equal(airport.slice(0, 13), 'SPACP VHHHVHA');
    assert.equal(airport.slice(32, 51), 'N22183200E113545300');
    assert.equal(airport.slice(51, 56), 'W0030');
    assert.equal(airport.slice(56, 61), '00028');
    const runway = encoded.records.find((record) => record.sourceKey === 'RW07L')!.line;
    assert.equal(runway.slice(12, 18), 'GRW07L');
    assert.equal(runway.slice(22, 27), '12467');
    assert.equal(runway.slice(27, 31), '0709');
    const ils = encoded.records.find((record) => record.category === 'ILS_NAVAID')!.line;
    assert.equal(ils.slice(12, 18), 'IITFR ');
    assert.equal(ils.slice(22, 27), '10875');
    assert.equal(ils.slice(27, 32), 'RW25R');
    assert.equal(ils.slice(32, 51), 'N22191267E113524061');
    const vhf = encoded.records.find((record) => record.category === 'VHF_NAVAID')!.line;
    assert.equal(vhf.slice(0, 5), 'SPACD');
    assert.equal(vhf.slice(13, 17), 'SMT ');
    assert.equal(vhf.slice(19, 27), 'VH011480');
    assert.equal(vhf.slice(55, 74), 'N22201543E113585546');

    const waypoints = encodeTerminalWaypointRecords({ master: result, canonicals: [{ airportIcao: 'VHHH', fixes: [
      { identifier: 'HH301', latitude: 22.324725, longitude: 113.986558333, sourcePageNo: 80 },
      { identifier: 'BEKOL', latitude: 22.543333333, longitude: 114.133333333, sourcePageNo: 80 },
    ] }] });
    assert.equal(waypoints.records.length, 2);
    assert.equal(waypoints.records[0].line.slice(12, 22), 'CHH301 VH0');
    assert.equal(waypoints.records[0].line.slice(32, 51), 'N22192901E113591161');
    assert.equal(waypoints.records[1].line.slice(19, 21), 'ZG');
    assert.equal(waypoints.records[1].line.slice(74, 79), 'W0030');
    assert.ok(waypoints.records.every((record) => record.line.length === 132));
  });
});
