<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
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
  Square,
  Trash2,
  Upload,
  Wand2,
} from 'lucide-vue-next';
import ProcedureMap from '../components/procedure/ProcedureMap.vue';
import type { LayerVisibility } from '../components/procedure/ProcedureLayerControl.vue';
import { parseProcedureGeoJson } from '../utils/procedureGeojsonParser';
import type {
  AiInputPackage,
  AiInputPage,
  BuiltPromptPreview,
  EvaluationResult,
  GeoJsonRenderMode,
  Jeppesen424CompareResponse,
  LegCompareResult,
  PackageType,
  PackageWorkflowState,
  PdfPageAsset,
  ProcedureGroup,
  ProcedureCompareResult,
  ProcedureTask,
  SendMode,
  SendPolicy,
  SimpleProcedureLeg,
  SupportingInfoRef,
} from '../types/procedureTask';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const route = useRoute();
const router = useRouter();

type StepKey = 'grouping' | 'request' | 'recognition' | 'preview' | 'jeppesen';

const steps: Array<{ key: StepKey; title: string }> = [
  { key: 'grouping', title: 'PDF 分组' },
  { key: 'request', title: 'AI 请求预览' },
  { key: 'recognition', title: 'AI 识别结果' },
  { key: 'preview', title: 'GeoJSON 预览' },
];
steps.push({ key: 'jeppesen', title: 'Jeppesen 424 对比' });
const stepKeys = steps.map((step) => step.key);

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

const packageTypes: PackageType[] = ['STAR', 'SID', 'APPROACH', 'OTHER'];
statusLabels.AI_CANCELLED = 'AI识别已停止';
const groupCategories: ProcedureGroup['procedureCategory'][] = ['ARRIVAL', 'DEPARTURE', 'APPROACH', 'UNKNOWN'];
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
const currentStep = ref<StepKey>('grouping');
const aiInputPackage = ref<AiInputPackage>();
const aiInputBusy = ref(false);
const recognitionBusy = ref(false);
const stopRecognitionBusy = ref(false);
const geojsonBusy = ref(false);
const evaluationBusy = ref(false);
const promptPreview = ref<BuiltPromptPreview>();
const promptModalOpen = ref(false);
const promptModalTab = ref<'prompt' | 'schema' | 'request'>('prompt');
const promptPreviewBusy = ref(false);
const rawJsonOpen = ref(false);
const jeppesenText = ref('');
const jeppesenCompareBusy = ref(false);
const jeppesenCompareResult = ref<Jeppesen424CompareResponse>();
const jeppesen424ExportText = ref('');
const jeppesen424ExportError = ref('');
const jeppesen424ExportBusy = ref(false);
const mapResetCounter = ref(0);
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
let restoringFromRoute = false;

const mapLayerVisibility = ref<LayerVisibility>({
  procedureTrack: true,
  procedureLeg: true,
  procedureFix: true,
  derivedFix: true,
  navaid: true,
  runway: true,
  dmeArc: true,
  radial: true,
  leadRadial: true,
  msaSector: true,
  directionArrows: true,
  tangentMarks: true,
  labels: true,
  reviewOnly: false,
});

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
const selectedGeoJsonRenderMode = computed<GeoJsonRenderMode>({
  get: () => selectedGroup.value?.geojsonRenderMode ?? 'AUTO',
  set: (mode) => {
    if (selectedGroup.value) selectedGroup.value.geojsonRenderMode = mode;
  },
});
const geojsonRenderSummary = computed(() => selectedGroup.value?.geojsonRenderSummary);

const supportingPageCount = computed(() => {
  const group = selectedGroup.value;
  if (!group) return 0;
  if (aiInputPackage.value) {
    return new Set(aiInputPackage.value.supportingInfo.flatMap((info) => info.pageNos)).size;
  }
  return group.supportingPages?.length ?? group.supportingInfoDetails?.length ?? 0;
});

const procedureUnderstanding = computed(() => selectedGroup.value?.procedureUnderstanding);
const visionRunRecord = computed(() => selectedGroup.value?.visionRunRecord);
const recognitionEvaluation = computed(() => selectedGroup.value?.recognitionEvaluation);
const llmRunStatus = computed<PackageWorkflowState['recognitionStatus']>(() => {
  if (recognitionBusy.value || selectedGroup.value?.status === 'AI_RUNNING') return 'RUNNING';
  if (selectedGroup.value?.status === 'AI_CANCELLED') return 'CANCELLED';
  if (visionRunRecord.value?.errorType || selectedGroup.value?.status === 'ERROR') return 'ERROR';
  if (procedureUnderstanding.value || selectedGroup.value?.status === 'AI_COMPLETED') return 'COMPLETED';
  return 'NOT_STARTED';
});
const canStopRecognition = computed(() => Boolean(task.value && selectedGroup.value && llmRunStatus.value === 'RUNNING'));
const recognitionClassification = computed(() => procedureUnderstanding.value?.procedureClassification);
const recognitionChartTexts = computed(() => procedureUnderstanding.value?.chartTexts ?? []);
const recognitionTableLegs = computed(() => procedureUnderstanding.value?.tableLegs ?? []);
const recognitionGeometry = computed(() => procedureUnderstanding.value?.geometrySemantics ?? []);
const recognitionSupportObjects = computed(() => procedureUnderstanding.value?.supportObjects ?? []);
const understandingJson = computed(() => JSON.stringify(procedureUnderstanding.value ?? {}, null, 2));
const supportSummaryJson = computed(() => JSON.stringify(aiInputPackage.value?.supportSummary ?? {}, null, 2));
const promptTextForCopy = computed(() => promptPreview.value ? `${promptPreview.value.systemPrompt}\n\n${promptPreview.value.userPrompt}` : '');
const promptSchemaJson = computed(() => JSON.stringify(promptPreview.value?.responseSchema ?? {}, null, 2));
const fullRequestJson = computed(() => {
  if (!promptPreview.value) return '';
  return JSON.stringify({
    model: aiInputPackage.value?.model,
    promptTemplateId: promptPreview.value.promptTemplateId,
    promptVersion: promptPreview.value.promptVersion,
    outputSchemaName: promptPreview.value.outputSchemaName,
    outputSchemaVersion: promptPreview.value.outputSchemaVersion,
    systemPrompt: promptPreview.value.systemPrompt,
    userPrompt: promptPreview.value.userPrompt,
    inputImages: promptPreview.value.inputImages.map(({ pageNo, aipPageNo, role, region, sendMode }) => ({ pageNo, aipPageNo, role, region, sendMode })),
    supportSummaries: promptPreview.value.supportSummaries.map(({ title, supportType, pageNos, sendMode }) => ({ title, supportType, pageNos, sendMode })),
    excludedSupport: promptPreview.value.excludedSupport.map(({ title, supportType, pageNos, reason }) => ({ title, supportType, pageNos, reason })),
    responseSchema: promptPreview.value.responseSchema,
  }, null, 2);
});

const classificationWarning = computed(() => {
  if (llmRunStatus.value !== 'COMPLETED') return '';
  const cls = recognitionClassification.value;
  if (!cls || !cls.packageType || !cls.navigationType || !cls.runway) {
    return 'AI 未正确判断程序类型，后续 GeoJSON 可能无效。';
  }
  if ((cls.confidence ?? 1) < 0.5) return '程序类型识别置信度过低，后续 GeoJSON 可能无效。';
  return '';
});

const effectiveNavigationType = computed(() => String(recognitionClassification.value?.navigationType || selectedGroup.value?.navigationType || '').toUpperCase());

// ---------- 关键项检查（Prompt 打磨反馈） ----------

interface KeyCheckItem {
  label: string;
  ok: boolean;
}

const isDmeArcPackage = computed(() => effectiveNavigationType.value.includes('DME'));

const isWmkjDmeArcStar = computed(() => {
  if (!isDmeArcPackage.value) return false;
  const signature = [
    selectedGroup.value?.packageName,
    selectedGroup.value?.chartTitle,
    recognitionClassification.value?.chartPurpose,
    ...(selectedGroup.value?.procedureNames ?? []),
    ...(recognitionClassification.value?.procedureNames ?? []),
  ].filter(Boolean).join(' ').toUpperCase();
  return /WMKJ|EMTUV|OMKOM|PIMOK|ADLOV|11\s*DME\s*ARC/.test(signature);
});

function hasChartText(pattern: RegExp) {
  return recognitionChartTexts.value.some((item) => pattern.test(item.text || '') || pattern.test(item.normalizedText || ''));
}

function nearDeg(value: number | null | undefined, expected: number) {
  return value !== null && value !== undefined && Math.abs(Number(value) - expected) <= 1;
}

const keyItemChecks = computed<KeyCheckItem[]>(() => {
  if (llmRunStatus.value !== 'COMPLETED' || !isDmeArcPackage.value) return [];
  const geometry = recognitionGeometry.value;
  const navOk = String(recognitionClassification.value?.navigationType || '').toUpperCase() === 'DME_ARC';
  if (isWmkjDmeArcStar.value) {
    return [
      { label: 'procedureClassification.navigationType = DME_ARC', ok: navOk },
      { label: 'chartTexts 包含 11 DME ARC', ok: hasChartText(/11\s*DME\s*ARC/i) },
      { label: 'chartTexts 包含 VJB', ok: hasChartText(/\bVJB\b/i) },
      { label: 'chartTexts 包含 RDL340 / 160', ok: hasChartText(/RDL[-\s]*340/i) },
      { label: 'chartTexts 包含 L-R332', ok: hasChartText(/L-?R\s*332/i) },
      { label: 'chartTexts 包含 L-R348', ok: hasChartText(/L-?R\s*348/i) },
      {
        label: 'geometrySemantics 包含 DME_ARC center=VJB radius=11',
        ok: geometry.some((item) => item.type === 'DME_ARC' && String(item.centerNavaid || '').toUpperCase() === 'VJB' && nearDeg(item.radiusNm, 11)),
      },
      {
        label: 'geometrySemantics 包含 RADIAL radialDeg=340 inboundTrackDeg=160',
        ok: geometry.some((item) => item.type === 'RADIAL' && nearDeg(item.radialDeg, 340) && nearDeg(item.inboundTrackDeg, 160)),
      },
      {
        label: 'geometrySemantics 包含 LEAD_RADIAL radialDeg=332',
        ok: geometry.some((item) => item.type === 'LEAD_RADIAL' && nearDeg(item.radialDeg, 332)),
      },
      {
        label: 'geometrySemantics 包含 LEAD_RADIAL radialDeg=348',
        ok: geometry.some((item) => item.type === 'LEAD_RADIAL' && nearDeg(item.radialDeg, 348)),
      },
      {
        label: 'chartTexts 包含各入弧径向线标签 RDL016/114/236/275/295',
        ok: [16, 114, 236, 275, 295].every((deg) => hasChartText(new RegExp(`RDL[-\\s]*${String(deg).padStart(3, '0')}`, 'i'))),
      },
      {
        label: 'geometrySemantics 包含入弧径向线 RADIAL 016/114/236/275/295',
        ok: [16, 114, 236, 275, 295].every((deg) => geometry.some((item) => item.type === 'RADIAL' && nearDeg(item.radialDeg, deg))),
      },
      {
        label: 'procedures 每个 1G 程序均有模型编码的腿段（tableLegs 来源，含 AF 弧腿）',
        ok: (procedureUnderstanding.value?.procedures ?? []).length > 0
          && (procedureUnderstanding.value?.procedures ?? []).every((procedure) => {
            const legs = (procedure.legs ?? []).filter((leg) => !isSynthesizedLeg(leg as Record<string, unknown>));
            return legs.length >= 4 && legs.some((leg) => String((leg as Record<string, unknown>).pathTerminator ?? '').toUpperCase() === 'AF');
          }),
      },
    ];
  }
  return [
    { label: 'procedureClassification.navigationType = DME_ARC', ok: navOk },
    { label: 'chartTexts 包含 DME ARC 标签', ok: hasChartText(/\d+\s*DME\s*ARC/i) },
    { label: 'chartTexts 包含 RDL 径向标签', ok: hasChartText(/RDL[-\s]*\d{2,3}/i) },
    { label: 'chartTexts 包含 L-R 提前转弯径向', ok: hasChartText(/L-?R\s*\d{2,3}/i) },
    { label: 'geometrySemantics 包含 DME_ARC（含 center 与 radius）', ok: geometry.some((item) => item.type === 'DME_ARC' && Boolean(item.centerNavaid) && item.radiusNm != null) },
    { label: 'geometrySemantics 包含 RADIAL', ok: geometry.some((item) => item.type === 'RADIAL' && item.radialDeg != null) },
    { label: 'geometrySemantics 包含 LEAD_RADIAL', ok: geometry.some((item) => item.type === 'LEAD_RADIAL') },
  ];
});

