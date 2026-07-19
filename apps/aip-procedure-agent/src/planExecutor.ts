import fs from 'node:fs/promises';
import path from 'node:path';
import { budgets, callModel } from './modelGateway';
import { carryOverManualEdits, createEmptyPir, mergeFragment, resolveRunwayFixes, type PirFragment } from './fragmentMerger';
import { validatePir } from './validation';
import type { AgentTask, BusinessProcedurePackage, PageAsset, ProcedurePIR, RecognitionAction, RecognitionPlan } from './domain';
import { saveAgentTask, taskDir, writeArtifact } from './storage';

// Plan Executor：把 Recognition Plan 的动作序列真正映射为独立的聚焦模型调用，
// 逐步合并 PIR 片段。动作可请求只读工具（局部取文/裁剪/搜索），可依据结构校验追加步骤，
// 全程受步骤数 / 模型调用数 / 工具调用数 / 重试次数 / 循环检测约束。

const ACTION_PROMPT: Partial<Record<RecognitionAction, string>> = {
  EXTRACT_PROCEDURE_METADATA: 'fragment-metadata',
  EXTRACT_FIX_COORDINATES: 'fragment-fixes',
  ANALYZE_ROUTE_STRUCTURE: 'fragment-routes',
  EXTRACT_PROCEDURE_LEGS: 'fragment-legs',
  EXTRACT_CONSTRAINTS: 'fragment-constraints',
  EXTRACT_MINIMA: 'fragment-minima',
  EXTRACT_HOLDING: 'fragment-holding',
};
// 基线动作：Plan 缺失时补齐，保证 PIR 完整性不依赖 Planner 的输出质量。
const BASELINE: RecognitionAction[] = ['EXTRACT_PROCEDURE_METADATA', 'EXTRACT_FIX_COORDINATES', 'ANALYZE_ROUTE_STRUCTURE', 'EXTRACT_PROCEDURE_LEGS', 'EXTRACT_CONSTRAINTS'];

export interface PlanStepExecution { sequence: number; action: RecognitionAction; status: 'COMPLETED' | 'FAILED' | 'SKIPPED'; modelCallIds: string[]; toolCalls: number; appended?: boolean; error?: string }
export interface PlannedRecognitionResult { pir: ProcedurePIR; executions: PlanStepExecution[] }

export async function executePlannedRecognition(
  task: AgentTask,
  pkg: BusinessProcedurePackage,
  plan: RecognitionPlan,
  signal: AbortSignal,
  options: { procedureId: string; previousPir?: ProcedurePIR } = { procedureId: '' },
): Promise<PlannedRecognitionResult> {
  const pir = createEmptyPir(
    { icao: task.airportIcao || '', name: task.airportName || undefined },
    { category: pkg.procedureCategory, name: pkg.procedureName, runways: pkg.runways },
  );
  const steps = normalizePlanSteps(plan, pkg);
  const executions: PlanStepExecution[] = [];
  const executedSignatures = new Map<string, number>();
  let toolCallsUsed = 0;

  let index = 0;
  while (index < steps.length) {
    if (signal.aborted || task.cancelRequested) throw new Error('Task cancelled.');
    if (executions.length >= budgets.maxPlanSteps) { pir.notes.push({ text: `Plan step budget (${budgets.maxPlanSteps}) exhausted; remaining steps skipped.`, evidence: [] }); break; }
    const step = steps[index];
    index += 1;
    const promptName = ACTION_PROMPT[step.action];
    if (!promptName) { executions.push({ sequence: step.sequence, action: step.action, status: 'SKIPPED', modelCallIds: [], toolCalls: 0 }); continue; }
    // 循环检测：同一动作 + 同一页面组合最多执行 2 次（初跑 + 定向重试）
    const signature = `${step.action}|${step.sourcePages.map((p) => `${p.documentId}:${p.pageNumber}`).sort().join(',')}`;
    const runCount = executedSignatures.get(signature) || 0;
    if (runCount >= 2) { executions.push({ sequence: step.sequence, action: step.action, status: 'SKIPPED', modelCallIds: [], toolCalls: 0, error: 'Loop detected: identical step already executed twice.' }); continue; }
    executedSignatures.set(signature, runCount + 1);

    const execution: PlanStepExecution = { sequence: step.sequence, action: step.action, status: 'COMPLETED', modelCallIds: [], toolCalls: 0, appended: step.appended };
    let attempt = 0;
    for (;;) {
      try {
        const used = await executeAction(task, pkg, pir, plan, step, signal, options.procedureId, execution, toolCallsUsed);
        toolCallsUsed = used;
        break;
      } catch (error) {
        attempt += 1;
        if (attempt > budgets.maxActionRetries) { execution.status = 'FAILED'; execution.error = error instanceof Error ? error.message : String(error); break; }
      }
    }
    executions.push(execution);
    await saveAgentTask(task);

    // 结构反馈环：识别出计划声明的结构缺失时，动态追加针对性步骤（一次）。
    if (step.action === 'EXTRACT_PROCEDURE_LEGS' || step.action === 'EXTRACT_CONSTRAINTS') {
      appendCorrectiveSteps(plan, pir, steps, index, pkg);
    }
  }
  finalizeQuality(pir);
  // 跑道 fix 的坐标从已提取的跑道数据确定性补齐。放在人工编辑回填之前，
  // 这样人工值仍然优先，而自动值不会因为没人做这一步而空着。
  resolveRunwayFixes(pir);
  carryOverManualEdits(options.previousPir, pir);
  await writeArtifact(task.taskId, `procedures/${options.procedureId}/plan-executions.json`, executions);
  return { pir, executions };
}

