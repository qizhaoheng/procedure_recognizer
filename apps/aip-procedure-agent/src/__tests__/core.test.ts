import assert from 'node:assert/strict';
import test from 'node:test';
import { dmsToDecimal, geodesicForward, geodesicInverse, parseCoordinate } from '../coordinate';
import { arc, compile424Candidate, compileGeoJson, validatePir } from '../compiler';
import { garbledTextRatio } from '../pdfPreprocessor';
import type { BusinessProcedurePackage, PageAsset, ProcedurePIR } from '../domain';
import { derivePackageSources, selectGroupingImagePages } from '../orchestrator';
import { assessPackageSources, pageVectorPathCount, repairInvertedChartRoles } from '../sourcePreflight';
import { verify424Text, verifyGeometry } from '../aiGeneration';

test('parses compact AIP coordinates', () => { const value = parseCoordinate('N012030.00 E1034500.00'); assert.ok(Math.abs(value.latitude! - 1.3416667) < 1e-5); assert.equal(value.longitude, 103.75); });
test('converts DMS and validates components', () => { assert.equal(dmsToDecimal(1, 30, 0, 'S'), -1.5); assert.throws(() => dmsToDecimal(1, 60, 0)); });
test('geodesic forward and inverse round trip', () => { const end = geodesicForward([103.8, 1.3], 90, 10); const inv = geodesicInverse([103.8, 1.3], end); assert.ok(Math.abs(inv.distanceNm - 10) < 0.01); assert.ok(Math.abs(inv.initialBearing - 90) < 0.1); });
test('RF arc includes endpoints and samples', () => { const points = arc([103.8, 1.3], [103.8, 1.4], [103.9, 1.3], 'R'); assert.ok(points.length >= 8); assert.ok(geodesicInverse(points[0], [103.8, 1.4]).distanceNm < 0.01); });
test('validates PIR, compiles GeoJSON, and emits incomplete 424 safely', () => { const pir = samplePir(); const validations = validatePir(pir); assert.equal(validations.length, 0); const geo = compileGeoJson(pir) as any; assert.equal(geo.type, 'FeatureCollection'); assert.ok(geo.features.some((f: any) => f.properties.featureType === 'LEG')); const candidate = compile424Candidate(pir); assert.ok(['424_CANDIDATE','424_INCOMPLETE'].includes(candidate.status)); });

test('normalizes AIP RWY runway designators for 424 output', () => {
  const pir = samplePir();
  pir.procedure.name = 'AKSEL 2B ARRIVAL';
  pir.procedure.runways = ['RWY22'];
  pir.routes[0].runway = 'RWY22';
  const candidate = compile424Candidate(pir);
  assert.equal(candidate.status, '424_CANDIDATE', JSON.stringify(candidate));
  assert.match(candidate.text, /RW22/);
});

test('compiles a combined RNAV procedure name with the route-specific designator', () => {
  const pir = samplePir();
  pir.airport.icao = 'RKSI';
  pir.procedure.name = 'RNAV BINIL 3C, RNAV BOPTA 3C';
  pir.procedure.identifier = pir.procedure.name;
  pir.procedure.runways = ['15L', '15R'];
  pir.routes[0].identifier = 'RNAV BINIL 3C RWY 15L/R';
  pir.routes[0].runway = '15L';
  const candidate = compile424Candidate(pir);
  assert.equal(candidate.status, '424_CANDIDATE', JSON.stringify(candidate));
  assert.match(candidate.text, /BINI3C/);
});

test('matches a spelled-out combined title to a numeric route designator', () => {
  const pir = samplePir();
  pir.airport.icao = 'RKSI';
  pir.procedure.name = 'RNAV EGOBA TWO CHARLIE DEPARTURE, RNAV OSPOT TWO CHARLIE DEPARTURE';
  pir.procedure.identifier = pir.procedure.name;
  pir.procedure.runways = ['15L'];
  pir.routes[0].identifier = 'RNAV OSPOT 2C';
  pir.routes[0].runway = '15L';
  const candidate = compile424Candidate(pir);
  assert.equal(candidate.status, '424_CANDIDATE', JSON.stringify(candidate));
  assert.match(candidate.text, /OSPO2C/);
});

