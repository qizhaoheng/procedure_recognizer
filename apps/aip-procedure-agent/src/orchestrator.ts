import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { getLlmRuntimeConfig, runVisionRecognition } from '../../../server/src/services/llm/llmClient';
import { compile424Candidate, compileGeoJson, validatePir } from './compiler';
import type { AgentProcedure, AgentStep, AgentTask, AirportPackageAnalysis, BusinessProcedurePackage, ModelCall, PackagePageRef, ProcedurePIR, RecognitionPlan } from './domain';
import { PdfDocumentTools } from './pdfPreprocessor';
import { loadPrompt, renderTemplate } from './promptRegistry';
import { saveAgentTask, taskDir, writeArtifact } from './storage';

const running = new Map<string, AbortController>();
const budgets = { maxModelCalls: Number(process.env.AGENT_MAX_MODEL_CALLS || 80), maxImagesPerCall: Number(process.env.AGENT_MAX_IMAGES || 6) };

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

async function analyzeAirportFiles(task: AgentTask, signal: AbortSignal) {
  if (!task.documents.length) throw new Error('请先上传至少一个 PDF。');
  task.status = 'RUNNING'; task.stage = 'ANALYZING'; task.progress = 2; task.error = undefined; task.airportAnalysis = undefined; task.packages = []; task.procedures = []; await saveAgentTask(task);
  let globalPage = 0; task.pages = [];
  for (let index = 0; index < task.documents.length; index++) {
    assertActive(task, signal); const document = task.documents[index]; document.parseStatus = 'PARSING'; await saveAgentTask(task);
    const tools = new PdfDocumentTools(document.filePath, path.join(taskDir(task.taskId), 'documents', document.documentId, 'pages'));
    try {
      const pages = await tools.preprocess(async (page) => { document.pageCount = page.pageNumber; task.progress = Math.min(45, 3 + Math.round(40 * (index + page.pageNumber / Math.max(1, document.pageCount || page.pageNumber)) / task.documents.length)); if (page.pageNumber % 5 === 0) await saveAgentTask(task); });
      for (const page of pages) { globalPage += 1; page.documentId = document.documentId; page.fileName = document.fileName; page.globalPageNumber = globalPage; task.pages.push(page); }
      document.pageCount = pages.length; document.parseStatus = 'PARSED'; document.error = undefined;
    } catch (error) { document.parseStatus = 'FAILED'; document.error = messageOf(error); task.warningCount += 1; }
    await saveAgentTask(task);
  }
  const parsed = task.documents.filter((d) => d.parseStatus === 'PARSED'); if (!parsed.length) throw new Error('所有 PDF 均解析失败。');
  task.progress = 50; await saveAgentTask(task);
  const analysis = await groupAirportPackages(task, signal); task.airportIcao = analysis.airport.icao || null; task.airportName = analysis.airport.name || null;
  task.packages = analysis.packages.map((item) => toBusinessPackage(item, task)); task.totalProcedures = task.packages.length; task.airportAnalysis = { airport: { icao: analysis.airport.icao, name: analysis.airport.name, country: analysis.airport.country }, document: { languages: [...new Set(task.pages.flatMap((p) => p.detectedLanguages))], pageCount: task.pages.length }, pageRoles: [], procedures: task.packages.filter((p) => p.procedureCategory !== 'APPROACH').map((p) => ({ procedureKey: p.procedureKey, category: p.procedureCategory as 'SID' | 'STAR', name: p.procedureName, runways: p.runways, navigationType: p.navigationType, primaryPages: p.sources.primaryCharts, relatedPages: p.sources.relatedPages, sharedPages: p.packagePages.filter((x) => x.isShared).map((x) => x.pageNumber), confidence: p.groupingConfidence })), sharedSources: [], unassignedPages: analysis.unassignedPages.map((p) => task.pages.find((x) => x.documentId === p.documentId && x.pageNumber === p.pageNumber)?.globalPageNumber || 0).filter(Boolean), warnings: analysis.warnings, decisionSummary: analysis.decisionSummary };
  task.status = 'COMPLETED'; task.stage = 'PACKAGES_READY'; task.progress = 100; await writeArtifact(task.taskId, 'airport-package-analysis.json', analysis); await writeArtifact(task.taskId, 'procedure-packages.json', task.packages); await saveAgentTask(task);
}

