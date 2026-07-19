import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { compile424Candidate, compileGeoJson } from './compiler';
import { applyQualityGate, validatePir } from './validation';
import { budgets, callModel } from './modelGateway';
import { executeCorrectiveLegExtraction, executePlannedRecognition, materializeEvidenceCrops } from './planExecutor';
import { carryOverManualEdits } from './fragmentMerger';
import { deviationsToValidations, verifyAgainstSourceChart } from './chartOverlay';
import { assessPackageSources, pageVectorPathCount, repairInvertedChartRoles } from './sourcePreflight';
import type { AgentProcedure, AgentStep, AgentTask, AirportPackageAnalysis, BusinessProcedurePackage, PackagePageRef, PageAsset, ProcedurePIR, RecognitionPlan } from './domain';
import { PdfDocumentTools, garbledTextRatio } from './pdfPreprocessor';
import { loadPrompt } from './promptRegistry';
import { saveAgentTask, taskDir, writeArtifact } from './storage';

const running = new Map<string, AbortController>();
const executionMode = () => (process.env.AGENT_EXECUTION_MODE === 'single' ? 'single' : 'planned');

export function startAgentTask(task: AgentTask) { startTaskAnalysis(task); }
export function startTaskAnalysis(task: AgentTask) { launch(task, (signal) => analyzeAirportFiles(task, signal)); }
export function startPackagePlanning(task: AgentTask, pkg: BusinessProcedurePackage) { launch(task, (signal) => planPackage(task, pkg, signal)); }
export function startPackageRecognition(task: AgentTask, pkg: BusinessProcedurePackage) { launch(task, (signal) => recognizePackage(task, pkg, signal)); }
export function startPackagesRecognition(task: AgentTask, packages: BusinessProcedurePackage[]) { launch(task, (signal) => recognizePackages(task, packages, signal)); }
export function cancelAgentTask(taskId: string) { running.get(taskId)?.abort(new Error('Task cancelled by user.')); }

function launch(task: AgentTask, runner: (signal: AbortSignal) => Promise<void>) {
  if (running.has(task.taskId)) throw new Error('Task is already running.');
  const controller = new AbortController(); running.set(task.taskId, controller);
  void runner(controller.signal).catch(async (error) => { task.status = controller.signal.aborted ? 'CANCELLED' : 'FAILED'; task.stage = 'FAILED'; task.error = messageOf(error); task.errorCount += 1; await saveAgentTask(task); }).finally(() => running.delete(task.taskId));
}

// ============================== 阶段 A：文档分析与程序包分组 ==============================