function samplePir(): ProcedurePIR { return { schemaVersion: '1.0.0', airport: { icao: 'WSSS', name: 'Singapore' }, procedure: { category: 'SID', identifier: 'TEST1A', name: 'TEST ONE ALPHA DEPARTURE', runways: ['02L'], navigationSpecification: 'RNAV 1' }, routes: [{ routeId: 'r1', routeType: 'RUNWAY_TRANSITION', identifier: 'RW02L', runway: '02L', legIds: ['l1'], sequence: 1 }], fixes: [{ fixId: 'a', identifier: 'AAAAA', type: 'WAYPOINT', latitude: 1.3, longitude: 103.8, coordinateSourceType: 'EXPLICIT_TABLE', evidence: ['e1'], confidence: .99, status: 'CONFIRMED', allowFor424: true }, { fixId: 'b', identifier: 'BBBBB', type: 'WAYPOINT', latitude: 1.4, longitude: 103.9, coordinateSourceType: 'EXPLICIT_TABLE', evidence: ['e2'], confidence: .99, status: 'CONFIRMED', allowFor424: true }], legs: [{ legId: 'l1', sequence: 10, routeId: 'r1', pathTerminator: 'TF', fromFixId: 'a', toFixId: 'b', course: 45, courseReference: 'MAGNETIC', distanceNm: 8, openEnded: false, evidence: ['e3'], confidence: .95, fieldStatus: { pathTerminator: 'CONFIRMED' }, warnings: [] }], notes: [], sourceEvidence: [], conflicts: [], validation: { results: [] }, quality: { confidence: .95, reviewRequired: false, unresolvedFields: [] } }; }

// 回归：OMAA AD-2 实测版式。旧选图逻辑（仅按文本覆盖率升序）把 6 张图额度全花在
// "PAGE INTENTIONALLY LEFT BLANK" 上，模型一张真实航图都没看到。实测修复后
// 航图页正确的包 70→77、无航图页的包 8→0。
// （注：拦掉 74 个包的并非此处，而是 preflight 里对 roleReason 的字符串匹配，见
//  sourcePreflight.ts 的 CHART_PAGE_IS_ACTUALLY_TABLE 与下方 preflight 回归测试。）
function omaaPage(pageNumber: number, vectorPathCount: number, nativeTextCoverage: number): PageAsset {
  return { documentId: 'doc', fileName: 'OMAA.pdf', pageNumber, width: 842, height: 1191, rotation: 0, renderedImagePath: `page-${pageNumber}.png`, thumbnailPath: `thumb-${pageNumber}.png`, nativeText: 'x', textSpans: [], vectorPaths: [], vectorPathCount, embeddedImages: [], detectedTables: [], detectedLanguages: ['en'], quality: { isScanned: false, nativeTextCoverage, renderDpi: 200 }, summary: '' };
}

test('grouping image budget goes to charts, never to blank pages', () => {
  const pages = [
    omaaPage(65, 26, 0.006), omaaPage(69, 26, 0.006), omaaPage(71, 26, 0.006),
    omaaPage(73, 26, 0.006), omaaPage(75, 26, 0.006), omaaPage(77, 26, 0.006),
    omaaPage(43, 1203, 0.60), omaaPage(45, 1086, 0.56), omaaPage(49, 1772, 0.91),
    omaaPage(107, 94762, 0.43), omaaPage(115, 93448, 0.35), omaaPage(117, 93191, 0.30),
    omaaPage(141, 77912, 0.14), omaaPage(143, 77082, 0.13), omaaPage(147, 47338, 0.15),
  ];
  const selected = selectGroupingImagePages(pages, 6).map((p) => p.pageNumber);
  assert.deepEqual(selected, [107, 115, 117, 141, 143, 147]);
  for (const blank of [65, 69, 71, 73, 75, 77]) assert.ok(!selected.includes(blank), `blank page ${blank} must not consume the image budget`);
  for (const table of [43, 45, 49]) assert.ok(!selected.includes(table), `table page ${table} must not outrank a chart page`);
});

