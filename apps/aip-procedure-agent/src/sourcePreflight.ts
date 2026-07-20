import { deriveRouteCode } from '../../../server/src/services/jeppesen424/routeCode';
import type { BusinessProcedurePackage, PackagePreflight, PageAsset } from './domain';

/**
 * 一张真正的程序图，其绘图算子数应显著高于同一程序包里的编码表页。
 *
 * 不做语料级"图带/表带"划分：实测 OMAA 的算子数从 368 连续分布到 258 万（机场平面图是极端
 * 离群值），任何全局分界点都会被离群值带偏——早期版本正是因此把 82 个包全拦了。
 * 改为包内相对比较：拿本包声明的表格页做基准，图页必须达到其 CHART_TO_TABLE_RATIO 倍。
 * 基准不存在（本包没有表格页）时无法比较，一律不拦（缺表由 TABLE_MISSING 单独报）。
 *
 * OMAA 82 个包实测：正确拦截 5、误拦 0、正确放行 77，K 取 2/3/5 结果一致。
 */
const CHART_TO_TABLE_RATIO = 3;

/** 真实矢量算子数；旧任务无此字段时退回已截断的数组长度（上限 5000）。 */
export function pageVectorPathCount(page: PageAsset) { return page.vectorPathCount ?? page.vectorPaths.length; }

export interface RoleRepair { packageId: string; procedureName: string; promotedPage: number; demotedPage: number; promotedDensity: number; demotedDensity: number }

/**
 * 纠正图/表角色倒置。
 *
 * OMAA 的进近编码表每份占两页：首页带小节号（"2.22.4.2.2 RNP Y RWY 13R (AR)…"），
 * 续页只有列头。续页没有可锚定的身份信息，模型把它填进了 PROCEDURE_CHART，
 * 真航图反被挤进 PROCEDURE_TABLE——页面关联全对，只是角色标反了。
 *
 * 判据同 preflight：包内相对密度。若某张表格页的算子数超过图页的 CHART_TO_TABLE_RATIO 倍，
 * 二者对调。这是对模型输出的确定性覆盖，因此必须在 warnings 留痕，让倒置次数保持可见，
 * 而不是把模型的系统性弱点悄悄抹平。
 *
 * OMAA 82 包实测：触发 5 次，全部命中真实倒置，77 个正常包零误触。
 */
export function repairInvertedChartRoles(pkg: BusinessProcedurePackage, pages: PageAsset[]): RoleRepair | undefined {
  const density = (ref: { documentId: string; pageNumber: number }) => { const asset = findPage(ref, pages); return asset ? pageVectorPathCount(asset) : undefined; };
  const charts = pkg.packagePages.filter((page) => page.pageRole === 'PROCEDURE_CHART' && density(page) !== undefined);
  const tables = pkg.packagePages.filter((page) => page.pageRole === 'PROCEDURE_TABLE' && density(page) !== undefined);
  if (!charts.length || !tables.length) return undefined;
  const bestChart = charts.reduce((a, b) => (density(b)! > density(a)! ? b : a));
  const bestTable = tables.reduce((a, b) => (density(b)! > density(a)! ? b : a));
  const promotedDensity = density(bestTable)!;
  const demotedDensity = density(bestChart)!;
  if (promotedDensity <= CHART_TO_TABLE_RATIO * demotedDensity) return undefined;
  bestChart.pageRole = 'PROCEDURE_TABLE';
  bestTable.pageRole = 'PROCEDURE_CHART';
  pkg.warnings = [...new Set([...(pkg.warnings || []), `ROLE_SWAPPED_BY_DENSITY: p${bestTable.pageNumber}(${promotedDensity} ops) replaced p${bestChart.pageNumber}(${demotedDensity} ops) as the procedure chart.`])];
  return { packageId: pkg.packageId, procedureName: pkg.procedureName, promotedPage: bestTable.pageNumber, demotedPage: bestChart.pageNumber, promotedDensity, demotedDensity };
}