function normalizePlanSteps(plan: RecognitionPlan, pkg: BusinessProcedurePackage) {
  type Step = { sequence: number; action: RecognitionAction; sourcePages: Array<{ documentId: string; pageNumber: number }>; appended?: boolean };
  const allPages = pkg.packagePages.map((p) => ({ documentId: p.documentId, pageNumber: p.pageNumber }));
  /**
   * 机场级参考页（跑道 AD 2.12 / 导航台 AD 2.19）无条件并进每个提取步骤。
   *
   * 它们是确定性挂到包上的共享数据，不该由规划器决定读不读——实测规划器把
   * EXTRACT_FIX_COORDINATES 只绑到航路点坐标表，跑道页虽然在包里却从没被读，
   * 于是 runwayData 为空、跑道 fix 一直 UNRESOLVED，离场起点锚不住、机场画不出来。
   * 规划器"忘了绑"不应该让一整类数据消失。
   */
  const referencePages = pkg.packagePages
    .filter((p) => p.pageRole === 'RUNWAY_DATA' || p.pageRole === 'NAVAID_DATA')
    .map((p) => ({ documentId: p.documentId, pageNumber: p.pageNumber }));
  const withReference = (pages: Array<{ documentId: string; pageNumber: number }>) => {
    const seen = new Set(pages.map((p) => `${p.documentId}:${p.pageNumber}`));
    return [...pages, ...referencePages.filter((p) => !seen.has(`${p.documentId}:${p.pageNumber}`))];
  };
  const steps: Step[] = (plan.recognitionPlan || [])
    .filter((s) => ACTION_PROMPT[s.action as RecognitionAction] || ['VALIDATE_PROCEDURE_STRUCTURE'].includes(s.action))
    .map((s) => ({ sequence: s.sequence, action: s.action as RecognitionAction, sourcePages: withReference(s.sourcePages?.length ? s.sourcePages : allPages) }));
  for (const action of BASELINE) if (!steps.some((s) => s.action === action)) steps.push({ sequence: steps.length + 1, action, sourcePages: allPages, appended: true });
  if (pkg.procedureCategory === 'APPROACH' && !steps.some((s) => s.action === 'EXTRACT_MINIMA')) steps.push({ sequence: steps.length + 1, action: 'EXTRACT_MINIMA', sourcePages: allPages, appended: true });
  const planMentionsHolding = /hold/i.test(`${plan.geometryStrategy || ''} ${plan.arinc424Strategy || ''}`) || plan.detectedStructure?.hasMissedApproach;
  if (planMentionsHolding && !steps.some((s) => s.action === 'EXTRACT_HOLDING')) steps.push({ sequence: steps.length + 1, action: 'EXTRACT_HOLDING', sourcePages: allPages, appended: true });
  // 依赖顺序：metadata → fixes → routes → legs → constraints → minima/holding
  const order: Record<string, number> = { EXTRACT_PROCEDURE_METADATA: 0, EXTRACT_FIX_COORDINATES: 1, ANALYZE_ROUTE_STRUCTURE: 2, EXTRACT_PROCEDURE_LEGS: 3, EXTRACT_CONSTRAINTS: 4, EXTRACT_MINIMA: 5, EXTRACT_HOLDING: 5, VALIDATE_PROCEDURE_STRUCTURE: 6 };
  return steps.sort((a, b) => (order[a.action] ?? 9) - (order[b.action] ?? 9) || a.sequence - b.sequence);
}