test('scanned pages still outrank denser vector pages in the image budget', () => {
  const scanned = omaaPage(9, 30, 0.0);
  scanned.quality.isScanned = true;
  scanned.quality.nativeTextCoverage = 0.05; // 非空白：无文字覆盖但确实需要看图
  const selected = selectGroupingImagePages([omaaPage(107, 94762, 0.43), scanned], 2);
  assert.deepEqual(selected.map((p) => p.pageNumber), [9, 107]);
});

test('falls back to the truncated array length for tasks stored before vectorPathCount existed', () => {
  const legacy = omaaPage(115, 0, 0.35);
  delete (legacy as { vectorPathCount?: number }).vectorPathCount;
  legacy.vectorPaths = Array.from({ length: 5000 }, () => ({ operator: 'op' }));
  assert.equal(pageVectorPathCount(legacy), 5000);
});

// ---- 来源完整性预检（sourcePreflight）----
// 历史缺陷：旧检查要求模型自由文本 roleReason 里字面出现 "chart topology"/"visual chart"，
// 而分组 schema 是 additionalProperties:false 且未定义 roleReasons，模型结构上无法输出该字段。
// 于是条件恒为真，每个航图页都被判为"实为表格"——OMAA 82 个包里 70 个是这样被误拦的。
// 现改为包内相对比较：图页算子数须达本包表格页的 3 倍。
function pkgWith(pages: Array<{ page: number; role: string }>, name = 'ATUDO 5F', category: 'SID' | 'STAR' | 'APPROACH' = 'SID'): BusinessProcedurePackage {
  return {
    packageId: 'pkg', procedureKey: 'k', category: 'SID', procedureName: name, runways: ['13L'],
    sources: { primaryCharts: [], procedureTables: [], coordinateTables: [], runwayPages: [], navaidPages: [], sharedNotes: [], profilePages: [], minimaPages: [], relatedPages: [] },
    confidence: 1, warnings: [], procedureCategory: category, navigationType: 'RNAV 1',
    packagePages: pages.map((p) => ({ documentId: 'doc', fileName: 'OMAA.pdf', pageNumber: p.page, pageRole: p.role, isShared: false, confidence: 1 })),
    groupingConfidence: 1, groupingReason: 'r', status: 'GROUPED',
  } as BusinessProcedurePackage;
}
// 含机场平面图这个极端离群值（258 万算子）——早期的"语料级最大倍差分界"会被它带偏到
// 2585709，导致连真航图 p115 都低于分界、82 个包全被拦。回归必须覆盖它。
const omaaCorpus = [omaaPage(23, 1226, 0.63), omaaPage(43, 1203, 0.60), omaaPage(65, 26, 0.006), omaaPage(115, 93448, 0.35), omaaPage(64, 2585709, 0.39)];

test('a genuine chart page passes preflight (the roleReason check blocked 70 of 82 OMAA packages)', () => {
  const pkg = assessPackageSources(pkgWith([{ page: 115, role: 'PROCEDURE_CHART' }, { page: 23, role: 'PROCEDURE_TABLE' }]), omaaCorpus);
  assert.equal(pkg.preflight!.blockingIssues.filter((i) => i.code === 'CHART_PAGE_IS_ACTUALLY_TABLE').length, 0);
  assert.equal(pkg.sourceCompleteness!.chart, 'PRESENT');
  assert.equal(pkg.status, 'GROUPED', '真航图不得被降级为需复核');
});

// 预检跑在识别之前，此时没有任何结果可"复核"。它绝不能改生命周期状态——
// 旧实现把 GROUPED 覆盖成 REQUIRES_REVIEW，界面于是显示"没点识别就全是需复核"，
// 且从状态上再也看不出这个包跑没跑过。
test('preflight never touches the lifecycle status', () => {
  const blocked = assessPackageSources(pkgWith([{ page: 23, role: 'PROCEDURE_TABLE' }]), omaaCorpus);
  assert.ok(blocked.preflight!.blockingIssues.length, '这个包确实有阻塞项');
  assert.equal(blocked.status, 'GROUPED', '有阻塞项也必须停在待识别');
  const clean = assessPackageSources(pkgWith([{ page: 115, role: 'PROCEDURE_CHART' }, { page: 23, role: 'PROCEDURE_TABLE' }]), omaaCorpus);
  assert.equal(clean.status, 'GROUPED');
});