async function analyzeAirportFiles(task: AgentTask, signal: AbortSignal) {
  if (!task.documents.length) throw new Error('请先上传至少一个 PDF。');
  task.status = 'RUNNING'; task.stage = 'ANALYZING'; task.progress = 2; task.error = undefined; task.airportAnalysis = undefined; task.packages = []; task.procedures = []; await saveAgentTask(task);
  let globalPage = 0; task.pages = [];
  for (let index = 0; index < task.documents.length; index++) {
    assertActive(task, signal); const document = task.documents[index]; document.parseStatus = 'PARSING'; await saveAgentTask(task);
    const tools = new PdfDocumentTools(document.filePath, path.join(taskDir(task.taskId), 'documents', document.documentId, 'pages'));
    try {
      const pages = await tools.preprocess(async (page) => { document.pageCount = page.pageNumber; task.progress = Math.min(40, 3 + Math.round(35 * (index + page.pageNumber / Math.max(1, document.pageCount || page.pageNumber)) / task.documents.length)); if (page.pageNumber % 5 === 0) await saveAgentTask(task); });
      for (const page of pages) { globalPage += 1; page.documentId = document.documentId; page.fileName = document.fileName; page.globalPageNumber = globalPage; task.pages.push(page); }
      document.pageCount = pages.length; document.parseStatus = 'PARSED'; document.error = undefined;
    } catch (error) { document.parseStatus = 'FAILED'; document.error = messageOf(error); task.warningCount += 1; }
    await saveAgentTask(task);
  }
  const parsed = task.documents.filter((d) => d.parseStatus === 'PARSED'); if (!parsed.length) throw new Error('所有 PDF 均解析失败。');

  // —— 扫描页 OCR/视觉转写：无原生文本的页面不得被忽略 ——
  await step(task, 'SCANNED_PAGE_TRANSCRIPTION', () => transcribeScannedPages(task, signal));

  task.progress = 50; task.stage = 'ANALYZING'; await saveAgentTask(task);
  const analysis = await step(task, 'AIRPORT_PACKAGE_GROUPING', () => groupAirportPackages(task, signal));
  task.airportIcao = analysis.airport.icao || null; task.airportName = analysis.airport.name || null;
  task.packages = analysis.packages.map((item) => toBusinessPackage(item, task));
  markSharedPages(task.packages);
  // 先按矢量密度纠正图/表角色倒置（改 pageRole 后必须重算派生的 sources），再做来源完整性预检。
  const roleRepairs = task.packages.flatMap((pkg) => {
    const repair = repairInvertedChartRoles(pkg, task.pages);
    if (repair) pkg.sources = derivePackageSources(pkg.packagePages, task);
    return repair ? [repair] : [];
  });
  if (roleRepairs.length) task.warningCount += roleRepairs.length;
  for (const pkg of task.packages) assessPackageSources(pkg, task.pages);
  const auditWarnings = auditGrouping(task, analysis);
  analysis.warnings = [...new Set([...(analysis.warnings || []), ...auditWarnings])];
  task.warningCount += auditWarnings.length;
  task.totalProcedures = task.packages.length;
  task.airportAnalysis = { airport: { icao: analysis.airport.icao, name: analysis.airport.name, country: analysis.airport.country }, document: { languages: [...new Set(task.pages.flatMap((p) => p.detectedLanguages))], pageCount: task.pages.length }, pageRoles: [], procedures: task.packages.filter((p) => p.procedureCategory !== 'APPROACH').map((p) => ({ procedureKey: p.procedureKey, category: p.procedureCategory as 'SID' | 'STAR', name: p.procedureName, runways: p.runways, navigationType: p.navigationType, primaryPages: p.sources.primaryCharts, relatedPages: p.sources.relatedPages, sharedPages: p.packagePages.filter((x) => x.isShared).map((x) => x.pageNumber), confidence: p.groupingConfidence })), sharedSources: [], unassignedPages: analysis.unassignedPages.map((p) => task.pages.find((x) => x.documentId === p.documentId && x.pageNumber === p.pageNumber)?.globalPageNumber || 0).filter(Boolean), warnings: analysis.warnings, decisionSummary: analysis.decisionSummary };
  task.status = 'COMPLETED'; task.stage = 'PACKAGES_READY'; task.progress = 100;
  await writeArtifact(task.taskId, 'airport-package-analysis.json', analysis); await writeArtifact(task.taskId, 'procedure-packages.json', task.packages); await saveAgentTask(task);
}

// 判据从"页面有没有文本"改成"页面的文本能不能用"。WMKJ 的 p35 有 1190 个字符、
// 覆盖率 0.463，看着文本充裕，实际是无 ToUnicode 映射导致的字形码乱码；旧判据
// （isScanned=文本<20 字符，或覆盖率<0.02）完全不触发，模型读不到坐标就编了 7 个。
const GARBLED_TEXT_RATIO = 0.35;   // 实测正常页 0.04-0.15、乱码页 0.59-0.64，取中间空档
const SPARSE_TEXT_CHARS = 200;     // 正文没进文本层的页（WMKJ 航图/编码表只剩页眉 75-99 字符）
const GRAPHICS_RICH_OPERATORS = 1000; // 有实质图形内容，说明页面并非真的空

function transcriptionNeed(page: PageAsset): { need: boolean; priority: number; reason: string } {
  // 空白页永远排在"文本最少"的最前面，旧实现把 30 次 OCR 全烧在 OMAA 的
  // "PAGE INTENTIONALLY LEFT BLANK" 上。没有内容就没有可转写的东西。
  if (isBlankPage(page)) return { need: false, priority: 9, reason: '' };
  if (page.quality.isScanned) return { need: true, priority: 0, reason: 'NO_TEXT_LAYER' };
  // 就地从文本算，不读 quality.garbledTextRatio：该字段只在预处理时写入，
  // 存量任务一律没有，依赖它会让乱码检测对所有既有任务静默失效。
  if (garbledTextRatio(page.nativeText) >= GARBLED_TEXT_RATIO) return { need: true, priority: 1, reason: 'TEXT_LAYER_GARBLED' };
  if (page.quality.nativeTextCoverage < 0.02) return { need: true, priority: 2, reason: 'TEXT_COVERAGE_NEGLIGIBLE' };
  if (page.nativeText.trim().length < SPARSE_TEXT_CHARS && pageVectorPathCount(page) >= GRAPHICS_RICH_OPERATORS) return { need: true, priority: 3, reason: 'CONTENT_NOT_IN_TEXT_LAYER' };
  return { need: false, priority: 9, reason: '' };
}

