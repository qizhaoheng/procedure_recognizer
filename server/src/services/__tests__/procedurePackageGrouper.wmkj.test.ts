import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ChartRole, PdfPageAsset } from '../../types/procedure';
import { buildGroupingDebug, groupProcedurePackages } from '../procedurePackageGrouper';

interface FixtureProcedure {
  title: string;
  chartNo: string;
  pageNo: number;
  tabulars?: Array<{ chartNo: string; pageNo: number; role?: ChartRole }>;
}

const procedures: FixtureProcedure[] = [
  { title: 'STANDARD DEPARTURE CHART - ICAO RWY 16/34 RADAR TWO DEPARTURE', chartNo: 'AD 2-WMKJ-6-1', pageNo: 31 },
  {
    title: 'STANDARD DEPARTURE CHART - ICAO RWY 16 RNAV AROSO 1J ADLOV 1J PIMOK 1J SABKA 1J',
    chartNo: 'AD 2-WMKJ-6-3',
    pageNo: 33,
    tabulars: [
      { chartNo: 'AD 2-WMKJ-6-4', pageNo: 34 },
      { chartNo: 'AD 2-WMKJ-6-5', pageNo: 35, role: 'WAYPOINT_COORDINATES' },
    ],
  },
  {
    title: 'STANDARD DEPARTURE CHART - ICAO RWY 16 RNAV AROSO 2J ADLOV 2J SABKA 2J OMKOM 2J',
    chartNo: 'AD 2-WMKJ-6-7',
    pageNo: 37,
    tabulars: [
      { chartNo: 'AD 2-WMKJ-6-8', pageNo: 38 },
      { chartNo: 'AD 2-WMKJ-6-9', pageNo: 39, role: 'WAYPOINT_COORDINATES' },
    ],
  },
  {
    title: 'STANDARD DEPARTURE CHART - ICAO RWY 34 RNAV AROSO 1K ADLOV 1K PIMOK 1K OMKOM 1K SABKA 1K',
    chartNo: 'AD 2-WMKJ-6-11',
    pageNo: 41,
    tabulars: [
      { chartNo: 'AD 2-WMKJ-6-12', pageNo: 42 },
      { chartNo: 'AD 2-WMKJ-6-13', pageNo: 43, role: 'WAYPOINT_COORDINATES' },
    ],
  },
  {
    title: 'STANDARD DEPARTURE CHART - ICAO RWY 16 AROSO 1L SABKA 1L PIMOK 1L',
    chartNo: 'AD 2-WMKJ-6-15',
    pageNo: 45,
    tabulars: [{ chartNo: 'AD 2-WMKJ-6-16', pageNo: 46 }],
  },
  {
    title: 'STANDARD DEPARTURE CHART - ICAO RWY 16 AROSO 2L ADLOV 2L OMKOM 2L',
    chartNo: 'AD 2-WMKJ-6-17',
    pageNo: 47,
    tabulars: [{ chartNo: 'AD 2-WMKJ-6-18', pageNo: 48 }],
  },
  {
    title: 'STANDARD DEPARTURE CHART - ICAO RWY 34 AROSO 1M ADLOV 1M OMKOM 1M PIMOK 1M SABKA 1M',
    chartNo: 'AD 2-WMKJ-6-19',
    pageNo: 49,
    tabulars: [{ chartNo: 'AD 2-WMKJ-6-20', pageNo: 50 }],
  },
  {
    title: 'STANDARD ARRIVAL CHART - ICAO RWY 16 RNAV STAR EMTUV 1E OMKOM 1E PIMOK 1E ADLOV 1E',
    chartNo: 'AD 2-WMKJ-7-1',
    pageNo: 51,
    tabulars: [
      { chartNo: 'AD 2-WMKJ-7-2', pageNo: 52 },
      { chartNo: 'AD 2-WMKJ-7-3', pageNo: 53, role: 'WAYPOINT_COORDINATES' },
    ],
  },
  {
    title: 'STANDARD ARRIVAL CHART - ICAO RWY 16 11 DME ARC STAR EMTUV 1G OMKOM 1G PIMOK 1G ADLOV 1G',
    chartNo: 'AD 2-WMKJ-7-5',
    pageNo: 55,
    tabulars: [{ chartNo: 'AD 2-WMKJ-7-6', pageNo: 56 }],
  },
  ...approach('ILS Z OR LOC Z', 'AD 2-WMKJ-8-1', 57, ['AD 2-WMKJ-8-2']),
  ...approach('ILS Y OR LOC Y', 'AD 2-WMKJ-8-3', 59, ['AD 2-WMKJ-8-4']),
  ...approach('ILS X OR LOC X', 'AD 2-WMKJ-8-5', 61, ['AD 2-WMKJ-8-6']),
  ...approach('ILS W OR LOC W', 'AD 2-WMKJ-8-7', 63, ['AD 2-WMKJ-8-8']),
  ...approach('VOR Z', 'AD 2-WMKJ-8-9', 65, ['AD 2-WMKJ-8-10']),
  ...approach('VOR Y', 'AD 2-WMKJ-8-11', 67, ['AD 2-WMKJ-8-12']),
  ...approach('VOR X', 'AD 2-WMKJ-8-13', 69, ['AD 2-WMKJ-8-14']),
  ...approach('VOR W', 'AD 2-WMKJ-8-15', 71, ['AD 2-WMKJ-8-16']),
  ...approach('RNP Y', 'AD 2-WMKJ-8-17', 73, ['AD 2-WMKJ-8-18', 'AD 2-WMKJ-8-19']),
  ...approach('RNP X', 'AD 2-WMKJ-8-21', 77, ['AD 2-WMKJ-8-22', 'AD 2-WMKJ-8-23']),
  ...approach('RNP Z (AR)', 'AD 2-WMKJ-8-25', 81, ['AD 2-WMKJ-8-26', 'AD 2-WMKJ-8-27']),
  {
    title: 'INSTRUMENT APPROACH CHART - ICAO RWY 34 RNP Z (AR)',
    chartNo: 'AD 2-WMKJ-8-29',
    pageNo: 85,
    tabulars: [
      { chartNo: 'AD 2-WMKJ-8-30', pageNo: 86 },
      { chartNo: 'AD 2-WMKJ-8-31', pageNo: 87 },
    ],
  },
];