export function assessPackageSources(pkg: BusinessProcedurePackage, pages: PageAsset[]): BusinessProcedurePackage {
  const roles = (role: string) => pkg.packagePages.filter((page) => page.pageRole === role || page.secondaryRoles?.includes(role));
  const charts = roles('PROCEDURE_CHART');
  const tables = roles('PROCEDURE_TABLE');
  const coordinates = [...roles('COORDINATE_TABLE'), ...roles('WAYPOINT_COORDINATE_TABLE')];
  const texts = roles('PROCEDURE_TEXT');
  const runway = roles('RUNWAY_DATA');
  const navaid = roles('NAVAID_DATA');
  pkg.sourceCompleteness = {
    // 只做结构陈述（有几张图页），不再用矢量密度猜"这张图其实是表"——那个比值拟合自单一机场。
    chart: charts.length === 1 ? 'PRESENT' : charts.length ? 'AMBIGUOUS' : 'MISSING',
    table: tables.length ? 'PRESENT' : 'MISSING',
    coordinates: coordinates.length ? 'PRESENT' : 'MISSING',
    text: texts.length ? 'PRESENT' : 'NOT_REQUIRED',
    runwayData: runway.length ? 'PRESENT' : 'MISSING',
    navaidData: navaid.length ? 'PRESENT' : 'MISSING',
  };
  pkg.packageStatus = pkg.sourceCompleteness.chart === 'MISSING'
    ? 'CHART_MISSING'
    : pkg.sourceCompleteness.chart === 'AMBIGUOUS'
      ? 'SOURCE_AMBIGUOUS'
      : pkg.sourceCompleteness.table === 'MISSING'
        ? 'TABLE_MISSING'
        : pkg.sourceCompleteness.coordinates === 'MISSING' && /RNAV|RNP|DME_ARC/.test(pkg.navigationType || '')
          ? 'COORDINATE_MISSING'
          : 'COMPLETE_SOURCE_SET';
  pkg.preflight = packagePreflight(pkg, pages);
  // 刻意不动 pkg.status。生命周期状态（待识别/识别中/已完成/需复核）与来源质量是两条独立的轴：
  // 预检跑在识别之前，此时还没有任何结果可"复核"。旧实现把 GROUPED 覆盖成 REQUIRES_REVIEW，
  // 既让界面显示"没点识别就需复核"，也销毁了"这个包到底跑没跑过"的信息。
  // 预检结论完整保存在 pkg.preflight / pkg.sourceCompleteness，由前端作为独立标识展示。
  pkg.warnings = [...new Set([...(pkg.warnings || []), ...pkg.preflight.blockingIssues.map((issue) => `${issue.code}: ${issue.message}`)])];
  return pkg;
}

export function packagePreflight(pkg: BusinessProcedurePackage, pages: PageAsset[]): PackagePreflight {
  const issues: PackagePreflight['blockingIssues'] = [];
  const warnings: PackagePreflight['warnings'] = [];
  const chartPages = pkg.packagePages.filter((page) => page.pageRole === 'PROCEDURE_CHART');
  const tablePages = pkg.packagePages.filter((page) => page.pageRole === 'PROCEDURE_TABLE');
  if (!routeDesignator(pkg.procedureName) && !compactIdentity(pkg.procedureName) && !(pkg.procedureCategory === 'APPROACH' && approachIdentity(pkg.procedureName))) issues.push({ code: 'PROCEDURE_IDENTITY_UNCLEAR', procedure: pkg.procedureName, message: 'The package does not have an unambiguous procedure identity.' });
  if (!['SID', 'STAR', 'APPROACH'].includes(pkg.procedureCategory)) issues.push({ code: 'PROCEDURE_CATEGORY_UNCLEAR', procedure: pkg.procedureName, message: 'Procedure category is not SID, STAR or APPROACH.' });
  if (!chartPages.length) issues.push({ code: 'CHART_MISSING', procedure: pkg.procedureName, message: 'No actual procedure chart is associated with this package.' });
  // 编码表是佐证而非前提：整套流程本来就以读图为主，缺表仍可识别。WMKJ 的进近是
  // "航图 + 最低标准表"、没有 FMS 编码表，雷达引导 SID 同样没有——按阻塞处理会误拦一大片。
  if (!tablePages.length) warnings.push({ code: 'TABLE_MISSING', procedure: pkg.procedureName, message: 'No procedure coding table is associated with this package; recognition will rely on the chart alone.' });
  for (const page of chartPages) {
    if (!findPage(page, pages)) warnings.push({ code: 'CHART_PAGE_NOT_IN_CORPUS', page: page.pageNumber, message: 'The declared chart page was not found among the parsed pages.' });
  }
  // 这里曾有 CHART_PAGE_IS_ACTUALLY_TABLE：要求每张图页的矢量密度达本包表格页的 3 倍。
  // 该比值拟合自 OMAA（图 4.7万-9.5万 vs 表 611-1772，差 40 倍），换到 WMKJ 就失效——
  // 那边航图只有 1814-4829 个算子、与表格同量级，比值连续分布在 1.12-6.79，阈值正好切在中间
  // （2.91 被拦、3.14 放行，相邻取值两种结果）。且 OMAA 上真实倒置全部由
  // repairInvertedChartRoles 修好，该拦截实际一次未命中，只在 WMKJ 制造了 4 个误报，故移除。
  // 修复本身保留：它判的是"表格页比图页密 3 倍以上"这种数量级倒置（OMAA 实测 60 倍），
  // 方向相反且宽松得多，两份语料都判得准。
  if (!pkg.packagePages.some((page) => ['COORDINATE_TABLE', 'WAYPOINT_COORDINATE_TABLE'].includes(page.pageRole) || page.secondaryRoles?.some((role) => ['COORDINATE_TABLE', 'WAYPOINT_COORDINATE_TABLE'].includes(role)))) warnings.push({ code: 'COORDINATE_SOURCE_MISSING', procedure: pkg.procedureName, message: 'No explicit coordinate source was associated.' });
  if (!pkg.packagePages.some((page) => page.pageRole === 'RUNWAY_DATA')) warnings.push({ code: 'RUNWAY_DATA_MISSING', procedure: pkg.procedureName, message: 'Runway support data is missing.' });
  if (/DME_ARC|CONVENTIONAL|VOR|NDB|ILS|LOC/.test(pkg.navigationType || '') && !pkg.packagePages.some((page) => page.pageRole === 'NAVAID_DATA')) issues.push({ code: 'NAVAID_DATA_MISSING', procedure: pkg.procedureName, message: 'The conventional procedure has no navaid support source.' });
  if (/[,/]/.test(pkg.procedureName)) issues.push({ code: 'CROSS_PROCEDURE_PACKAGE', procedure: pkg.procedureName, message: 'Multiple independent procedure identities remain concatenated in one package.' });
  return { preflightPassed: !issues.length, checkedAt: new Date().toISOString(), blockingIssues: issues, warnings };
}