async function transcribeScannedPages(task: AgentTask, signal: AbortSignal) {
  // 预算有限（maxOcrPages），按损坏程度排序，让最不可读的页优先拿到转写额度。
  const candidates = task.pages
    .map((page) => ({ page, ...transcriptionNeed(page) }))
    .filter((item) => item.need)
    .sort((a, b) => a.priority - b.priority || a.page.pageNumber - b.page.pageNumber);
  const scanned = candidates.map((item) => item.page);
  let transcribed = 0;
  let budgetExhausted = false;
  for (const page of scanned) {
    if (transcribed >= budgets.maxOcrPages) { budgetExhausted = true; task.warningCount += 1; break; }
    assertActive(task, signal);
    try {
      const image = { pageNo: page.pageNumber, dataUrl: `data:image/png;base64,${(await fs.readFile(page.renderedImagePath)).toString('base64')}` };
      const { parsed } = await callModel(task, 'page-transcriber', { fileName: page.fileName, pageNumber: page.pageNumber }, [image], `OCR:${page.documentId}:${page.pageNumber}`, signal, { planAction: 'PAGE_TRANSCRIPTION' });
      page.nativeText = String(parsed.fullText || '');
      page.textSpans = (parsed.regions || []).map((r: any) => ({ text: String(r.text || ''), bbox: [r.bbox[0] * page.width, r.bbox[1] * page.height, r.bbox[2] * page.width, r.bbox[3] * page.height] as [number, number, number, number] }));
      page.detectedLanguages = parsed.languages?.length ? parsed.languages : page.detectedLanguages;
      page.summary = page.nativeText.replace(/\s+/g, ' ').trim().slice(0, 1800);
      page.title = page.nativeText.split(/\r?\n/).map((s) => s.trim()).find((s) => s.length > 5)?.slice(0, 160);
      (page.quality as any).transcribed = true;
      transcribed += 1;
    } catch (error) { task.warningCount += 1; void error; }
  }
  // 预算不足时必须让"哪些页没被转写"可见——静默截断会让下游拿着不可读的文本继续跑。
  const byReason = candidates.reduce<Record<string, number>>((acc, item) => ({ ...acc, [item.reason]: (acc[item.reason] || 0) + 1 }), {});
  return {
    scannedPages: scanned.length,
    transcribedPages: transcribed,
    needByReason: byReason,
    budgetExhausted,
    untranscribedPages: budgetExhausted ? candidates.slice(transcribed).map((item) => item.page.pageNumber) : [],
  };
}

const GROUPING_BATCH_PAGE_LIMIT = 110;

// 纯结构判据，不依赖任何语种的"本页空白"字样：几乎没有图形且几乎没有文字。
function isBlankPage(page: PageAsset) { return pageVectorPathCount(page) < 50 && page.quality.nativeTextCoverage < 0.02; }

// 分组要看的是航图，不是空白页。旧排序只按文本覆盖率升序，而空白页覆盖率恒为最低，
// 会把整个图额度吃光（OMAA：6 张全是 PAGE INTENTIONALLY LEFT BLANK，模型一张真实航图都没看到）。
// 改为：扫描页优先（确实只能靠看），其次按矢量算子数降序取图形最密的页。
export function selectGroupingImagePages(pages: PageAsset[], limit: number) {
  return [...pages]
    .filter((page) => !isBlankPage(page))
    .sort((a, b) => Number(b.quality.isScanned) - Number(a.quality.isScanned) || pageVectorPathCount(b) - pageVectorPathCount(a) || a.quality.nativeTextCoverage - b.quality.nativeTextCoverage)
    .slice(0, limit);
}