const failedKeyChecks = computed(() => keyItemChecks.value.filter((item) => !item.ok));

// 几何合成兜底只保证 GeoJSON/424 产物可用，不代表模型识别达标——必须显式亮牌
function isSynthesizedLeg(leg: Record<string, unknown>) {
  return String(leg.derivationMethod ?? '').startsWith('synthesized');
}

const legFallbackActive = computed(() =>
  (procedureUnderstanding.value?.procedures ?? []).some(
    (procedure) => (procedure.legs ?? []).some((leg) => isSynthesizedLeg(leg as Record<string, unknown>)),
  ),
);

const keyErrorChecks = computed(() => {
  if (llmRunStatus.value !== 'COMPLETED' || !isWmkjDmeArcStar.value) return [];
  const errors: string[] = [];
  const usedIdents = new Set(
    recognitionSupportObjects.value
      .filter((item) => item.usedInProcedure === true)
      .map((item) => item.ident.toUpperCase()),
  );
  if (usedIdents.has('JR')) errors.push('supportObjects 中 JR usedInProcedure=true：辅助 NDB 被误加入当前程序。');
  if (usedIdents.has('IJB')) errors.push('supportObjects 中 IJB usedInProcedure=true：ILS/LOC 对象被误加入 DME ARC STAR。');
  return errors;
});

const geometryMissing = computed(() => llmRunStatus.value === 'COMPLETED' && !recognitionGeometry.value.length);
const supportLeakObjects = computed(() => recognitionSupportObjects.value.filter((item) => item.supportOnly === true && item.usedInProcedure === true));

const recognitionSummary = computed<PackageWorkflowState['recognitionSummary']>(() => {
  const understanding = procedureUnderstanding.value;
  if (!understanding) return undefined;
  return {
    procedureCount: recognitionClassification.value?.procedureNames?.length || understanding.procedures?.length || 0,
    chartTextCount: recognitionChartTexts.value.length,
    tableLegCount: recognitionTableLegs.value.length,
    geometrySemanticCount: recognitionGeometry.value.length,
    warningCount:
      (understanding.warnings?.length || 0)
      + (classificationWarning.value ? 1 : 0)
      + failedKeyChecks.value.length
      + keyErrorChecks.value.length
      + (geometryMissing.value ? 1 : 0)
      + (supportLeakObjects.value.length ? 1 : 0),
  };
});

const geojsonFeatures = computed(() => selectedGroup.value?.geojson?.features ?? []);
const geojsonStats = computed<PackageWorkflowState['geojsonSummary']>(() => {
  const features = geojsonFeatures.value;
  let pointCount = 0;
  let lineStringCount = 0;
  let polygonCount = 0;
  let nullGeometryCount = 0;
  for (const feature of features) {
    const type = feature.geometry?.type;
    if (!type) nullGeometryCount += 1;
    else if (type.includes('Point')) pointCount += 1;
    else if (type.includes('LineString')) lineStringCount += 1;
    else if (type.includes('Polygon')) polygonCount += 1;
  }
  return {
    featureCount: features.length,
    renderableCount: features.length - nullGeometryCount,
    pointCount,
    lineStringCount,
    polygonCount,
    nullGeometryCount,
  };
});

const MAIN_OBJECT_TYPES = [
  'Navaid',
  'Runway',
  'ProcedureFix',
  'ProcedureLeg',
  'ProcedureTrack',
  'DMEReferenceCircle',
  'RadialReference',
  'LeadRadial',
  'LabelPoint',
  'SourceEvidence',
];

const objectTypeStats = computed(() => {
  const counts = new Map<string, number>();
  for (const feature of geojsonFeatures.value) {
    const type = String((feature.properties as Record<string, unknown> | null)?.object_type || 'Unknown');
    counts.set(type, (counts.get(type) || 0) + 1);
  }
  const rows = MAIN_OBJECT_TYPES
    .map((type) => ({ type, count: counts.get(type) || 0 }))
    .filter((row) => row.count > 0);
  const otherCount = [...counts.entries()]
    .filter(([type]) => !MAIN_OBJECT_TYPES.includes(type))
    .reduce((sum, [, count]) => sum + count, 0);
  if (otherCount) rows.push({ type: '其他', count: otherCount });
  return rows;
});

const geojsonModel = computed(() => {
  const geojson = selectedGroup.value?.geojson;
  return geojson ? parseProcedureGeoJson(geojson) : undefined;
});

const geojsonDisplayStatus = computed<PackageWorkflowState['geojsonStatus']>(() => {
  if (geojsonBusy.value || selectedGroup.value?.geojsonStatus === 'GENERATING') return 'GENERATING';
  if (selectedGroup.value?.geojsonStatus === 'ERROR') return 'ERROR';
  if (selectedGroup.value?.geojson) {
    return geojsonStats.value?.renderableCount ? 'GENERATED' : 'GENERATED_WITHOUT_GEOMETRY';
  }
  return 'NOT_GENERATED';
});

const geojsonIssues = computed(() => {
  if (!selectedGroup.value?.geojson) return [];
  const issues: string[] = [];
  const stats = geojsonStats.value;
  if (stats && !stats.lineStringCount) {
    issues.push('未生成程序航迹线。请返回 AI 识别结果，检查 geometrySemantics 是否包含 DME_ARC / RADIAL / PROCEDURE_TRACK。');
  }
  const excludedIdents = new Set(
    recognitionSupportObjects.value
      .filter((item) => item.usedInProcedure === false)
      .map((item) => item.ident.toUpperCase()),
  );
  const leakedIdents = geojsonFeatures.value
    .filter((feature) => {
      const props = feature.properties as Record<string, unknown> | null;
      if (props?.object_type !== 'Navaid') return false;
      const ident = String(props.ident ?? props.identifier ?? props.name ?? '').toUpperCase();
      return ident && excludedIdents.has(ident);
    })
    .map((feature) => String((feature.properties as Record<string, unknown>).ident ?? (feature.properties as Record<string, unknown>).identifier ?? (feature.properties as Record<string, unknown>).name));
  if (leakedIdents.length) {
    issues.push(`疑似辅助导航台（${[...new Set(leakedIdents)].join(' / ')}）被错误渲染，请检查 Step 3 的辅助对象过滤。`);
  }
  const hasDmeSemantics = recognitionGeometry.value.some((item) => String(item.type || '').toUpperCase().includes('DME'));
  const hasDmeFeature = geojsonFeatures.value.some((feature) => {
    const type = String((feature.properties as Record<string, unknown> | null)?.object_type || '');
    return type === 'DMEReferenceCircle' || type === 'DMEArc';
  });
  if ((effectiveNavigationType.value.includes('DME') || hasDmeSemantics) && !hasDmeFeature) {
    issues.push('未生成 DME ARC 参考圆，请检查 Step 3 是否识别出 DME_ARC（如 center=VJB radius=11）。');
  }
  return issues;
});

const stepDone = computed<Record<StepKey, boolean>>(() => ({
  grouping: Boolean(task.value?.groups.length && selectedGroup.value),
  request: Boolean(aiInputPackage.value),
  recognition: llmRunStatus.value === 'COMPLETED',
  preview: Boolean(selectedGroup.value?.geojson),
  jeppesen: Boolean(jeppesenCompareResult.value),
}));

const groupingSummaryText = computed(() => {
  if (!task.value?.groups.length) return '';
  const name = selectedGroup.value?.packageName || selectedGroup.value?.groupName || '-';
  return `已识别 ${task.value.groups.length} 个程序包，当前选择 ${name}。`;
});

const requestSummaryText = computed(() => {
  const pkg = aiInputPackage.value;
  if (!pkg) return '';
  return `将发送 ${pkg.includedImages.length} 张图片、${pkg.includedSummaries.length} 类辅助摘要，模板 ${pkg.promptTemplate}。`;
});

const recognitionSummaryText = computed(() => {
  if (llmRunStatus.value === 'ERROR') return `AI 识别失败：${visionRunRecord.value?.errorMessage || '请查看 Step 3 详情'}`;
  const summary = recognitionSummary.value;
  if (!summary) return '';
  const warningText = summary.warningCount ? `，${summary.warningCount} 条警告` : '';
  return `识别出 ${summary.procedureCount} 个程序、${summary.chartTextCount} 条关键文本、${summary.geometrySemanticCount} 个几何语义${warningText}。`;
});

const geojsonSummaryText = computed(() => {
  const stats = geojsonStats.value;
  if (!selectedGroup.value?.geojson || !stats) return '';
  return `生成 ${stats.featureCount} 个 Feature，其中 LineString ${stats.lineStringCount}，Point ${stats.pointCount}，Polygon ${stats.polygonCount}。`;
});

const jeppesenProcedureFilter = computed(() => {
  return selectedGroup.value?.procedureNames?.length ? selectedGroup.value.procedureNames : [];
});

const jeppesenSummaryText = computed(() => {
  const summary = jeppesenCompareResult.value?.summary;
  if (!summary) return '';
  return `overall ${compareScoreText(summary.overallScore)}, match ${summary.matchedLegs}, partial ${summary.partialLegs}, total ${summary.totalLegs}`;
});

const stepSummaries = computed(() => [
  { key: 'grouping', label: 'PDF 分组', text: groupingSummaryText.value },
  { key: 'request', label: 'AI 请求', text: requestSummaryText.value },
  { key: 'recognition', label: 'AI 识别', text: recognitionSummaryText.value },
  { key: 'preview', label: 'GeoJSON', text: geojsonSummaryText.value },
  { key: 'jeppesen', label: 'Jeppesen 424', text: jeppesenSummaryText.value },
].filter((item) => item.text));

function stepState(key: StepKey) {
  if (currentStep.value === key) return 'current';
  return stepDone.value[key] ? 'done' : 'todo';
}

function stepStateLabel(key: StepKey) {
  const state = stepState(key);
  return state === 'current' ? '当前' : state === 'done' ? '已完成' : '待处理';
}

function goToStep(step: StepKey) {
  currentStep.value = step;
  if (task.value) replaceRecognizerRoute(task.value.taskId, selectedGroup.value?.packageId || selectedGroupId.value || undefined);
}

onBeforeUnmount(() => {
  stopPolling();
  if (qualityRenderTimer) window.clearTimeout(qualityRenderTimer);
  void pdfDocument?.destroy?.();
});

onMounted(() => {
  void restoreFromRoute();
});

watch([() => task.value?.taskId, selectedPageNo, currentStep], () => {
  if (currentStep.value !== 'grouping') return;
  void nextTick(() => renderSelectedPdfPage());
});