async function groupAirportPackages(task: AgentTask, signal: AbortSignal): Promise<AirportPackageAnalysis> {
  const documents = task.documents.map((document) => ({ documentId: document.documentId, fileName: document.fileName, pageCount: document.pageCount, pages: task.pages.filter((p) => p.documentId === document.documentId).map((p) => ({ pageNumber: p.pageNumber, title: p.title, summary: p.summary, languages: p.detectedLanguages, nativeTextQuality: p.quality.nativeTextCoverage })) }));
  return await callModel(task, 'airport-package-grouper', { taskName: task.taskName, documents }, [], 'AIRPORT_PACKAGE_GROUPING', signal) as AirportPackageAnalysis;
}

function toBusinessPackage(item: AirportPackageAnalysis['packages'][number], task: AgentTask): BusinessProcedurePackage {
  const packagePages: PackagePageRef[] = [...item.sources.map((s) => ({ ...s, shared: false })), ...item.sharedSources.map((s) => ({ ...s, shared: true }))].flatMap((source) => source.pages.map((pageNumber, index) => ({ documentId: source.documentId, fileName: source.fileName, pageNumber, pageRole: source.roles[index] || source.roles[0] || 'RELATED', isShared: source.shared, confidence: item.groupingConfidence })));
  const globals = (role: RegExp) => packagePages.filter((ref) => role.test(ref.pageRole)).map((ref) => task.pages.find((p) => p.documentId === ref.documentId && p.pageNumber === ref.pageNumber)?.globalPageNumber).filter((n): n is number => !!n);
  return { packageId: crypto.randomUUID(), procedureKey: item.procedureKey, category: item.procedureCategory === 'SID' ? 'SID' : 'STAR', procedureCategory: item.procedureCategory, procedureName: item.procedureName, runways: item.runways, navigationType: item.navigationType, packagePages, sources: { primaryCharts: globals(/CHART/i), procedureTables: globals(/PROCEDURE_TABLE/i), coordinateTables: globals(/COORDINATE/i), runwayPages: globals(/RUNWAY/i), navaidPages: globals(/NAVAID/i), sharedNotes: globals(/NOTE/i), profilePages: globals(/PROFILE/i), minimaPages: globals(/MINIMA/i), relatedPages: globals(/RELATED|INDEX/i) }, confidence: item.groupingConfidence, groupingConfidence: item.groupingConfidence, groupingReason: item.groupingReason, status: 'GROUPED', warnings: item.warnings };
}

async function planPackage(task: AgentTask, pkg: BusinessProcedurePackage, signal: AbortSignal) {
  pkg.status = 'PLANNING'; task.status = 'RUNNING'; task.stage = 'RECOGNIZING'; task.currentProcedure = pkg.procedureName; await saveAgentTask(task);
  const pages = resolvePackagePages(task, pkg); const images = await pageImages(pages.filter((p) => /CHART/i.test(pkg.packagePages.find((r) => r.documentId === p.documentId && r.pageNumber === p.pageNumber)?.pageRole || '')).slice(0, budgets.maxImagesPerCall));
  const plan = await callModel(task, 'procedure-recognition-planner', { airport: { icao: task.airportIcao, name: task.airportName }, procedurePackage: packageForModel(pkg), pages: pages.map(pageForModel), sharedAirportSources: sharedAirportSources(task, pkg) }, images, `PACKAGE_PLANNING:${pkg.packageId}`, signal) as RecognitionPlan;
  plan.packageId = pkg.packageId; plan.promptVersion = (await loadPrompt('procedure-recognition-planner')).version; pkg.recognitionPlan = plan; pkg.status = 'PLAN_COMPLETED'; task.status = 'COMPLETED'; task.stage = task.completedProcedures > 0 ? 'RESULTS_READY' : 'PACKAGES_READY'; task.currentProcedure = undefined; await writeArtifact(task.taskId, `packages/${pkg.packageId}/recognition-plan.json`, plan); await saveAgentTask(task);
}

async function recognizePackages(task: AgentTask, packages: BusinessProcedurePackage[], signal: AbortSignal) {
  task.status = 'RUNNING'; task.stage = 'RECOGNIZING'; task.completedProcedures = packages.filter((p) => p.status === 'COMPLETED').length; task.totalProcedures = task.packages.length; await saveAgentTask(task);
  for (const pkg of packages) { if (signal.aborted) break; try { await recognizePackage(task, pkg, signal, false); } catch { /* package failure is isolated */ } }
  const failed = packages.filter((p) => p.status === 'FAILED').length; task.status = failed ? 'PARTIALLY_COMPLETED' : 'COMPLETED'; task.stage = 'RESULTS_READY'; task.currentProcedure = undefined; task.progress = 100; await saveAgentTask(task);
}

