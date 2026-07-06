<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import * as pdfjsLib from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';
import {
  Bot,
  Clipboard,
  Download,
  Eye,
  FileJson,
  FileText,
  Plus,
  RefreshCw,
  Trash2,
  Upload,
  Wand2,
} from 'lucide-vue-next';
import type {
  AiInputPackage,
  AiInputPage,
  AiRequestPreview,
  BuiltPromptPreview,
  ChartRole,
  EvaluationResult,
  NavigationType,
  PackageType,
  PdfPageAsset,
  ProcedureCategory,
  ProcedureGroup,
  ProcedureTask,
  SendMode,
  SendPolicy,
  SupportingInfoRef,
} from '../types/procedureTask';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const statusLabels: Record<string, string> = {
  UPLOADED: '已上传',
  PARSING: '解析中',
  PARSED: '已解析',
  GROUPED: '已分组',
  CANDIDATES_EXTRACTED: '已提取候选',
  AI_READY: '待AI识别',
  AI_RUNNING: 'AI识别中',
  AI_COMPLETED: 'AI已完成',
  ERROR: '失败',
};

const chartRoles: ChartRole[] = ['CHART', 'TABULAR_DESCRIPTION', 'WAYPOINT_COORDINATES', 'MINIMA_TABLE', 'CHART_INDEX', 'BLANK', 'SUPPORT', 'OTHER', 'UNKNOWN'];
const procedureCategories: ProcedureCategory[] = ['ARRIVAL', 'DEPARTURE', 'APPROACH', 'AERODROME', 'AIRSPACE', 'UNKNOWN'];
const groupCategories: ProcedureGroup['procedureCategory'][] = ['ARRIVAL', 'DEPARTURE', 'APPROACH', 'UNKNOWN'];
const navigationTypes: NavigationType[] = ['RNAV', 'RNP', 'RNP_AR', 'ILS', 'ILS_LOC', 'LOC', 'VOR', 'NDB', 'DME_ARC', 'RADAR', 'CONVENTIONAL', 'UNKNOWN'];
const packageTypes: PackageType[] = ['STAR', 'SID', 'APPROACH', 'OTHER'];
const sourceLabels: Record<string, string> = {
  AD_2_24_CHART_INDEX: 'AD 2.24 图件目录',
  PAGE_HEADER_RULE: '页头规则',
  TITLE_MATCH_RULE: '标题匹配',
  MANUAL: '人工',
};

const fileInput = ref<HTMLInputElement>();
const task = ref<ProcedureTask>();
const selectedPageNo = ref<number>();
const selectedGroupId = ref('');
const busy = ref(false);
const message = ref('等待上传 PDF');
const error = ref('');
const aiPreview = ref<AiRequestPreview>();
const aiInputPackage = ref<AiInputPackage>();
const aiInputBusy = ref(false);
const aiInputTab = ref<'core' | 'support' | 'summary' | 'manifest'>('support');
const evaluationBusy = ref(false);
const promptPreview = ref<BuiltPromptPreview>();
const promptPreviewOpen = ref(false);
const promptPreviewBusy = ref(false);
const promptPreviewTab = ref<'images' | 'support' | 'prompt' | 'schema' | 'manifest'>('prompt');
const pdfCanvas = ref<HTMLCanvasElement>();
const pdfFrame = ref<HTMLDivElement>();
const pdfRenderBusy = ref(false);
const pdfRenderError = ref('');
const previewZoom = ref(1);
const previewPanX = ref(0);
const previewPanY = ref(0);
const previewPanning = ref(false);
let panPointerStart = { x: 0, y: 0, panX: 0, panY: 0 };
let renderedQuality = 1;
let renderedQualityCap = Number.POSITIVE_INFINITY;
let qualityRenderTimer: number | undefined;
let pollTimer: number | undefined;
let pdfDocumentTaskId = '';
let pdfDocument: any;
let renderSerial = 0;

const previewStageStyle = computed(() => ({
  transform: `translate(${previewPanX.value}px, ${previewPanY.value}px) scale(${previewZoom.value})`,
}));

const selectedPage = computed(() => task.value?.pages.find((page) => page.pageNo === selectedPageNo.value));
const selectedGroup = computed(() => task.value?.groups.find((group) => group.groupId === selectedGroupId.value));
const taskStatusLabel = computed(() => (task.value ? statusLabels[task.value.status] || task.value.status : '未创建任务'));
const selectedGroupPages = computed(() => {
  if (!task.value || !selectedGroup.value) return [];
  const pageNos = new Set(allGroupPages(selectedGroup.value));
  return task.value.pages.filter((page) => pageNos.has(page.pageNo));
});
const hasGeoJson = computed(() => Boolean(selectedGroup.value?.geojson));
const corePageNoSet = computed(() => new Set(aiInputPackage.value?.corePages.map((page) => page.pageNo) ?? []));
const includedSupportImages = computed(() => aiInputPackage.value?.includedImages.filter((page) => !corePageNoSet.value.has(page.pageNo)) ?? []);
const supportSummaryJson = computed(() => JSON.stringify(aiInputPackage.value?.supportSummary ?? {}, null, 2));
const promptTextForCopy = computed(() => promptPreview.value ? `${promptPreview.value.systemPrompt}\n\n${promptPreview.value.userPrompt}` : '');
const promptSchemaJson = computed(() => JSON.stringify(promptPreview.value?.responseSchema ?? {}, null, 2));
const promptManifestJson = computed(() => JSON.stringify(promptPreview.value
  ? {
      promptTemplateId: promptPreview.value.promptTemplateId,
      promptTemplateName: promptPreview.value.promptTemplateName,
      promptVersion: promptPreview.value.promptVersion,
      outputSchemaName: promptPreview.value.outputSchemaName,
      outputSchemaVersion: promptPreview.value.outputSchemaVersion,
      inputImages: promptPreview.value.inputImages.map(({ pageNo, aipPageNo, role, sendMode }) => ({ pageNo, aipPageNo, role, sendMode })),
      supportSummaries: promptPreview.value.supportSummaries.map(({ title, supportType, pageNos, sendMode }) => ({ title, supportType, pageNos, sendMode })),
      excludedSupport: promptPreview.value.excludedSupport.map(({ title, supportType, pageNos, reason }) => ({ title, supportType, pageNos, reason })),
    }
  : {}, null, 2));
const aiPreviewText = computed(() => {
  if (!aiPreview.value) return '';
  const inputPackage = aiPreview.value.aiInputPackage || aiInputPackage.value;
  return JSON.stringify({
    model: aiPreview.value.model,
    procedurePackage: inputPackage
      ? {
          packageId: inputPackage.packageId,
          packageName: inputPackage.packageName,
          promptTemplate: inputPackage.promptTemplate,
          outputSchemaName: inputPackage.outputSchemaName,
        }
      : undefined,
    corePages: inputPackage?.corePages ?? aiPreview.value.inputPages,
    supportingInfoPackage: inputPackage?.supportingInfo,
    images: inputPackage?.includedImages.map(({ pageNo, role, sendMode }) => ({ pageNo, role, sendMode })),
    supportSummaries: inputPackage?.includedSummaries.map(({ supportType, pageNos, sendMode }) => ({ supportType, pageNos, sendMode })),
    excludedSupport: inputPackage?.excludedSupport.map(({ supportType, pageNos, reason }) => ({ supportType, pageNos, reason })),
    prompt: aiPreview.value.prompt,
    outputSchema: aiPreview.value.schema,
  }, null, 2);
});
const selectedGroupIndexLabel = computed(() => {
  const index = task.value?.groups.findIndex((group) => group.groupId === selectedGroupId.value) ?? -1;
  return index >= 0 ? `${index + 1} / ${task.value?.groups.length || 0}` : '-';
});
const procedureUnderstanding = computed(() => selectedGroup.value?.procedureUnderstanding);
const visionRunRecord = computed(() => selectedGroup.value?.visionRunRecord);
const recognitionEvaluation = computed(() => selectedGroup.value?.recognitionEvaluation);
const recognitionLegRows = computed(() => {
  const evidence = procedureUnderstanding.value?.sourceEvidence ?? [];
  return (procedureUnderstanding.value?.procedures ?? []).flatMap((procedure) => (procedure.legs ?? []).map((leg) => {
    const evidenceIds = Array.isArray(leg.sourceEvidenceIds) ? leg.sourceEvidenceIds : [];
    const firstEvidence = evidence.find((item) => evidenceIds.includes(String(item.id)));
    return {
      procedureName: procedure.procedureName || '-',
      sequence: leg.sequence,
      pathTerminator: leg.pathTerminator,
      fromFix: leg.fromFix,
      fixIdentifier: leg.fixIdentifier,
      courseDegMag: leg.courseDegMag,
      distanceNm: leg.distanceNm,
      turnDirection: leg.turnDirection,
      altitudeConstraint: leg.altitudeConstraint,
      speedLimitKias: leg.speedLimitKias,
      navigationSpec: leg.navigationSpec || procedure.navigationSpec,
      sourcePage: firstEvidence?.pageNo,
      confidence: leg.confidence,
      reviewRequired: leg.reviewRequired,
    };
  }));
});
const recognitionFixRows = computed(() => procedureUnderstanding.value?.fixes ?? []);
const recognitionEvidenceRows = computed(() => procedureUnderstanding.value?.sourceEvidence ?? []);

