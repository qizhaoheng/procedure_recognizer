import assert from 'node:assert/strict';
import test from 'node:test';
import { dmsToDecimal, geodesicForward, geodesicInverse, parseCoordinate } from '../coordinate';
import { arc, compile424Candidate, compileGeoJson, validatePir } from '../compiler';
import { garbledTextRatio } from '../pdfPreprocessor';
import type { BusinessProcedurePackage, PageAsset, ProcedurePIR } from '../domain';
import { derivePackageSources, selectGroupingImagePages } from '../orchestrator';
import { assessPackageSources, pageVectorPathCount, repairInvertedChartRoles } from '../sourcePreflight';
import { verify424Text, verifyGeometry } from '../aiGeneration';
import { attachAirportReferencePages, findAirportReferencePages } from '../airportReference';
import { createEmptyPir, mergeFragment, resolveRunwayFixes } from '../fragmentMerger';
import { deriveRouteCode } from '../../../../server/src/services/jeppesen424/routeCode';
import { completenessFindingsToValidations } from '../completenessAudit';
import { simpleLegsTo424Text } from '../../../../server/src/services/jeppesen424/simpleLegsTo424Text';

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

// 424 覆盖度比对：不比记录总数。424 要求每条路线自带完整记录集，公共段会在各路线代码下
// 重复出现——WMKJ 四条 1J SID 共用起始段，12 条记录对 9 条 PIR 腿是正确编码。
test('replicated common segments are not reported as a leg-count difference', () => {
  const pir = samplePir(); // 1 条腿：TF 到 BBBBB
  // 同一条腿在两个路线代码下各出现一次——合法的 424 复制
  const text = simpleLegsTo424Text([
    { procedureName: 'TEST1A', procedureCode: 'TEST1A', routeKey: 'TEST1A', category: 'SID', runway: 'RW02', sequence: '010', fix: 'BBBBB', pathTerminator: 'TF', source: 'AI' },
    { procedureName: 'TEST1B', procedureCode: 'TEST1B', routeKey: 'TEST1B', category: 'SID', runway: 'RW02', sequence: '010', fix: 'BBBBB', pathTerminator: 'TF', source: 'AI' },
  ], { airportIcao: 'WSSS' });
  const codes = verify424Text(text, pir).map((d) => d.code);
  assert.ok(!codes.includes('LEG_COUNT'), `不该再有 LEG_COUNT: ${codes.join(',')}`);
  assert.ok(!codes.includes('LEG_NOT_ENCODED'), `腿已被编出，不该报缺失: ${codes.join(',')}`);
});

test('a PIR leg that never made it into the records is reported', () => {
  const pir = samplePir();
  const text = simpleLegsTo424Text([
    { procedureName: 'TEST1A', procedureCode: 'TEST1A', routeKey: 'TEST1A', category: 'SID', runway: 'RW02', sequence: '010', fix: 'AAAAA', pathTerminator: 'IF', source: 'AI' },
  ], { airportIcao: 'WSSS' });
  const diffs = verify424Text(text, pir);
  assert.ok(diffs.some((d) => d.code === 'LEG_NOT_ENCODED'), diffs.map((d) => d.code).join(','));
});

test('a record terminating at a fix the PIR does not contain is reported', () => {
  const pir = samplePir();
  const text = simpleLegsTo424Text([
    { procedureName: 'TEST1A', procedureCode: 'TEST1A', routeKey: 'TEST1A', category: 'SID', runway: 'RW02', sequence: '010', fix: 'BBBBB', pathTerminator: 'TF', source: 'AI' },
    { procedureName: 'TEST1A', procedureCode: 'TEST1A', routeKey: 'TEST1A', category: 'SID', runway: 'RW02', sequence: '020', fix: 'GHOST', pathTerminator: 'TF', source: 'AI' },
  ], { airportIcao: 'WSSS' });
  const diffs = verify424Text(text, pir);
  assert.ok(diffs.some((d) => d.code === 'RECORD_FIX_NOT_IN_PIR' && d.detail.includes('GHOST')), diffs.map((d) => d.code).join(','));
});