async function groupAirportPackages(task: AgentTask, signal: AbortSignal): Promise<AirportPackageAnalysis> {
  // 文档分批（每批页数受限），每批附页面缩略图（优先扫描页，其次图形最密的页），多轮结果确定性合并。
  const batches: Array<typeof task.documents> = [];
  let current: typeof task.documents = []; let pageCount = 0;
  for (const document of task.documents.filter((d) => d.parseStatus === 'PARSED')) {
    if (current.length && pageCount + document.pageCount > GROUPING_BATCH_PAGE_LIMIT) { batches.push(current); current = []; pageCount = 0; }
    current.push(document); pageCount += document.pageCount;
  }
  if (current.length) batches.push(current);

  const partials: AirportPackageAnalysis[] = [];
  for (const [batchIndex, batch] of batches.entries()) {
    assertActive(task, signal);
    const documents = batch.map((document) => ({ documentId: document.documentId, fileName: document.fileName, pageCount: document.pageCount, pages: task.pages.filter((p) => p.documentId === document.documentId).map((p) => ({ pageNumber: p.pageNumber, title: p.title, summary: p.summary, languages: p.detectedLanguages, nativeTextQuality: p.quality.nativeTextCoverage, vectorPathCount: pageVectorPathCount(p), transcribed: (p.quality as any).transcribed === true })) }));
    const batchPages = task.pages.filter((p) => batch.some((d) => d.documentId === p.documentId));
    const imagePages = selectGroupingImagePages(batchPages, budgets.maxImagesPerCall);
    const images = await Promise.all(imagePages.map(async (p) => ({ pageNo: p.pageNumber, aipPageNo: `${p.documentId}:${p.pageNumber}`, dataUrl: `data:image/png;base64,${(await fs.readFile(p.thumbnailPath)).toString('base64')}` })));
    const { parsed } = await callModel(task, 'airport-package-grouper', { taskName: batches.length > 1 ? `${task.taskName}（批次 ${batchIndex + 1}/${batches.length}，已识别机场：${partials[0]?.airport?.icao || '未定'}）` : task.taskName, documents }, images, `AIRPORT_PACKAGE_GROUPING${batches.length > 1 ? `:${batchIndex + 1}` : ''}`, signal, { planAction: 'AIRPORT_PACKAGE_GROUPING' });
    partials.push(parsed as AirportPackageAnalysis);
  }
  return mergeGroupingResults(partials);
}

function mergeGroupingResults(partials: AirportPackageAnalysis[]): AirportPackageAnalysis {
  if (partials.length === 1) return partials[0];
  const first = partials[0];
  const merged: AirportPackageAnalysis = { airport: first.airport, packages: [], unassignedPages: [], warnings: [], decisionSummary: partials.map((p, i) => `[批次${i + 1}] ${p.decisionSummary}`).join(' ') };
  const byKey = new Map<string, AirportPackageAnalysis['packages'][number]>();
  for (const partial of partials) {
    if (!merged.airport.icao && partial.airport.icao) merged.airport = partial.airport;
    merged.warnings.push(...(partial.warnings || []));
    merged.unassignedPages.push(...(partial.unassignedPages || []));
    for (const pkg of partial.packages) {
      const key = `${pkg.procedureCategory}|${pkg.procedureName.toUpperCase()}|${[...pkg.runways].sort().join(',')}`;
      const existing = byKey.get(key);
      if (!existing) { byKey.set(key, pkg); merged.packages.push(pkg); }
      else { existing.sources.push(...pkg.sources); existing.sharedSources.push(...pkg.sharedSources); existing.warnings.push(`跨批次合并：${pkg.groupingReason}`); }
    }
  }
  return merged;
}