// 编码表是佐证不是前提：WMKJ 的进近是"航图 + 最低标准表"、没有 FMS 编码表，
// 雷达引导 SID 同样没有。按阻塞处理会误拦 15 个包。
test('a missing coding table is a warning, not a blocker', () => {
  const pkg = assessPackageSources(pkgWith([{ page: 115, role: 'PROCEDURE_CHART' }]), omaaCorpus);
  assert.ok(pkg.preflight!.warnings.some((i) => i.code === 'TABLE_MISSING'));
  assert.ok(!pkg.preflight!.blockingIssues.some((i) => i.code === 'TABLE_MISSING'));
});

// 密度型 CHART_PAGE_IS_ACTUALLY_TABLE 已移除：该比值拟合自 OMAA（图/表差 40 倍），
// WMKJ 的航图只有 1814-4829 个算子、与表格同量级，比值连续分布在 1.12-6.79，
// 固定阈值必然切在合法航图中间（实测 2.91 被拦、3.14 放行）。倒置改由 repair 处理。
test('a low-density chart page is no longer blocked by a fixed ratio', () => {
  const wmkjLike = [omaaPage(51, 4829, 0.4), omaaPage(52, 1537, 0.6), omaaPage(41, 4140, 0.4), omaaPage(42, 1423, 0.6)];
  for (const [chart, table] of [[41, 42], [51, 52]]) {
    const pkg = assessPackageSources(pkgWith([{ page: chart, role: 'PROCEDURE_CHART' }, { page: table, role: 'PROCEDURE_TABLE' }]), wmkjLike);
    assert.equal(pkg.preflight!.blockingIssues.filter((i) => i.code === 'CHART_PAGE_IS_ACTUALLY_TABLE').length, 0, `p${chart}/p${table} 比值不足 3 也不该被拦`);
  }
});

test('a package with no chart page at all is blocked as CHART_MISSING', () => {
  const pkg = assessPackageSources(pkgWith([{ page: 23, role: 'PROCEDURE_TABLE' }]), omaaCorpus);
  assert.ok(pkg.preflight!.blockingIssues.some((i) => i.code === 'CHART_MISSING'));
  assert.equal(pkg.sourceCompleteness!.chart, 'MISSING');
});

test('an RNP AR approach name keeps its identity despite the (AR) suffix', () => {
  // 归一化成 RNPYRWY13LAR；原实现把跑道号锚定在串尾，尾部的 AR 会让它失配，
  // OMAA 4 个 RNP AR 进近因此被误报 PROCEDURE_IDENTITY_UNCLEAR。
  const pkg = assessPackageSources(pkgWith([{ page: 115, role: 'PROCEDURE_CHART' }, { page: 23, role: 'PROCEDURE_TABLE' }], 'RNP Y RWY 13L (AR)', 'APPROACH'), omaaCorpus);
  assert.equal(pkg.preflight!.blockingIssues.filter((i) => i.code === 'PROCEDURE_IDENTITY_UNCLEAR').length, 0);
});

test('an approach package that names no runway is still identity-unclear', () => {
  const pkg = assessPackageSources(pkgWith([{ page: 115, role: 'PROCEDURE_CHART' }, { page: 23, role: 'PROCEDURE_TABLE' }], 'AREA MINIMA', 'APPROACH'), omaaCorpus);
  assert.ok(pkg.preflight!.blockingIssues.some((i) => i.code === 'PROCEDURE_IDENTITY_UNCLEAR'));
});

// ---- 图/表角色倒置的确定性纠正 ----
// OMAA 进近编码表每份两页：首页带小节号，续页只有列头。续页无身份信息，模型把它
// 填进 PROCEDURE_CHART，真航图反被挤进 PROCEDURE_TABLE。实测触发 5 次、零误触，
// 纠正后预检通过 73 -> 78。
test('an inverted chart/table role pair is swapped back by density', () => {
  const pkg = pkgWith([{ page: 43, role: 'PROCEDURE_CHART' }, { page: 23, role: 'PROCEDURE_TABLE' }, { page: 115, role: 'PROCEDURE_TABLE' }], 'RNP Y RWY 13L (AR)', 'APPROACH');
  const repair = repairInvertedChartRoles(pkg, omaaCorpus);
  assert.ok(repair, '倒置必须被检出');
  assert.equal(repair!.promotedPage, 115);
  assert.equal(repair!.demotedPage, 43);
  assert.equal(pkg.packagePages.find((p) => p.pageNumber === 115)!.pageRole, 'PROCEDURE_CHART');
  assert.equal(pkg.packagePages.find((p) => p.pageNumber === 43)!.pageRole, 'PROCEDURE_TABLE');
  assert.ok(pkg.warnings.some((w) => w.startsWith('ROLE_SWAPPED_BY_DENSITY')), '确定性覆盖必须留痕');
});