async function recognizePackage(task: AgentTask, pkg: BusinessProcedurePackage, signal: AbortSignal, finalizeTask = true) {
  if (!pkg.recognitionPlan) await planPackage(task, pkg, signal);
  pkg.warnings = pkg.warnings.filter((warning) => !warning.includes('后端服务重启导致识别中断'));
  pkg.status = 'RECOGNIZING'; task.status = 'RUNNING'; task.stage = 'RECOGNIZING'; task.currentProcedure = pkg.procedureName; await saveAgentTask(task);
  const previous = task.procedures.filter((p) => p.packageId === pkg.packageId).sort((a, b) => b.version - a.version)[0]; const procedure: AgentProcedure = { procedureId: crypto.randomUUID(), packageId: pkg.packageId, version: (previous?.version || 0) + 1, validations: [], status: 'RUNNING' }; task.procedures.push(procedure);
  try {
    const pages = resolvePackagePages(task, pkg); const images = await pageImages(pages.filter((p) => /CHART|TABLE/i.test(pkg.packagePages.find((r) => r.documentId === p.documentId && r.pageNumber === p.pageNumber)?.pageRole || '')).slice(0, budgets.maxImagesPerCall));
    const pir = await callModel(task, 'procedure-recognizer', { airport: { icao: task.airportIcao, name: task.airportName }, procedurePackage: packageForModel(pkg), recognitionPlan: pkg.recognitionPlan, sources: pages.map(pageForModel) }, images, `PROCEDURE_RECOGNITION:${pkg.packageId}`, signal) as ProcedurePIR;
    normalizePir(pir, task, pkg); pkg.status = 'VALIDATING'; await saveAgentTask(task); pir.validation.results = validatePir(pir); procedure.pir = pir; procedure.validations = pir.validation.results; procedure.geojson = compileGeoJson(pir); procedure.candidate424 = compile424Candidate(pir); procedure.status = 'COMPLETED'; pkg.status = pir.quality.reviewRequired || pir.validation.results.some((v) => v.severity === 'ERROR' || v.severity === 'BLOCKER') ? 'COMPLETED_WITH_WARNINGS' : 'COMPLETED';
    await writeArtifact(task.taskId, `procedures/${procedure.procedureId}/pir-v${procedure.version}.json`, pir); await writeArtifact(task.taskId, `procedures/${procedure.procedureId}/geojson-v${procedure.version}.json`, procedure.geojson); await writeArtifact(task.taskId, `procedures/${procedure.procedureId}/424-v${procedure.version}.txt`, procedure.candidate424.text || JSON.stringify(procedure.candidate424, null, 2));
  } catch (error) { procedure.status = 'FAILED'; pkg.status = 'FAILED'; procedure.validations.push({ ruleCode: 'PROCEDURE_RECOGNITION_FAILED', severity: 'ERROR', fieldPath: '', message: messageOf(error), evidence: [], autoRepairable: true }); task.errorCount += 1; if (finalizeTask) throw error; }
  task.completedProcedures = task.packages.filter((p) => ['COMPLETED', 'COMPLETED_WITH_WARNINGS'].includes(p.status)).length; task.progress = Math.round(100 * task.completedProcedures / Math.max(1, task.packages.length)); if (finalizeTask) { task.status = pkg.status === 'FAILED' ? 'PARTIALLY_COMPLETED' : 'COMPLETED'; task.stage = task.completedProcedures ? 'RESULTS_READY' : 'PACKAGES_READY'; task.currentProcedure = undefined; } await saveAgentTask(task);
}