/** 确定性分组完整性审计：目录/数量/重复/高价值未分配页。 */
export function auditGrouping(task: AgentTask, analysis: AirportPackageAnalysis): string[] {
  const warnings: string[] = [];
  const counts: Record<string, number> = {};
  for (const pkg of analysis.packages) counts[pkg.procedureCategory] = (counts[pkg.procedureCategory] || 0) + 1;
  // 1) 模型自述数量 vs 实际包数
  const summary = analysis.decisionSummary || '';
  for (const match of summary.matchAll(/(\d+)\s*(?:个)?\s*(SID|STAR|APPROACH|IAP|instrument approach|进近|离场|进场)/gi)) {
    const claimed = Number(match[1]);
    const raw = match[2].toUpperCase();
    const category = raw.startsWith('SID') || raw.includes('离场') ? 'SID' : raw.startsWith('STAR') || raw.includes('进场') ? 'STAR' : 'APPROACH';
    const actual = counts[category] || 0;
    if (claimed !== actual) warnings.push(`GROUPING_COUNT_MISMATCH: decisionSummary 声称 ${claimed} 个 ${category}，实际输出 ${actual} 个。`);
  }
  // 2) 重复程序包
  const seen = new Map<string, string>();
  for (const pkg of analysis.packages) {
    const key = `${pkg.procedureCategory}|${pkg.procedureName.toUpperCase()}|${[...pkg.runways].sort().join(',')}`;
    if (seen.has(key)) warnings.push(`GROUPING_DUPLICATE: 程序包 "${pkg.procedureName}" (${pkg.procedureCategory}) 出现重复分组。`);
    seen.set(key, pkg.procedureKey);
  }
  // 3) 高价值页面未分配（标题含程序图关键词）
  const assigned = new Set(analysis.packages.flatMap((p) => [...p.sources, ...p.sharedSources].flatMap((s) => s.pages.map((n) => `${s.documentId}:${n}`))));
  for (const page of task.pages) {
    const key = `${page.documentId}:${page.pageNumber}`;
    if (assigned.has(key)) continue;
    const text = `${page.title || ''} ${page.summary?.slice(0, 300) || ''}`;
    if (/\b(SID|STAR|DEPARTURE|ARRIVAL|APPROACH|RNP|ILS|VOR|NDB)\b.{0,60}\b(CHART|RWY|RUNWAY)\b/i.test(text) || /INSTRUMENT APPROACH CHART|STANDARD (DEPARTURE|ARRIVAL) CHART/i.test(text)) {
      warnings.push(`GROUPING_HIGH_VALUE_UNASSIGNED: 第 ${page.pageNumber} 页（${page.fileName}）看起来是程序图（"${(page.title || '').slice(0, 60)}"）但未被任何程序包引用。`);
    }
  }
  // 4) 页面账目
  const totalReferenced = new Set([...assigned, ...analysis.unassignedPages.map((p) => `${p.documentId}:${p.pageNumber}`)]).size;
  if (totalReferenced < task.pages.length) warnings.push(`GROUPING_PAGE_ACCOUNTING: ${task.pages.length - totalReferenced} 页既未分配到程序包也未出现在未分配清单。`);
  return warnings;
}

function markSharedPages(packages: BusinessProcedurePackage[]) {
  const usage = new Map<string, number>();
  for (const pkg of packages) for (const ref of pkg.packagePages) { const key = `${ref.documentId}:${ref.pageNumber}`; usage.set(key, (usage.get(key) || 0) + 1); }
  for (const pkg of packages) for (const ref of pkg.packagePages) if ((usage.get(`${ref.documentId}:${ref.pageNumber}`) || 0) > 1) ref.isShared = true;
}

function toBusinessPackage(item: AirportPackageAnalysis['packages'][number], task: AgentTask): BusinessProcedurePackage {
  const packagePages: PackagePageRef[] = [...item.sources.map((s) => ({ ...s, shared: false })), ...item.sharedSources.map((s) => ({ ...s, shared: true }))].flatMap((source) => source.pages.map((pageNumber, index) => ({ documentId: source.documentId, fileName: source.fileName, pageNumber, pageRole: source.roles[index] || source.roles[0] || 'RELATED', isShared: source.shared, confidence: item.groupingConfidence })));
  return { packageId: crypto.randomUUID(), procedureKey: item.procedureKey, category: item.procedureCategory === 'SID' ? 'SID' : 'STAR', procedureCategory: item.procedureCategory, procedureName: item.procedureName, runways: item.runways, navigationType: item.navigationType, packagePages, sources: derivePackageSources(packagePages, task), confidence: item.groupingConfidence, groupingConfidence: item.groupingConfidence, groupingReason: item.groupingReason, status: 'GROUPED', warnings: item.warnings };
}

// sources 是 packagePages 的派生视图；任何改动 pageRole 的地方都必须重算它，否则两份表述会打架。
export function derivePackageSources(packagePages: PackagePageRef[], task: AgentTask): BusinessProcedurePackage['sources'] {
  const globals = (role: RegExp) => packagePages.filter((ref) => role.test(ref.pageRole)).map((ref) => task.pages.find((p) => p.documentId === ref.documentId && p.pageNumber === ref.pageNumber)?.globalPageNumber).filter((n): n is number => !!n);
  return { primaryCharts: globals(/CHART/i), procedureTables: globals(/PROCEDURE_TABLE/i), coordinateTables: globals(/COORDINATE/i), runwayPages: globals(/RUNWAY/i), navaidPages: globals(/NAVAID/i), sharedNotes: globals(/NOTE/i), profilePages: globals(/PROFILE/i), minimaPages: globals(/MINIMA/i), relatedPages: globals(/RELATED|INDEX/i) };
}