function appendCorrectiveSteps(plan: RecognitionPlan, pir: ProcedurePIR, steps: ReturnType<typeof normalizePlanSteps>, cursor: number, pkg: BusinessProcedurePackage) {
  const allPages = pkg.packagePages.map((p) => ({ documentId: p.documentId, pageNumber: p.pageNumber }));
  const upcoming = new Set(steps.slice(cursor).map((s) => s.action));
  const validations = validatePir(pir, plan);
  const planExpectsHolding = validations.some((v) => v.ruleCode === 'PLAN_CONSISTENCY' && /holding/i.test(v.message));
  if (planExpectsHolding && !upcoming.has('EXTRACT_HOLDING')) steps.push({ sequence: steps.length + 1, action: 'EXTRACT_HOLDING', sourcePages: allPages, appended: true });
  const missedMissing = validations.some((v) => (v.ruleCode === 'PLAN_CONSISTENCY' || v.ruleCode === 'APPROACH_STRUCTURE') && /missed approach/i.test(v.message));
  if (missedMissing && !upcoming.has('EXTRACT_PROCEDURE_LEGS')) steps.push({ sequence: steps.length + 1, action: 'EXTRACT_PROCEDURE_LEGS', sourcePages: allPages, appended: true });
}

async function executeAction(
  task: AgentTask,
  pkg: BusinessProcedurePackage,
  pir: ProcedurePIR,
  plan: RecognitionPlan,
  step: { sequence: number; action: RecognitionAction; sourcePages: Array<{ documentId: string; pageNumber: number }> },
  signal: AbortSignal,
  procedureId: string,
  execution: PlanStepExecution,
  toolCallsUsed: number,
): Promise<number> {
  const promptName = ACTION_PROMPT[step.action]!;
  const pages = resolvePages(task, step.sourcePages, pkg);
  let images = await pageImages(pages.slice(0, budgets.maxImagesPerCall));
  let toolResults: Array<{ name: string; arguments: unknown; result: unknown }> = [];

  for (let round = 0; round < 3; round++) {
    const { parsed, callId } = await callModel(task, promptName, {
      airport: { icao: task.airportIcao, name: task.airportName },
      procedurePackage: { packageId: pkg.packageId, procedureCategory: pkg.procedureCategory, procedureName: pkg.procedureName, runways: pkg.runways, navigationType: pkg.navigationType },
      planStep: { sequence: step.sequence, action: step.action, geometryStrategy: plan.geometryStrategy, arinc424Strategy: plan.arinc424Strategy, risks: plan.risks },
      knownPir: knownPirContext(pir, step.action),
      toolResults,
      sources: pages.map(pageForModel),
    }, images, `PLAN:${step.action}:${pkg.packageId.slice(0, 8)}#${step.sequence}`, signal, { procedureId, planAction: step.action });
    execution.modelCallIds.push(callId);

    const fragment = fragmentOf(step.action, parsed);
    mergeFragment(pir, fragment, { action: step.action, modelCallId: callId });

    const requests: any[] = parsed.needsMoreContext && Array.isArray(parsed.toolRequests) ? parsed.toolRequests.slice(0, 3) : [];
    if (!requests.length) return toolCallsUsed;
    if (toolCallsUsed + requests.length > budgets.maxToolCallsPerPackage) {
      pir.notes.push({ text: `Tool budget exhausted during ${step.action}; proceeding with partial context.`, evidence: [] });
      return toolCallsUsed;
    }
    const cropImages: Array<{ pageNo?: number; dataUrl: string }> = [];
    toolResults = [];
    for (const request of requests) {
      toolCallsUsed += 1;
      execution.toolCalls += 1;
      const outcome = await executeTool(task, request, cropImages);
      toolResults.push({ name: request.name, arguments: request.arguments, result: outcome });
    }
    images = [...images.slice(0, budgets.maxImagesPerCall - cropImages.length), ...cropImages];
  }
  return toolCallsUsed;
}