describe('WMKJ procedure package grouping', () => {
  const pages = buildMockPages();
  const packages = groupProcedurePackages(pages);

  it('builds the expected 21 AD 2.24 procedure packages', () => {
    assert.equal(packages.length, 21);
    assert.equal(packages.filter((item) => item.packageType === 'SID').length, 7);
    assert.equal(packages.filter((item) => item.packageType === 'STAR').length, 2);
    assert.equal(packages.filter((item) => item.packageType === 'APPROACH').length, 12);
  });

  it('matches chartNo to exact PDF pages and keeps tabular pages attached', () => {
    assert.deepEqual(getPackage('AD 2-WMKJ-6-1').chartPages, [31]);
    assert.deepEqual(getPackage('AD 2-WMKJ-6-3').chartPages, [33]);
    assert.deepEqual(getPackage('AD 2-WMKJ-6-3').tabularPages, [34, 35]);
    assert.deepEqual(getPackage('AD 2-WMKJ-7-1').chartPages, [51]);
    assert.deepEqual(getPackage('AD 2-WMKJ-7-1').tabularPages, [52, 53]);
    assert.ok(getPackage('AD 2-WMKJ-7-1').coordinatePages.includes(53));
    assert.deepEqual(getPackage('AD 2-WMKJ-7-5').chartPages, [55]);
    assert.deepEqual(getPackage('AD 2-WMKJ-7-5').tabularPages, [56]);
    assert.deepEqual(getPackage('AD 2-WMKJ-8-1').chartPages, [57]);
    assert.deepEqual(getPackage('AD 2-WMKJ-8-1').tabularPages, [58]);
    assert.deepEqual(getPackage('AD 2-WMKJ-8-17').chartPages, [73]);
    assert.deepEqual(getPackage('AD 2-WMKJ-8-17').tabularPages, [74, 75]);
    assert.deepEqual(getPackage('AD 2-WMKJ-8-25').chartPages, [81]);
    assert.deepEqual(getPackage('AD 2-WMKJ-8-25').tabularPages, [82, 83]);
    assert.deepEqual(getPackage('AD 2-WMKJ-8-29').chartPages, [85]);
    assert.deepEqual(getPackage('AD 2-WMKJ-8-29').tabularPages, [86, 87]);
  });

  it('does not create UNKNOWN SID or consume index/blank pages as charts', () => {
    const allChartPages = packages.flatMap((item) => item.chartPages);
    assert.ok(!allChartPages.includes(17));
    for (const pageNo of [18, 20, 22, 24, 26, 28, 30, 32, 36, 40, 44, 54, 76, 80, 84, 88]) {
      assert.ok(!allChartPages.includes(pageNo), `page ${pageNo} should not be a chart page`);
    }
    assert.ok(packages.every((item) => !(item.packageName || '').includes('UNKNOWN SID')));
  });

  it('exposes exact chartNo debug data', () => {
    const debug = buildGroupingDebug(pages);
    assert.deepEqual(debug.chartNoPageMap.find((item) => item.chartNo === 'AD 2-WMKJ-6-1')?.pageNos, [31]);
    assert.deepEqual(debug.chartNoPageMap.find((item) => item.chartNo === 'AD 2-WMKJ-8-1')?.pageNos, [57]);
    assert.deepEqual(debug.chartNoPageMap.find((item) => item.chartNo === 'AD 2-WMKJ-8-17')?.pageNos, [73]);
    assert.equal(debug.unmatchedChartIndexItems.length, 0);
    assert.equal(debug.duplicateChartNoPages.length, 0);
  });

  it('attaches supporting info by procedure/navigation type', () => {
    assert.deepEqual(getPackage('AD 2-WMKJ-7-1').supportingInfoRefs, {
      airportMetadata: [1],
      runwayData: [10],
      communication: [12],
      chartIndex: [16, 17],
    });
    assert.deepEqual(getPackage('AD 2-WMKJ-7-5').supportingInfoRefs, {
      airportMetadata: [1],
      runwayData: [10],
      communication: [12],
      navaid: [13],
      flightProcedures: [15],
      chartIndex: [16, 17],
    });
    assert.deepEqual(getPackage('AD 2-WMKJ-8-1').supportingInfoRefs, {
      airportMetadata: [1],
      runwayData: [10],
      runwayOperationalData: [11],
      communication: [12],
      navaid: [13],
      chartIndex: [16, 17],
    });
  });

  function getPackage(chartNo: string) {
    const found = packages.find((item) => item.chartNo === chartNo);
    assert.ok(found, `missing package ${chartNo}`);
    return found;
  }
});