// ============================== 阶段 B：识别规划 ==============================

async function planPackage(task: AgentTask, pkg: BusinessProcedurePackage, signal: AbortSignal) {
  pkg.status = 'PLANNING'; task.status = 'RUNNING'; task.stage = 'RECOGNIZING'; task.currentProcedure = pkg.procedureName; await saveAgentTask(task);
  const pages = resolvePackagePages(task, pkg); const images = await pageImages(pages.filter((p) => /CHART/i.test(pkg.packagePages.find((r) => r.documentId === p.documentId && r.pageNumber === p.pageNumber)?.pageRole || '')).slice(0, budgets.maxImagesPerCall));
  const { parsed } = await callModel(task, 'procedure-recognition-planner', { airport: { icao: task.airportIcao, name: task.airportName }, procedurePackage: packageForModel(pkg), pages: pages.map(pageForModel), sharedAirportSources: sharedAirportSources(task, pkg) }, images, `PACKAGE_PLANNING:${pkg.packageId}`, signal, { planAction: 'PACKAGE_PLANNING' });
  const plan = parsed as RecognitionPlan;
  plan.packageId = pkg.packageId; plan.promptVersion = (await loadPrompt('procedure-recognition-planner')).version; pkg.recognitionPlan = plan; pkg.status = 'PLAN_COMPLETED'; task.status = 'COMPLETED'; task.stage = task.completedProcedures > 0 ? 'RESULTS_READY' : 'PACKAGES_READY'; task.currentProcedure = undefined; await writeArtifact(task.taskId, `packages/${pkg.packageId}/recognition-plan.json`, plan); await saveAgentTask(task);
}

// ============================== 阶段 C：识别（planned 默认 / single 保留对照） ==============================

async function recognizePackages(task: AgentTask, packages: BusinessProcedurePackage[], signal: AbortSignal) {
  task.status = 'RUNNING'; task.stage = 'RECOGNIZING'; task.completedProcedures = packages.filter((p) => p.status === 'COMPLETED').length; task.totalProcedures = task.packages.length; await saveAgentTask(task);
  for (const pkg of packages) { if (signal.aborted) break; try { await recognizePackage(task, pkg, signal, false); } catch { /* package failure is isolated */ } }
  const failed = packages.filter((p) => p.status === 'FAILED').length; task.status = failed ? 'PARTIALLY_COMPLETED' : 'COMPLETED'; task.stage = 'RESULTS_READY'; task.currentProcedure = undefined; task.progress = 100; await saveAgentTask(task);
}