// ---- 机场级参考页挂载 ----
// 跑道 AD 2.12 / 导航台 AD 2.19 不属于任何一条程序，分组不会带上它们，但每条程序都需要：
// 没有跑道入口坐标，离场起点就锚不住（WMKJ 的 RWY16 一直 UNRESOLVED，4-5 条腿画不出来）。
// 实测：挂载后 WMKJ 预检 12/23 -> 23/23、OMAA 78/82 -> 82/82，NAVAID/RUNWAY 缺失全部清零。
function referencePage(pageNumber: number, text: string): PageAsset {
  const page = omaaPage(pageNumber, 1200, 0.5);
  page.nativeText = text;
  return page;
}

test('ICAO AD 2.12 and AD 2.19 sections are recognized as airport reference pages', () => {
  const pages = [
    // 坐标被拆成多行——nativeText 是每个 textSpan 各占一行拼出来的，真实数据就长这样
    referencePage(10, 'WMKJ AD 2.12 RUNWAY PHYSICAL CHARACTERISTICS\n013919.83N\n1033950.29E\n013723.68N\n1034032.51E'),
    referencePage(13, 'WMKJ AD 2.19 RADIO NAVIGATION AND LANDING AIDS\nVOR/DME 113.4'),
    referencePage(33, 'STANDARD DEPARTURE CHART'),
  ];
  const found = findAirportReferencePages(pages);
  assert.deepEqual(found.runwayPages.map((p) => p.pageNumber), [10]);
  assert.deepEqual(found.navaidPages.map((p) => p.pageNumber), [13]);
});

test('a page that merely cites AD 2.12 without coordinates is not a runway page', () => {
  const found = findAirportReferencePages([referencePage(50, 'For runway details refer to AD 2.12 of this AIP.')]);
  assert.deepEqual(found.runwayPages, [], '只是引用小节号、没有坐标，不算跑道数据页');
});

test('reference pages are attached once and marked shared', () => {
  const pages = [
    referencePage(10, 'AD 2.12 RUNWAY PHYSICAL CHARACTERISTICS\n013919.83N\n1033950.29E\n013723.68N\n1034032.51E'),
    referencePage(13, 'AD 2.19 RADIO NAVIGATION AND LANDING AIDS'),
  ];
  const found = findAirportReferencePages(pages);
  const pkg = pkgWith([{ page: 33, role: 'PROCEDURE_CHART' }]);
  assert.equal(attachAirportReferencePages(pkg, found), 2);
  assert.equal(attachAirportReferencePages(pkg, found), 0, '重复挂载必须是空操作');
  const attached = pkg.packagePages.filter((p) => p.pageNumber === 10 || p.pageNumber === 13);
  assert.equal(attached.length, 2);
  assert.ok(attached.every((p) => p.isShared), '机场级页面是共享页');
  assert.deepEqual(attached.map((p) => p.pageRole).sort(), ['NAVAID_DATA', 'RUNWAY_DATA']);
});

// ---- 结果完整性核查（AI 校验 AI）----
// 这个校验器与被查对象同源，所以它的结论只能供人复核，不能直接推翻识别：
// BLOCKER 一律降为 ERROR，读不了的页上的 finding 降为 WARNING。
test('a same-family auditor cannot escalate to BLOCKER', () => {
  const validations = completenessFindingsToValidations({
    findings: [{ kind: 'MISSING_LEG', severity: 'BLOCKER', subject: 'Leg 030', detail: '源图有 TF 到 SABKA，结果里没有', pageNumber: 35, legId: 'l9' }],
    readablePages: [{ pageNumber: 35, readable: true }],
    completeness: 'INCOMPLETE',
    decisionSummary: '',
  });
  assert.equal(validations.length, 1);
  assert.equal(validations[0].severity, 'ERROR', 'BLOCKER 必须降级——拒出权留给确定性规则');
  assert.equal(validations[0].ruleCode, 'SOURCE_COMPLETENESS_MISSING_LEG');
  assert.equal(validations[0].fieldPath, 'legs.l9');
});