test('a correctly assigned package is left alone', () => {
  const pkg = pkgWith([{ page: 115, role: 'PROCEDURE_CHART' }, { page: 23, role: 'PROCEDURE_TABLE' }]);
  assert.equal(repairInvertedChartRoles(pkg, omaaCorpus), undefined, '正常包不得被误触');
  assert.equal(pkg.packagePages.find((p) => p.pageNumber === 115)!.pageRole, 'PROCEDURE_CHART');
  assert.equal(pkg.warnings.length, 0, '未纠正就不该留痕');
});

test('repair then preflight clears the chart-role blocker', () => {
  const pkg = pkgWith([{ page: 43, role: 'PROCEDURE_CHART' }, { page: 23, role: 'PROCEDURE_TABLE' }, { page: 115, role: 'PROCEDURE_TABLE' }], 'RNP Y RWY 13L (AR)', 'APPROACH');
  repairInvertedChartRoles(pkg, omaaCorpus);
  const assessed = assessPackageSources(pkg, omaaCorpus);
  assert.equal(assessed.preflight!.blockingIssues.filter((i) => i.code === 'CHART_PAGE_IS_ACTUALLY_TABLE').length, 0);
});

test('sources stays consistent with packagePages after a role swap', () => {
  // sources 是 packagePages 的派生视图。忘记重算会让两份表述打架：
  // packagePages 说 p115 是图页，而 sources.primaryCharts 还停留在 p43。
  const pages = omaaCorpus.map((p, i) => ({ ...p, globalPageNumber: i + 1 }));
  const task = { pages } as unknown as Parameters<typeof derivePackageSources>[1];
  const pkg = pkgWith([{ page: 43, role: 'PROCEDURE_CHART' }, { page: 23, role: 'PROCEDURE_TABLE' }, { page: 115, role: 'PROCEDURE_TABLE' }], 'RNP Y RWY 13L (AR)', 'APPROACH');
  repairInvertedChartRoles(pkg, pages);
  pkg.sources = derivePackageSources(pkg.packagePages, task);
  const chartGlobals = pages.filter((p) => p.pageNumber === 115).map((p) => p.globalPageNumber);
  assert.deepEqual(pkg.sources.primaryCharts, chartGlobals, 'sources.primaryCharts 必须跟随 pageRole 更新');
  assert.ok(!pkg.sources.primaryCharts.includes(pages.find((p) => p.pageNumber === 43)!.globalPageNumber));
});

// ---- 文本可用性判据 ----
// 旧判据只问"页面有没有文本"：WMKJ 的 p35 有 1190 字符、覆盖率 0.463，看着文本充裕，
// 实际是无 ToUnicode 映射的字形码乱码。旧规则在 WMKJ 88 页里一页都没选中，
// 模型读不到坐标就编了 7 个（见上面的出处核验）。
test('garbled glyph-code text is detected as unusable', () => {
  // WMKJ p35 实际抽出的文本片段："CIVIL AVIATION AUTHORITY OF MALAYSIA" 的字形码
  const garbled = '&,9,/$9,$7,21$87+25,7<2)0$/$<6,$ ^fsfi=^sf^qflk=^rqelofqv=lc=j^i^vpf^';
  assert.ok(garbledTextRatio(garbled) >= 0.35, `实测应在 0.59-0.64，得到 ${garbledTextRatio(garbled)}`);
});