onBeforeUnmount(() => {
  stopPolling();
  if (qualityRenderTimer) window.clearTimeout(qualityRenderTimer);
  void pdfDocument?.destroy?.();
});

watch([() => task.value?.taskId, selectedPageNo], () => {
  void renderSelectedPdfPage();
});

function openFilePicker() {
  fileInput.value?.click();
}

async function onFileSelected(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  if (!file.name.toLowerCase().endsWith('.pdf')) {
    error.value = '请选择 PDF 文件';
    input.value = '';
    return;
  }

  const formData = new FormData();
  formData.append('file', file);
  busy.value = true;
  error.value = '';
  message.value = `正在上传 ${file.name}`;

  try {
    const uploaded = await requestJson<Pick<ProcedureTask, 'taskId' | 'fileName' | 'status'>>('/api/procedure-tasks/upload', {
      method: 'POST',
      body: formData,
    });
    task.value = {
      taskId: uploaded.taskId,
      fileName: uploaded.fileName,
      filePath: '',
      status: uploaded.status,
      pages: [],
      groups: [],
      createdAt: '',
      updatedAt: '',
    };
    selectedPageNo.value = undefined;
    selectedGroupId.value = '';
    aiPreview.value = undefined;
    promptPreview.value = undefined;
    message.value = 'PDF 已上传，可以开始解析';
  } catch (uploadError) {
    error.value = toErrorMessage(uploadError);
    message.value = '上传失败';
  } finally {
    busy.value = false;
    input.value = '';
  }
}

async function startParse() {
  if (!task.value) return;
  busy.value = true;
  error.value = '';
  aiPreview.value = undefined;
  promptPreview.value = undefined;
  message.value = '正在创建解析任务';

  try {
    await requestJson(`/api/procedure-tasks/${task.value.taskId}/parse`, { method: 'POST' });
    await refreshTask();
    startPolling();
  } catch (parseError) {
    error.value = toErrorMessage(parseError);
  } finally {
    busy.value = false;
  }
}

function startPolling() {
  stopPolling();
  pollTimer = window.setInterval(async () => {
    if (!task.value) return;
    await refreshTask(false);
    if (task.value.status !== 'PARSING') stopPolling();
  }, 1200);
}

function stopPolling() {
  if (pollTimer) window.clearInterval(pollTimer);
  pollTimer = undefined;
}

async function refreshTask(showBusy = true) {
  if (!task.value) return;
  if (showBusy) busy.value = true;
  try {
    const nextTask = await requestJson<ProcedureTask>(`/api/procedure-tasks/${task.value.taskId}`);
    task.value = nextTask;
    selectedGroupId.value ||= nextTask.groups[0]?.groupId || '';
    const activeGroup = nextTask.groups.find((group) => group.groupId === selectedGroupId.value) || nextTask.groups[0];
    selectedPageNo.value ??= activeGroup ? allGroupPages(activeGroup)[0] : nextTask.pages[0]?.pageNo;
    message.value = nextTask.error || `任务状态：${statusLabels[nextTask.status] || nextTask.status}`;
    await loadAiInputPackage(false);
  } catch (refreshError) {
    error.value = toErrorMessage(refreshError);
  } finally {
    if (showBusy) busy.value = false;
  }
}