test('findings raised from an unreadable page are demoted to warnings', () => {
  // 页面读不了等于"不知道"，不是"结果有问题"——不能拿看不清的页去否定识别结果
  const validations = completenessFindingsToValidations({
    findings: [{ kind: 'MISSING_CONSTRAINT', severity: 'ERROR', subject: '高度约束', detail: '看不清但似乎缺了', pageNumber: 34 }],
    readablePages: [{ pageNumber: 34, readable: false, note: '字形码乱码' }],
    completeness: 'NOT_ASSESSABLE',
    decisionSummary: '',
  });
  assert.equal(validations[0].severity, 'WARNING');
});

test('a complete result yields no validations', () => {
  const validations = completenessFindingsToValidations({
    findings: [], readablePages: [{ pageNumber: 35, readable: true }], completeness: 'COMPLETE', decisionSummary: '',
  });
  assert.deepEqual(validations, []);
});

test('non-blocker severities and anchors are preserved', () => {
  const validations = completenessFindingsToValidations({
    findings: [{ kind: 'MISSING_FIX', severity: 'WARNING', subject: 'KJ706', detail: '坐标表有该点', pageNumber: 35, fixIdentifier: 'KJ706' }],
    readablePages: [{ pageNumber: 35, readable: true }],
    completeness: 'INCOMPLETE',
    decisionSummary: '',
  });
  assert.equal(validations[0].severity, 'WARNING');
  assert.equal(validations[0].fieldPath, 'fixes.KJ706');
  assert.match(validations[0].message, /source page 35/);
});

// 视觉转写输出的是带度分秒符号的格式（"02° 03' 57.10\" N"），而符号被换成空格后，
// 原先按 2 个以上空白切分恰好把这一组切碎，导致转写出来的坐标表一个都读不出来——
// 转写辛苦读回来的数据在解析这一步全丢了。
test('parses the degree-minute-second form produced by visual transcription', () => {
  const value = parseCoordinate('ADLOV 02° 03\' 57.10" N 103° 46\' 40.10" E');
  assert.ok(Math.abs(value.latitude! - 2.065861) < 1e-5, String(value.latitude));
  assert.ok(Math.abs(value.longitude! - 103.777806) < 1e-5, String(value.longitude));
});

test('a waypoint identifier containing digits does not derail the scan', () => {
  // KJ706：扫描正则若不强制要求半球符，会先在 "706 01 37" 上匹配一个无半球符的三元组、
  // 丢弃它的同时把位置推过真正的度分秒，于是带数字的点名读不出坐标、不带数字的却能读出来。
  const value = parseCoordinate('KJ706 01° 37\' 03.66" N 103° 29\' 46.28" E');
  assert.ok(Math.abs(value.latitude! - 1.617683) < 1e-5, String(value.latitude));
  assert.ok(Math.abs(value.longitude! - 103.496189) < 1e-5, String(value.longitude));
});

test('table numbers without a hemisphere are never read as coordinates', () => {
  assert.deepEqual(parseCoordinate('010 CA - - 160° - - +1000 - RNAV 1'), {});
  assert.deepEqual(parseCoordinate('030 TF SABKA - 317° 18.6 - +6000'), {});
});