test('a contents page with dotted leaders is not mistaken for garbled text', () => {
  // OMAA p63 原始符号占比 0.49，折叠连续重复字符后降到 0.15——点线导引是同一字符重复，
  // 文本本身完全可读。不折叠就会把正常目录页送去 OCR。
  const contents = 'OMAA AD 2.24 CHARTS RELATED TO AN AERODROME AD CHART - ICAO (Chart OMAA-AD-2-21A) ............................ 63';
  assert.ok(garbledTextRatio(contents) < 0.35, `目录页不得判为乱码，得到 ${garbledTextRatio(contents)}`);
});

test('ordinary AIP text stays well clear of the threshold', () => {
  for (const sample of [
    'ARP coordinates and site at AD 013826N 1034013E In front of AFRS station.',
    'NAV Specification VPA/TCH Speed Limit (KT) Distance (NM) Altitude (FT) Turn Direction',
    'RNAV 1 WITH GNSS REQUIRED AL DHAFRA MIL ZAYED INTL KANIP MEKRI ATUDO',
  ]) assert.ok(garbledTextRatio(sample) < 0.2, `${sample.slice(0, 30)} -> ${garbledTextRatio(sample)}`);
});

test('empty text yields no garbling signal', () => {
  assert.equal(garbledTextRatio(''), 0);
  assert.equal(garbledTextRatio('   \n  '), 0);
});

// ---- AI 直接生成 424 / 几何，确定性代码只做核对 ----
// 生成权交给模型后，往返核对是唯一能独立发现"看着像但其实错了"的手段：
// 424 文本解析回来逐字段比对，坐标串测地反算回来与 PIR 的航向/距离比对。
test('424 text that parses to nothing is reported, not accepted', () => {
  const diffs = verify424Text('这不是 424 记录\n随便几行文字\n', samplePir());
  assert.equal(diffs.length, 1);
  assert.ok(['NO_RECORDS_PARSED', 'UNPARSEABLE'].includes(diffs[0].code), diffs[0].code);
});

test('empty 424 output is reported', () => {
  const diffs = verify424Text('   \n  ', samplePir());
  assert.deepEqual(diffs.map((d) => d.code), ['EMPTY_OUTPUT']);
});

test('geometry drawn away from the PIR fixes is caught', () => {
  const pir = samplePir(); // 腿 l1: a(1.3,103.8) -> b(1.4,103.9)，course 45、8NM
  const wrong = {
    type: 'FeatureCollection',
    features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: [[104.5, 2.9], [104.6, 3.0]] }, properties: { featureType: 'LEG', legId: 'l1' } }],
  };
  const codes = verifyGeometry(wrong, pir).map((d) => d.code);
  assert.ok(codes.includes('VERTEX_OFF_FIX'), `凭记忆摆点必须被抓到: ${codes.join(',')}`);
});

test('geometry anchored on the PIR fixes passes', () => {
  const pir = samplePir();
  const good = {
    type: 'FeatureCollection',
    features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: [[103.8, 1.3], [103.9, 1.4]] }, properties: { featureType: 'LEG', legId: 'l1' } }],
  };
  assert.deepEqual(verifyGeometry(good, pir).filter((d) => d.code === 'VERTEX_OFF_FIX'), []);
});

test('a leg with resolved endpoints but no geometry is reported as not drawn', () => {
  const pir = samplePir();
  const codes = verifyGeometry({ type: 'FeatureCollection', features: [] }, pir).map((d) => d.code);
  assert.ok(codes.includes('LEG_NOT_DRAWN'), codes.join(','));
});

test('a missing FeatureCollection is reported rather than silently empty', () => {
  assert.deepEqual(verifyGeometry(null, samplePir()).map((d) => d.code), ['NO_FEATURE_COLLECTION']);
});

test('open-ended legs are not required to terminate on a fix', () => {
  const pir = samplePir();
  pir.legs[0].pathTerminator = 'CA';
  pir.legs[0].openEnded = true;
  const feature = {
    type: 'FeatureCollection',
    features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: [[103.8, 1.3], [103.85, 1.35]] }, properties: { featureType: 'LEG', legId: 'l1', openEnded: true } }],
  };
  const codes = verifyGeometry(feature, pir).map((d) => d.code);
  assert.ok(!codes.includes('VERTEX_OFF_FIX'), `开放腿不该因终点不在 fix 上而报错: ${codes.join(',')}`);
});