watch(
  () => [route.query.taskId, route.query.packageId],
  () => {
    void restoreFromRoute();
  },
);

watch(
  () => route.query.step,
  () => {
    readStepFromRoute();
  },
);

function readStepFromRoute() {
  const step = queryString(route.query.step) as StepKey;
  if (stepKeys.includes(step)) currentStep.value = step;
}

async function restoreFromRoute() {
  if (restoringFromRoute) return;
  const taskId = queryString(route.query.taskId);
  const packageId = queryString(route.query.packageId);
  readStepFromRoute();
  if (!taskId) {
    task.value = undefined;
    selectedGroupId.value = '';
    selectedPageNo.value = undefined;
    aiInputPackage.value = undefined;
    promptPreview.value = undefined;
    message.value = '等待上传 PDF';
    return;
  }
  if (task.value?.taskId === taskId && !packageId && selectedGroupId.value) {
    replaceRecognizerRoute(taskId, selectedGroupId.value);
    return;
  }
  if (task.value?.taskId === taskId && packageId && selectedGroupId.value === packageId) return;

  restoringFromRoute = true;
  busy.value = true;
  error.value = '';
  try {
    await loadTaskById(taskId, packageId || undefined, false);
  } catch (restoreError) {
    task.value = undefined;
    selectedGroupId.value = '';
    selectedPageNo.value = undefined;
    aiInputPackage.value = undefined;
    promptPreview.value = undefined;
    error.value = '任务不存在或已过期';
    message.value = toErrorMessage(restoreError);
  } finally {
    busy.value = false;
    restoringFromRoute = false;
  }
}

async function loadTaskById(taskId: string, packageId?: string, updateUrl = true) {
  const nextTask = await requestJson<ProcedureTask>(`/api/procedure-tasks/${encodeURIComponent(taskId)}`);
  task.value = nextTask;
  const activeGroup = selectRestoredGroup(nextTask, packageId);
  selectedGroupId.value = activeGroup?.groupId || '';
  selectedPageNo.value = activeGroup ? allGroupPages(activeGroup)[0] : nextTask.pages[0]?.pageNo;
  message.value = nextTask.error || `任务状态：${statusLabels[nextTask.status] || nextTask.status}`;
  await loadAiInputPackage(false);
  if (updateUrl) replaceRecognizerRoute(nextTask.taskId, selectedGroupId.value || undefined);
  else if (activeGroup && (!packageId || activeGroup.groupId !== packageId)) replaceRecognizerRoute(nextTask.taskId, activeGroup.packageId || activeGroup.groupId);
}

function selectRestoredGroup(nextTask: ProcedureTask, packageId?: string) {
  return nextTask.groups.find((group) => group.groupId === packageId || group.packageId === packageId) || nextTask.groups[0];
}

function replaceRecognizerRoute(taskId: string, packageId?: string) {
  router.replace({
    path: '/pdf-procedure-recognizer',
    query: {
      taskId,
      ...(packageId ? { packageId } : {}),
      step: currentStep.value,
    },
  });
}

function queryString(value: unknown) {
  return Array.isArray(value) ? String(value[0] || '') : String(value || '');
}

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
    currentStep.value = 'grouping';
    replaceRecognizerRoute(uploaded.taskId);
    selectedPageNo.value = undefined;
    selectedGroupId.value = '';
    aiInputPackage.value = undefined;
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
    const activeGroup = nextTask.groups.find((group) => group.groupId === selectedGroupId.value || group.packageId === selectedGroupId.value) || nextTask.groups[0];
    selectedGroupId.value = activeGroup?.groupId || '';
    selectedPageNo.value ??= activeGroup ? allGroupPages(activeGroup)[0] : nextTask.pages[0]?.pageNo;
    message.value = nextTask.error || `任务状态：${statusLabels[nextTask.status] || nextTask.status}`;
    await loadAiInputPackage(false);
    replaceRecognizerRoute(nextTask.taskId, selectedGroupId.value || undefined);
  } catch (refreshError) {
    error.value = toErrorMessage(refreshError);
  } finally {
    if (showBusy) busy.value = false;
  }
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
  if (task.value) replaceRecognizerRoute(task.value.taskId, group.groupId);
}

async function deleteSelectedGroup() {
  if (!selectedGroup.value) return;
  const groups = cloneGroups().filter((group) => group.groupId !== selectedGroup.value?.groupId);
  await saveGroups(groups);
  selectedGroupId.value = groups[0]?.groupId || '';
  selectedPageNo.value = groups[0] ? allGroupPages(groups[0])[0] : task.value?.pages[0]?.pageNo;
  if (task.value) replaceRecognizerRoute(task.value.taskId, selectedGroupId.value || undefined);
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

async function openPromptModal(tab: typeof promptModalTab.value = 'prompt') {
  if (!task.value || !selectedGroup.value) return;
  promptModalTab.value = tab;
  promptModalOpen.value = true;
  if (promptPreview.value) return;
  await loadPromptPreview();
}

async function loadPromptPreview() {
  if (!task.value || !selectedGroup.value) return;
  promptPreviewBusy.value = true;
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

async function sendRecognition() {
  if (!task.value || !selectedGroup.value) return;
  goToStep('recognition');
  recognitionBusy.value = true;
  error.value = '';
  message.value = '正在调用 AI 识别';
  try {
    const result = await requestJson<{ status: string }>(`/api/procedure-tasks/${task.value.taskId}/packages/${selectedGroup.value.groupId}/run-vision-recognition`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    await refreshTask(false);
    message.value = result.status === 'AI_COMPLETED' ? 'AI 识别已完成' : `AI 识别未完成：${result.status}`;
  } catch (aiError) {
    error.value = toErrorMessage(aiError);
    message.value = `AI 识别未完成：${error.value}`;
    await refreshTask(false);
  } finally {
    recognitionBusy.value = false;
  }
}

// 识别问题标记：保存到任务记录，用于后续 Prompt 打磨
async function stopRecognition() {
  if (!task.value || !selectedGroup.value) return;
  stopRecognitionBusy.value = true;
  error.value = '';
  try {
    await requestJson<{ status: string }>(
      `/api/procedure-tasks/${task.value.taskId}/packages/${selectedGroup.value.groupId}/cancel-recognition`,
      { method: 'POST' },
    );
    recognitionBusy.value = false;
    await refreshTask(false);
    message.value = 'AI 识别已停止';
  } catch (stopError) {
    error.value = toErrorMessage(stopError);
  } finally {
    stopRecognitionBusy.value = false;
  }
}

const ISSUE_TAGS = [
  '程序类型错误',
  '图面文本漏识别',
  '表格腿段漏识别',
  '几何语义漏识别',
  '辅助对象误加入',
  '输出格式错误',
];
const issueTagBusy = ref(false);

async function toggleIssueTag(tag: string) {
  if (!task.value || !selectedGroup.value) return;
  issueTagBusy.value = true;
  try {
    const groups = cloneGroups();
    const group = groups.find((item) => item.groupId === selectedGroup.value?.groupId);
    if (!group) return;
    const tags = new Set(group.recognitionIssueTags ?? []);
    if (tags.has(tag)) tags.delete(tag);
    else tags.add(tag);
    group.recognitionIssueTags = [...tags];
    await saveGroups(groups);
    message.value = '识别问题标记已保存到任务记录';
  } catch (tagError) {
    error.value = toErrorMessage(tagError);
  } finally {
    issueTagBusy.value = false;
  }
}

async function retestPrompt() {
  promptPreview.value = undefined;
  await loadPromptPreview();
  if (!promptPreview.value) return;
  await sendRecognition();
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
    message.value = 'Golden Case 评测已完成';
  } catch (evaluationError) {
    error.value = toErrorMessage(evaluationError);
  } finally {
    evaluationBusy.value = false;
  }
}

async function compareJeppesen424() {
  if (!task.value || !selectedGroup.value) return;
  jeppesenCompareBusy.value = true;
  error.value = '';
  try {
    const compareResult = await requestJson<Jeppesen424CompareResponse>(
      `/api/procedure-tasks/${task.value.taskId}/packages/${selectedGroup.value.groupId}/jeppesen424/compare`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: jeppesenText.value,
          procedureFilter: jeppesenProcedureFilter.value,
          runway: selectedGroup.value.runway || procedureUnderstanding.value?.runway || 'RW16',
        }),
      },
    );
    jeppesenCompareResult.value = compareResult;
    if (compareResult.renderSource) {
      selectedGroup.value.jeppesen424Source = {
        text: jeppesenText.value,
        parsedLegs: compareResult.parsedJeppesenLegs,
        importedAt: compareResult.renderSource.importedAt,
        procedureCount: compareResult.renderSource.procedureCount,
        legCount: compareResult.renderSource.legCount,
      };
      selectedGroup.value.geojsonRenderMode = 'AUTO';
      selectedGroup.value.geojson = undefined;
      selectedGroup.value.geojsonStatus = 'NOT_GENERATED';
      selectedGroup.value.geojsonRenderSummary = undefined;
    }
    message.value = 'Jeppesen 424 compare completed';
  } catch (compareError) {
    error.value = toErrorMessage(compareError);
  } finally {
    jeppesenCompareBusy.value = false;
  }
}

// ---------- 对比分析结果（供 AI 完善提示词的结构化报告） ----------

const jeppesenAnalysisText = computed(() => {
  const result = jeppesenCompareResult.value;
  const group = selectedGroup.value;
  if (!result || !group) return '';

  const missingAi: string[] = [];
  const missingJeppesen: string[] = [];
  const fieldDiffs = new Map<string, string[]>();
  for (const procedure of result.procedureResults) {
    for (const leg of procedure.legResults) {
      if (leg.status === 'MISSING_AI') {
        missingAi.push(`  - ${procedure.procedureName} seq${leg.sequence}: ${analysisLegSummary(leg.jeppesen)}`);
      } else if (leg.status === 'MISSING_JEPPESEN') {
        missingJeppesen.push(`  - ${procedure.procedureName} seq${leg.sequence}: ${analysisLegSummary(leg.ai)}`);
      } else {
        for (const field of leg.fieldResults.filter((item) => !item.matched)) {
          const list = fieldDiffs.get(field.field) ?? [];
          list.push(`  - ${procedure.procedureName} seq${leg.sequence} ${leg.ai?.fix || leg.jeppesen?.fix || ''}: AI=${analysisValue(field.aiValue)} / 424=${analysisValue(field.jeppesenValue)}`);
          fieldDiffs.set(field.field, list);
        }
      }
    }
  }

  const s = result.summary;
  const lines: string[] = [
    '# Jeppesen 424 对比分析报告',
    `- 程序包: ${group.packageName || group.groupName}`,
    `- Prompt: ${visionRunRecord.value?.promptTemplateId ?? '-'} v${visionRunRecord.value?.promptVersion ?? '-'} | 模型: ${visionRunRecord.value?.model ?? '-'}`,
    `- 腿段来源: ${legFallbackActive.value ? '几何合成兜底（模型未输出 tableLegs，高度缺失为预期）' : '模型 tableLegs'}`,
    `- 报告时间: ${new Date().toISOString()}`,
    `- 总体匹配率 ${s.overallScore}% | 程序 ${s.matchedProcedures}/${s.totalProcedures} | 完全匹配腿段 ${s.matchedLegs}/${s.totalLegs} | 部分匹配 ${s.partialLegs} | 不匹配 ${s.mismatchedLegs} | AI缺失 ${s.missingAiLegs} | AI多出 ${s.missingJeppesenLegs} | 字段差异 ${s.fieldMismatchCount}`,
    '',
    `## AI 缺失的腿段（424 有、AI 无）: ${missingAi.length}`,
    ...(missingAi.length ? missingAi : ['  - 无']),
    '',
    `## AI 多出的腿段（AI 有、424 无）: ${missingJeppesen.length}`,
    ...(missingJeppesen.length ? missingJeppesen : ['  - 无']),
    '',
    '## 字段差异（按字段归类）',
  ];
  if (!fieldDiffs.size) lines.push('  - 无');
  for (const [field, items] of fieldDiffs) {
    lines.push(`- ${field}: ${items.length} 处`, ...items);
  }
  lines.push('', '## 每程序得分');
  for (const procedure of result.procedureResults) {
    lines.push(`- ${procedure.procedureName} (${procedure.runway}): ${procedure.score}%（完全匹配 ${procedure.matchedLegs}/${procedure.totalLegs}，部分匹配 ${procedure.partialLegs}，不匹配 ${procedure.mismatchedLegs}）`);
  }
  return lines.join('\n');
});