function approach(name: string, chartNo: string, pageNo: number, tabularChartNos: string[]): FixtureProcedure[] {
  return [{
    title: `INSTRUMENT APPROACH CHART - ICAO RWY 16 ${name}`,
    chartNo,
    pageNo,
    tabulars: tabularChartNos.map((tabularChartNo, index) => ({ chartNo: tabularChartNo, pageNo: pageNo + index + 1 })),
  }];
}

function buildMockPages(): PdfPageAsset[] {
  return [
    page(1, 'AD 2-WMKJ-1-1', 'WMKJ AD 2.1 AERODROME LOCATION INDICATOR AND NAME WMKJ - JOHOR BAHRU/SENAI INTERNATIONAL\nWMKJ AD 2.2 AERODROME GEOGRAPHICAL AND ADMINISTRATIVE DATA\nARP coordinates and site at AD 013826N 1034013E\nElevation 41 M (135 FT)', 'SUPPORT'),
    page(10, 'AD 2-WMKJ-1-10', 'WMKJ AD 2.12 RUNWAY PHYSICAL CHARACTERISTICS\nRWY 16 34 true bearing 160° 340° length 3800 x 45 M Asphalt PCR 1230\nTHR coordinates 013826N 1034013E', 'SUPPORT'),
    page(11, 'AD 2-WMKJ-1-11', 'WMKJ AD 2.13 DECLARED DISTANCES\nWMKJ AD 2.14 APPROACH AND RUNWAY LIGHTING\n16 THRESHOLD 3800 3800 3800 3800\nPAPI RUNWAY LIGHTS RUNWAY END LIGHTS', 'SUPPORT'),
    page(12, 'AD 2-WMKJ-1-12', 'WMKJ AD 2.17 ATS AIRSPACE\nWMKJ AD 2.18 ATS COMMUNICATION FACILITIES\nJOHOR BAHRU CTR transition altitude 11000 FT\nAPP 123.45 TWR 118.15 SMC 121.8 ATIS 126.0', 'SUPPORT'),
    page(13, 'AD 2-WMKJ-1-13', 'WMKJ AD 2.19 RADIO NAVIGATION AND LANDING AIDS\nILS LOC GP/DME VOR/DME VJB 112.500 MHZ CH 72X coordinates 013950N 1033939E', 'SUPPORT'),
    page(15, 'AD 2-WMKJ-1-15', 'WMKJ AD 2.22 FLIGHT PROCEDURES\nDME Arrival Procedures RADIAL/TRACK NAVAID DME CHECK POINT MNM IFR ALTITUDE REMARKS R-275/095° VJB 5000FT level restriction', 'SUPPORT'),
    page(16, 'AD 2-WMKJ-1-16', 'AD 2.24 CHARTS RELATED TO AN AERODROME\n' + buildIndexText().split('\n').slice(0, 30).join('\n'), 'CHART_INDEX'),
    page(17, 'AD 2-WMKJ-1-17', buildIndexText().split('\n').slice(30).join('\n') + '\nChart name Page', 'CHART_INDEX'),
    ...procedures.flatMap((procedure) => [
      page(procedure.pageNo, procedure.chartNo, `${procedure.title}\n${procedure.chartNo}`, 'CHART'),
      ...(procedure.tabulars ?? []).map((tabular, index) =>
        page(
          tabular.pageNo,
          tabular.chartNo,
          `${procedure.title} (TABULAR ${index + 1})\nTABULAR DESCRIPTION\n${tabular.role === 'WAYPOINT_COORDINATES' ? 'WAYPOINT COORDINATES\n' : ''}${tabular.chartNo}`,
          tabular.role || 'TABULAR_DESCRIPTION',
        ),
      ),
    ]),
  ];
}

function buildIndexText() {
  return procedures
    .flatMap((procedure) => [
      `${procedure.title} ${procedure.chartNo}`,
      ...(procedure.tabulars ?? []).map((tabular, index) => `${procedure.title} (TABULAR ${index + 1})${tabular.chartNo}`),
    ])
    .join('\n');
}

function page(pageNo: number, aipPageNo: string, text: string, chartRole: ChartRole): PdfPageAsset {
  return {
    pageNo,
    aipPageNo,
    textLayerText: text,
    ocrText: text,
    chartRole,
    procedureCategory: 'UNKNOWN',
    navigationType: 'UNKNOWN',
    confidence: 0.95,
    reviewRequired: false,
  };
}