async function recognizePackage(task: AgentTask, pkg: BusinessProcedurePackage, signal: AbortSignal, finalizeTask = true) {
  if (!pkg.recognitionPlan) await planPackage(task, pkg, signal);
  pkg.warnings = pkg.warnings.filter((warning) => !warning.includes('后端服务重启导致识别中断'));
  pkg.status = 'RECOGNIZING'; task.status = 'RUNNING'; task.stage = 'RECOGNIZING'; task.currentProcedure = pkg.procedureName; await saveAgentTask(task);
  const previous = task.procedures.filter((p) => p.packageId === pkg.packageId).sort((a, b) => b.version - a.version)[0];
  const procedure: AgentProcedure = { procedureId: crypto.randomUUID(), packageId: pkg.packageId, version: (previous?.version || 0) + 1, validations: [], status: 'RUNNING' };
  task.procedures.push(procedure);
  try {
    const plan = pkg.recognitionPlan!;
    let pir: ProcedurePIR;
    if (executionMode() === 'planned') {
      const result = await step(task, `PROCEDURE_RECOGNITION:${pkg.procedureKey}(planned)`, () => executePlannedRecognition(task, pkg, plan, signal, { procedureId: procedure.procedureId, previousPir: previous?.pir }));
      pir = result.pir;
    } else {
      pir = await step(task, `PROCEDURE_RECOGNITION:${pkg.procedureKey}(single)`, () => recognizeProcedureSingle(task, pkg, signal, procedure.procedureId));
      carryOverManualEdits(previous?.pir, pir);
    }
    pkg.status = 'VALIDATING'; await saveAgentTask(task);
    let validations = validatePir(pir, plan);
    procedure.pir = pir;
    procedure.geojson = compileGeoJson(pir);

    // —— 原图叠加反向校验 + 定向局部重识别（最多 budgets.maxOverlayRounds 轮） ——
    const chartRef = pkg.packagePages.find((r) => /CHART/i.test(r.pageRole));
    const chartPage = chartRef ? task.pages.find((p) => p.documentId === chartRef.documentId && p.pageNumber === chartRef.pageNumber) : undefined;
    if (chartPage) {
      for (let round = 0; round < budgets.maxOverlayRounds; round++) {
        assertActive(task, signal);
        let verification;
        try { verification = await verifyAgainstSourceChart(task, procedure.procedureId, pir, procedure.geojson, chartPage, signal); }
        catch (error) { pir.notes.push({ text: `Chart overlay verification failed: ${messageOf(error)}`, evidence: [] }); break; }
        await writeArtifact(task.taskId, `procedures/${procedure.procedureId}/overlay-verification-r${round + 1}.json`, verification);
        const overlayValidations = deviationsToValidations(verification);
        validations = [...validations.filter((v) => !v.ruleCode.startsWith('CHART_OVERLAY')), ...overlayValidations];
        const repairable = verification.deviations.filter((d) => (d.severity === 'ERROR' || d.severity === 'BLOCKER'));
        if (verification.status !== 'VERIFIED' || !repairable.length || round === budgets.maxOverlayRounds - 1) break;
        try {
          await executeCorrectiveLegExtraction(task, pkg, pir, plan, repairable.map((d) => `${d.kind}${d.legId ? ` leg=${d.legId}` : ''}${d.fixIdentifier ? ` fix=${d.fixIdentifier}` : ''}: ${d.note}`), signal, procedure.procedureId);
          procedure.geojson = compileGeoJson(pir);
          validations = [...validatePir(pir, plan), ...overlayValidations];
        } catch (error) { pir.notes.push({ text: `Corrective re-extraction failed: ${messageOf(error)}`, evidence: [] }); break; }
      }
    }

    pir.validation.results = validations;
    procedure.validations = validations;
    const gate = applyQualityGate(pir, validations);
    procedure.geojson = compileGeoJson(pir);
    procedure.candidate424 = compile424Candidate(pir, validations);
    await materializeEvidenceCrops(task, pir, procedure.procedureId);
    procedure.status = 'COMPLETED';
    pkg.status = gate;
    await writeArtifact(task.taskId, `procedures/${procedure.procedureId}/pir-v${procedure.version}.json`, pir);
    await writeArtifact(task.taskId, `procedures/${procedure.procedureId}/geojson-v${procedure.version}.json`, procedure.geojson);
    await writeArtifact(task.taskId, `procedures/${procedure.procedureId}/424-v${procedure.version}.txt`, procedure.candidate424.text || JSON.stringify(procedure.candidate424, null, 2));
  } catch (error) {
    procedure.status = 'FAILED'; pkg.status = 'FAILED';
    procedure.validations.push({ ruleCode: 'PROCEDURE_RECOGNITION_FAILED', severity: 'ERROR', fieldPath: '', message: messageOf(error), evidence: [], autoRepairable: true });
    task.errorCount += 1;
    if (finalizeTask) throw error;
  }
  task.completedProcedures = task.packages.filter((p) => ['COMPLETED', 'COMPLETED_WITH_WARNINGS', 'REQUIRES_REVIEW'].includes(p.status)).length;
  task.progress = Math.round(100 * task.completedProcedures / Math.max(1, task.packages.length));
  if (finalizeTask) { task.status = pkg.status === 'FAILED' ? 'PARTIALLY_COMPLETED' : 'COMPLETED'; task.stage = task.completedProcedures ? 'RESULTS_READY' : 'PACKAGES_READY'; task.currentProcedure = undefined; }
  await saveAgentTask(task);
}