// ---- 最低爬升梯度（PDG）----
// WMKJ 实测：源页明明白白印着 "MINIMUM CLIMB GRADIENT (PDG) 5% UNTIL PASSING 6000FT"，
// 而 PIR 根本没有这个字段——不是没提取到，是没建模，于是完整性核查报了 4 条
// MISSING_CONSTRAINT 却无处安放。同一张图上各条 SID 的数值还不同（PIMOK 1J 是 3500FT）。
test('a route carries the published climb gradient through the merge', () => {
  const pir = createEmptyPir({ icao: 'WMKJ' }, { category: 'SID', name: 'AROSO 1J', runways: ['16'] });
  mergeFragment(pir, {
    routes: [{
      routeId: 'r1', routeType: 'RUNWAY_TRANSITION', identifier: 'AROSO 1J', runway: '16', sequence: 1,
      climbGradient: { percent: 5, untilAltitudeFt: 6000, purpose: 'ATC', rawText: 'MINIMUM CLIMB GRADIENT (PDG) 5% UNTIL PASSING 6000FT FOR ATC PURPOSES.' },
    }],
  }, { action: 'ANALYZE_ROUTE_STRUCTURE' });
  assert.equal(pir.routes[0].climbGradient?.percent, 5);
  assert.equal(pir.routes[0].climbGradient?.untilAltitudeFt, 6000);
  assert.match(pir.routes[0].climbGradient!.rawText!, /5% UNTIL PASSING 6000FT/);
});

test('a later fragment does not overwrite a gradient already recorded for the route', () => {
  // 同一张图上 PIMOK 1J 是 3500FT、其余是 6000FT，串味会把错的值写进来
  const pir = createEmptyPir({ icao: 'WMKJ' }, { category: 'SID', name: 'PIMOK 1J', runways: ['16'] });
  const route = (climbGradient: any) => ({ routeId: 'r1', routeType: 'RUNWAY_TRANSITION' as const, identifier: 'PIMOK 1J', runway: '16', sequence: 1, climbGradient });
  mergeFragment(pir, { routes: [route({ percent: 5, untilAltitudeFt: 3500, rawText: 'PDG 5% UNTIL PASSING 3500FT' })] }, { action: 'ANALYZE_ROUTE_STRUCTURE' });
  mergeFragment(pir, { routes: [route({ percent: 5, untilAltitudeFt: 6000, rawText: 'PDG 5% UNTIL PASSING 6000FT' })] }, { action: 'ANALYZE_ROUTE_STRUCTURE' });
  assert.equal(pir.routes[0].climbGradient?.untilAltitudeFt, 3500, '先记录的值不得被邻近程序的值覆盖');
});

test('a route with no published gradient stays null rather than borrowing one', () => {
  const pir = createEmptyPir({ icao: 'WMKJ' }, { category: 'STAR', name: 'X', runways: ['16'] });
  mergeFragment(pir, { routes: [{ routeId: 'r1', routeType: 'ENROUTE_TRANSITION', identifier: 'X', sequence: 1 }] }, { action: 'ANALYZE_ROUTE_STRUCTURE' });
  assert.equal(pir.routes[0].climbGradient, null);
});

// 字母的拼法在各国 AIP 里不统一：ICAO 官方是 ALFA/JULIETT/WHISKY，实际印刷中
// ALPHA/JULIET/WHISKEY 同样常见。只收官方拼法会让整类程序解不出路线代码——
// WMKJ 的 AIP 印 "AROSO ONE JULIET DEPARTURE"，8 条 SID 因此全被判为身份不明。
test('spelled-out designators accept both official and common phonetic spellings', () => {
  for (const [name, expected] of [
    ['AROSO ONE JULIET DEPARTURE', 'AROS1J'],   // 单 T，WMKJ 实际印法
    ['ADLOV TWO JULIETT DEPARTURE', 'ADLO2J'],  // 双 T，ICAO 官方
    ['EMTUV ONE GOLF ARRIVAL', 'EMTU1G'],
    ['AROSO ONE MIKE DEPARTURE', 'AROS1M'],
  ] as const) assert.equal(deriveRouteCode(name), expected, name);
});

test('a radar-vectored departure genuinely has no route code', () => {
  assert.equal(deriveRouteCode('JOHOR RADAR TWO DEPARTURE'), undefined);
});