function analysisValue(value: unknown) {
  if (value === undefined || value === null || value === '') return '(空)';
  return String(value);
}

// 缺失腿段的完整字段快照（覆盖全部对比字段），供报告读者判断缺的是什么类型的腿
function analysisLegSummary(leg?: SimpleProcedureLeg) {
  if (!leg) return '(无数据)';
  const fix = leg.fix ? leg.fix : '(无Fix，可能为CI腿)';
  const parts = [
    `fix=${fix}`,
    `PT=${analysisValue(leg.pathTerminator)}`,
    `turn=${analysisValue(leg.turnDirection)}`,
    `dist=${analysisValue(leg.distanceNm)}`,
    `crs=${analysisValue(leg.courseDegMag)}`,
    `alt=${analysisValue(leg.altitudeRaw)}`,
    `alt2=${analysisValue(leg.altitudeUpperFt)}`,
    `nav=${analysisValue(leg.recommendedNavaid)}`,
    `spd=${analysisValue(leg.speedLimitKias)}`,
    `标记=${legMarkers(leg)}`,
  ];
  return parts.join(' ');
}

async function copyJeppesenAnalysis() {
  if (!jeppesenAnalysisText.value) return;
  await navigator.clipboard.writeText(jeppesenAnalysisText.value);
  message.value = '对比分析结果已复制';
}

function statusClass(status: string) {
  return status.toLowerCase().replace(/_/g, '-');
}

// 汇总 424 扩展标记：Fix section（EA/PC）、等待（H）、末段腿（EE）
function legMarkers(leg?: SimpleProcedureLeg) {
  if (!leg) return '-';
  const markers = [leg.fixSection, leg.holdingAtFix ? 'H' : '', leg.endOfProcedure ? 'EE' : ''].filter(Boolean);
  return markers.join(' ') || '-';
}

function compareFixText(leg?: SimpleProcedureLeg) {
  if (!leg) return '-';
  if (leg.fix) return leg.fix;
  const pathTerminator = String(leg.pathTerminator || '').toUpperCase();
  if (['CA', 'CI', 'CR', 'VA', 'VI'].includes(pathTerminator)) return `no-fix ${pathTerminator}`;
  return '-';
}

function altitudeText(leg?: SimpleProcedureLeg) {
  if (!leg) return '-';
  if (typeof leg.altitudeValue === 'number') {
    const sign = leg.altitudeSign ?? (leg.altitudeRaw?.startsWith('+') ? '+' : leg.altitudeRaw?.startsWith('-') ? '-' : '');
    return `${sign}${String(Math.round(leg.altitudeValue)).padStart(5, '0')}`;
  }
  return leg.altitudeRaw || '-';
}

function legDiffTitle(leg: LegCompareResult) {
  const mismatches = leg.fieldResults.filter((field) => !field.matched);
  return mismatches.length ? mismatches.map((field) => field.field).join(', ') : 'All compared fields matched';
}

function procedureDiffCount(procedure: ProcedureCompareResult) {
  return procedure.legResults.reduce((sum, leg) => {
    const missing = leg.status === 'MISSING_AI' || leg.status === 'MISSING_JEPPESEN' ? 1 : 0;
    return sum + missing + leg.fieldResults.filter((field) => !field.matched).length;
  }, 0);
}

async function generateGeoJson() {
  if (!task.value || !selectedGroup.value) return;
  geojsonBusy.value = true;
  error.value = '';
  message.value = '正在生成 GeoJSON';
  try {
    await requestJson(`/api/procedure-tasks/${task.value.taskId}/packages/${selectedGroup.value.groupId}/generate-geojson`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'geojson', renderMode: selectedGeoJsonRenderMode.value }),
    });
    await refreshTask(false);
    mapResetCounter.value += 1;
    message.value = 'GeoJSON 已生成';
  } catch (generateError) {
    error.value = toErrorMessage(generateError);
    message.value = 'GeoJSON 生成失败';
  } finally {
    geojsonBusy.value = false;
  }
}

async function proceedToPreview() {
  if (geometryMissing.value) {
    const confirmed = window.confirm('AI 识别结果缺少关键几何语义，生成的 GeoJSON 可能不完整，是否继续？');
    if (!confirmed) return;
  }
  goToStep('preview');
  if (!selectedGroup.value?.geojson) await generateGeoJson();
}

function openFullMapPreview() {
  if (!task.value || !selectedGroup.value) return;
  router.push({
    path: '/procedure-geojson',
    query: {
      taskId: task.value.taskId,
      packageId: selectedGroup.value.packageId || selectedGroup.value.groupId,
      from: 'pdf-procedure-recognizer',
    },
  });
}

function downloadGroupGeoJson() {
  if (!task.value || !selectedGroup.value?.geojson) return;
  const packageId = selectedGroup.value.packageId || selectedGroup.value.groupId;
  const anchor = document.createElement('a');
  anchor.href = `/api/procedure-tasks/${encodeURIComponent(task.value.taskId)}/packages/${encodeURIComponent(packageId)}/geojson/download`;
  anchor.download = '';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

async function loadJeppesen424Export() {
  if (!task.value || !selectedGroup.value || !procedureUnderstanding.value) return;
  const packageId = selectedGroup.value.packageId || selectedGroup.value.groupId;
  jeppesen424ExportBusy.value = true;
  jeppesen424ExportError.value = '';
  try {
    const response = await fetch(
      `/api/procedure-tasks/${encodeURIComponent(task.value.taskId)}/packages/${encodeURIComponent(packageId)}/jeppesen424/export`,
    );
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || `${response.status} ${response.statusText}`);
    }
    jeppesen424ExportText.value = await response.text();
  } catch (exportError) {
    jeppesen424ExportText.value = '';
    jeppesen424ExportError.value = toErrorMessage(exportError);
  } finally {
    jeppesen424ExportBusy.value = false;
  }
}

function onJeppesen424ExportToggle(event: Event) {
  if ((event.target as HTMLDetailsElement).open) void loadJeppesen424Export();
}

function exportTaskJson() {
  if (!task.value) return;
  downloadJson(task.value, `${task.value.taskId}.json`);
}

function selectPage(page: PdfPageAsset) {
  selectedPageNo.value = page.pageNo;
}

function handleSelectedGroupChanged() {
  const group = selectedGroup.value;
  if (!group) return;
  selectedPageNo.value = allGroupPages(group)[0] || selectedPageNo.value;
  promptPreview.value = undefined;
  jeppesenCompareResult.value = undefined;
  jeppesen424ExportText.value = '';
  jeppesen424ExportError.value = '';
  if (task.value) replaceRecognizerRoute(task.value.taskId, group.packageId || group.groupId);
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
  promptPreview.value = undefined;
  message.value = 'AI 输入包发送策略已更新';
}

async function copyPrompt() {
  if (!promptPreview.value) await loadPromptPreview();
  if (!promptTextForCopy.value) return;
  await navigator.clipboard.writeText(promptTextForCopy.value);
  message.value = 'Prompt 已复制';
}