function fragmentOf(action: RecognitionAction, parsed: any): PirFragment {
  switch (action) {
    case 'EXTRACT_PROCEDURE_METADATA': return { procedure: parsed.procedure, runwayData: parsed.runwayData, sourceEvidence: parsed.sourceEvidence };
    case 'EXTRACT_FIX_COORDINATES': return { fixes: parsed.fixes, sourceEvidence: parsed.sourceEvidence };
    case 'ANALYZE_ROUTE_STRUCTURE': return { routes: parsed.routes, sourceEvidence: parsed.sourceEvidence };
    case 'EXTRACT_PROCEDURE_LEGS': return { legs: parsed.legs, sourceEvidence: parsed.sourceEvidence };
    case 'EXTRACT_CONSTRAINTS': return { legConstraints: parsed.legConstraints, sourceEvidence: parsed.sourceEvidence };
    case 'EXTRACT_MINIMA': return { minima: parsed.minima, sourceEvidence: parsed.sourceEvidence };
    case 'EXTRACT_HOLDING': return { holdings: parsed.holdings, sourceEvidence: parsed.sourceEvidence };
    default: return {};
  }
}

function knownPirContext(pir: ProcedurePIR, action: RecognitionAction) {
  // 每步只回喂需要的上下文，控制 token
  const fixes = pir.fixes.map((f) => ({ fixId: f.fixId, identifier: f.identifier, role: f.role, latitude: f.latitude, longitude: f.longitude }));
  const routes = pir.routes.map((r) => ({ routeId: r.routeId, routeType: r.routeType, identifier: r.identifier, runway: r.runway, fixSequence: (r as any).fixSequence }));
  const legs = pir.legs.map((l) => ({ legId: l.legId, routeId: l.routeId, sequence: l.sequence, pathTerminator: l.pathTerminator, fromFixId: l.fromFixId, toFixId: l.toFixId }));
  switch (action) {
    case 'EXTRACT_PROCEDURE_METADATA': return { procedure: pir.procedure };
    case 'EXTRACT_FIX_COORDINATES': return { procedure: pir.procedure, routes };
    case 'ANALYZE_ROUTE_STRUCTURE': return { procedure: pir.procedure, fixes };
    case 'EXTRACT_PROCEDURE_LEGS': return { procedure: pir.procedure, fixes, routes };
    case 'EXTRACT_CONSTRAINTS': case 'EXTRACT_HOLDING': return { procedure: pir.procedure, fixes, legs };
    case 'EXTRACT_MINIMA': return { procedure: pir.procedure };
    default: return { procedure: pir.procedure, fixes, routes, legs };
  }
}