// ---- 跑道 fix 坐标的确定性补齐 ----
// AD 2.12 页里白纸黑字的 "THR coordinates 013919.83N 1033950.29E" 已经进了 PIR 的
// runwayData，却没有任何环节把它接到航段引用的那个跑道 fix 上——于是 RW16 一直
// UNRESOLVED，离场起点锚不住、机场画不出来、下游一连串腿无法绘制。
function pirWithRunway(role: 'DER' | 'NONE'): ProcedurePIR {
  const pir = samplePir();
  pir.fixes = [{ fixId: 'rw', identifier: 'RW16', type: 'RUNWAY', role, latitude: null, longitude: null, coordinateSourceType: 'UNRESOLVED', evidence: [], confidence: 1, status: 'UNRESOLVED', allowFor424: true }];
  pir.legs = []; pir.routes[0].legIds = [];
  pir.runwayData = [{ runwayId: 'RWY-16', designator: '16', thresholdLatitude: 1.655508, thresholdLongitude: 103.663969, derLatitude: 1.623244, derLongitude: 103.675697, evidence: ['p10'], status: 'CONFIRMED' }];
  return pir;
}

test('a departure-end runway fix takes the far end of the runway', () => {
  const pir = pirWithRunway('DER');
  assert.equal(resolveRunwayFixes(pir), 1);
  const fix = pir.fixes[0];
  assert.equal(fix.latitude, 1.623244, '从 16 号跑道起飞，离场端是跑道另一头');
  assert.equal(fix.coordinateSourceType, 'RUNWAY_DATABASE');
  assert.equal(fix.status, 'DERIVED');
  assert.match(fix.derivation!, /departure end/);
  assert.deepEqual(fix.evidence, ['p10'], '证据要跟着跑道数据一起带过来');
});

test('a non-departure runway fix takes the threshold', () => {
  const pir = pirWithRunway('NONE');
  resolveRunwayFixes(pir);
  assert.equal(pir.fixes[0].latitude, 1.655508);
  assert.match(pir.fixes[0].derivation!, /threshold/);
});

test('an already-resolved fix is left alone', () => {
  const pir = pirWithRunway('DER');
  pir.fixes[0].latitude = 9.9; pir.fixes[0].longitude = 99.9;
  pir.fixes[0].coordinateSourceType = 'EXPLICIT_TABLE';
  assert.equal(resolveRunwayFixes(pir), 0);
  assert.equal(pir.fixes[0].latitude, 9.9, '已有坐标不得被覆盖');
});

test('a runway fix with no matching runway data stays unresolved', () => {
  const pir = pirWithRunway('DER');
  pir.runwayData[0].designator = '34';
  assert.equal(resolveRunwayFixes(pir), 0);
  assert.equal(pir.fixes[0].latitude, null, '没有对应跑道就保持未解析，不得瞎凑');
});

// 跑道 fix 的坐标必须与它自己声明的角色一致。实测：fix 标着 role=DER，坐标却是入口的，
// 两端相距约 3.6 公里，离场起点因此偏掉。依据就在同一份 PIR 的 runwayData 里（两端俱全），
// 所以这是自相矛盾而非信息不足——但只报不改，覆盖模型给的坐标交给人判断。
function pirWithRunwayFix(role: 'DER' | 'NONE', latitude: number, longitude: number): ProcedurePIR {
  const pir = samplePir();
  pir.fixes = [{ fixId: 'rw', identifier: 'RWY16', type: 'RUNWAY', role, latitude, longitude, coordinateSourceType: 'RUNWAY_DATABASE', evidence: [], confidence: 1, status: 'CONFIRMED', allowFor424: true }];
  pir.legs = []; pir.routes[0].legIds = [];
  pir.runwayData = [{ runwayId: 'WMKJ-16', designator: '16', thresholdLatitude: 1.655508, thresholdLongitude: 103.663969, derLatitude: 1.623244, derLongitude: 103.675697, evidence: ['p10'], status: 'CONFIRMED' }];
  return pir;
}