function resolvePackagePages(task: AgentTask, pkg: BusinessProcedurePackage) { return pkg.packagePages.map((ref) => task.pages.find((p) => p.documentId === ref.documentId && p.pageNumber === ref.pageNumber)).filter((p): p is NonNullable<typeof p> => !!p); }
function sharedAirportSources(task: AgentTask, pkg: BusinessProcedurePackage) { return task.pages.filter((page) => !pkg.packagePages.some((ref) => ref.documentId === page.documentId && ref.pageNumber === page.pageNumber) && /COORDINATE|RUNWAY|NAVAID/i.test(page.title || '')).map(pageForModel); }
function packageForModel(pkg: BusinessProcedurePackage) { return { packageId: pkg.packageId, procedureCategory: pkg.procedureCategory, procedureName: pkg.procedureName, runways: pkg.runways, navigationType: pkg.navigationType, groupingReason: pkg.groupingReason, pages: pkg.packagePages }; }
function pageForModel(page: AgentTask['pages'][number]) { return { documentId: page.documentId, fileName: page.fileName, pageNumber: page.pageNumber, title: page.title, nativeText: page.nativeText.slice(0, 18000), summary: page.summary, quality: page.quality }; }
async function pageImages(pages: AgentTask['pages']) { return await Promise.all(pages.map(async (p) => ({ pageNo: p.pageNumber, aipPageNo: `${p.documentId}:${p.pageNumber}`, dataUrl: `data:image/png;base64,${(await fs.readFile(p.renderedImagePath)).toString('base64')}` }))); }
function normalizePir(pir: ProcedurePIR, task: AgentTask, pkg: BusinessProcedurePackage) { pir.schemaVersion = '1.0.0'; pir.airport = { icao: task.airportIcao || '', name: task.airportName || undefined }; pir.procedure.category = pkg.procedureCategory === 'SID' ? 'SID' : 'STAR'; pir.procedure.name ||= pkg.procedureName; pir.procedure.runways ||= pkg.runways; pir.routes ||= []; pir.fixes ||= []; pir.legs ||= []; pir.notes ||= []; pir.sourceEvidence ||= []; pir.conflicts ||= []; pir.validation = { results: [] }; pir.quality ||= { confidence: pkg.groupingConfidence, reviewRequired: false, unresolvedFields: [] }; }

async function callModel(task: AgentTask, promptName: string, values: Record<string, unknown>, images: any[], stepName: string, signal: AbortSignal) {
  if (task.modelCalls.length >= budgets.maxModelCalls) throw new Error('Agent model-call budget exceeded.'); const prompt = await loadPrompt(promptName); const config = getLlmRuntimeConfig(); const startedAt = new Date().toISOString(); const callId = crypto.randomUUID(); const rendered = renderTemplate(prompt.userTemplate, values); const userPrompt = config.structuredOutputMode === 'json_schema' ? rendered : `${rendered}\n\nRequired output JSON Schema (use exact field names):\n${JSON.stringify(prompt.schema)}`;
  const result = await runVisionRecognition({ model: config.model, systemPrompt: prompt.systemPrompt, userPrompt, images, responseSchema: prompt.schema, schemaName: prompt.name.replace(/-/g, '_'), abortSignal: signal }); const completedAt = new Date().toISOString(); const rawPath = `model-calls/${callId}.json`; await writeArtifact(task.taskId, rawPath, result.rawResponse ?? result.rawText ?? result.error);
  const record: ModelCall = { callId, agentRunId: task.taskId, stepName, startedAt, completedAt, model: result.model, error: result.ok ? undefined : result.error?.message, decisionSummary: typeof (result.parsedJson as any)?.decisionSummary === 'string' ? (result.parsedJson as any).decisionSummary : undefined, promptName, promptVersion: prompt.version, rawResponsePath: rawPath }; task.modelCalls.push(record); await saveAgentTask(task); if (!result.ok || !result.parsedJson) throw new Error(result.error?.message || 'Model returned no valid structured JSON.'); return result.parsedJson;
}

export async function recordBusinessStep<T>(task: AgentTask, name: string, fn: () => Promise<T>): Promise<T> { const item: AgentStep = { stepId: crypto.randomUUID(), name, status: 'RUNNING', startedAt: new Date().toISOString(), retryCount: 0, version: 1 }; task.steps.push(item); const start = Date.now(); try { const result = await fn(); item.status = 'COMPLETED'; return result; } catch (error) { item.status = 'FAILED'; item.error = messageOf(error); throw error; } finally { item.completedAt = new Date().toISOString(); item.durationMs = Date.now() - start; await saveAgentTask(task); } }
function assertActive(task: AgentTask, signal: AbortSignal) { if (signal.aborted || task.cancelRequested) throw new Error('Task cancelled.'); }
function messageOf(error: unknown) { return error instanceof Error ? error.message : String(error); }