/** single 模式：一次调用产出完整 PIR（历史对照用，AGENT_EXECUTION_MODE=single 启用）。 */
async function recognizeProcedureSingle(task: AgentTask, pkg: BusinessProcedurePackage, signal: AbortSignal, procedureId: string): Promise<ProcedurePIR> {
  const pages = resolvePackagePages(task, pkg);
  const images = await pageImages(pages.filter((p) => /CHART|TABLE/i.test(pkg.packagePages.find((r) => r.documentId === p.documentId && r.pageNumber === p.pageNumber)?.pageRole || '')).slice(0, budgets.maxImagesPerCall));
  const { parsed } = await callModel(task, 'procedure-recognizer', { airport: { icao: task.airportIcao, name: task.airportName }, procedurePackage: packageForModel(pkg), recognitionPlan: pkg.recognitionPlan, sources: pages.map(pageForModel) }, images, `PROCEDURE_RECOGNITION:${pkg.packageId}`, signal, { procedureId, planAction: 'SINGLE_SHOT_RECOGNITION' });
  const pir = parsed as ProcedurePIR;
  normalizePir(pir, task, pkg);
  return pir;
}

function normalizePir(pir: ProcedurePIR, task: AgentTask, pkg: BusinessProcedurePackage) {
  pir.schemaVersion = '1.1.0';
  pir.airport = { icao: task.airportIcao || '', name: task.airportName || undefined };
  // 禁止类别强转：包是什么类别，PIR 就是什么类别。
  pir.procedure.category = pkg.procedureCategory;
  pir.procedure.name ||= pkg.procedureName; pir.procedure.runways ||= pkg.runways;
  pir.routes ||= []; pir.fixes ||= []; pir.legs ||= []; pir.runwayData ||= []; pir.minima ||= []; pir.notes ||= []; pir.sourceEvidence ||= []; pir.conflicts ||= []; pir.validation = { results: [] };
  pir.quality ||= { confidence: pkg.groupingConfidence, reviewRequired: false, unresolvedFields: [] };
}

function resolvePackagePages(task: AgentTask, pkg: BusinessProcedurePackage) { return pkg.packagePages.map((ref) => task.pages.find((p) => p.documentId === ref.documentId && p.pageNumber === ref.pageNumber)).filter((p): p is NonNullable<typeof p> => !!p); }
function sharedAirportSources(task: AgentTask, pkg: BusinessProcedurePackage) { return task.pages.filter((page) => !pkg.packagePages.some((ref) => ref.documentId === page.documentId && ref.pageNumber === page.pageNumber) && /COORDINATE|RUNWAY|NAVAID/i.test(page.title || '')).map(pageForModel); }
function packageForModel(pkg: BusinessProcedurePackage) { return { packageId: pkg.packageId, procedureCategory: pkg.procedureCategory, procedureName: pkg.procedureName, runways: pkg.runways, navigationType: pkg.navigationType, groupingReason: pkg.groupingReason, pages: pkg.packagePages }; }
function pageForModel(page: PageAsset) { return { documentId: page.documentId, fileName: page.fileName, pageNumber: page.pageNumber, title: page.title, nativeText: page.nativeText.slice(0, 18000), summary: page.summary, quality: page.quality }; }
async function pageImages(pages: PageAsset[]) { return await Promise.all(pages.map(async (p) => ({ pageNo: p.pageNumber, aipPageNo: `${p.documentId}:${p.pageNumber}`, dataUrl: `data:image/png;base64,${(await fs.readFile(p.renderedImagePath)).toString('base64')}` }))); }

async function step<T>(task: AgentTask, name: string, fn: () => Promise<T>): Promise<T> { const item: AgentStep = { stepId: crypto.randomUUID(), name, status: 'RUNNING', startedAt: new Date().toISOString(), retryCount: 0, version: 1 }; task.steps.push(item); await saveAgentTask(task); const start = Date.now(); try { const out = await fn(); item.status = 'COMPLETED'; item.output = summarizeOutput(out); return out; } catch (error) { item.status = 'FAILED'; item.error = messageOf(error); throw error; } finally { item.completedAt = new Date().toISOString(); item.durationMs = Date.now() - start; await saveAgentTask(task); } }
function summarizeOutput(value: unknown) { const text = JSON.stringify(value); return text && text.length > 8000 ? { summary: `${text.slice(0, 8000)}...`, truncated: true } : value; }
function assertActive(task: AgentTask, signal: AbortSignal) { if (signal.aborted || task.cancelRequested) throw new Error('Task cancelled.'); }
function messageOf(error: unknown) { return error instanceof Error ? error.message : String(error); }