async function saveSelectedPage() {
  if (!task.value || !selectedPage.value) return;
  const page = selectedPage.value;
  const payload = {
    aipPageNo: page.aipPageNo,
    chartRole: page.chartRole,
    procedureCategory: page.procedureCategory,
    navigationType: page.navigationType,
    runway: page.runway,
    chartTitle: page.chartTitle,
    procedureNames: page.procedureNames,
  };
  task.value = await requestJson<ProcedureTask>(`/api/procedure-tasks/${task.value.taskId}/pages/${page.pageNo}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  message.value = `已保存第 ${page.pageNo} 页识别结果`;
}

async function autoRegroup() {
  if (!task.value) return;
  task.value = await requestJson<ProcedureTask>(`/api/procedure-tasks/${task.value.taskId}/regroup`, { method: 'POST' });
  selectedGroupId.value = task.value.groups[0]?.groupId || '';
  selectedPageNo.value = task.value.groups[0] ? allGroupPages(task.value.groups[0])[0] : task.value.pages[0]?.pageNo;
  message.value = '已重新自动分组';
}

async function createGroup() {
  if (!task.value) return;
  const groups = cloneGroups();
  const page = selectedPage.value;
  const packageId = `pkg_manual_${Date.now()}`;
  const group: ProcedureGroup = {
    groupId: packageId,
    packageId,
    groupName: page ? `人工分组 · P${page.pageNo}` : '人工分组',
    packageName: page ? `人工程序包 · P${page.pageNo}` : '人工程序包',
    packageType: page?.procedureCategory === 'ARRIVAL' ? 'STAR' : page?.procedureCategory === 'DEPARTURE' ? 'SID' : page?.procedureCategory === 'APPROACH' ? 'APPROACH' : 'OTHER',
    procedureCategory: page && ['ARRIVAL', 'DEPARTURE', 'APPROACH'].includes(page.procedureCategory)
      ? (page.procedureCategory as ProcedureGroup['procedureCategory'])
      : 'UNKNOWN',
    navigationType: page?.navigationType || 'UNKNOWN',
    runway: page?.runway,
    chartPages: [],
    tabularPages: [],
    coordinatePages: [],
    minimaPages: [],
    textSupplementPages: [],
    supportingPages: [],
    otherPages: [],
    procedureNames: page?.procedureNames ?? [],
    source: 'MANUAL',
    confidence: 0.5,
    status: 'GROUPED',
    reviewRequired: true,
  };
  if (page) addPageNoToGroup(group, page);
  groups.push(group);
  await saveGroups(groups);
  selectedGroupId.value = group.groupId;
  selectedPageNo.value = page?.pageNo;
}

async function deleteSelectedGroup() {
  if (!selectedGroup.value) return;
  const groups = cloneGroups().filter((group) => group.groupId !== selectedGroup.value?.groupId);
  await saveGroups(groups);
  selectedGroupId.value = groups[0]?.groupId || '';
  selectedPageNo.value = groups[0] ? allGroupPages(groups[0])[0] : task.value?.pages[0]?.pageNo;
}

function exportGroupPdf() {
  if (!task.value || !selectedGroup.value) return;
  const url = `/api/procedure-tasks/${encodeURIComponent(task.value.taskId)}/groups/${encodeURIComponent(selectedGroup.value.groupId)}/pdf`;
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = '';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  message.value = `正在导出「${selectedGroup.value.packageName || selectedGroup.value.groupName}」PDF`;
}

async function saveGroupMetadata() {
  if (!selectedGroup.value) return;
  await saveGroups(cloneGroups());
  message.value = '已保存分组';
}

async function addSelectedPageToGroup() {
  if (!selectedPage.value || !selectedGroup.value) return;
  const groups = cloneGroups();
  groups.forEach((group) => removePageNoFromGroup(group, selectedPage.value!.pageNo));
  const group = groups.find((item) => item.groupId === selectedGroup.value?.groupId);
  if (!group) return;
  addPageNoToGroup(group, selectedPage.value);
  group.procedureNames = Array.from(new Set([...group.procedureNames, ...(selectedPage.value.procedureNames ?? [])]));
  await saveGroups(groups);
}

async function removeSelectedPageFromGroup() {
  if (!selectedPage.value || !selectedGroup.value) return;
  const groups = cloneGroups();
  const group = groups.find((item) => item.groupId === selectedGroup.value?.groupId);
  if (!group) return;
  removePageNoFromGroup(group, selectedPage.value.pageNo);
  await saveGroups(groups);
}

async function extractSelectedCandidates() {
  if (!task.value || !selectedGroup.value) return;
  busy.value = true;
  try {
    await requestJson(`/api/procedure-tasks/${task.value.taskId}/groups/${selectedGroup.value.groupId}/extract-candidates`, {
      method: 'POST',
    });
    await refreshTask(false);
    message.value = '候选信息已提取';
  } catch (candidateError) {
    error.value = toErrorMessage(candidateError);
  } finally {
    busy.value = false;
  }
}

async function loadAiPreview() {
  await loadPromptPreview('prompt');
}

async function loadPromptPreview(tab: typeof promptPreviewTab.value = 'prompt') {
  if (!task.value || !selectedGroup.value) return;
  promptPreviewTab.value = tab;
  promptPreviewBusy.value = true;
  promptPreviewOpen.value = true;
  try {
    promptPreview.value = await requestJson<BuiltPromptPreview>(
      `/api/procedure-tasks/${task.value.taskId}/packages/${selectedGroup.value.groupId}/prompt-preview`,
    );
    message.value = 'Prompt 预览已生成';
  } catch (previewError) {
    error.value = toErrorMessage(previewError);
  } finally {
    promptPreviewBusy.value = false;
  }
}

async function runAiRecognition() {
  if (!task.value || !selectedGroup.value) return;
  busy.value = true;
  try {
    const result = await requestJson<{ status: string }>(`/api/procedure-tasks/${task.value.taskId}/packages/${selectedGroup.value.groupId}/run-vision-recognition`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.5' }),
    });
    await refreshTask(false);
    message.value = result.status === 'AI_COMPLETED' ? 'AI 识别已完成' : `AI 识别未完成：${result.status}`;
  } catch (aiError) {
    error.value = toErrorMessage(aiError);
    message.value = `AI 识别未完成：${error.value}`;
    await refreshTask(false);
  } finally {
    busy.value = false;
  }
}

async function evaluateRecognition() {
  if (!task.value || !selectedGroup.value) return;
  evaluationBusy.value = true;
  try {
    const result = await requestJson<EvaluationResult>(
      `/api/procedure-tasks/${task.value.taskId}/packages/${selectedGroup.value.groupId}/evaluate-recognition`,
      { method: 'POST' },
    );
    selectedGroup.value.recognitionEvaluation = result;
    message.value = 'Golden Case evaluation completed';
  } catch (evaluationError) {
    error.value = toErrorMessage(evaluationError);
  } finally {
    evaluationBusy.value = false;
  }
}

async function previewGeoJson() {
  if (!task.value || !selectedGroup.value) return;
  if (!selectedGroup.value.geojson) {
    busy.value = true;
    message.value = '正在生成 GeoJSON 预览结果';
    try {
      await requestJson(`/api/procedure-tasks/${task.value.taskId}/groups/${selectedGroup.value.groupId}/run-ai`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'geojson' }),
      });
      await refreshTask(false);
    } catch (previewError) {
      error.value = toErrorMessage(previewError);
      message.value = 'GeoJSON 预览生成失败';
      busy.value = false;
      return;
    }
    busy.value = false;
  }
  window.location.href = `/procedure-geojson?taskId=${encodeURIComponent(task.value.taskId)}&groupId=${encodeURIComponent(selectedGroup.value.groupId)}`;
}

function downloadGroupGeoJson() {
  if (!selectedGroup.value?.geojson) return;
  downloadJson(selectedGroup.value.geojson, `${selectedGroup.value.groupId}.geojson`);
}

function exportTaskJson() {
  if (!task.value) return;
  downloadJson(task.value, `${task.value.taskId}.json`);
}

function selectPage(page: PdfPageAsset) {
  selectedPageNo.value = page.pageNo;
}

function selectGroup(group: ProcedureGroup) {
  selectedGroupId.value = group.groupId;
  selectedPageNo.value = allGroupPages(group)[0] || selectedPageNo.value;
  aiPreview.value = undefined;
  promptPreview.value = undefined;
  void loadAiInputPackage(false);
}

function handleSelectedGroupChanged() {
  const group = selectedGroup.value;
  if (!group) return;
  selectedPageNo.value = allGroupPages(group)[0] || selectedPageNo.value;
  aiPreview.value = undefined;
  promptPreview.value = undefined;
  void loadAiInputPackage(false);
}

async function saveGroups(groups: ProcedureGroup[]) {
  if (!task.value) return;
  task.value = await requestJson<ProcedureTask>(`/api/procedure-tasks/${task.value.taskId}/groups`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ groups }),
  });
  message.value = '分组已更新';
}

function cloneGroups() {
  return JSON.parse(JSON.stringify(task.value?.groups ?? [])) as ProcedureGroup[];
}

function addPageNoToGroup(group: ProcedureGroup, page: PdfPageAsset) {
  const target = page.chartRole === 'CHART'
    ? group.chartPages
    : page.chartRole === 'TABULAR_DESCRIPTION'
      ? group.tabularPages
      : page.chartRole === 'WAYPOINT_COORDINATES'
        ? group.coordinatePages
        : page.chartRole === 'MINIMA_TABLE'
          ? group.minimaPages
          : group.otherPages;
  if (!target.includes(page.pageNo)) target.push(page.pageNo);
}

function removePageNoFromGroup(group: ProcedureGroup, pageNo: number) {
  [group.chartPages, group.tabularPages, group.coordinatePages, group.minimaPages, group.otherPages].forEach((list) => {
    const index = list.indexOf(pageNo);
    if (index >= 0) list.splice(index, 1);
  });
}

function allGroupPages(group: ProcedureGroup) {
  return [
    ...group.chartPages,
    ...group.tabularPages,
    ...group.coordinatePages,
    ...group.minimaPages,
    ...(group.textSupplementPages ?? []),
    ...group.otherPages,
  ].sort((a, b) => a - b);
}

function pageNosText(pageNos: number[]) {
  return pageNos.length ? pageNos.join(', ') : '-';
}

function pageRangeText(pageNos: number[] | undefined) {
  if (!pageNos?.length) return '-';
  const sorted = [...pageNos].sort((a, b) => a - b);
  const ranges: string[] = [];
  let start = sorted[0];
  let previous = sorted[0];
  for (const pageNo of sorted.slice(1)) {
    if (pageNo === previous + 1) {
      previous = pageNo;
      continue;
    }
    ranges.push(start === previous ? String(start) : `${start}-${previous}`);
    start = pageNo;
    previous = pageNo;
  }
  ranges.push(start === previous ? String(start) : `${start}-${previous}`);
  return ranges.join(', ');
}

async function loadAiInputPackage(showBusy = true) {
  if (!task.value || !selectedGroup.value) {
    aiInputPackage.value = undefined;
    return;
  }
  if (showBusy) aiInputBusy.value = true;
  try {
    aiInputPackage.value = await requestJson<AiInputPackage>(
      `/api/procedure-tasks/${task.value.taskId}/packages/${selectedGroup.value.groupId}/ai-input-package`,
    );
  } catch (loadError) {
    error.value = toErrorMessage(loadError);
  } finally {
    if (showBusy) aiInputBusy.value = false;
  }
}

async function setSupportSendMode(ref: SupportingInfoRef, sendMode: SendMode) {
  if (!task.value || !selectedGroup.value) return;
  const groups = cloneGroups();
  const group = groups.find((item) => item.groupId === selectedGroup.value?.groupId);
  if (!group) return;
  group.manualOverride = true;
  group.aiInputOverrides ||= {};
  group.aiInputOverrides[ref.id] = {
    sendPolicy: manualPolicyFor(ref, sendMode),
    sendMode,
  };
  await saveGroups(groups);
  await loadAiInputPackage(false);
  aiPreview.value = undefined;
  promptPreview.value = undefined;
  message.value = 'AI 输入包发送策略已更新';
}

async function copyPrompt() {
  if (!promptPreview.value) await loadPromptPreview('prompt');
  if (!promptTextForCopy.value) return;
  await navigator.clipboard.writeText(promptTextForCopy.value);
  message.value = 'Prompt 已复制';
}

function manualPolicyFor(ref: SupportingInfoRef, sendMode: SendMode): SendPolicy {
  if (sendMode === 'NOT_SENT') return ref.sendPolicy === 'REQUIRED' ? 'OPTIONAL' : ref.sendPolicy;
  if (ref.sendPolicy === 'EXCLUDED') return 'OPTIONAL';
  return ref.sendPolicy;
}

function previewPage(pageNo: number | undefined) {
  if (!pageNo) return;
  selectedPageNo.value = pageNo;
  message.value = `正在预览 PDF ${pageNo}`;
}

function roleLabel(role: AiInputPage['role']) {
  const labels: Record<AiInputPage['role'], string> = {
    CHART: '图面页',
    TABULAR: '表格页',
    COORDINATES: '坐标页',
    MINIMA: '最低标准页',
  };
  return labels[role];
}

function policyLabel(policy: SendPolicy) {
  return policy === 'REQUIRED' ? '必送' : policy === 'OPTIONAL' ? '可选' : '排除';
}

function sendModeLabel(mode: SendMode) {
  const labels: Record<SendMode, string> = {
    SUMMARY_ONLY: '结构化摘要',
    IMAGE_ONLY: '高清截图',
    SUMMARY_AND_IMAGE: '摘要 + 截图',
    NOT_SENT: '不发送',
  };
  return labels[mode];
}

function sentLabel(ref: SupportingInfoRef) {
  if (ref.sendPolicy === 'EXCLUDED' || ref.sendMode === 'NOT_SENT') return '否';
  if (ref.sendPolicy === 'OPTIONAL') return '可选，当前发送';
  return '是';
}

function summaryLines(summary: Record<string, unknown>) {
  return flattenSummary(summary).slice(0, 12);
}

function valueText(value: unknown) {
  if (value === undefined || value === null || value === '') return '-';
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.?0+$/, '');
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return String(value);
}

function altitudeText(value: unknown) {
  if (!value || typeof value !== 'object') return '-';
  const record = value as Record<string, unknown>;
  const type = valueText(record.type);
  const altitude = record.altitudeFt ?? record.lowerFt ?? record.upperFt;
  return `${type !== '-' ? `${type} ` : ''}${valueText(altitude)}${altitude !== undefined ? ' FT' : ''}`.trim() || '-';
}

function fixIdent(fix: Record<string, unknown>) {
  return valueText(fix.identifier ?? fix.ident ?? fix.fixIdentifier ?? fix.name);
}

function evidenceText(evidence: Record<string, unknown>) {
  return valueText(evidence.rawText ?? evidence.visualDescription);
}

function scoreText(value: number | undefined) {
  return value === undefined ? '-' : `${Math.round(value * 100)}%`;
}

function flattenSummary(value: unknown, prefix = ''): string[] {
  if (value === undefined || value === null || value === '') return [];
  if (Array.isArray(value)) {
    if (!value.length) return [];
    if (value.every((item) => typeof item !== 'object' || item === null)) return [`${prefix}${value.join(', ')}`];
    return value.flatMap((item, index) => flattenSummary(item, `${prefix}${index + 1}. `));
  }
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== 'textSample')
      .flatMap(([key, item]) => flattenSummary(item, prefix ? `${prefix}${key}: ` : `${key}: `));
  }
  return [`${prefix}${String(value)}`];
}

async function downloadGroupingDebug() {
  if (!task.value) return;
  const debug = await requestJson(`/api/procedure-tasks/${task.value.taskId}/grouping-debug`);
  downloadJson(debug, `${task.value.taskId}-grouping-debug.json`);
}

function candidatePreview(group: ProcedureGroup | undefined) {
  return (group?.textCandidates ?? []).slice(0, 10);
}

function updateProcedureNames(event: Event) {
  if (!selectedGroup.value) return;
  selectedGroup.value.procedureNames = (event.target as HTMLInputElement).value
    .split('/')
    .map((item) => item.trim())
    .filter(Boolean);
}

const PDF_BASE_SCALE = 1.6;
const MAX_CANVAS_DIMENSION = 8192;
const MAX_CANVAS_PIXELS = 60_000_000;

async function renderSelectedPdfPage(options?: { quality?: number; preserveView?: boolean }) {
  const currentTask = task.value;
  const pageNo = selectedPageNo.value;
  if (!currentTask || !pageNo) return;
  if (!pdfCanvas.value) {
    await nextTick();
    if (!pdfCanvas.value) return;
  }

  const serial = ++renderSerial;
  pdfRenderBusy.value = true;
  pdfRenderError.value = '';

  try {
    const pdf = await loadPdfDocument(currentTask.taskId);
    if (serial !== renderSerial) return;
    const page = await pdf.getPage(pageNo);
    const canvas = pdfCanvas.value;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;

    const ratio = window.devicePixelRatio || 1;
    const baseViewport = page.getViewport({ scale: PDF_BASE_SCALE });
    // canvas 备份分辨率随缩放倍率提升，但受浏览器画布上限约束
    const qualityCap = Math.min(
      MAX_CANVAS_DIMENSION / (baseViewport.width * ratio),
      MAX_CANVAS_DIMENSION / (baseViewport.height * ratio),
      Math.sqrt(MAX_CANVAS_PIXELS / (baseViewport.width * baseViewport.height * ratio * ratio)),
    );
    const quality = Math.max(1, Math.min(options?.quality ?? 1, qualityCap));
    const viewport = page.getViewport({ scale: PDF_BASE_SCALE * quality });

    canvas.width = Math.floor(viewport.width * ratio);
    canvas.height = Math.floor(viewport.height * ratio);
    canvas.style.width = `${Math.floor(baseViewport.width)}px`;
    canvas.style.height = `${Math.floor(baseViewport.height)}px`;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    await page.render({ canvasContext: context, viewport }).promise;
    if (serial === renderSerial) {
      renderedQuality = quality;
      renderedQualityCap = qualityCap;
      if (!options?.preserveView) resetPreviewView();
    }
  } catch (renderError) {
    pdfRenderError.value = toErrorMessage(renderError);
  } finally {
    if (serial === renderSerial) pdfRenderBusy.value = false;
  }
}

function scheduleQualityRender() {
  if (qualityRenderTimer) window.clearTimeout(qualityRenderTimer);
  qualityRenderTimer = window.setTimeout(() => {
    qualityRenderTimer = undefined;
    const quality = Math.max(1, Math.min(previewZoom.value, renderedQualityCap));
    if (Math.abs(quality - renderedQuality) > 0.01) {
      void renderSelectedPdfPage({ quality, preserveView: true });
    }
  }, 220);
}

function resetPreviewView() {
  const frame = pdfFrame.value;
  const canvas = pdfCanvas.value;
  if (!frame || !canvas) return;
  const canvasWidth = parseFloat(canvas.style.width) || canvas.width;
  const canvasHeight = parseFloat(canvas.style.height) || canvas.height;
  if (!canvasWidth || !canvasHeight) return;
  const fit = Math.min(frame.clientWidth / canvasWidth, frame.clientHeight / canvasHeight, 1);
  previewZoom.value = fit;
  previewPanX.value = (frame.clientWidth - canvasWidth * fit) / 2;
  previewPanY.value = (frame.clientHeight - canvasHeight * fit) / 2;
  scheduleQualityRender();
}

function onPreviewWheel(event: WheelEvent) {
  const frame = pdfFrame.value;
  if (!frame) return;
  const rect = frame.getBoundingClientRect();
  const cursorX = event.clientX - rect.left;
  const cursorY = event.clientY - rect.top;
  const factor = event.deltaY < 0 ? 1.15 : 1 / 1.15;
  const nextZoom = Math.min(8, Math.max(0.1, previewZoom.value * factor));
  const applied = nextZoom / previewZoom.value;
  previewPanX.value = cursorX - applied * (cursorX - previewPanX.value);
  previewPanY.value = cursorY - applied * (cursorY - previewPanY.value);
  previewZoom.value = nextZoom;
  scheduleQualityRender();
}

function onPreviewPointerDown(event: PointerEvent) {
  if (event.button !== 0) return;
  previewPanning.value = true;
  panPointerStart = { x: event.clientX, y: event.clientY, panX: previewPanX.value, panY: previewPanY.value };
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
}

function onPreviewPointerMove(event: PointerEvent) {
  if (!previewPanning.value) return;
  previewPanX.value = panPointerStart.panX + (event.clientX - panPointerStart.x);
  previewPanY.value = panPointerStart.panY + (event.clientY - panPointerStart.y);
}

function endPreviewPan(event: PointerEvent) {
  if (!previewPanning.value) return;
  previewPanning.value = false;
  const target = event.currentTarget as HTMLElement;
  if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId);
}

async function loadPdfDocument(taskId: string) {
  if (pdfDocument && pdfDocumentTaskId === taskId) return pdfDocument;
  await pdfDocument?.destroy?.();
  pdfDocumentTaskId = taskId;
  const loadingTask = pdfjsLib.getDocument({ url: `/api/procedure-tasks/${encodeURIComponent(taskId)}/pdf` });
  pdfDocument = await loadingTask.promise;
  return pdfDocument;
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || `${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<T>;
}

function downloadJson(data: unknown, fileName: string) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

function toErrorMessage(value: unknown) {
  return value instanceof Error ? value.message : String(value);
}
</script>

<template>
  <main class="recognizer">
    <header class="topbar">
      <div class="title">
        <h1>PDF 程序识别流程</h1>
        <p>{{ task?.fileName || '上传 AIP AD PDF，按分组发给 AI，并跳转现有 GeoJSON 预览页校核。' }}</p>
      </div>
      <div class="actions">
        <input ref="fileInput" class="file-input" type="file" accept="application/pdf,.pdf" @change="onFileSelected" />
        <button type="button" class="primary" :disabled="busy" @click="openFilePicker">
          <Upload :size="16" /> 上传PDF
        </button>
        <button type="button" :disabled="!task || busy" @click="startParse">
          <FileText :size="16" /> 开始解析
        </button>
        <button type="button" :disabled="!task" @click="exportTaskJson">
          <Download :size="16" /> 导出任务数据
        </button>
        <span class="status">{{ taskStatusLabel }}</span>
      </div>
    </header>

    <div class="notice" :class="{ error: error }">
      <span>{{ error || message }}</span>
      <button v-if="task" type="button" class="ghost" @click="refreshTask()">
        <RefreshCw :size="14" /> 刷新
      </button>
    </div>

    <section class="workspace">
      <section class="column group-panel">
        <div class="column-head">
          <h2>当前分组</h2>
          <div class="mini-actions">
            <button type="button" :disabled="!task" title="重新自动分组" @click="autoRegroup">
              <Wand2 :size="15" />
            </button>
            <button type="button" :disabled="!task" title="新建分组" @click="createGroup">
              <Plus :size="15" />
            </button>
            <button type="button" :disabled="!task" title="调试 JSON" @click="downloadGroupingDebug">
              <FileJson :size="15" />
            </button>
          </div>
        </div>

        <label class="group-picker">
          分组
          <select v-model="selectedGroupId" :disabled="!task?.groups.length" @change="handleSelectedGroupChanged">
            <option v-for="group in task?.groups" :key="group.groupId" :value="group.groupId">
              {{ group.packageName || group.groupName }}
            </option>
          </select>
        </label>

        <div v-if="selectedGroup" class="editor">
          <div class="group-title">
            <h3>{{ selectedGroup.packageName || selectedGroup.groupName }}</h3>
            <span>{{ selectedGroupIndexLabel }}</span>
          </div>

          <div class="summary">
            <p>{{ selectedGroup.procedureNames.join(' / ') || selectedGroup.chartTitle || '未识别程序名' }}</p>
            <p>{{ selectedGroup.chartNo || 'chartNo?' }} · 来源：{{ sourceLabels[selectedGroup.source || ''] || selectedGroup.source || '-' }} · 置信度 {{ selectedGroup.confidence ?? '-' }}</p>
            <em>{{ selectedGroup.reviewRequired ? '需复核' : (statusLabels[selectedGroup.status] || selectedGroup.status) }}</em>
          </div>

          <div class="form-grid">
            <label>程序包名称<input v-model="selectedGroup.packageName" @input="selectedGroup.groupName = selectedGroup.packageName || selectedGroup.groupName" /></label>
            <label>程序包类型<select v-model="selectedGroup.packageType"><option v-for="type in packageTypes" :key="type">{{ type }}</option></select></label>
            <label>程序类别<select v-model="selectedGroup.procedureCategory"><option v-for="category in groupCategories" :key="category">{{ category }}</option></select></label>
            <label>导航类型<input v-model="selectedGroup.navigationType" /></label>
            <label>跑道<input v-model="selectedGroup.runway" /></label>
            <label>主图件编号<input v-model="selectedGroup.chartNo" /></label>
            <label class="wide">程序名<input :value="selectedGroup.procedureNames.join(' / ')" @input="updateProcedureNames" /></label>
          </div>

          <section class="summary">
            <h4>程序包页面</h4>
            <p>图面 P{{ pageNosText(selectedGroup.chartPages) }} · 表格 P{{ pageNosText(selectedGroup.tabularPages) }} · 坐标 P{{ pageNosText(selectedGroup.coordinatePages) }} · 最低标准 P{{ pageNosText(selectedGroup.minimaPages) }}</p>
          </section>

          <section class="ai-package">
            <div class="ai-package-head">
              <div>
                <h4>AI 输入包</h4>
                <p>本程序包发送给 AI 的核心页、辅助页、结构化摘要和发送方式。</p>
              </div>
              <span v-if="selectedGroup.manualOverride" class="tag warn">手动策略</span>
            </div>

            <div v-if="aiInputPackage" class="prompt-panel">
              <div class="manifest-grid">
                <span>当前模型</span><strong>{{ aiInputPackage.model || 'gpt-5.5' }}</strong>
                <span>当前模板</span><strong>{{ aiInputPackage.promptTemplateName || aiInputPackage.promptTemplate }} {{ aiInputPackage.promptVersion || '' }}</strong>
                <span>输出 Schema</span><strong>{{ aiInputPackage.outputSchemaName }} {{ aiInputPackage.outputSchemaVersion || '' }}</strong>
                <span>Prompt 状态</span><strong>{{ promptPreview ? '已渲染' : '待预览' }}</strong>
              </div>
              <div class="button-row compact">
                <button type="button" @click="loadPromptPreview('prompt')">
                  <FileText :size="15" /> 查看 Prompt
                </button>
                <button type="button" @click="loadPromptPreview('schema')">
                  <FileJson :size="15" /> 查看 Schema
                </button>
                <button type="button" @click="copyPrompt">
                  <Clipboard :size="15" /> 复制 Prompt
                </button>
                <button type="button" @click="loadPromptPreview('manifest')">重新选择模板</button>
                <button type="button" class="primary" @click="runAiRecognition">
                  <Bot :size="15" /> 发送 AI 识别
                </button>
              </div>
            </div>

            <div class="tab-row">
              <button type="button" :class="{ active: aiInputTab === 'core' }" @click="aiInputTab = 'core'">核心页</button>
              <button type="button" :class="{ active: aiInputTab === 'support' }" @click="aiInputTab = 'support'">辅助信息</button>
              <button type="button" :class="{ active: aiInputTab === 'summary' }" @click="aiInputTab = 'summary'">结构化摘要</button>
              <button type="button" :class="{ active: aiInputTab === 'manifest' }" @click="aiInputTab = 'manifest'">发送清单</button>
            </div>

            <p v-if="aiInputBusy" class="empty">正在加载 AI 输入包...</p>
            <p v-else-if="!aiInputPackage" class="empty">暂无 AI 输入包。解析或选择分组后会自动生成。</p>

            <div v-else-if="aiInputTab === 'core'" class="card-list">
              <article v-for="page in aiInputPackage.corePages" :key="`${page.role}-${page.pageNo}`" class="input-card">
                <div class="card-top">
                  <strong>{{ roleLabel(page.role) }}</strong>
                  <span class="tag required">发送给 AI</span>
                </div>
                <div class="meta-grid">
                  <span>PDF页：{{ page.pageNo }}</span>
                  <span>AIP页码：{{ page.aipPageNo || '-' }}</span>
                  <span>发送形式：{{ sendModeLabel(page.sendMode) }}</span>
                  <span>置信度：{{ page.confidence }}</span>
                </div>
                <p>{{ page.reason }}</p>
                <button type="button" @click="previewPage(page.pageNo)">预览页面</button>
              </article>
            </div>

            <div v-else-if="aiInputTab === 'support'" class="card-list">
              <article v-for="info in aiInputPackage.supportingInfo" :key="info.id" class="input-card">
                <div class="card-top">
                  <strong>{{ info.title }}</strong>
                  <div class="tag-row">
                    <span class="tag" :class="info.sendPolicy.toLowerCase()">{{ policyLabel(info.sendPolicy) }}</span>
                    <span class="tag">{{ sendModeLabel(info.sendMode) }}</span>
                    <span class="tag" :class="{ warn: info.reviewRequired }">{{ info.reviewRequired ? '需复核' : '已识别' }}</span>
                  </div>
                </div>
                <div class="meta-grid">
                  <span>PDF页：{{ pageRangeText(info.pageNos) }}</span>
                  <span>AIP章节：{{ info.aipSection || info.aipPageNos.join(', ') || '-' }}</span>
                  <span>发送给AI：{{ sentLabel(info) }}</span>
                  <span>置信度：{{ info.confidence }}</span>
                </div>
                <p>{{ info.reason }}</p>
                <div class="summary-lines">
                  <b>提取摘要</b>
                  <ul>
                    <li v-for="line in summaryLines(info.summary)" :key="line">{{ line }}</li>
                  </ul>
                </div>
                <div class="button-row compact">
                  <button type="button" @click="previewPage(info.pageNos[0])">预览</button>
                  <button type="button" @click="setSupportSendMode(info, 'SUMMARY_ONLY')">发送摘要</button>
                  <button type="button" @click="setSupportSendMode(info, 'SUMMARY_AND_IMAGE')">发送截图</button>
                  <button type="button" @click="setSupportSendMode(info, 'NOT_SENT')">不发送</button>
                </div>
              </article>
            </div>

            <div v-else-if="aiInputTab === 'summary'">
              <pre>{{ supportSummaryJson }}</pre>
            </div>

            <div v-else class="manifest">
              <div class="manifest-grid">
                <span>模型</span><strong>{{ aiInputPackage.model }}</strong>
                <span>程序包</span><strong>{{ aiInputPackage.packageName }}</strong>
                <span>Prompt 模板</span><strong>{{ aiInputPackage.promptTemplate }}</strong>
                <span>输出 Schema</span><strong>{{ aiInputPackage.outputSchemaName }}</strong>
                <span>OCR/TextLayer</span><strong>{{ aiInputPackage.ocrTextLayerIncluded ? '包含' : '不包含' }}</strong>
                <span>预计图片数</span><strong>{{ aiInputPackage.includedImages.length }}</strong>
              </div>
              <h4>核心页面截图</h4>
              <ul>
                <li v-for="page in aiInputPackage.corePages" :key="`manifest-core-${page.pageNo}`">
                  PDF {{ page.pageNo }} / {{ page.aipPageNo || '-' }} / {{ roleLabel(page.role) }} / {{ sendModeLabel(page.sendMode) }}
                </li>
              </ul>
              <h4>辅助截图</h4>
              <ul>
                <li v-if="!includedSupportImages.length">无</li>
                <li v-for="page in includedSupportImages" :key="`manifest-image-${page.pageNo}`">
                  PDF {{ page.pageNo }} / {{ page.aipPageNo || '-' }} / {{ sendModeLabel(page.sendMode) }}
                </li>
              </ul>
              <h4>结构化摘要</h4>
              <ul>
                <li v-for="info in aiInputPackage.includedSummaries" :key="`manifest-summary-${info.id}`">
                  PDF {{ pageRangeText(info.pageNos) }} / {{ info.title }} / {{ sendModeLabel(info.sendMode) }}
                </li>
              </ul>
              <h4>当前不发送</h4>
              <ul>
                <li v-for="info in aiInputPackage.excludedSupport" :key="`manifest-excluded-${info.id}`">
                  PDF {{ pageRangeText(info.pageNos) }} / {{ info.title }} / {{ policyLabel(info.sendPolicy) }} / {{ info.reason }}
                </li>
              </ul>
            </div>
          </section>

          <section v-if="procedureUnderstanding" class="ai-result">
            <div class="ai-package-head">
              <div>
                <h4>AI Recognition Result</h4>
                <p>ProcedureUnderstanding JSON from {{ visionRunRecord?.model || selectedGroup.aiRequest?.model || 'gpt-5.5' }}</p>
              </div>
              <button type="button" :disabled="evaluationBusy" @click="evaluateRecognition">Compare Golden Case</button>
            </div>

            <div class="manifest-grid">
              <span>Model</span><strong>{{ visionRunRecord?.model || selectedGroup.aiRequest?.model || '-' }}</strong>
              <span>Prompt</span><strong>{{ visionRunRecord?.promptTemplateId || selectedGroup.aiRequest?.promptTemplateId || '-' }} {{ visionRunRecord?.promptVersion || selectedGroup.aiRequest?.promptVersion || '' }}</strong>
              <span>Schema</span><strong>{{ visionRunRecord?.schemaName || selectedGroup.aiRequest?.schemaName || '-' }} {{ visionRunRecord?.schemaVersion || selectedGroup.aiRequest?.schemaVersion || '' }}</strong>
              <span>Confidence</span><strong>{{ valueText(procedureUnderstanding.confidence) }}</strong>
              <span>Review</span><strong>{{ valueText(procedureUnderstanding.reviewRequired) }}</strong>
              <span>Validation</span><strong>{{ visionRunRecord?.validationResult.schemaValid ? 'Schema valid' : 'Needs review' }}</strong>
            </div>

            <div v-if="procedureUnderstanding.warnings?.length" class="summary-lines">
              <b>Warnings</b>
              <ul>
                <li v-for="(warning, index) in procedureUnderstanding.warnings" :key="`ai-warning-${index}`">
                  {{ valueText(warning.message ?? warning) }}
                </li>
              </ul>
            </div>

            <div v-if="recognitionEvaluation" class="evaluation-box">
              <div class="manifest-grid">
                <span>Total Score</span><strong>{{ scoreText(recognitionEvaluation.totalScore) }}</strong>
                <span>Procedure Names</span><strong>{{ scoreText(recognitionEvaluation.procedureNameAccuracy) }}</strong>
                <span>Leg Count</span><strong>{{ scoreText(recognitionEvaluation.legCountAccuracy) }}</strong>
                <span>Path Terminators</span><strong>{{ scoreText(recognitionEvaluation.pathTerminatorAccuracy) }}</strong>
                <span>Fixes</span><strong>{{ scoreText(recognitionEvaluation.fixAccuracy) }}</strong>
                <span>Course</span><strong>{{ scoreText(recognitionEvaluation.courseAccuracy) }}</strong>
                <span>Distance</span><strong>{{ scoreText(recognitionEvaluation.distanceAccuracy) }}</strong>
                <span>Altitude</span><strong>{{ scoreText(recognitionEvaluation.altitudeAccuracy) }}</strong>
                <span>Coordinates</span><strong>{{ scoreText(recognitionEvaluation.coordinateAccuracy) }}</strong>
                <span>Evidence</span><strong>{{ scoreText(recognitionEvaluation.sourceEvidenceCoverage) }}</strong>
              </div>
              <ul v-if="recognitionEvaluation.errors.length">
                <li v-for="(item, index) in recognitionEvaluation.errors" :key="`eval-error-${index}`">
                  {{ item.code }} / {{ item.procedureName || '-' }} / {{ item.fieldName || '-' }}: {{ item.message }}
                </li>
              </ul>
            </div>

            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Procedure</th>
                    <th>Seq</th>
                    <th>PT</th>
                    <th>From</th>
                    <th>To/Fix</th>
                    <th>Course</th>
                    <th>Dist</th>
                    <th>Turn</th>
                    <th>Altitude</th>
                    <th>Speed</th>
                    <th>Nav</th>
                    <th>Page</th>
                    <th>Conf</th>
                    <th>Review</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(leg, index) in recognitionLegRows" :key="`leg-${index}`">
                    <td>{{ leg.procedureName }}</td>
                    <td>{{ valueText(leg.sequence) }}</td>
                    <td>{{ valueText(leg.pathTerminator) }}</td>
                    <td>{{ valueText(leg.fromFix) }}</td>
                    <td>{{ valueText(leg.fixIdentifier) }}</td>
                    <td>{{ valueText(leg.courseDegMag) }}</td>
                    <td>{{ valueText(leg.distanceNm) }}</td>
                    <td>{{ valueText(leg.turnDirection) }}</td>
                    <td>{{ altitudeText(leg.altitudeConstraint) }}</td>
                    <td>{{ valueText(leg.speedLimitKias) }}</td>
                    <td>{{ valueText(leg.navigationSpec) }}</td>
                    <td>{{ valueText(leg.sourcePage) }}</td>
                    <td>{{ valueText(leg.confidence) }}</td>
                    <td>{{ valueText(leg.reviewRequired) }}</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Ident</th>
                    <th>Lat</th>
                    <th>Lon</th>
                    <th>Source Page</th>
                    <th>Confidence</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(fix, index) in recognitionFixRows" :key="`fix-${index}`">
                    <td>{{ fixIdent(fix) }}</td>
                    <td>{{ valueText(fix.latitude ?? fix.lat) }}</td>
                    <td>{{ valueText(fix.longitude ?? fix.lon) }}</td>
                    <td>{{ valueText(fix.sourcePage ?? fix.pageNo) }}</td>
                    <td>{{ valueText(fix.confidence) }}</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Field</th>
                    <th>Page</th>
                    <th>Type</th>
                    <th>Raw Text / Visual</th>
                    <th>Confidence</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(evidence, index) in recognitionEvidenceRows" :key="`evidence-${index}`">
                    <td>{{ valueText(evidence.fieldName) }}</td>
                    <td>{{ valueText(evidence.pageNo) }}</td>
                    <td>{{ valueText(evidence.evidenceType) }}</td>
                    <td>{{ evidenceText(evidence) }}</td>
                    <td>{{ valueText(evidence.confidence) }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          <section class="summary">
            <h4>候选摘要</h4>
            <p>文字 {{ selectedGroup.textCandidates?.length || 0 }} · 坐标 {{ selectedGroup.waypointCandidates?.length || 0 }} · 表格 {{ selectedGroup.tableCandidates?.length || 0 }} · 几何 {{ selectedGroup.geometryCandidates?.length || 0 }}</p>
            <ul>
              <li v-for="candidate in candidatePreview(selectedGroup)" :key="candidate.id">
                P{{ candidate.pageNo }} · {{ candidate.typeCandidate }} · {{ candidate.text }}
              </li>
            </ul>
          </section>

          <div class="button-row">
            <button type="button" @click="saveGroupMetadata">保存分组</button>
            <button type="button" @click="extractSelectedCandidates">提取候选</button>
            <button type="button" @click="loadAiPreview">
              <FileJson :size="15" /> AI 请求预览
            </button>
            <button type="button" class="primary" @click="runAiRecognition">
              <Bot :size="15" /> 发送AI识别
            </button>
            <button type="button" :disabled="!selectedGroup || busy" @click="previewGeoJson">
              <Eye :size="15" /> {{ hasGeoJson ? '预览GeoJSON' : '生成并预览GeoJSON' }}
            </button>
            <button type="button" :disabled="!hasGeoJson" @click="downloadGroupGeoJson">下载GeoJSON</button>
            <button type="button" @click="exportGroupPdf">
              <Download :size="15" /> 导出PDF
            </button>
            <button type="button" class="danger" @click="deleteSelectedGroup">
              <Trash2 :size="15" /> 删除分组
            </button>
          </div>

          <details v-if="aiPreview" open>
            <summary>AI 请求预览</summary>
            <pre>{{ aiPreviewText }}</pre>
          </details>
          <div v-if="promptPreviewOpen" class="modal-backdrop" @click.self="promptPreviewOpen = false">
            <section class="prompt-modal">
              <div class="modal-head">
                <div>
                  <h3>AI 请求预览</h3>
                  <p v-if="promptPreview">{{ promptPreview.promptTemplateName || promptPreview.promptTemplateId }} · {{ promptPreview.promptVersion }}</p>
                </div>
                <button type="button" class="ghost" @click="promptPreviewOpen = false">关闭</button>
              </div>
              <div class="tab-row">
                <button type="button" :class="{ active: promptPreviewTab === 'images' }" @click="promptPreviewTab = 'images'">输入图片</button>
                <button type="button" :class="{ active: promptPreviewTab === 'support' }" @click="promptPreviewTab = 'support'">辅助摘要</button>
                <button type="button" :class="{ active: promptPreviewTab === 'prompt' }" @click="promptPreviewTab = 'prompt'">Prompt</button>
                <button type="button" :class="{ active: promptPreviewTab === 'schema' }" @click="promptPreviewTab = 'schema'">Schema</button>
                <button type="button" :class="{ active: promptPreviewTab === 'manifest' }" @click="promptPreviewTab = 'manifest'">发送清单</button>
              </div>
              <p v-if="promptPreviewBusy" class="empty">正在渲染 Prompt...</p>
              <template v-else-if="promptPreview">
                <div v-if="promptPreviewTab === 'images'" class="card-list">
                  <article v-for="page in promptPreview.inputImages" :key="`prompt-image-${page.pageNo}`" class="input-card">
                    <div class="card-top">
                      <strong>PDF {{ page.pageNo }} / {{ page.aipPageNo || '-' }}</strong>
                      <span class="tag">{{ roleLabel(page.role) }}</span>
                    </div>
                    <div class="meta-grid">
                      <span>发送形式：{{ sendModeLabel(page.sendMode) }}</span>
                      <span>置信度：{{ page.confidence }}</span>
                    </div>
                    <p>{{ page.reason }}</p>
                  </article>
                </div>
                <div v-else-if="promptPreviewTab === 'support'" class="card-list">
                  <article v-for="info in promptPreview.supportSummaries" :key="`prompt-support-${info.id}`" class="input-card">
                    <div class="card-top">
                      <strong>{{ info.title }}</strong>
                      <span class="tag">{{ sendModeLabel(info.sendMode) }}</span>
                    </div>
                    <div class="meta-grid">
                      <span>PDF页：{{ pageRangeText(info.pageNos) }}</span>
                      <span>{{ info.aipSection || info.supportType }}</span>
                    </div>
                    <p>{{ info.reason }}</p>
                  </article>
                </div>
                <div v-else-if="promptPreviewTab === 'prompt'" class="prompt-stack">
                  <h4>System Prompt</h4>
                  <pre>{{ promptPreview.systemPrompt }}</pre>
                  <h4>User Prompt</h4>
                  <pre>{{ promptPreview.userPrompt }}</pre>
                </div>
                <pre v-else-if="promptPreviewTab === 'schema'">{{ promptSchemaJson }}</pre>
                <pre v-else>{{ promptManifestJson }}</pre>
              </template>
            </section>
          </div>
          <details v-if="selectedGroup.aiResponse">
            <summary>AI 返回结果</summary>
            <pre>{{ selectedGroup.aiResponse.rawText.slice(0, 3600) }}</pre>
          </details>
        </div>

        <p v-if="!task?.groups.length" class="empty">解析后自动生成分组，也可以人工新建。</p>
      </section>

      <section class="column page-preview">
        <div class="column-head">
          <h2>PDF 页面</h2>
          <div v-if="selectedGroupPages.length" class="page-tabs">
            <button
              v-for="page in selectedGroupPages"
              :key="page.pageNo"
              type="button"
              :class="{ active: page.pageNo === selectedPageNo }"
              @click="selectPage(page)"
            >
              P{{ page.pageNo }}
            </button>
          </div>
          <span v-else>P{{ selectedPageNo || '-' }}</span>
        </div>

        <div
          ref="pdfFrame"
          class="pdf-page-frame"
          :class="{ panning: previewPanning }"
          @wheel.prevent="onPreviewWheel"
          @pointerdown="onPreviewPointerDown"
          @pointermove="onPreviewPointerMove"
          @pointerup="endPreviewPan"
          @pointercancel="endPreviewPan"
          @dblclick="resetPreviewView"
        >
          <div v-if="pdfRenderBusy" class="pdf-state">正在渲染页面...</div>
          <div v-if="pdfRenderError" class="pdf-state error">{{ pdfRenderError }}</div>
          <div class="pdf-stage" :style="previewStageStyle">
            <canvas ref="pdfCanvas" class="pdf-canvas"></canvas>
          </div>
        </div>

      </section>
    </section>
  </main>
</template>

<style scoped>
:global(*) {
  box-sizing: border-box;
}

:global(body) {
  margin: 0;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
  background: #eef2f7;
  color: #172033;
}

.recognizer {
  display: grid;
  grid-template-rows: auto auto minmax(0, 1fr);
  width: 100vw;
  height: 100vh;
  overflow: hidden;
}

.topbar,
.notice {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 16px;
  border-bottom: 1px solid #d7deea;
  background: #fff;
}

.title {
  min-width: 0;
}

h1,
h2,
h3,
h4,
p {
  margin: 0;
}

h1 {
  font-size: 20px;
}

h2 {
  font-size: 15px;
}

h3 {
  font-size: 14px;
}

h4 {
  font-size: 13px;
}

.title p,
.empty,
.notice,
.summary p {
  color: #64748b;
  font-size: 12px;
}

.actions,
.button-row,
.mini-actions,
.page-tabs {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.button-row.compact {
  gap: 6px;
}

.file-input {
  display: none;
}

button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 32px;
  border: 1px solid #cbd5e1;
  border-radius: 7px;
  background: #fff;
  color: #263548;
  padding: 0 10px;
  font-size: 12px;
  cursor: pointer;
}

button:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

button.primary {
  border-color: #2563eb;
  background: #2563eb;
  color: #fff;
}

button.danger {
  color: #b91c1c;
}

button.ghost {
  min-height: 26px;
  border: 0;
  background: transparent;
}

.status {
  border: 1px solid #bfdbfe;
  border-radius: 999px;
  background: #eff6ff;
  color: #1d4ed8;
  padding: 5px 10px;
  font-size: 12px;
  white-space: nowrap;
}

.notice {
  min-height: 42px;
  padding-block: 8px;
}

.notice.error {
  background: #fef2f2;
  color: #b91c1c;
}

.workspace {
  display: grid;
  grid-template-columns: minmax(360px, 0.7fr) minmax(560px, 1.3fr);
  gap: 1px;
  min-height: 0;
  background: #d7deea;
}

.column {
  min-width: 0;
  min-height: 0;
  overflow: auto;
  background: #f8fafc;
  padding: 12px;
}

.column-head {
  position: sticky;
  top: -12px;
  z-index: 2;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin: -12px -12px 10px;
  padding: 12px;
  border-bottom: 1px solid #e2e8f0;
  background: #f8fafc;
}

.group-picker,
.editor,
.summary {
  display: grid;
  gap: 10px;
}

.group-picker {
  margin-bottom: 12px;
}

.group-title {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.group-title span {
  color: #64748b;
  font-size: 12px;
  white-space: nowrap;
}

.editor {
  margin-bottom: 14px;
  border-bottom: 1px solid #e2e8f0;
  padding-bottom: 14px;
}

.ai-package {
  display: grid;
  gap: 10px;
  border: 1px solid #dbe3ef;
  border-radius: 7px;
  background: #fff;
  padding: 10px;
}

.ai-result {
  display: grid;
  gap: 10px;
  border: 1px solid #dbe3ef;
  border-radius: 7px;
  background: #fff;
  padding: 10px;
}

.evaluation-box {
  display: grid;
  gap: 8px;
  border: 1px solid #fde68a;
  border-radius: 7px;
  background: #fffbeb;
  padding: 9px;
}

.table-wrap {
  max-width: 100%;
  overflow: auto;
  border: 1px solid #e2e8f0;
  border-radius: 7px;
}

table {
  width: 100%;
  min-width: 760px;
  border-collapse: collapse;
  background: #fff;
  font-size: 11px;
}

th,
td {
  border-bottom: 1px solid #e2e8f0;
  padding: 6px 8px;
  text-align: left;
  vertical-align: top;
}

th {
  position: sticky;
  top: 0;
  background: #f8fafc;
  color: #334155;
  font-weight: 700;
}

td {
  color: #475569;
}

.prompt-panel {
  display: grid;
  gap: 9px;
  border: 1px solid #e2e8f0;
  border-radius: 7px;
  background: #f8fafc;
  padding: 9px;
}

.ai-package-head,
.card-top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
}

.ai-package-head p,
.input-card p {
  color: #64748b;
  font-size: 12px;
  line-height: 1.5;
}

.tab-row,
.tag-row {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.tab-row {
  border-bottom: 1px solid #e2e8f0;
  padding-bottom: 8px;
}

.tab-row button {
  min-height: 28px;
  padding: 0 9px;
}

.tab-row button.active {
  border-color: #2563eb;
  background: #eff6ff;
  color: #1d4ed8;
}

.card-list {
  display: grid;
  gap: 8px;
}

.input-card {
  display: grid;
  gap: 8px;
  border: 1px solid #e2e8f0;
  border-radius: 7px;
  background: #f8fafc;
  padding: 9px;
}

.input-card strong {
  color: #172033;
  font-size: 13px;
}

.meta-grid,
.manifest-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px 10px;
  color: #475569;
  font-size: 12px;
}

.manifest-grid {
  border: 1px solid #e2e8f0;
  border-radius: 7px;
  background: #f8fafc;
  padding: 8px;
}

.manifest-grid strong {
  color: #172033;
  font-size: 12px;
}

.summary-lines {
  display: grid;
  gap: 5px;
}

.summary-lines b {
  color: #334155;
  font-size: 12px;
}

.manifest {
  display: grid;
  gap: 9px;
}

.tag {
  display: inline-flex;
  align-items: center;
  min-height: 22px;
  border: 1px solid #cbd5e1;
  border-radius: 999px;
  background: #f8fafc;
  color: #475569;
  padding: 0 8px;
  font-size: 11px;
  white-space: nowrap;
}

.tag.required {
  border-color: #bbf7d0;
  background: #f0fdf4;
  color: #15803d;
}

.tag.optional {
  border-color: #fde68a;
  background: #fffbeb;
  color: #a16207;
}

.tag.excluded,
.tag.warn {
  border-color: #fecaca;
  background: #fef2f2;
  color: #b91c1c;
}

.form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

label {
  display: grid;
  gap: 4px;
  color: #475569;
  font-size: 12px;
}

label.wide {
  grid-column: 1 / -1;
}

input,
select {
  width: 100%;
  min-height: 32px;
  border: 1px solid #cbd5e1;
  border-radius: 7px;
  background: #fff;
  color: #172033;
  padding: 0 9px;
  font: inherit;
}

em {
  width: fit-content;
  color: #b45309;
  font-size: 11px;
  font-style: normal;
}

details {
  border: 1px solid #e2e8f0;
  border-radius: 7px;
  background: #fff;
  padding: 9px;
}

.modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 20;
  display: grid;
  place-items: center;
  background: rgb(15 23 42 / 42%);
  padding: 24px;
}

.prompt-modal {
  display: grid;
  grid-template-rows: auto auto minmax(0, 1fr);
  gap: 10px;
  width: min(980px, 96vw);
  max-height: 88vh;
  overflow: hidden;
  border: 1px solid #cbd5e1;
  border-radius: 8px;
  background: #fff;
  padding: 12px;
  box-shadow: 0 24px 60px rgb(15 23 42 / 28%);
}

.modal-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.modal-head p {
  color: #64748b;
  font-size: 12px;
}

.prompt-modal > .card-list,
.prompt-stack,
.prompt-modal > pre {
  min-height: 0;
  overflow: auto;
}

.prompt-stack {
  display: grid;
  gap: 8px;
}

summary {
  cursor: pointer;
  color: #334155;
  font-size: 12px;
  font-weight: 700;
}

pre {
  max-height: 320px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  color: #1f2937;
  font-size: 11px;
  line-height: 1.55;
}

.page-tabs {
  flex: 1;
  justify-content: flex-end;
  min-width: 0;
}

.page-tabs button.active {
  border-color: #2563eb;
  background: #eff6ff;
  color: #1d4ed8;
}

.page-preview {
  display: flex;
  flex-direction: column;
}

.pdf-page-frame {
  position: relative;
  flex: 1;
  min-height: 480px;
  overflow: hidden;
  border: 1px solid #e2e8f0;
  border-radius: 7px;
  background: #e5e7eb;
  cursor: grab;
  touch-action: none;
  user-select: none;
}

.pdf-page-frame.panning {
  cursor: grabbing;
}

.pdf-stage {
  position: absolute;
  top: 0;
  left: 0;
  transform-origin: 0 0;
  will-change: transform;
}

.pdf-canvas {
  display: block;
  background: #fff;
  box-shadow: 0 12px 28px rgb(15 23 42 / 18%);
}

.pdf-state {
  position: absolute;
  top: 12px;
  left: 12px;
  z-index: 1;
  border: 1px solid #bfdbfe;
  border-radius: 999px;
  background: #eff6ff;
  color: #1d4ed8;
  padding: 5px 10px;
  font-size: 12px;
}

.pdf-state.error {
  border-color: #fecaca;
  background: #fef2f2;
  color: #b91c1c;
}

ul {
  display: grid;
  gap: 4px;
  margin: 0;
  padding-left: 18px;
  color: #334155;
  font-size: 12px;
}

@media (max-width: 980px) {
  .recognizer {
    height: auto;
    min-height: 100vh;
    overflow: visible;
  }

  .topbar,
  .notice {
    align-items: flex-start;
    flex-direction: column;
  }

  .workspace {
    grid-template-columns: 1fr;
  }

  .column {
    max-height: none;
  }

  .form-grid {
    grid-template-columns: 1fr;
  }

  .meta-grid,
  .manifest-grid {
    grid-template-columns: 1fr;
  }
}
</style>