async function executeTool(task: AgentTask, request: { name: string; arguments: any }, cropImages: Array<{ pageNo?: number; dataUrl: string }>) {
  try {
    const args = request.arguments || {};
    const page = findPage(task, args.documentId, args.pageNumber);
    switch (request.name) {
      case 'extract_text': {
        if (!page) return { error: 'Page not found.' };
        if (!args.bbox) return { text: page.nativeText.slice(0, 12000) };
        const [x1, y1, x2, y2] = fractionToPageBox(args.bbox, page);
        return { text: page.textSpans.filter((span) => intersects(span.bbox, [x1, y1, x2, y2])).map((s) => s.text).join('\n').slice(0, 12000) };
      }
      case 'search_document': {
        const needle = String(args.keyword || '').toLocaleLowerCase();
        if (!needle) return { matches: [] };
        return {
          matches: task.pages
            .filter((p) => p.nativeText.toLocaleLowerCase().includes(needle))
            .slice(0, 8)
            .map((p) => ({ documentId: p.documentId, pageNumber: p.pageNumber, snippet: snippetOf(p.nativeText, needle) })),
        };
      }
      case 'crop_page': {
        if (!page || !args.bbox) return { error: 'crop_page requires documentId, pageNumber and bbox.' };
        const dataUrl = await cropPageImage(task, page, args.bbox);
        if (!dataUrl) return { error: 'Crop failed.' };
        cropImages.push({ pageNo: page.pageNumber, dataUrl });
        return { attachedImage: true, pageNumber: page.pageNumber, bbox: args.bbox };
      }
      default: return { error: `Tool ${request.name} is not allowed.` };
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export async function cropPageImage(task: AgentTask, page: PageAsset, fractionBox: [number, number, number, number], outFile?: string): Promise<string | undefined> {
  try {
    const { createCanvas, loadImage } = await import('@napi-rs/canvas');
    const image = await loadImage(page.renderedImagePath);
    const [fx1, fy1, fx2, fy2] = fractionBox.map((v) => Math.max(0, Math.min(1, v)));
    const x = Math.floor(fx1 * image.width); const y = Math.floor(fy1 * image.height);
    const w = Math.max(8, Math.ceil((fx2 - fx1) * image.width)); const h = Math.max(8, Math.ceil((fy2 - fy1) * image.height));
    const canvas = createCanvas(w, h);
    canvas.getContext('2d').drawImage(image, x, y, w, h, 0, 0, w, h);
    const buffer = canvas.toBuffer('image/png');
    if (outFile) { await fs.mkdir(path.dirname(outFile), { recursive: true }); await fs.writeFile(outFile, buffer); return outFile; }
    return `data:image/png;base64,${buffer.toString('base64')}`;
  } catch { return undefined; }
}

/** 为带紧致 bbox 的证据生成裁剪图（字段级证据落地）。 */
export async function materializeEvidenceCrops(task: AgentTask, pir: ProcedurePIR, procedureId: string, limit = 40) {
  let produced = 0;
  for (const evidence of pir.sourceEvidence) {
    if (produced >= limit) break;
    const box = evidence.bbox;
    if (!box || evidence.imageCropPath) continue;
    const area = Math.max(0, box[2] - box[0]) * Math.max(0, box[3] - box[1]);
    if (area <= 0 || area > 0.6) continue; // 整页/超大区域不裁
    const page = findPage(task, evidence.documentId ?? undefined, evidence.pageNumber);
    if (!page) continue;
    const file = path.join(taskDir(task.taskId), 'procedures', procedureId, 'evidence', `${evidence.evidenceId.replace(/[^\w-]/g, '_')}.png`);
    const saved = await cropPageImage(task, page, box as [number, number, number, number], file);
    if (saved) { evidence.imageCropPath = saved; produced += 1; }
  }
}

function finalizeQuality(pir: ProcedurePIR) {
  const unresolved: string[] = [];
  pir.fixes.forEach((fix, i) => { if (fix.status === 'UNRESOLVED' || fix.latitude == null) unresolved.push(`fixes[${i}].coordinates(${fix.identifier})`); });
  pir.legs.forEach((leg, i) => { for (const [field, status] of Object.entries(leg.fieldStatus || {})) if (status === 'UNRESOLVED') unresolved.push(`legs[${i}].${field}`); });
  pir.quality.unresolvedFields = unresolved;
  const confidences = [...pir.fixes.map((f) => f.confidence), ...pir.legs.map((l) => l.confidence)].filter((v) => Number.isFinite(v));
  pir.quality.confidence = confidences.length ? Number((confidences.reduce((s, v) => s + v, 0) / confidences.length).toFixed(3)) : 0.5;
  pir.quality.reviewRequired = pir.quality.reviewRequired || unresolved.length > 0 || pir.conflicts.some((c) => c.status === 'OPEN');
}

/** 叠加校验发现偏差后的定向重识别：只重跑腿段提取，把偏差说明作为上下文。 */
export async function executeCorrectiveLegExtraction(
  task: AgentTask,
  pkg: BusinessProcedurePackage,
  pir: ProcedurePIR,
  plan: RecognitionPlan,
  deviationNotes: string[],
  signal: AbortSignal,
  procedureId: string,
): Promise<void> {
  const pages = pkg.packagePages.map((ref) => findPage(task, ref.documentId, ref.pageNumber)).filter((p): p is PageAsset => !!p);
  const images = await pageImages(pages.slice(0, budgets.maxImagesPerCall));
  const { parsed, callId } = await callModel(task, 'fragment-legs', {
    airport: { icao: task.airportIcao, name: task.airportName },
    procedurePackage: { packageId: pkg.packageId, procedureCategory: pkg.procedureCategory, procedureName: pkg.procedureName, runways: pkg.runways, navigationType: pkg.navigationType },
    planStep: { sequence: 99, action: 'EXTRACT_PROCEDURE_LEGS', geometryStrategy: plan.geometryStrategy, arinc424Strategy: plan.arinc424Strategy, risks: [...plan.risks, ...deviationNotes.map((n) => `CHART OVERLAY DEVIATION: ${n}`)] },
    knownPir: knownPirContext(pir, 'EXTRACT_PROCEDURE_LEGS'),
    toolResults: deviationNotes.map((note) => ({ name: 'chart_overlay_review', arguments: {}, result: { deviation: note } })),
    sources: pages.map(pageForModel),
  }, images, `PLAN:CORRECTIVE_LEGS:${pkg.packageId.slice(0, 8)}`, signal, { procedureId, planAction: 'EXTRACT_PROCEDURE_LEGS' });
  mergeFragment(pir, { legs: parsed.legs, sourceEvidence: parsed.sourceEvidence }, { action: 'EXTRACT_PROCEDURE_LEGS(CORRECTIVE)', modelCallId: callId });
}

function resolvePages(task: AgentTask, refs: Array<{ documentId: string; pageNumber: number }>, pkg: BusinessProcedurePackage): PageAsset[] {
  const resolved = refs.map((ref) => findPage(task, ref.documentId, ref.pageNumber)).filter((p): p is PageAsset => !!p);
  if (resolved.length) return resolved;
  return pkg.packagePages.map((ref) => findPage(task, ref.documentId, ref.pageNumber)).filter((p): p is PageAsset => !!p);
}
function findPage(task: AgentTask, documentId: string | undefined | null, pageNumber: number | undefined | null): PageAsset | undefined {
  if (pageNumber == null) return undefined;
  return task.pages.find((p) => (documentId ? p.documentId === documentId : true) && p.pageNumber === Number(pageNumber));
}
function pageForModel(page: PageAsset) {
  return { documentId: page.documentId, fileName: page.fileName, pageNumber: page.pageNumber, title: page.title, nativeText: page.nativeText.slice(0, 18000), summary: page.summary, quality: page.quality };
}
async function pageImages(pages: PageAsset[]) {
  return await Promise.all(pages.map(async (p) => ({ pageNo: p.pageNumber, aipPageNo: `${p.documentId}:${p.pageNumber}`, dataUrl: `data:image/png;base64,${(await fs.readFile(p.renderedImagePath)).toString('base64')}` })));
}
function fractionToPageBox(box: number[], page: PageAsset): [number, number, number, number] {
  // 支持两种输入：页面分数 [0,1] 或已是页面坐标
  const isFraction = box.every((v) => v >= 0 && v <= 1.0001);
  if (!isFraction) return box as [number, number, number, number];
  return [box[0] * page.width, box[1] * page.height, box[2] * page.width, box[3] * page.height];
}
function intersects(a: number[], b: number[]) { return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1]; }
function snippetOf(text: string, needle: string) { const i = text.toLowerCase().indexOf(needle); return text.slice(Math.max(0, i - 80), i + needle.length + 160).replace(/\s+/g, ' '); }