test('a DER-role fix holding the threshold coordinate is reported', () => {
  const results = validatePir(pirWithRunwayFix('DER', 1.655508, 103.663969));
  const finding = results.find((v) => v.ruleCode === 'RUNWAY_FIX_END_MISMATCH');
  assert.ok(finding, results.map((v) => v.ruleCode).join(','));
  assert.equal(finding!.severity, 'ERROR');
  assert.match(finding!.message, /matches the threshold instead/);
});

test('a DER-role fix holding the departure end passes', () => {
  const results = validatePir(pirWithRunwayFix('DER', 1.623244, 103.675697));
  assert.equal(results.filter((v) => v.ruleCode === 'RUNWAY_FIX_END_MISMATCH').length, 0);
});

test('a threshold-role fix holding the threshold passes', () => {
  const results = validatePir(pirWithRunwayFix('NONE', 1.655508, 103.663969));
  assert.equal(results.filter((v) => v.ruleCode === 'RUNWAY_FIX_END_MISMATCH').length, 0);
});

// 渲染器的硬契约：非进近的腿必须有合法跑道号或过渡名之一，两者皆空会被拒。
// 这条契约此前只写在渲染器里，424 writer 的提示词凭我对 424 的印象写成了
// "公共航段两者都留空"，模型照做后被渲染器当场拒绝——提示词该照着代码的实际契约写。
test('a leg with neither runway nor transition name is rejected by the renderer', () => {
  const leg = { procedureName: 'X 1A', procedureCode: 'X1A', routeKey: 'X1A', category: 'SID' as const, runway: '', sequence: '030', fix: 'ABCDE', pathTerminator: 'TF', source: 'AI' as const };
  assert.throws(() => simpleLegsTo424Text([leg], { airportIcao: 'WMKJ' }), /缺少有效跑道/);
});

test('a common-route leg carrying the procedure runway renders', () => {
  const leg = { procedureName: 'X 1A', procedureCode: 'X1A', routeKey: 'X1A', category: 'SID' as const, runway: 'RW16', sequence: '030', fix: 'ABCDE', pathTerminator: 'TF', source: 'AI' as const };
  const text = simpleLegsTo424Text([leg], { airportIcao: 'WMKJ' });
  assert.match(text, /RW16/);
});

// ---- 模型响应必须符合所声明的 schema ----
// structuredOutputMode=json_object 时 schema 是作为文本拼进提示词的，模型可能把它原样吐回来。
// 那段回声本身是合法 JSON，只检查"是不是 JSON"会一路放行；而顶层没有 fullText，
// 读出来是 undefined -> 空字符串，却被记为成功。
// 实测 WMKJ 一次分析的 44 次转写里 13 次是这种回声。
test('a schema echo does not satisfy the schema it echoes', async () => {
  const Ajv = (await import('ajv')).default;
  const ajv = new Ajv({ allErrors: false, strict: false });
  const schema = JSON.parse(await (await import('node:fs/promises')).readFile('apps/aip-procedure-agent/prompts/page-transcriber/output-schema.json', 'utf8'));
  const validate = ajv.compile(schema);
  // 模型实际返回的内容形态：schema 定义本身
  assert.equal(validate({ type: 'object', additionalProperties: false, required: ['fullText'], properties: { fullText: { type: 'string' } } }), false);
  assert.match(ajv.errorsText(validate.errors), /fullText/);
  // 真正的转写结果应当通过
  assert.equal(validate({ fullText: 'AIP MALAYSIA', regions: [], languages: ['en'], decisionSummary: '' }), true);
});

test('every prompt schema compiles, so validation cannot fail for the wrong reason', async () => {
  const Ajv = (await import('ajv')).default;
  const fsp = await import('node:fs/promises');
  const ajv = new Ajv({ allErrors: false, strict: false });
  const dirs = await fsp.readdir('apps/aip-procedure-agent/prompts');
  for (const dir of dirs) {
    const schema = JSON.parse(await fsp.readFile(`apps/aip-procedure-agent/prompts/${dir}/output-schema.json`, 'utf8'));
    assert.doesNotThrow(() => ajv.compile(schema), `${dir} 的 schema 无法编译`);
  }
});