function manualPolicyFor(ref: SupportingInfoRef, sendMode: SendMode): SendPolicy {
  if (sendMode === 'NOT_SENT') return ref.sendPolicy === 'REQUIRED' ? 'OPTIONAL' : ref.sendPolicy;
  if (ref.sendPolicy === 'EXCLUDED') return 'OPTIONAL';
  return ref.sendPolicy;
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

function regionLabel(region: AiInputPage['region']) {
  const labels: Record<NonNullable<AiInputPage['region']>, string> = {
    full_page: 'full_page',
    header: 'header_crop',
    main_chart: 'main_chart_crop',
    table: 'table_crop',
    notes: 'notes_crop',
    msa: 'msa_crop',
    profile: 'profile_crop',
    minima: 'minima_crop',
  };
  return labels[region || 'full_page'];
}

function imageSizeText(page: AiInputPage) {
  const quality = page.imageQuality;
  if (!quality) return '-';
  return `${quality.expectedWidthPx} x ${quality.expectedHeightPx}`;
}

function fileSizeText(bytes: number | undefined) {
  if (!bytes) return '-';
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
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

function valueText(value: unknown) {
  if (value === undefined || value === null || value === '') return '-';
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.?0+$/, '');
  if (typeof value === 'boolean') return value ? '是' : '否';
  return String(value);
}

function scoreText(value: number | undefined) {
  return value === undefined ? '-' : `${Math.round(value * 100)}%`;
}

function compareScoreText(value: number | undefined) {
  return value === undefined ? '-' : `${value.toFixed(1).replace(/\.0$/, '')}%`;
}

const visionImagePagesText = computed(() => {
  const pages = visionRunRecord.value?.imagePages ?? [];
  return pages
    .map((page) => {
      const region = page.region && page.region !== 'full_page' ? ` / ${page.region}` : '';
      const size = page.widthPx ? ` / ${page.widthPx}×${page.heightPx}px / ${fileSizeText(page.fileSizeBytes)}` : '';
      return `PDF ${page.pageNo}${page.aipPageNo ? ` / ${page.aipPageNo}` : ''} / ${page.role}${region} / ${page.imageMode}${size}`;
    })
    .join(', ') || '-';
});

async function downloadGroupingDebug() {
  if (!task.value) return;
  const debug = await requestJson(`/api/procedure-tasks/${task.value.taskId}/grouping-debug`);
  downloadJson(debug, `${task.value.taskId}-grouping-debug.json`);
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
    const requestError = new Error(payload.error || `${response.status} ${response.statusText}`) as Error & { errorType?: string; status?: number };
    requestError.errorType = payload.errorType;
    requestError.status = response.status;
    throw requestError;
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
  if (isCancelledError(value)) return 'AI 识别已停止';
  return value instanceof Error ? value.message : String(value);
}

function isCancelledError(value: unknown) {
  return Boolean(value && typeof value === 'object' && (value as { errorType?: unknown }).errorType === 'CANCELLED');
}
</script>

<template>
  <main class="recognizer">
    <header class="topbar">
      <div class="title">
        <h1>PDF 程序识别流程</h1>
        <p>上传 PDF 后，按步骤完成程序分组、AI识别和地图预览。{{ task?.fileName ? ` · ${task.fileName}` : '' }}</p>
      </div>
      <div class="actions">
        <input ref="fileInput" class="file-input" type="file" accept="application/pdf,.pdf" @change="onFileSelected" />
        <button type="button" class="primary" :disabled="busy" @click="openFilePicker">
          <Upload :size="16" /> 上传PDF
        </button>
        <button type="button" :disabled="!task || busy" @click="startParse">
          <FileText :size="16" /> 开始解析
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

    <nav class="stepper">
      <button
        v-for="(step, index) in steps"
        :key="step.key"
        type="button"
        class="step"
        :class="stepState(step.key)"
        @click="goToStep(step.key)"
      >
        <span class="step-no">{{ index + 1 }}</span>
        <span class="step-text">
          <strong>{{ step.title }}</strong>
          <em>{{ stepStateLabel(step.key) }}</em>
        </span>
      </button>
    </nav>

    <div v-if="stepSummaries.length" class="step-summaries">
      <p v-for="item in stepSummaries" :key="item.key">
        <b>{{ item.label }}：</b>{{ item.text }}
      </p>
    </div>

    <section class="step-scroll">
      <!-- ==================== Step 1：PDF 分组 ==================== -->
      <section v-if="currentStep === 'grouping'" class="step-panel">
        <div class="grouping-layout">
          <div class="package-detail">
            <div class="panel-head">
              <h2>当前程序包</h2>
              <div class="mini-actions">
                <button type="button" :disabled="!task" title="重新自动分组" @click="autoRegroup">
                  <Wand2 :size="15" />
                </button>
                <button type="button" :disabled="!task" title="新建分组" @click="createGroup">
                  <Plus :size="15" />
                </button>
              </div>
            </div>

            <label class="group-picker">
              分组
              <select v-model="selectedGroupId" :disabled="!task?.groups.length" @change="handleSelectedGroupChanged">
                <option v-for="group in task?.groups" :key="group.groupId" :value="group.groupId">
                  {{ group.packageName || group.groupName }} / {{ group.packageType || '-' }} / {{ group.runway || '-' }}
                </option>
              </select>
            </label>

            <template v-if="selectedGroup">
              <p class="hint">
                来源：{{ sourceLabels[selectedGroup.source || ''] || selectedGroup.source || '-' }}
                · 置信度 {{ selectedGroup.confidence ?? '-' }}
                · {{ selectedGroup.reviewRequired ? '需复核' : (statusLabels[selectedGroup.status] || selectedGroup.status) }}
              </p>

              <div class="form-grid">
                <label>程序包名称<input v-model="selectedGroup.packageName" @input="selectedGroup.groupName = selectedGroup.packageName || selectedGroup.groupName" /></label>
                <label>程序类型<select v-model="selectedGroup.packageType"><option v-for="type in packageTypes" :key="type">{{ type }}</option></select></label>
                <label>程序类别<select v-model="selectedGroup.procedureCategory"><option v-for="category in groupCategories" :key="category">{{ category }}</option></select></label>
                <label>导航类型<input v-model="selectedGroup.navigationType" /></label>
                <label>跑道<input v-model="selectedGroup.runway" /></label>
                <label class="wide">程序名<input :value="selectedGroup.procedureNames.join(' / ')" @input="updateProcedureNames" /></label>
              </div>

              <div class="manifest-grid">
                <span>主图页</span><strong>P{{ pageNosText(selectedGroup.chartPages) }}</strong>
                <span>表格页</span><strong>P{{ pageNosText(selectedGroup.tabularPages) }}</strong>
                <span>坐标页</span><strong>P{{ pageNosText(selectedGroup.coordinatePages) }}</strong>
                <span>辅助页数量</span><strong>{{ supportingPageCount }}</strong>
              </div>

              <div class="button-row compact">
                <button type="button" @click="saveGroupMetadata">保存分组</button>
                <button type="button" class="danger" @click="deleteSelectedGroup">
                  <Trash2 :size="15" /> 删除分组
                </button>
              </div>
            </template>
            <p v-else class="empty">解析后自动生成程序包，也可以人工新建。</p>

            <div class="step-footer">
              <button type="button" class="primary" :disabled="!selectedGroup" @click="goToStep('request')">
                下一步：预览 AI 请求
              </button>
            </div>
          </div>

          <div class="package-detail">
            <div class="panel-head">
              <h2>核心页预览</h2>
              <div class="page-tabs">
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
          </div>
        </div>
      </section>

      <!-- ==================== Step 2：AI 请求预览 ==================== -->
      <section v-else-if="currentStep === 'request'" class="step-panel">
        <p v-if="!selectedGroup" class="empty">请先返回 Step 1 选择程序包。</p>
        <template v-else>
          <section class="block">
            <h2>当前程序包</h2>
            <div class="manifest-grid">
              <span>packageName</span><strong>{{ selectedGroup.packageName || selectedGroup.groupName }}</strong>
              <span>packageType</span><strong>{{ selectedGroup.packageType || '-' }}</strong>
              <span>navigationType</span><strong>{{ selectedGroup.navigationType || '-' }}</strong>
              <span>runway</span><strong>{{ selectedGroup.runway || '-' }}</strong>
              <span>procedureNames</span><strong>{{ selectedGroup.procedureNames.join(' / ') || '-' }}</strong>
            </div>
          </section>

          <p v-if="aiInputBusy" class="empty">正在加载 AI 输入包...</p>
          <p v-else-if="!aiInputPackage" class="empty">暂无 AI 输入包。解析或选择程序包后会自动生成。</p>
          <template v-else>
            <section class="block">
              <h2>发送图片（{{ aiInputPackage.includedImages.length }}）</h2>
              <div class="image-cards">
                <article
                  v-for="page in aiInputPackage.includedImages"
                  :key="`${page.role}-${page.pageNo}-${page.region || 'full_page'}`"
                  class="input-card"
                >
                  <div class="card-top">
                    <strong>PDF {{ page.pageNo }} / {{ page.aipPageNo || '-' }}</strong>
                    <span v-if="page.imageQuality && !page.imageQuality.isHighRes" class="tag warn">分辨率不足</span>
                  </div>
                  <div class="meta-grid">
                    <span>角色：{{ roleLabel(page.role) }}</span>
                    <span>区域：{{ regionLabel(page.region) }}</span>
                    <span>发送：是（{{ sendModeLabel(page.sendMode) }}）</span>
                    <span>图片：{{ imageSizeText(page) }}</span>
                  </div>
                  <p v-if="page.imageQuality?.warning" class="quality-warning">{{ page.imageQuality.warning }}</p>
                </article>
              </div>
            </section>

            <section class="block">
              <h2>辅助摘要（{{ aiInputPackage.supportingInfo.length }}）</h2>
              <div class="support-rows">
                <div v-for="info in aiInputPackage.supportingInfo" :key="info.id" class="support-row">
                  <div class="support-main">
                    <strong>{{ info.supportType }}</strong>
                    <span>PDF {{ pageRangeText(info.pageNos) }}</span>
                    <span class="tag" :class="info.sendPolicy.toLowerCase()">发送：{{ sentLabel(info) }}</span>
                    <span class="tag">{{ sendModeLabel(info.sendMode) }}</span>
                  </div>
                  <p class="support-reason">{{ info.reason }}</p>
                  <div class="button-row compact">
                    <button type="button" @click="setSupportSendMode(info, 'SUMMARY_ONLY')">发送摘要</button>
                    <button type="button" @click="setSupportSendMode(info, 'SUMMARY_AND_IMAGE')">发送截图</button>
                    <button type="button" @click="setSupportSendMode(info, 'NOT_SENT')">不发送</button>
                  </div>
                </div>
              </div>
            </section>

            <section class="block">
              <h2>Prompt 摘要</h2>
              <div class="manifest-grid">
                <span>模型</span><strong>{{ aiInputPackage.model }}</strong>
                <span>Prompt 模板</span><strong>{{ aiInputPackage.promptTemplateName || aiInputPackage.promptTemplate }} {{ aiInputPackage.promptVersion || '' }}</strong>
                <span>输出 Schema</span><strong>{{ aiInputPackage.outputSchemaName }} {{ aiInputPackage.outputSchemaVersion || '' }}</strong>
                <span>识别目标</span><strong>程序类型 · 图面文本 · 表格腿段 · 几何语义 · 辅助对象过滤</strong>
              </div>
              <div class="button-row compact">
                <button type="button" @click="openPromptModal('prompt')">
                  <FileText :size="15" /> 查看完整 Prompt
                </button>
                <button type="button" @click="openPromptModal('request')">
                  <FileJson :size="15" /> 查看完整请求 JSON
                </button>
                <button type="button" @click="copyPrompt">
                  <Clipboard :size="15" /> 复制 Prompt
                </button>
                <button type="button" :disabled="recognitionBusy" @click="retestPrompt">
                  <RefreshCw :size="15" /> 使用当前程序包重新测试 Prompt
                </button>
              </div>
            </section>
          </template>

          <div class="step-footer">
            <button type="button" @click="goToStep('grouping')">返回 PDF 分组</button>
            <button v-if="canStopRecognition" type="button" class="danger" :disabled="stopRecognitionBusy" @click="stopRecognition">
              <Square :size="15" /> 停止识别
            </button>
            <button type="button" class="primary" :disabled="!aiInputPackage || recognitionBusy" @click="sendRecognition">
              <Bot :size="15" /> 发送 AI 识别
            </button>
          </div>
        </template>
      </section>

      <!-- ==================== Step 3：AI 识别结果 ==================== -->
      <section v-else-if="currentStep === 'recognition'" class="step-panel">
        <p v-if="!selectedGroup" class="empty">请先返回 Step 1 选择程序包。</p>
        <template v-else>
          <div class="run-status" :class="llmRunStatus.toLowerCase()">
            <strong>运行状态：{{ llmRunStatus }}</strong>
            <button v-if="canStopRecognition" type="button" class="danger inline-action" :disabled="stopRecognitionBusy" @click="stopRecognition">
              <Square :size="15" /> 停止识别
            </button>
            <span v-if="llmRunStatus === 'CANCELLED'">AI 识别已停止，可重新发送识别。</span>
            <span v-if="visionRunRecord">
              Prompt：{{ visionRunRecord.promptTemplateId }} v{{ visionRunRecord.promptVersion }}
              · Schema：{{ visionRunRecord.schemaName }} {{ visionRunRecord.schemaVersion }}
            </span>
            <span v-if="llmRunStatus === 'RUNNING'">AI 识别中，完成后自动刷新结果...</span>
            <span v-else-if="llmRunStatus === 'ERROR'">{{ visionRunRecord?.errorMessage || selectedGroup.aiResponse?.errors?.[0] || 'AI 调用失败' }}</span>
            <span v-else-if="llmRunStatus === 'NOT_STARTED'">尚未发送 AI 识别，请返回 Step 2 点击「发送 AI 识别」。</span>
          </div>

          <div v-if="classificationWarning" class="alert error">{{ classificationWarning }}</div>
          <div v-if="geometryMissing" class="alert error">AI 没有识别出图面几何语义，无法生成完整程序图形。</div>
          <div v-if="supportLeakObjects.length" class="alert warn">
            疑似把辅助页对象错误加入当前程序：{{ supportLeakObjects.map((item) => item.ident).join(' / ') }}
          </div>

          <section v-if="keyItemChecks.length" class="block">
            <h2>关键项检查（{{ keyItemChecks.length - failedKeyChecks.length }} / {{ keyItemChecks.length }} 通过）</h2>
            <div v-if="failedKeyChecks.length || keyErrorChecks.length" class="alert error">
              AI 未识别出关键程序语义，请优先打磨 Prompt 或检查输入图片质量，不建议继续生成 GeoJSON。
            </div>
            <div v-if="legFallbackActive" class="alert warn">
              ⚠ 已启用几何合成兜底：当前腿段由 DME ARC 语义推算（无高度约束），仅供 GeoJSON / 424 结构预览。模型未输出 tableLegs，Prompt 仍需完善。
            </div>
            <ul class="check-list">
              <li v-for="check in keyItemChecks" :key="check.label" :class="check.ok ? 'ok' : 'fail'">
                <span class="check-mark">{{ check.ok ? '✓' : '✗' }}</span>{{ check.label }}
              </li>
            </ul>
            <div v-for="issue in keyErrorChecks" :key="issue" class="alert error">{{ issue }}</div>
          </section>

          <template v-if="llmRunStatus === 'COMPLETED'">
            <section class="block">
              <h2>1. 程序类型识别</h2>
              <p v-if="!recognitionClassification" class="empty">模型没有返回 procedureClassification。</p>
              <div v-else class="manifest-grid">
                <span>packageType</span><strong>{{ valueText(recognitionClassification.packageType) }}</strong>
                <span>procedureCategory</span><strong>{{ valueText(recognitionClassification.procedureCategory) }}</strong>
                <span>navigationType</span><strong>{{ valueText(recognitionClassification.navigationType) }}</strong>
                <span>runway</span><strong>{{ valueText(recognitionClassification.runway) }}</strong>
                <span>procedureNames</span><strong>{{ recognitionClassification.procedureNames?.join(' / ') || '-' }}</strong>
                <span>chartPurpose</span><strong>{{ valueText(recognitionClassification.chartPurpose) }}</strong>
                <span>confidence</span><strong>{{ valueText(recognitionClassification.confidence) }}</strong>
              </div>
            </section>

            <section class="block">
              <h2>2. 图面关键文本（{{ recognitionChartTexts.length }}）</h2>
              <p v-if="!recognitionChartTexts.length" class="empty">模型没有返回 chartTexts（图面关键文本）。</p>
              <div v-else class="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>文本</th>
                      <th>角色</th>
                      <th>区域</th>
                      <th>用于当前程序</th>
                      <th>来源页</th>
                      <th>置信度</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="(item, index) in recognitionChartTexts" :key="`chart-text-${index}`">
                      <td>{{ item.text }}</td>
                      <td>{{ valueText(item.role) }}</td>
                      <td>{{ valueText(item.region) }}</td>
                      <td>{{ valueText(item.usedInProcedure) }}</td>
                      <td>{{ valueText(item.sourcePageNo) }}</td>
                      <td>{{ valueText(item.confidence) }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </section>

            <section class="block">
              <h2>3. 表格腿段（{{ recognitionTableLegs.length }}）</h2>
              <p v-if="!recognitionTableLegs.length" class="empty">
                {{ selectedGroup.tabularPages.length ? '模型没有返回 tableLegs（表格腿段）。' : '当前程序包未识别到表格页，表格腿段为空。' }}
              </p>
              <div v-else class="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>程序名</th>
                      <th>序号</th>
                      <th>Path Terminator</th>
                      <th>From</th>
                      <th>To</th>
                      <th>Course</th>
                      <th>Distance</th>
                      <th>Altitude</th>
                      <th>Turn</th>
                      <th>来源页</th>
                      <th>置信度</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="(leg, index) in recognitionTableLegs" :key="`table-leg-${index}`">
                      <td>{{ valueText(leg.procedureName) }}</td>
                      <td>{{ valueText(leg.sequence) }}</td>
                      <td>{{ valueText(leg.pathTerminator) }}</td>
                      <td>{{ valueText(leg.fromFix) }}</td>
                      <td>{{ valueText(leg.toFix) }}</td>
                      <td>{{ valueText(leg.courseDeg) }}</td>
                      <td>{{ valueText(leg.distanceNm) }}</td>
                      <td>{{ valueText(leg.altitudeConstraint) }}</td>
                      <td>{{ valueText(leg.turnDirection) }}</td>
                      <td>{{ valueText(leg.sourcePageNo) }}</td>
                      <td>{{ valueText(leg.confidence) }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </section>

            <section class="block">
              <h2>4. 几何语义（{{ recognitionGeometry.length }}）</h2>
              <p v-if="!recognitionGeometry.length" class="empty">模型没有返回 geometrySemantics（图面几何语义）。</p>
              <div v-else class="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>类型</th>
                      <th>标签</th>
                      <th>中心导航台</th>
                      <th>半径 NM</th>
                      <th>径向</th>
                      <th>入航航迹</th>
                      <th>关联程序</th>
                      <th>来源页</th>
                      <th>置信度</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="(item, index) in recognitionGeometry" :key="`geometry-${index}`">
                      <td>{{ item.type }}</td>
                      <td>{{ valueText(item.labelText) }}</td>
                      <td>{{ valueText(item.centerNavaid) }}</td>
                      <td>{{ valueText(item.radiusNm) }}</td>
                      <td>{{ valueText(item.radialDeg) }}</td>
                      <td>{{ valueText(item.inboundTrackDeg) }}</td>
                      <td>{{ item.relatedProcedures?.join(' / ') || '-' }}</td>
                      <td>{{ valueText(item.sourcePageNo) }}</td>
                      <td>{{ valueText(item.confidence) }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </section>

            <section class="block">
              <h2>5. 辅助对象过滤（{{ recognitionSupportObjects.length }}）</h2>
              <p v-if="!recognitionSupportObjects.length" class="empty">模型没有返回 supportObjects（辅助对象过滤）。</p>
              <div v-else class="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>标识</th>
                      <th>类型</th>
                      <th>用于当前程序</th>
                      <th>仅辅助</th>
                      <th>原因</th>
                      <th>来源页</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="(item, index) in recognitionSupportObjects" :key="`support-object-${index}`">
                      <td>{{ item.ident }}</td>
                      <td>{{ valueText(item.type) }}</td>
                      <td>{{ valueText(item.usedInProcedure) }}</td>
                      <td>{{ valueText(item.supportOnly) }}</td>
                      <td>{{ valueText(item.reason) }}</td>
                      <td>{{ valueText(item.sourcePageNo) }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </section>

            <details class="block" :open="rawJsonOpen" @toggle="rawJsonOpen = ($event.target as HTMLDetailsElement).open">
              <summary>查看原始 AI JSON</summary>
              <pre class="raw-json">{{ understandingJson }}</pre>
            </details>
          </template>

          <details v-if="visionRunRecord?.rawResponse" class="block">
            <summary>查看模型原始输出（rawResponse）</summary>
            <pre class="raw-json">{{ visionRunRecord.rawResponse }}</pre>
          </details>

          <section v-if="llmRunStatus === 'COMPLETED' || llmRunStatus === 'ERROR'" class="block">
            <h2>标记识别问题（用于 Prompt 打磨）</h2>
            <p class="hint">点击切换标记，保存到任务记录，供后续优化 Prompt 使用。</p>
            <div class="button-row compact">
              <button
                v-for="tag in ISSUE_TAGS"
                :key="tag"
                type="button"
                :disabled="issueTagBusy"
                :class="{ 'issue-active': selectedGroup.recognitionIssueTags?.includes(tag) }"
                @click="toggleIssueTag(tag)"
              >
                {{ tag }}
              </button>
            </div>
          </section>

          <div class="step-footer">
            <button type="button" @click="goToStep('request')">返回 AI 请求预览</button>
            <button type="button" :disabled="recognitionBusy" @click="sendRecognition">
              <Bot :size="15" /> 重新发送 AI 识别
            </button>
            <button type="button" class="primary" :disabled="llmRunStatus !== 'COMPLETED' || geojsonBusy" @click="proceedToPreview">
              <Eye :size="15" /> 下一步：生成并预览 GeoJSON
            </button>
          </div>
        </template>
      </section>

      <!-- ==================== Step 4：GeoJSON 预览 ==================== -->
      <section v-else-if="currentStep === 'preview'" class="step-panel">
        <p v-if="!selectedGroup" class="empty">请先返回 Step 1 选择程序包。</p>
        <template v-else>
          <div class="preview-layout">
            <div class="map-frame">
              <ProcedureMap
                v-if="geojsonModel"
                :key="selectedGroup.geojsonGeneratedAt || selectedGroup.groupId"
                :model="geojsonModel"
                :layer-visibility="mapLayerVisibility"
                :reset-counter="mapResetCounter"
              />
              <div v-else class="map-placeholder">
                <strong>{{ geojsonDisplayStatus === 'GENERATING' ? '正在生成 GeoJSON...' : '尚未生成 GeoJSON' }}</strong>
                <span v-if="geojsonDisplayStatus !== 'GENERATING'">点击右侧「重新生成 GeoJSON」开始生成。</span>
              </div>
            </div>

            <aside class="preview-side">
              <section class="block">
                <h2>GeoJSON 状态</h2>
                <label class="field-label" for="geojson-render-mode">渲染模式</label>
                <select id="geojson-render-mode" v-model="selectedGeoJsonRenderMode">
                  <option value="AUTO">自动：424 优先</option>
                  <option value="JEPPESEN_424" :disabled="!selectedGroup.jeppesen424Source">仅 Jeppesen 424</option>
                  <option value="AI">仅 AI 识别结果</option>
                </select>
                <div v-if="selectedGroup.jeppesen424Source" class="manifest-grid compact-manifest">
                  <span>424 程序</span><strong>{{ selectedGroup.jeppesen424Source.procedureCount }}</strong>
                  <span>424 腿段</span><strong>{{ selectedGroup.jeppesen424Source.legCount }}</strong>
                </div>
                <div v-if="geojsonRenderSummary" class="manifest-grid compact-manifest">
                  <span>实际来源</span><strong>{{ geojsonRenderSummary.source }}</strong>
                  <span>424 渲染腿段</span><strong>{{ geojsonRenderSummary.canonicalLegCount }}</strong>
                </div>
                <div class="run-status" :class="geojsonDisplayStatus === 'GENERATED' ? 'completed' : geojsonDisplayStatus === 'ERROR' ? 'error' : 'running'">
                  <strong>{{ geojsonDisplayStatus }}</strong>
                  <span v-if="selectedGroup.geojsonError">{{ selectedGroup.geojsonError }}</span>
                </div>
              </section>

              <section v-if="geojsonStats && hasGeoJson" class="block">
                <h2>可渲染统计</h2>
                <div class="manifest-grid">
                  <span>Feature 总数</span><strong>{{ geojsonStats.featureCount }}</strong>
                  <span>可渲染 Feature</span><strong>{{ geojsonStats.renderableCount }}</strong>
                  <span>Point</span><strong>{{ geojsonStats.pointCount }}</strong>
                  <span>LineString</span><strong>{{ geojsonStats.lineStringCount }}</strong>
                  <span>Polygon</span><strong>{{ geojsonStats.polygonCount }}</strong>
                  <span>null geometry</span><strong>{{ geojsonStats.nullGeometryCount }}</strong>
                </div>
              </section>

              <section v-if="objectTypeStats.length" class="block">
                <h2>对象类型统计</h2>
                <div class="manifest-grid">
                  <template v-for="row in objectTypeStats" :key="row.type">
                    <span>{{ row.type }}</span><strong>{{ row.count }}</strong>
                  </template>
                </div>
              </section>

              <section v-if="geojsonIssues.length" class="block">
                <h2>问题提示</h2>
                <div v-for="(issue, index) in geojsonIssues" :key="`geojson-issue-${index}`" class="alert warn">{{ issue }}</div>
              </section>

              <div class="button-col">
                <button type="button" @click="goToStep('recognition')">返回 AI 识别结果</button>
                <button type="button" :disabled="geojsonBusy || llmRunStatus !== 'COMPLETED'" @click="generateGeoJson">
                  <RefreshCw :size="15" /> 重新生成 GeoJSON
                </button>
                <button type="button" :disabled="!hasGeoJson" @click="downloadGroupGeoJson">
                  <Download :size="15" /> 下载 GeoJSON
                </button>
                <button type="button" :disabled="!hasGeoJson" @click="openFullMapPreview">
                  <Eye :size="15" /> 全屏预览
                </button>
                <button type="button" @click="goToStep('grouping')">返回分组继续处理</button>
              </div>
            </aside>
          </div>
        </template>
      </section>

      <!-- ==================== 高级调试 ==================== -->
      <!-- ==================== Step 5: Jeppesen 424 compare ==================== -->
      <section v-else-if="currentStep === 'jeppesen'" class="step-panel">
        <p v-if="!selectedGroup" class="empty">请先返回 Step 1 选择程序包。</p>
        <template v-else>
          <section class="block">
            <div class="panel-head">
              <div>
                <h2>粘贴 Jeppesen 424 静态文本</h2>
                <p class="hint">MVP 只解析包含 SSPAP 的 WMKJ RWY16 STAR 记录，并按 procedure / runway / sequence 与当前 AI 结果对比。</p>
              </div>
              <button type="button" class="primary" :disabled="jeppesenCompareBusy || !jeppesenText.trim() || !procedureUnderstanding" @click="compareJeppesen424">
                <RefreshCw :size="15" /> 开始对比
              </button>
            </div>

            <textarea
              v-model="jeppesenText"
              class="jeppesen-input"
              placeholder="Paste Jeppesen 424 text here..."
              spellcheck="false"
            ></textarea>

            <div class="manifest-grid">
              <span>筛选程序</span><strong>{{ jeppesenProcedureFilter.join(' / ') || '当前 AI 程序' }}</strong>
              <span>跑道</span><strong>{{ selectedGroup.runway || procedureUnderstanding?.runway || 'RW16' }}</strong>
              <span>AI legs</span><strong>{{ jeppesenCompareResult?.aiLegs.length ?? '-' }}</strong>
              <span>Parsed 424 legs</span><strong>{{ jeppesenCompareResult?.parsedJeppesenLegs.length ?? '-' }}</strong>
            </div>
          </section>

          <p v-if="!procedureUnderstanding" class="alert warn">需要先完成 AI 识别，才能把 ProcedureUnderstanding legs 与 Jeppesen 424 文本对比。</p>
          <p v-if="jeppesenCompareResult && !jeppesenCompareResult.aiLegs.length && jeppesenCompareResult.parsedJeppesenLegs.length" class="alert warn">
            当前筛选范围内 Jeppesen 424 有 {{ jeppesenCompareResult.parsedJeppesenLegs.length }} 条腿段，但 AI 结果没有对应腿段。若要验证 RNAV 1E，请选择 RNAV STAR 程序包，并使用“仅 RNAV 1E”筛选。
          </p>
          <p v-if="jeppesenCompareBusy" class="empty">正在解析并对比 Jeppesen 424 文本...</p>

          <template v-if="jeppesenCompareResult">
            <section class="block">
              <h2>对比摘要</h2>
              <div class="summary-cards">
                <div class="metric-card"><span>部分匹配腿段</span><strong>{{ jeppesenCompareResult.summary.partialLegs }}</strong></div>
                <div class="metric-card"><span>不匹配腿段</span><strong>{{ jeppesenCompareResult.summary.mismatchedLegs }}</strong></div>
                <div class="metric-card"><span>总体匹配率</span><strong>{{ compareScoreText(jeppesenCompareResult.summary.overallScore) }}</strong></div>
                <div class="metric-card"><span>程序数</span><strong>{{ jeppesenCompareResult.summary.totalProcedures }}</strong></div>
                <div class="metric-card"><span>腿段数</span><strong>{{ jeppesenCompareResult.summary.totalLegs }}</strong></div>
                <div class="metric-card"><span>AI 腿段</span><strong>{{ jeppesenCompareResult.aiLegs.length }}</strong></div>
                <div class="metric-card"><span>424 腿段</span><strong>{{ jeppesenCompareResult.parsedJeppesenLegs.length }}</strong></div>
                <div class="metric-card"><span>完全匹配腿段</span><strong>{{ jeppesenCompareResult.summary.matchedLegs }}</strong></div>
                <div class="metric-card"><span>缺失 AI 腿段</span><strong>{{ jeppesenCompareResult.summary.missingAiLegs }}</strong></div>
                <div class="metric-card"><span>差异数</span><strong>{{ jeppesenCompareResult.summary.issueCount ?? jeppesenCompareResult.procedureResults.reduce((sum, item) => sum + procedureDiffCount(item), 0) }}</strong></div>
              </div>
            </section>

            <details
              v-for="procedure in jeppesenCompareResult.procedureResults"
              :key="`${procedure.procedureName}-${procedure.runway}`"
              class="block compare-panel"
              open
            >
              <summary>
                {{ procedure.procedureName }} / {{ procedure.runway }} -
                {{ compareScoreText(procedure.score) }} -
                {{ procedure.matchedLegs }}/{{ procedure.totalLegs }} legs matched,
                {{ procedure.partialLegs }} partial,
                {{ procedure.mismatchedLegs }} mismatch
              </summary>
              <p class="hint">
                SID first no-fix CA legs are coded without Fix/EA-PC markers in Jeppesen 424. Alt2/Nav are shown only when 424 encodes them on that leg; for WMKJ RNAV SID this is normally the first CA leg carrying transition altitude and VJB.
              </p>
              <div class="table-wrap">
                <table class="compare-table">
                  <thead>
                    <tr>
                      <th>Seq</th>
                      <th>AI Fix</th>
                      <th>424 Fix</th>
                      <th>AI PT</th>
                      <th>424 PT</th>
                      <th>AI Dist</th>
                      <th>424 Dist</th>
                      <th>AI Alt</th>
                      <th>424 Alt</th>
                      <th>AI Alt2</th>
                      <th>424 Alt2</th>
                      <th>AI Crs</th>
                      <th>424 Crs</th>
                      <th>AI Nav</th>
                      <th>424 Nav</th>
                      <th>AI Spd</th>
                      <th>424 Spd</th>
                      <th>AI 标记</th>
                      <th>424 标记</th>
                      <th>Score</th>
                      <th>Status</th>
                      <th>差异字段</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="leg in procedure.legResults" :key="`${procedure.procedureName}-${leg.sequence}`" :class="statusClass(leg.status)">
                      <td>{{ leg.sequence }}</td>
                      <td>{{ compareFixText(leg.ai) }}</td>
                      <td>{{ compareFixText(leg.jeppesen) }}</td>
                      <td>{{ leg.ai?.pathTerminator || '-' }}</td>
                      <td>{{ leg.jeppesen?.pathTerminator || '-' }}</td>
                      <td>{{ valueText(leg.ai?.distanceNm) }}</td>
                      <td>{{ valueText(leg.jeppesen?.distanceNm) }}</td>
                      <td>{{ altitudeText(leg.ai) }}</td>
                      <td>{{ altitudeText(leg.jeppesen) }}</td>
                      <td>{{ valueText(leg.ai?.altitudeUpperFt) }}</td>
                      <td>{{ valueText(leg.jeppesen?.altitudeUpperFt) }}</td>
                      <td>{{ valueText(leg.ai?.courseDegMag) }}</td>
                      <td>{{ valueText(leg.jeppesen?.courseDegMag) }}</td>
                      <td>{{ leg.ai?.recommendedNavaid || '-' }}</td>
                      <td>{{ leg.jeppesen?.recommendedNavaid || '-' }}</td>
                      <td>{{ valueText(leg.ai?.speedLimitKias) }}</td>
                      <td>{{ valueText(leg.jeppesen?.speedLimitKias) }}</td>
                      <td>{{ legMarkers(leg.ai) }}</td>
                      <td>{{ legMarkers(leg.jeppesen) }}</td>
                      <td>{{ compareScoreText(leg.score) }}</td>
                      <td><span class="status-pill" :class="statusClass(leg.status)">{{ leg.status }}</span></td>
                      <td>{{ legDiffTitle(leg) }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <details class="raw-evidence">
                <summary>原始 424 行证据</summary>
                <pre>{{ procedure.legResults.map((leg) => leg.jeppesen?.rawRecord).filter(Boolean).join('\n\n') || '-' }}</pre>
              </details>
            </details>

            <section class="block">
              <div class="panel-head">
                <div>
                  <h2>对比分析结果</h2>
                  <p class="hint">按差异类型归类的结构化报告，复制后发给 AI（Claude）用于完善识别提示词。</p>
                </div>
                <button type="button" @click="copyJeppesenAnalysis">
                  <Clipboard :size="15" /> 复制分析结果
                </button>
              </div>
              <pre>{{ jeppesenAnalysisText }}</pre>
            </section>
          </template>

          <details class="raw-evidence" @toggle="onJeppesen424ExportToggle">
            <summary>AI 识别结果生成的 424 标准数据</summary>
            <p v-if="!procedureUnderstanding" class="empty">需要先完成 AI 识别，才能生成 424 标准数据。</p>
            <p v-else-if="jeppesen424ExportBusy" class="empty">正在生成 424 标准数据...</p>
            <p v-else-if="jeppesen424ExportError" class="alert warn">生成 424 标准数据失败：{{ jeppesen424ExportError }}</p>
            <pre v-else-if="jeppesen424ExportText">{{ jeppesen424ExportText }}</pre>
            <p v-else class="empty">展开后自动生成。</p>
          </details>

          <div class="step-footer">
            <button type="button" @click="goToStep('recognition')">返回 AI 识别结果</button>
            <button type="button" @click="goToStep('preview')">查看 GeoJSON 预览</button>
          </div>
        </template>
      </section>

      <details v-if="selectedGroup" class="debug-panel">
        <summary>高级调试（Prompt / Schema / Request JSON / Raw Response / GeoJSON Raw / 评测 / 日志）</summary>
        <div class="button-row compact">
          <button type="button" :disabled="promptPreviewBusy" @click="loadPromptPreview">加载 Prompt 预览</button>
          <button type="button" @click="copyPrompt">
            <Clipboard :size="15" /> 复制 Prompt
          </button>
          <button type="button" :disabled="evaluationBusy || !procedureUnderstanding" @click="evaluateRecognition">Golden Case 评测</button>
          <button type="button" :disabled="busy" @click="extractSelectedCandidates">提取候选</button>
          <button type="button" @click="exportTaskJson">导出任务 JSON</button>
          <button type="button" @click="downloadGroupingDebug">下载分组调试</button>
          <button type="button" @click="exportGroupPdf">导出程序包 PDF</button>
        </div>

        <details>
          <summary>Prompt</summary>
          <p v-if="!promptPreview" class="empty">尚未加载，点击上方「加载 Prompt 预览」。</p>
          <template v-else>
            <h4>System Prompt</h4>
            <pre>{{ promptPreview.systemPrompt }}</pre>
            <h4>User Prompt</h4>
            <pre>{{ promptPreview.userPrompt }}</pre>
          </template>
        </details>
        <details>
          <summary>Schema</summary>
          <p v-if="!promptPreview" class="empty">尚未加载，点击上方「加载 Prompt 预览」。</p>
          <pre v-else>{{ promptSchemaJson }}</pre>
        </details>
        <details>
          <summary>Request JSON</summary>
          <p v-if="!promptPreview" class="empty">尚未加载，点击上方「加载 Prompt 预览」。</p>
          <pre v-else>{{ fullRequestJson }}</pre>
        </details>
        <details>
          <summary>辅助信息结构化摘要</summary>
          <pre>{{ supportSummaryJson }}</pre>
        </details>
        <details>
          <summary>Raw AI Response</summary>
          <pre>{{ visionRunRecord?.rawResponse || selectedGroup.aiResponse?.rawText || '-' }}</pre>
        </details>
        <details>
          <summary>Parsed JSON（ProcedureUnderstanding）</summary>
          <pre>{{ understandingJson }}</pre>
        </details>
        <details>
          <summary>GeoJSON Raw</summary>
          <pre>{{ hasGeoJson ? JSON.stringify(selectedGroup.geojson, null, 2) : '-' }}</pre>
        </details>
        <details>
          <summary>运行日志 / 元信息</summary>
          <div class="manifest-grid">
            <span>Provider</span><strong>{{ visionRunRecord?.provider || '-' }}</strong>
            <span>Model</span><strong>{{ visionRunRecord?.model || '-' }}</strong>
            <span>Prompt</span><strong>{{ visionRunRecord?.promptTemplateId || '-' }} {{ visionRunRecord?.promptVersion || '' }}</strong>
            <span>Schema</span><strong>{{ visionRunRecord?.schemaName || '-' }} {{ visionRunRecord?.schemaVersion || '' }}</strong>
            <span>Schema Valid</span><strong>{{ valueText(visionRunRecord?.schemaValidation?.valid ?? visionRunRecord?.validationResult.schemaValid) }}</strong>
            <span>Image Pages</span><strong>{{ visionImagePagesText }}</strong>
            <span>Support Pages</span><strong>{{ pageRangeText(visionRunRecord?.supportSummaryPages) }}</strong>
            <span>Input Hash</span><strong>{{ visionRunRecord?.inputPackageHash || '-' }}</strong>
            <span>Error</span><strong>{{ visionRunRecord?.errorType || '-' }} {{ visionRunRecord?.errorMessage || '' }}</strong>
          </div>
          <div v-if="recognitionEvaluation" class="manifest-grid">
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
        </details>
      </details>
    </section>

    <!-- Prompt / 请求 JSON 弹窗 -->
    <div v-if="promptModalOpen" class="modal-backdrop" @click.self="promptModalOpen = false">
      <section class="prompt-modal">
        <div class="modal-head">
          <div>
            <h3>AI 请求详情</h3>
            <p v-if="promptPreview">{{ promptPreview.promptTemplateName || promptPreview.promptTemplateId }} · {{ promptPreview.promptVersion }}</p>
          </div>
          <button type="button" class="ghost" @click="promptModalOpen = false">关闭</button>
        </div>
        <div class="tab-row">
          <button type="button" :class="{ active: promptModalTab === 'prompt' }" @click="promptModalTab = 'prompt'">Prompt</button>
          <button type="button" :class="{ active: promptModalTab === 'schema' }" @click="promptModalTab = 'schema'">Schema</button>
          <button type="button" :class="{ active: promptModalTab === 'request' }" @click="promptModalTab = 'request'">完整请求 JSON</button>
        </div>
        <p v-if="promptPreviewBusy" class="empty">正在渲染 Prompt...</p>
        <template v-else-if="promptPreview">
          <div v-if="promptModalTab === 'prompt'" class="prompt-stack">
            <h4>System Prompt</h4>
            <pre>{{ promptPreview.systemPrompt }}</pre>
            <h4>User Prompt</h4>
            <pre>{{ promptPreview.userPrompt }}</pre>
          </div>
          <pre v-else-if="promptModalTab === 'schema'">{{ promptSchemaJson }}</pre>
          <pre v-else>{{ fullRequestJson }}</pre>
        </template>
        <p v-else class="empty">Prompt 预览加载失败，请重试。</p>
      </section>
    </div>
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
  grid-template-rows: auto auto auto auto minmax(0, 1fr);
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
  font-size: 14px;
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
.hint {
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
  border-color: #dc2626;
  background: #fff;
  color: #b91c1c;
}

button.danger.inline-action {
  align-self: flex-start;
  background: #dc2626;
  color: #fff;
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

/* ---------- Stepper ---------- */

.stepper {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 8px;
  padding: 10px 16px;
  border-bottom: 1px solid #d7deea;
  background: #fff;
}

.step {
  justify-content: flex-start;
  gap: 10px;
  min-height: 44px;
  border-radius: 8px;
  padding: 6px 10px;
  text-align: left;
}

.step .step-no {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  flex: none;
  border-radius: 999px;
  background: #e2e8f0;
  color: #475569;
  font-weight: 700;
}

.step .step-text {
  display: grid;
  gap: 1px;
  min-width: 0;
}

.step .step-text strong {
  font-size: 13px;
}

.step .step-text em {
  color: #64748b;
  font-size: 11px;
  font-style: normal;
}

.step.current {
  border-color: #2563eb;
  background: #eff6ff;
}

.step.current .step-no {
  background: #2563eb;
  color: #fff;
}

.step.done .step-no {
  background: #16a34a;
  color: #fff;
}

.step.done .step-text em {
  color: #15803d;
}

.step-summaries {
  display: flex;
  gap: 6px 20px;
  flex-wrap: wrap;
  padding: 8px 16px;
  border-bottom: 1px solid #d7deea;
  background: #f8fafc;
}

.step-summaries p {
  color: #475569;
  font-size: 12px;
}

.step-summaries b {
  color: #172033;
}

/* ---------- Step body ---------- */

.step-scroll {
  min-height: 0;
  overflow: auto;
  padding: 12px 16px 24px;
  display: grid;
  gap: 12px;
  align-content: start;
}

.step-panel {
  display: grid;
  gap: 12px;
}

.block {
  display: grid;
  gap: 10px;
  border: 1px solid #dbe3ef;
  border-radius: 8px;
  background: #fff;
  padding: 12px;
}

.step-footer {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  border-top: 1px solid #e2e8f0;
  padding-top: 12px;
}

/* ---------- Step 1 ---------- */

.grouping-layout {
  display: grid;
  grid-template-columns: minmax(360px, 0.8fr) minmax(0, 1.2fr);
  gap: 12px;
  align-items: start;
}

.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.group-picker {
  display: grid;
  gap: 4px;
}

.package-detail {
  display: grid;
  gap: 10px;
  border: 1px solid #dbe3ef;
  border-radius: 8px;
  background: #fff;
  padding: 12px;
}

/* ---------- Step 2 ---------- */

.image-cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
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

.card-top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
}

.support-rows {
  display: grid;
  gap: 8px;
}

.support-row {
  display: grid;
  gap: 6px;
  border: 1px solid #e2e8f0;
  border-radius: 7px;
  background: #f8fafc;
  padding: 9px;
}

.support-main {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  font-size: 12px;
  color: #475569;
}

.support-main strong {
  color: #172033;
}

.support-reason {
  color: #64748b;
  font-size: 12px;
}

/* ---------- Step 3 ---------- */

.run-status {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  background: #f8fafc;
  padding: 10px 12px;
  font-size: 12px;
  color: #475569;
}

.run-status.completed {
  border-color: #bbf7d0;
  background: #f0fdf4;
  color: #15803d;
}

.run-status.running {
  border-color: #bfdbfe;
  background: #eff6ff;
  color: #1d4ed8;
}

.run-status.error {
  border-color: #fecaca;
  background: #fef2f2;
  color: #b91c1c;
}

.run-status.cancelled {
  border-color: #fed7aa;
  background: #fff7ed;
  color: #c2410c;
}

.alert {
  display: grid;
  gap: 4px;
  border-radius: 8px;
  padding: 9px 12px;
  font-size: 12px;
}

.alert.error {
  border: 1px solid #fecaca;
  background: #fef2f2;
  color: #b91c1c;
}

.alert.warn {
  border: 1px solid #fde68a;
  background: #fffbeb;
  color: #a16207;
}

.alert ul {
  margin: 0;
  padding-left: 18px;
}

.check-list {
  display: grid;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.check-list li {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 12px;
  color: #334155;
}

.check-list .check-mark {
  flex: none;
  width: 16px;
  text-align: center;
  font-weight: 700;
}

.check-list li.ok .check-mark {
  color: #16a34a;
}

.check-list li.fail {
  color: #b91c1c;
}

.check-list li.fail .check-mark {
  color: #b91c1c;
}

button.issue-active {
  border-color: #b91c1c;
  background: #fef2f2;
  color: #b91c1c;
}

/* ---------- Step 5 ---------- */

.jeppesen-input {
  width: 100%;
  min-height: 300px;
  resize: vertical;
  border: 1px solid #cbd5e1;
  border-radius: 7px;
  background: #fff;
  color: #172033;
  padding: 10px;
  font: 12px/1.5 ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
}

.filter-row {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
}

.filter-row label {
  display: inline-flex;
  grid-auto-flow: column;
  align-items: center;
  gap: 6px;
  color: #334155;
}

.filter-row input {
  width: auto;
  min-height: auto;
}

.summary-cards {
  display: grid;
  grid-template-columns: repeat(5, minmax(120px, 1fr));
  gap: 8px;
}

.metric-card {
  display: grid;
  gap: 4px;
  border: 1px solid #e2e8f0;
  border-radius: 7px;
  background: #f8fafc;
  padding: 10px;
}

.metric-card span {
  color: #64748b;
  font-size: 11px;
}

.metric-card strong {
  color: #172033;
  font-size: 18px;
}

.compare-table tr.match {
  background: #f0fdf4;
}

.compare-table tr.partial {
  background: #fffbeb;
}

.compare-table tr.mismatch {
  background: #fef2f2;
}

.compare-table tr.missing-ai,
.compare-table tr.missing-jeppesen {
  background: #f1f5f9;
}

.status-pill {
  display: inline-flex;
  align-items: center;
  min-height: 20px;
  border-radius: 999px;
  padding: 0 7px;
  font-size: 10px;
  font-weight: 700;
}

.status-pill.match {
  background: #dcfce7;
  color: #15803d;
}

.status-pill.partial {
  background: #fef3c7;
  color: #a16207;
}

.status-pill.mismatch {
  background: #fee2e2;
  color: #b91c1c;
}

.status-pill.missing-ai,
.status-pill.missing-jeppesen {
  background: #e2e8f0;
  color: #475569;
}

.raw-evidence {
  margin-top: 8px;
}

/* ---------- Step 4 ---------- */

.preview-layout {
  display: grid;
  grid-template-columns: minmax(0, 2fr) minmax(300px, 1fr);
  gap: 12px;
  align-items: start;
}

.map-frame {
  position: relative;
  height: calc(100vh - 300px);
  min-height: 420px;
  overflow: hidden;
  border: 1px solid #dbe3ef;
  border-radius: 8px;
  background: #e5e7eb;
}

.map-placeholder {
  display: grid;
  place-content: center;
  gap: 6px;
  height: 100%;
  text-align: center;
  color: #64748b;
  font-size: 12px;
}

.map-placeholder strong {
  color: #334155;
  font-size: 14px;
}

.preview-side {
  display: grid;
  gap: 10px;
}

.button-col {
  display: grid;
  gap: 8px;
}

/* ---------- shared ---------- */

.table-wrap {
  max-width: 100%;
  overflow: auto;
  border: 1px solid #e2e8f0;
  border-radius: 7px;
}

.quality-warning {
  color: #b45309;
  font-size: 12px;
}

.raw-json {
  max-height: 420px;
  overflow: auto;
}

table {
  width: 100%;
  min-width: 680px;
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

.tab-row {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
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
  font-style: normal;
}

details {
  border: 1px solid #e2e8f0;
  border-radius: 7px;
  background: #fff;
  padding: 9px;
}

details > details {
  margin-top: 8px;
}

.debug-panel {
  display: grid;
  gap: 8px;
  background: #f8fafc;
}

.debug-panel > summary {
  color: #64748b;
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
  justify-content: flex-end;
  min-width: 0;
}

.page-tabs button.active {
  border-color: #2563eb;
  background: #eff6ff;
  color: #1d4ed8;
}

.pdf-page-frame {
  position: relative;
  height: calc(100vh - 330px);
  min-height: 420px;
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

@media (max-width: 1080px) {
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

  .stepper {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .grouping-layout,
  .preview-layout {
    grid-template-columns: 1fr;
  }

  .map-frame {
    height: 60vh;
  }

  .form-grid,
  .meta-grid,
  .manifest-grid,
  .summary-cards {
    grid-template-columns: 1fr;
  }
}
</style>