function findPage(ref: { documentId: string; pageNumber: number }, pages: PageAsset[]) {
  return pages.find((page) => page.documentId === ref.documentId && page.pageNumber === ref.pageNumber);
}

function routeDesignator(name: string) { try { return deriveRouteCode(name); } catch { return undefined; } }
function compactIdentity(name: string) { const match = name.toUpperCase().match(/\b([A-Z]{2,8})\s*(\d[A-Z])\b/); return match ? `${match[1]}${match[2]}` : undefined; }
// 进近的身份 = 类型 + 跑道。原实现把跑道号锚定在串尾（/RWY\d{2}[LRC]?$/），
// 于是 "RNP Y RWY 13L (AR)" 归一化成 RNPYRWY13LAR 后因尾部多了 AR 而失配——
// OMAA 4 个 RNP AR 进近被误报 PROCEDURE_IDENTITY_UNCLEAR。跑道号后面允许跟
// (AR)/(RF)/(GNSS) 这类限定后缀，锚定本就是附带的，改为只要求名称里点明了跑道。
function approachIdentity(name: string) { const compact = name.toUpperCase().replace(/\bOR\b/g, '').replace(/[^A-Z0-9]/g, ''); return /RWY\d{2}[LRC]?/.test(compact) ? compact : undefined; }

/**
 * 把一个包里挤着的多条程序拆开。
 *
 * 分组提示词已明确"一张图纸写了几条程序就出几个包"，但这是单次调用，模型时灵时不灵：
 * 同一份 WMKJ 两次分组，一次拆成 44 个包、一次又合成 21 个。靠提示词保证不了，
 * 而合并的后果是实打实的——腿失去归属，某条程序名下发布的点会被算到另一条头上
 * （实测 KJ706 从 SABKA 1J 串到了 PIMOK 1J），424 也因为四条程序共用一个 PIR 而漏编。
 *
 * 判据是程序代号的形态：<标识> <数字><字母>，如 AROSO 1J。出现两个以上即为混装。
 * 进近名（ILS Z OR LOC Z RWY 16 / RNP Z RWY 34 (AR)）没有这种形态，不会被误拆。
 */
const PROCEDURE_DESIGNATOR = /\b([A-Z]{3,5})\s+(\d[A-Z])\b/g;

export function splitMultiProcedurePackages(pkg: BusinessProcedurePackage): BusinessProcedurePackage[] {
  const designators = [...new Set(
    [...pkg.procedureName.toUpperCase().matchAll(PROCEDURE_DESIGNATOR)].map((match) => `${match[1]} ${match[2]}`),
  )];
  if (designators.length < 2) return [pkg];
  return designators.map((designator, index) => ({
    ...pkg,
    // 首个沿用原 packageId，其余新建：已经引用了这个包的地方不至于全部失效。
    packageId: index === 0 ? pkg.packageId : `${pkg.packageId}-${designator.replace(/\s+/g, '')}`,
    procedureKey: `${pkg.procedureKey}-${designator.replace(/\s+/g, '')}`,
    procedureName: designator,
    // 页面在各条程序间共享，这正是 424 期望的形态：每条程序自带完整记录集。
    packagePages: pkg.packagePages.map((page) => ({ ...page, isShared: true })),
    warnings: [...new Set([...(pkg.warnings || []), `SPLIT_FROM_COMBINED_PACKAGE: 原包 "${pkg.procedureName}" 含 ${designators.length} 条程序，已按程序代号拆分。`])],
  }));
}
