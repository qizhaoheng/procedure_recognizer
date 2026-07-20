<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import AgentResultMap from "../../components/agent/AgentResultMap.vue";
import { agentRequest } from "../../services/agentApi";
const route = useRoute(),
  router = useRouter(),
  id = String(route.params.taskId);
const task = ref<any>();
const selectedId = ref("");
const checked = ref<string[]>([]);
const error = ref("");
const saving = ref(false);
// 右侧常驻区域留给 424 / 对比 / 识别结果；航迹图改为按钮弹窗。
const resultTab = ref<"424" | "compare" | "result" | "overlay">("424");
const mapModalOpen = ref(false);
const resultBundles = ref<Record<string, any>>({});
const overlayBundles = ref<Record<string, any>>({});
const compareState = ref<{ open: boolean; text: string; running: boolean; report?: any; error?: string }>({ open: false, text: "", running: false });
const debugOpen = ref(false);
const ROUTE_TYPES = [
  { value: "RUNWAY_TRANSITION", label: "跑道过渡" },
  { value: "COMMON_ROUTE", label: "公共航段" },
  { value: "ENROUTE_TRANSITION", label: "航路过渡" },
  { value: "APPROACH_TRANSITION", label: "进近过渡" },
  { value: "FINAL_APPROACH", label: "最后进近" },
  { value: "MISSED_APPROACH", label: "复飞" },
  { value: "OTHER", label: "其他" },
];
const visibleRouteTypes = ref<string[]>(ROUTE_TYPES.map((t) => t.value));
const resultLoading = ref(false);
const selectedLegId = ref("");
const pdfPreview = ref<{
  documentId: string;
  fileName: string;
  pageNumber: number;
  mode: "document" | "page";
}>();
const packageFeedback = ref<Record<string, { state: string; message: string }>>(
  {},
);
let timer: number | undefined;
let disposed = false;
const parsedDocuments = computed(
  () =>
    task.value?.documents?.filter((d: any) => d.parseStatus === "PARSED")
      .length || 0,
);
const failedDocuments = computed(
  () =>
    task.value?.documents?.filter((d: any) => d.parseStatus === "FAILED")
      .length || 0,
);
const selected = computed(
  () =>
    task.value?.packages?.find((p: any) => p.packageId === selectedId.value) ||
    task.value?.packages?.[0],
);
const selectedBundle = computed(() =>
  selected.value ? resultBundles.value[selected.value.packageId] : undefined,
);
const selectedResult = computed(() => selectedBundle.value?.result);
const selectedPir = computed(() => selectedResult.value?.pir);
const selectedOverlay = computed(() =>
  selectedResult.value ? overlayBundles.value[selectedResult.value.procedureId] : undefined,
);
const selectedValidations = computed(() => selectedResult.value?.validations || []);
// "源上有、结果没有"单独成组：这是最需要人去补的一类，混在通用校验里会被淹没。
const completenessFindings = computed(() =>
  selectedValidations.value.filter((v: any) => String(v.ruleCode || "").startsWith("SOURCE_COMPLETENESS_")),
);
const otherValidations = computed(() =>
  selectedValidations.value.filter((v: any) => !String(v.ruleCode || "").startsWith("SOURCE_COMPLETENESS_")),
);
const validationCounts = computed(() => {
  const counts: Record<string, number> = { BLOCKER: 0, ERROR: 0, WARNING: 0, INFO: 0 };
  for (const v of selectedValidations.value) counts[v.severity] = (counts[v.severity] || 0) + 1;
  return counts;
});
const openConflicts = computed(() => (selectedPir.value?.conflicts || []).filter((c: any) => c.status === "OPEN"));
const blockingValidations = computed(() =>
  otherValidations.value.filter((v: any) => v.severity === "BLOCKER" || v.severity === "ERROR"),
);
const resolvedFixCount = computed(
  () => (selectedPir.value?.fixes || []).filter((f: any) => f.latitude != null && f.longitude != null).length,
);
function legsOfRoute(route: any) {
  return (selectedPir.value?.legs || [])
    .filter((leg: any) => leg.routeId === route.routeId)
    .sort((a: any, b: any) => a.sequence - b.sequence);
}
function constraintText(constraint: any) {
  if (!constraint) return "—";
  const unit = constraint.unit === "FL" ? "FL" : "FT";
  const one = (v: any) => (v == null ? "" : unit === "FL" ? `FL${v}` : `${v}FT`);
  switch (constraint.type) {
    case "AT": return one(constraint.altitude1);
    case "AT_OR_ABOVE": return `${one(constraint.altitude1)}+`;
    case "AT_OR_BELOW": return `${one(constraint.altitude1)}-`;
    case "BETWEEN": return `${one(constraint.altitude2)}~${one(constraint.altitude1)}`;
    default: return one(constraint.altitude1) || "—";
  }
}
const usedRouteTypes = computed(() => {
  const present = new Set((selectedPir.value?.routes || []).map((r: any) => r.routeType));
  return ROUTE_TYPES.filter((t) => present.has(t.value));
});
const selectedLeg = computed(() =>
  selectedPir.value?.legs?.find(
    (leg: any) => leg.legId === selectedLegId.value,
  ),
);
const showingResult = computed(
  () => !!selected.value && hasResult(selected.value),
);
const pdfPreviewUrl = computed(() =>
  pdfPreview.value
    ? `/api/agent/tasks/${id}/documents/${pdfPreview.value.documentId}/file#page=${pdfPreview.value.pageNumber}`
    : "",
);
const pageImageUrl = computed(() =>
  pdfPreview.value
    ? `/api/agent/tasks/${id}/documents/${pdfPreview.value.documentId}/pages/${pdfPreview.value.pageNumber}/image`
    : "",
);
const groupedPages = computed(() => {
  const map = new Map<string, any[]>();
  for (const page of selected.value?.packagePages || []) {
    const arr = map.get(page.documentId) || [];
    arr.push(page);
    map.set(page.documentId, arr);
  }
  return [...map.entries()];
});
const availablePages = computed(
  () =>
    task.value?.pages?.filter(
      (p: any) =>
        !selected.value?.packagePages?.some(
          (r: any) =>
            r.documentId === p.documentId && r.pageNumber === p.pageNumber,
        ),
    ) || [],
);
onMounted(async () => {
  await load();
  schedulePoll();
});
onBeforeUnmount(() => {
  disposed = true;
  clearTimeout(timer);
});
function schedulePoll() {
  if (disposed) return;
  timer = window.setTimeout(async () => {
    await load(true);
    schedulePoll();
  }, 3000);
}
async function load(bg = false) {
  try {
    task.value = await agentRequest(`/tasks/${id}?view=workspace`);
    if (!selectedId.value && task.value.packages?.length)
      selectedId.value = task.value.packages[0].packageId;
    for (const pkg of task.value.packages || []) {
      if (["PLANNING", "RECOGNIZING", "VALIDATING"].includes(pkg.status)) {
        packageFeedback.value[pkg.packageId] = {
          state: pkg.status,
          message: statusText(pkg.status),
        };
      } else if (
        ["COMPLETED", "COMPLETED_WITH_WARNINGS", "FAILED"].includes(pkg.status)
      ) {
        delete packageFeedback.value[pkg.packageId];
      }
    }
    if (selected.value && hasResult(selected.value))
      await loadResult(selected.value.packageId);
    if (!bg) error.value = "";
  } catch (e) {
    error.value = msg(e);
  }
}
async function patch(values: any) {
  if (!selected.value) return;
  saving.value = true;
  try {
    await agentRequest(`/packages/${selected.value.packageId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(values),
    });
    await load();
  } catch (e) {
    error.value = msg(e);
  } finally {
    saving.value = false;
  }
}
function removePage(page: any) {
  patch({
    packagePages: selected.value.packagePages.filter(
      (p: any) =>
        !(p.documentId === page.documentId && p.pageNumber === page.pageNumber),
    ),
  });
}
function addPage(key: string) {
  const [documentId, page] = key.split(":");
  const source = task.value.pages.find(
    (p: any) => p.documentId === documentId && p.pageNumber === +page,
  );
  if (!source) return;
  patch({
    packagePages: [
      ...selected.value.packagePages,
      {
        documentId,
        fileName: source.fileName,
        pageNumber: +page,
        pageRole: "RELATED",
        isShared: false,
        confidence: 1,
      },
    ],
  });
}
async function analyze() {
  try {
    await agentRequest(`/tasks/${id}/packages/reanalyze`, { method: "POST" });
    await load();
  } catch (e) {
    error.value = msg(e);
  }
}
async function recognize(ids: string[]) {
  const targets = task.value.packages.filter((pkg: any) =>
    ids.includes(pkg.packageId),
  );
  for (const pkg of targets) {
    packageFeedback.value[pkg.packageId] = {
      state: "STARTING",
      message: "请求已提交…",
    };
  }
  try {
    await agentRequest(`/tasks/${id}/packages/recognize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ packageIds: ids }),
    });
    for (const pkg of targets) {
      packageFeedback.value[pkg.packageId] = {
        state: "RECOGNIZING",
        message: "AI 正在识别",
      };
    }
    checked.value = [];
  } catch (e) {
    const message = msg(e);
    for (const pkg of targets) {
      packageFeedback.value[pkg.packageId] = { state: "ERROR", message };
    }
    error.value = message;
  }
}
async function actOnPackage(pkg: any) {
  await selectPackage(pkg);
  if (hasResult(pkg)) {
    return;
  }
  await recognize([pkg.packageId]);
}
async function selectPackage(pkg: any) {
  selectedId.value = pkg.packageId;
  selectedLegId.value = "";
  if (hasResult(pkg)) await loadResult(pkg.packageId);
}
async function loadResult(packageId: string) {
  if (resultBundles.value[packageId]) {
    selectedLegId.value =
      resultBundles.value[packageId]?.result?.pir?.legs?.[0]?.legId || "";
    return;
  }
  resultLoading.value = true;
  try {
    const bundle = await agentRequest(`/packages/${packageId}/result`);
    resultBundles.value[packageId] = bundle;
    selectedLegId.value = bundle?.result?.pir?.legs?.[0]?.legId || "";
    if (bundle?.result?.procedureId) void loadOverlays(bundle.result.procedureId);
  } catch (e) {
    error.value = msg(e);
  } finally {
    resultLoading.value = false;
  }
}
async function loadOverlays(procedureId: string) {
  try {
    overlayBundles.value[procedureId] = await agentRequest(`/procedures/${procedureId}/overlays`);
  } catch {
    /* overlay artifacts are optional */
  }
}
function evidenceOf(ids?: string[]) {
  const all = selectedPir.value?.sourceEvidence || [];
  return (ids || []).map((id: string) => all.find((e: any) => e.evidenceId === id)).filter(Boolean);
}
function openEvidence(evidence: any) {
  if (evidence?.documentId && evidence?.pageNumber) openPage(evidence.documentId, evidence.pageNumber);
}
async function runCompare424() {
  if (!selectedResult.value || !compareState.value.text.trim()) return;
  compareState.value.running = true;
  compareState.value.error = undefined;
  try {
    compareState.value.report = await agentRequest(
      `/procedures/${selectedResult.value.procedureId}/compare-424`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ referenceText: compareState.value.text }) },
    );
  } catch (e) {
    compareState.value.error = msg(e);
  } finally {
    compareState.value.running = false;
  }
}
function toggleRouteType(value: string) {
  visibleRouteTypes.value = visibleRouteTypes.value.includes(value)
    ? visibleRouteTypes.value.filter((v) => v !== value)
    : [...visibleRouteTypes.value, value];
}
function openPdf(documentId: string, pageNumber: number) {
  pdfPreview.value = {
    documentId,
    fileName: docName(documentId),
    pageNumber,
    mode: "document",
  };
}
function openPage(documentId: string, pageNumber: number) {
  pdfPreview.value = {
    documentId,
    fileName: docName(documentId),
    pageNumber,
    mode: "page",
  };
}
function fixName(fixId?: string) {
  return (
    selectedPir.value?.fixes?.find((fix: any) => fix.fixId === fixId)
      ?.identifier ||
    fixId ||
    "—"
  );
}
// 是否真的有识别产物，由后端给出。不要退回用 status 推断：REQUIRES_REVIEW 只说明
// 校验发现问题，一个从未识别过的包也可能带着别的状态，用状态猜会把"没结果"说成"有结果"。
function hasResult(pkg: any) {
  return pkg.hasResult === true;
}
function isPackageRunning(pkg: any) {
  return ["STARTING", "PLANNING", "RECOGNIZING", "VALIDATING"].includes(
    packageFeedback.value[pkg.packageId]?.state || pkg.status,
  );
}
function anotherPackageRunning(pkg: any) {
  return (task.value?.packages || []).some(
    (item: any) => item.packageId !== pkg.packageId && isPackageRunning(item),
  );
}
function packageAction(pkg: any) {
  if (pkg.status === "REQUIRES_REVIEW" && hasResult(pkg)) return "需复核";
  if (hasResult(pkg)) return "识别完成";
  if (isPackageRunning(pkg)) return "识别中…";
  if (pkg.status === "FAILED") return "重新识别";
  return "识别此程序包";
}
// 来源质量：预检在识别之前跑出的结论，描述"源页齐不齐"，与识别结果无关。
const SOURCE_ISSUE_LABELS: Record<string, string> = {
  CHART_MISSING: "缺航图",
  TABLE_MISSING: "缺编码表",
  COORDINATE_SOURCE_MISSING: "缺坐标源",
  RUNWAY_DATA_MISSING: "缺跑道数据",
  NAVAID_DATA_MISSING: "缺导航台数据",
  PROCEDURE_IDENTITY_UNCLEAR: "程序身份不明确",
  PROCEDURE_CATEGORY_UNCLEAR: "程序类别不明确",
  CROSS_PROCEDURE_PACKAGE: "多个程序混在一个包",
  CHART_PAGE_NOT_IN_CORPUS: "航图页不在文档中",
};
function sourceIssues(pkg: any) {
  const preflight = pkg.preflight;
  if (!preflight) return [];
  return [...(preflight.blockingIssues || []), ...(preflight.warnings || [])]
    .map((issue: any) => SOURCE_ISSUE_LABELS[issue.code] || issue.code)
    .filter((label: string, index: number, all: string[]) => all.indexOf(label) === index);
}
function statusText(status: string) {
  const labels: Record<string, string> = {
    GROUPED: "待识别",
    PLAN_COMPLETED: "方案已就绪",
    STARTING: "请求已提交…",
    PLANNING: "正在制定识别方案",
    RECOGNIZING: "AI 正在识别",
    VALIDATING: "正在校验并生成结果",
    COMPLETED: "识别完成",
    COMPLETED_WITH_WARNINGS: "识别完成，有警告",
    REQUIRES_REVIEW: "需复核（存在校验错误）",
    FAILED: "识别失败",
  };
  return labels[status] || status;
}
async function removePackage() {
  if (!selected.value) return;
  await agentRequest(`/packages/${selected.value.packageId}`, {
    method: "DELETE",
  });
  selectedId.value = "";
  await load();
}
function toggle(id: string) {
  checked.value = checked.value.includes(id)
    ? checked.value.filter((x) => x !== id)
    : [...checked.value, id];
}
function docName(docId: string) {
  return (
    task.value.documents.find((d: any) => d.documentId === docId)?.fileName ||
    docId
  );
}
function pagesForDoc(docId: string) {
  return task.value.pages.filter((p: any) => p.documentId === docId);
}
function msg(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}
</script>
<template>
  <main v-if="task" class="page">
    <header class="compact-header">
      <div class="identity">
        <button class="back" @click="router.push('/autonomous-recognition')">
          ←
        </button>
        <span class="stage-chip">程序包工作台</span>
        <h1>{{ task.airportIcao || task.taskName }}</h1>
        <p>
          {{ task.airportName }} · {{ task.documents.length }} 个文件 ·
          {{ task.packages.length }} 个程序包
        </p>
      </div>
      <div class="header-actions">
        <button :disabled="task.status === 'RUNNING'" @click="analyze">
          {{ task.stage === "FAILED" ? "修复后重新分析" : "重新分析" }}</button
        ><button
          class="primary"
          :disabled="!task.packages.length || task.status === 'RUNNING'"
          @click="
            recognize(
              checked.length
                ? checked
                : task.packages.map((p: any) => p.packageId),
            )
          "
        >
          {{
            checked.length
              ? `识别选中 ${checked.length} 项`
              : "开始识别全部程序包"
          }}
        </button>
      </div>
    </header>
    <p v-if="error" class="error">{{ error }}</p>
    <section v-if="task.stage === 'FAILED'" class="failed-state">
      <h2>分析未完成</h2>
      <p>{{ task.error || "后端分析失败，请重新分析。" }}</p>
      <div>
        已解析 {{ parsedDocuments }}/{{ task.documents.length }} 个文件
        <span v-if="failedDocuments">
          · {{ failedDocuments }} 个文件解析失败</span
        >
        · {{ task.pages.length }} 页
      </div>
      <button class="primary" @click="analyze">重新分析</button>
    </section>
    <section v-else-if="task.stage === 'ANALYZING'" class="analyzing">
      <div class="spinner"></div>
      <h2>AI 正在分析全部机场文件</h2>
      <p>正在识别文件关系并划分逻辑飞行程序包…</p>
    </section>
    <section v-else :class="['workspace', { 'has-result': showingResult }]">
      <aside>
        <div v-for="category in ['SID', 'STAR', 'APPROACH']" :key="category">
          <h3>{{ category }}</h3>
          <div
            v-for="pkg in task.packages.filter(
              (p: any) => p.procedureCategory === category,
            )"
            :key="pkg.packageId"
            :class="[
              'package-row',
              { active: selected?.packageId === pkg.packageId },
            ]"
          >
            <input
              type="checkbox"
              :checked="checked.includes(pkg.packageId)"
              @click="toggle(pkg.packageId)"
            />
            <button class="package-select" @click="selectPackage(pkg)">
              <b>{{ pkg.procedureName }}</b>
              <small>
                RWY {{ pkg.runways.join(", ") || "—" }} ·
                {{ pkg.packagePages.length }} 页
              </small>
              <!-- 来源质量与生命周期状态是两条独立的轴，分开显示，不要挤进状态徽章 -->
              <span v-if="sourceIssues(pkg).length" class="source-quality">
                {{ sourceIssues(pkg).join(" · ") }}
              </span>
              <em
                :class="{
                  running: isPackageRunning(pkg),
                  failed: pkg.status === 'FAILED',
                }"
              >
                {{
                  packageFeedback[pkg.packageId]?.message ||
                  statusText(pkg.status)
                }}
              </em>
            </button>
            <button
              class="package-action"
              :class="{
                result: hasResult(pkg) && pkg.status !== 'REQUIRES_REVIEW',
                review: hasResult(pkg) && pkg.status === 'REQUIRES_REVIEW',
              }"
              :disabled="isPackageRunning(pkg) || anotherPackageRunning(pkg)"
              @click="actOnPackage(pkg)"
            >
              {{ packageAction(pkg) }}
            </button>
          </div>
        </div>
      </aside>
      <section v-if="selected" class="sources">
        <div class="title">
          <div>
            <span>{{ selected.procedureCategory }}</span>
            <h2>{{ selected.procedureName }}</h2>
          </div>
          <button
            v-if="!showingResult"
            class="primary"
            :disabled="
              isPackageRunning(selected) || anotherPackageRunning(selected)
            "
            @click="actOnPackage(selected)"
          >
            {{ packageAction(selected) }}
          </button>
        </div>
        <div
          v-if="packageFeedback[selected.packageId]"
          :class="[
            'package-feedback',
            packageFeedback[selected.packageId].state,
          ]"
        >
          <span v-if="isPackageRunning(selected)" class="mini-spinner"></span>
          {{ packageFeedback[selected.packageId].message }}
        </div>
        <template v-if="!showingResult">
          <div
            v-for="[docId, pages] in groupedPages"
            :key="docId"
            class="document"
          >
            <button
              class="pdf-link"
              @click="openPdf(docId, pages[0]?.pageNumber || 1)"
            >
              <span>PDF</span>{{ docName(docId) }}
            </button>
            <div class="page-chips">
              <span v-for="page in pages" :key="page.pageNumber">
                <button
                  class="page-open"
                  :title="`仅预览第 ${page.pageNumber} 页`"
                  @click="openPage(docId, page.pageNumber)"
                >
                  P{{ page.pageNumber }} · {{ page.pageRole }}
                </button>
                <button aria-label="移除页面" @click="removePage(page)">
                  ×
                </button>
              </span>
            </div>
          </div>
          <div class="add">
            <select
              @change="
                addPage(($event.target as HTMLSelectElement).value);
                ($event.target as HTMLSelectElement).value = '';
              "
            >
              <option value="">+ 向程序包增加页面</option>
              <optgroup
                v-for="doc in task.documents"
                :key="doc.documentId"
                :label="doc.fileName"
              >
                <option
                  v-for="page in availablePages.filter(
                    (p: any) => p.documentId === doc.documentId,
                  )"
                  :key="page.pageNumber"
                  :value="`${doc.documentId}:${page.pageNumber}`"
                >
                  P{{ page.pageNumber }} {{ page.title }}
                </option>
              </optgroup>
            </select>
          </div>
        </template>
        <section v-else class="inline-result">
          <div class="result-sources">
            <div
              v-for="[docId, pages] in groupedPages"
              :key="docId"
              class="result-source-doc"
            >
              <button class="pdf-link" @click="openPdf(docId, pages[0]?.pageNumber || 1)">
                <span>PDF</span>{{ docName(docId) }}
              </button>
              <div class="page-chips">
                <span v-for="page in pages" :key="page.pageNumber">
                  <button
                    class="page-open"
                    :title="`仅预览第 ${page.pageNumber} 页`"
                    @click="openPage(docId, page.pageNumber)"
                  >
                    P{{ page.pageNumber }} · {{ page.pageRole }}
                  </button>
                </span>
              </div>
            </div>
          </div>
          <div v-if="resultLoading" class="result-loading">
            <span class="mini-spinner"></span>正在加载识别结果…
          </div>
          <template v-else-if="selectedResult">
            <div class="result-stats">
              <span
                >Route <b>{{ selectedPir?.routes?.length || 0 }}</b></span
              >
              <span
                >Leg <b>{{ selectedPir?.legs?.length || 0 }}</b></span
              >
              <span
                >Fix <b>{{ selectedPir?.fixes?.length || 0 }}</b></span
              >
              <span
                :class="[
                  'candidate-state',
                  selectedResult.candidate424?.status,
                ]"
                >{{ selectedResult.candidate424?.status }}</span
              >
              <span
                v-if="validationCounts.BLOCKER || validationCounts.ERROR"
                class="quality-flag bad"
                >⛔ {{ validationCounts.BLOCKER }} BLOCKER ·
                {{ validationCounts.ERROR }} ERROR</span
              >
              <span v-else-if="validationCounts.WARNING" class="quality-flag warn"
                >⚠ {{ validationCounts.WARNING }} 警告</span
              >
              <span
                v-if="selectedPir?.quality?.unresolvedFields?.length"
                class="quality-flag warn"
                >{{ selectedPir.quality.unresolvedFields.length }} 个未解决字段</span
              >
            </div>
            <button class="open-map" @click="mapModalOpen = true">
              打开航迹图
              <small>{{ (selectedResult.geojson?.features?.length || 0) }} 个要素</small>
            </button>
          </template>
          <div v-else class="result-loading">该程序包尚无识别结果。</div>
        </section>
      </section>
      <aside v-if="selected && showingResult" class="info">
        <div class="result-side-title">
          <h2>识别结果</h2>
          <span>{{ statusText(selected.status) }}</span>
        </div>
        <nav class="result-tabs">
          <button
            :class="{ active: resultTab === '424' }"
            @click="resultTab = '424'"
          >
            ARINC 424
          </button>
          <button
            :class="{ active: resultTab === 'compare' }"
            @click="resultTab = 'compare'"
          >
            Jeppesen 对比
          </button>
          <button
            :class="{ active: resultTab === 'result' }"
            @click="resultTab = 'result'"
          >
            识别结果
          </button>
          <button
            :class="{ active: resultTab === 'overlay' }"
            @click="resultTab = 'overlay'"
          >
            原图叠加
          </button>
          <!-- 地图移出常驻区域：右侧留给 424 与对比，地图按需弹出 -->
          <button class="map-open" @click="mapModalOpen = true">航迹图</button>
        </nav>
        <section v-if="resultLoading" class="result-loading">正在加载…</section>
        <section
          v-else-if="selectedResult && resultTab === 'result'"
          class="inline-result"
        >
          <div class="summary">
            <p><span>航路</span><b>{{ selectedPir?.routes?.length || 0 }}</b></p>
            <p><span>航段</span><b>{{ selectedPir?.legs?.length || 0 }}</b></p>
            <p><span>航路点</span><b>{{ resolvedFixCount }}/{{ selectedPir?.fixes?.length || 0 }}</b></p>
          </div>
          <div v-for="route in selectedPir?.routes || []" :key="route.routeId" class="result-route">
            <h4>{{ route.identifier }}<em>{{ route.routeType }}</em></h4>
            <p v-if="route.climbGradient?.percent" class="climb-gradient">
              最低爬升梯度 {{ route.climbGradient.percent }}%<template v-if="route.climbGradient.untilAltitudeFt">，直至通过 {{ route.climbGradient.untilAltitudeFt }} FT</template>
            </p>
            <table>
              <tr v-for="leg in legsOfRoute(route)" :key="leg.legId">
                <td class="seq">{{ leg.sequence }}</td>
                <td class="pt">{{ leg.pathTerminator }}</td>
                <td>{{ fixName(leg.fromFixId) }} → {{ fixName(leg.toFixId) }}</td>
                <td class="num">{{ leg.course ?? "—" }}°</td>
                <td class="num">{{ leg.distanceNm ?? "—" }} NM</td>
                <td class="alt">{{ constraintText(leg.altitudeConstraint) }}</td>
              </tr>
            </table>
          </div>
          <!-- 第 5 点要求的"提示缺失信息"保留在这里：校验标签去掉了，但源页比对的缺失清单
               是这套流程最该让人看到的产出，不该跟着标签一起消失。 -->
          <section v-if="completenessFindings.length" class="completeness-block">
            <h4>源页比对：结果中缺失的内容（{{ completenessFindings.length }}）</h4>
            <p class="completeness-note">由 AI 读原始页面得出，供人复核——它与识别同源，不作为拒出依据。</p>
            <p v-for="(v, i) in completenessFindings" :key="i" class="finding">{{ v.message }}</p>
          </section>
          <p v-if="blockingValidations.length" class="blocking-summary">
            另有 {{ blockingValidations.length }} 项规则校验未通过：{{ blockingValidations.map((v: any) => v.ruleCode).join("、") }}
          </p>
        </section>
        <section
          v-else-if="selectedResult && resultTab === 'compare'"
          class="inline-compare"
        >
          <p class="compare-hint">粘贴同一程序的 Jeppesen 424 参考记录，逐字段比对识别结果。</p>
          <textarea
            v-model="compareState.text"
            rows="8"
            placeholder="粘贴参考 424 静态文本（132 列记录）"
          ></textarea>
          <button
            class="primary"
            :disabled="compareState.running || !compareState.text.trim() || !selectedResult.candidate424?.text"
            @click="runCompare424"
          >
            {{ compareState.running ? "对比中…" : "运行对比" }}
          </button>
          <p v-if="!selectedResult.candidate424?.text" class="compare-hint">本程序尚未生成 424，无法对比。</p>
          <p v-if="compareState.error" class="error">{{ compareState.error }}</p>
          <div v-if="compareState.report" class="compare-report">
            <p>
              <b>匹配率
                {{
                  compareState.report.matchRate == null
                    ? "—"
                    : Math.round(compareState.report.matchRate * 100) + "%"
                }}</b>
              · {{ compareState.report.matchedLegs }}/{{ compareState.report.totalLegs }} 腿匹配 ·
              {{ compareState.report.partialLegs }} 部分 ·
              {{ compareState.report.mismatchedLegs }} 不匹配
            </p>
            <div v-for="proc in compareState.report.procedureResults" :key="proc.procedureName + (proc.transitionName || '')">
              <b>{{ proc.procedureName }} {{ proc.transitionName || proc.runway }}</b>
              <p v-for="legResult in proc.legResults.filter((l: any) => l.status !== 'MATCH')" :key="legResult.sequence" class="compare-diff">
                #{{ legResult.sequence }} {{ legResult.status }}：
                {{ legResult.fieldResults.filter((f: any) => !f.matched).map((f: any) => `${f.field}: AI=${f.aiValue ?? "—"} / 424=${f.jeppesenValue ?? "—"}`).join("；") || "腿段缺失" }}
              </p>
            </div>
          </div>
        </section>
        <section v-else-if="selectedResult && resultTab === '424'" class="inline-424">
          <div class="candidate-head">
            <span
              :class="['candidate-state', selectedResult.candidate424?.status]"
              >{{ selectedResult.candidate424?.status }}</span
            >
            <small v-if="selectedResult.candidate424?.roundTrip">
              Round-trip {{ selectedResult.candidate424.roundTrip.parsedLegs }}/{{
                selectedResult.candidate424.roundTrip.emittedLegs
              }}
              腿 ·
              {{
                selectedResult.candidate424.roundTrip.fieldMismatches?.length || 0
              }}
              字段差异
            </small>
            <!-- 产出由谁生成、依据是什么，要能看见：AI 的编码判断不该埋在产物内部 -->
            <span v-if="selectedResult.candidate424?.generatedBy === 'AI'" class="generated-by">
              AI 生成
            </span>
          </div>
          <p v-if="selectedResult.candidate424?.decisionSummary" class="decision-summary">
            {{ selectedResult.candidate424.decisionSummary }}
          </p>
          <ul v-if="selectedResult.candidate424?.diffs?.length" class="generation-diffs">
            <li v-for="(diff, index) in selectedResult.candidate424.diffs" :key="index">
              <b>{{ diff.code }}</b> {{ diff.detail }}
            </li>
          </ul>
          <pre>{{
            selectedResult.candidate424?.text || "尚未生成 424 Candidate"
          }}</pre>
          <ul v-if="selectedResult.candidate424?.missingFields?.length">
            <li
              v-for="field in selectedResult.candidate424.missingFields"
              :key="field"
            >
              {{ field }}
            </li>
          </ul>
          <details v-if="selectedResult.candidate424?.roundTrip?.fieldMismatches?.length" class="mismatch-list">
            <summary>Round-trip 字段差异</summary>
            <p v-for="(m, i) in selectedResult.candidate424.roundTrip.fieldMismatches" :key="i">
              {{ m.key }} · {{ m.field }}：导出 {{ m.emitted ?? "—" }} / 回读 {{ m.reparsed ?? "—" }}
            </p>
          </details>

        </section>
        <section v-else-if="selectedResult && resultTab === 'overlay'" class="inline-overlay">
          <template v-if="selectedOverlay?.overlays?.length">
            <div v-for="(v, i) in selectedOverlay.verifications" :key="i" class="overlay-meta">
              <span :class="['candidate-state', v.status === 'VERIFIED' ? '' : '424_INCOMPLETE']">{{ v.status }}</span>
              <small v-if="v.georeference">控制点 {{ v.georeference.controlPoints }} · 残差 {{ v.georeference.meanResidualPx?.toFixed?.(1) ?? "—" }}px</small>
              <small v-if="v.overallAssessment"> · {{ v.overallAssessment }}</small>
            </div>
            <img
              v-for="name in selectedOverlay.overlays"
              :key="name"
              :src="`/api/agent/procedures/${selectedResult.procedureId}/files/${name}`"
              :alt="name"
              class="overlay-img"
            />
          </template>
          <p v-else class="result-loading">
            {{ selectedOverlay?.verifications?.length ? "叠加未完成配准（控制点不足），已标记 NOT_GEOREFERENCED。" : "该程序尚未生成原图叠加。重新识别后自动执行配准与叠加校验。" }}
          </p>
        </section>
      </aside>
    </section>
    <details class="debug-drawer" :open="debugOpen" @toggle="debugOpen = ($event.target as HTMLDetailsElement).open">
      <summary>开发调试信息（模型调用 {{ task.modelCalls?.length || 0 }} · 步骤 {{ task.steps?.length || 0 }}）</summary>
      <div class="debug-columns">
        <section>
          <h4>模型调用</h4>
          <p v-for="call in (task.modelCalls || []).slice().reverse().slice(0, 40)" :key="call.callId">
            <b>{{ call.promptName }}</b> v{{ call.promptVersion }} · {{ call.toolName || call.stepName }}
            <em v-if="call.error" class="failed">{{ call.error }}</em>
          </p>
        </section>
        <section>
          <h4>执行步骤</h4>
          <p v-for="s in (task.steps || []).slice().reverse().slice(0, 30)" :key="s.stepId">
            {{ s.name }} · {{ s.status }} · {{ s.durationMs || 0 }}ms
            <em v-if="s.error" class="failed">{{ s.error }}</em>
          </p>
        </section>
      </div>
    </details>
    <div
      v-if="pdfPreview"
      class="pdf-modal"
      @click.self="pdfPreview = undefined"
    >
      <article>
        <header>
          <div>
            <b>{{ pdfPreview.fileName }}</b
            ><span>{{
              pdfPreview.mode === "page"
                ? `仅预览第 ${pdfPreview.pageNumber} 页`
                : `从 P${pdfPreview.pageNumber} 开始预览`
            }}</span>
          </div>
          <button @click="pdfPreview = undefined">关闭</button>
        </header>
        <div v-if="pdfPreview.mode === 'page'" class="page-image">
          <img
            :src="pageImageUrl"
            :alt="`${pdfPreview.fileName} 第 ${pdfPreview.pageNumber} 页`"
          />
        </div>
        <iframe
          v-else
          :src="pdfPreviewUrl"
          :title="pdfPreview.fileName"
        ></iframe>
      </article>
    </div>
    <div v-if="mapModalOpen && selectedResult" class="modal map-modal" @click.self="mapModalOpen = false">
      <article>
        <header>
          <h3>{{ selected?.procedureName }} · 航迹图</h3>
          <div v-if="usedRouteTypes.length > 1" class="route-layers">
            <label v-for="t in usedRouteTypes" :key="t.value">
              <input
                type="checkbox"
                :checked="visibleRouteTypes.includes(t.value)"
                @change="toggleRouteType(t.value)"
              />
              {{ t.label }}
            </label>
          </div>
          <button class="close" @click="mapModalOpen = false">关闭</button>
        </header>
        <div class="map-body">
          <AgentResultMap
            :geojson="selectedResult.geojson"
            :selected-leg-id="selectedLegId"
            :visible-route-types="visibleRouteTypes"
            @select-leg="selectedLegId = $event"
          />
        </div>
      </article>
    </div>
  </main>
</template>
<style scoped>
.page {
  box-sizing: border-box;
  width: 100%;
  height: calc(100vh - 41px);
  padding: 10px 14px 14px;
  color: #102a43;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.compact-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin: 0 0 10px;
  min-height: 44px;
  flex: 0 0 auto;
}
.compact-header .identity {
  display: flex;
  align-items: center;
  gap: 9px;
  min-width: 0;
}
.compact-header button {
  border: 1px solid #c8d2df;
  background: #fff;
  padding: 7px 10px;
  border-radius: 7px;
  margin-left: 6px;
}
.compact-header .back {
  border: 0;
  margin: 0;
  padding: 6px;
  color: #52606d;
  font-size: 18px;
}
.compact-header h1 {
  margin: 0;
  font-size: 20px;
  white-space: nowrap;
}
.compact-header p {
  color: #627d98;
  margin: 0;
  white-space: nowrap;
  font-size: 12px;
}
.stage-chip {
  color: #174ea6;
  background: #e8f1ff;
  padding: 4px 7px;
  border-radius: 5px;
  font-size: 11px;
}
.primary {
  background: #1769e0 !important;
  color: #fff !important;
  border-color: #1769e0 !important;
}
.error {
  background: #fee2e2;
  color: #991b1b;
  padding: 12px;
  margin: 0 0 12px;
  flex: 0 0 auto;
}
.analyzing {
  text-align: center;
  background: #fff;
  padding: 90px;
  border-radius: 14px;
  flex: 1;
}
.failed-state {
  background: #fff;
  padding: 48px;
  border-radius: 14px;
  border-left: 5px solid #b42318;
  flex: 1;
}
.failed-state h2 {
  color: #991b1b;
}
.failed-state p {
  color: #7f1d1d;
  overflow-wrap: anywhere;
}
.failed-state div {
  color: #627d98;
  margin: 18px 0;
}
.failed-state button {
  border: 0;
  padding: 10px 16px;
  border-radius: 8px;
}
.spinner {
  width: 38px;
  height: 38px;
  border: 4px solid #dbe8f6;
  border-top-color: #1769e0;
  border-radius: 50%;
  animation: s 1s linear infinite;
  margin: auto;
}
@keyframes s {
  to {
    transform: rotate(360deg);
  }
}
.workspace {
  display: grid;
  grid-template-columns: 320px minmax(480px, 1fr);
  background: #fff;
  border-radius: 14px;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
/* 出结果后 424 是主角：中间那列只剩包头和统计，收窄让位给右侧结果区。 */
.workspace.has-result {
  grid-template-columns: 280px 300px minmax(560px, 1fr);
}
.workspace > aside,
.sources {
  padding: 20px;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
}
.workspace > aside:first-child {
  background: #f5f8fb;
}
.workspace > aside:first-child h3 {
  font-size: 12px;
  color: #829ab1;
  margin-top: 20px;
}
.package-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: start;
  gap: 7px;
  padding: 10px;
  margin-bottom: 6px;
  border-radius: 9px;
}
.package-row.active {
  background: #e6effb;
}
.package-row > input {
  margin-top: 3px;
}
.package-select {
  border: 0;
  background: none;
  padding: 0;
  text-align: left;
  min-width: 0;
  cursor: pointer;
}
.package-select b,
.package-select small,
.package-select em {
  display: block;
}
.package-select b {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.package-select small {
  color: #627d98;
  margin-top: 4px;
}
.package-select em {
  font-style: normal;
  color: #237a4b;
  font-size: 11px;
  margin-top: 5px;
}
/* 来源质量：与状态徽章视觉上分开，用中性的琥珀色表示"源页有缺"，而非错误红 */
.package-select .source-quality {
  display: block;
  font-size: 11px;
  color: #92610a;
  background: #fdf3d8;
  border-radius: 4px;
  padding: 2px 6px;
  margin-top: 5px;
}
.package-select em.running {
  color: #1769e0;
}
.package-select em.failed {
  color: #b42318;
}
.package-action {
  grid-column: 2;
  justify-self: start;
  border: 1px solid #9db9df;
  background: #fff;
  color: #174ea6;
  border-radius: 6px;
  padding: 5px 8px;
  font-size: 11px;
  cursor: pointer;
}
.package-action.result {
  background: #e7f5ed;
  border-color: #a7d7b9;
  color: #237a4b;
}
.package-action.review {
  background: #fff7e6;
  border-color: #f3d19e;
  color: #b45309;
}
.package-action:disabled,
button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}
.sources {
  border-left: 1px solid #edf1f5;
  border-right: 1px solid #edf1f5;
  display: flex;
  flex-direction: column;
}
.title {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  flex: 0 0 auto;
}
.title span {
  font-size: 11px;
  background: #e8f1ff;
  color: #174ea6;
  padding: 4px 7px;
  border-radius: 5px;
}
.title h2 {
  margin: 8px 0;
  font-size: 18px;
}
.view-tabs,
.result-tabs {
  display: flex;
  gap: 4px;
  margin-left: auto;
}
.view-tabs button,
.result-tabs button {
  border: 0;
  background: #f1f5f9;
  color: #52606d;
  padding: 7px 10px;
  border-radius: 6px;
}
.view-tabs button.active,
.result-tabs button.active {
  background: #dfeafa;
  color: #174ea6;
  font-weight: 700;
}
.package-feedback {
  display: flex;
  align-items: center;
  gap: 8px;
  background: #edf5ff;
  color: #174ea6;
  padding: 10px 12px;
  border-radius: 7px;
  margin-top: 10px;
  font-size: 12px;
}
.package-feedback.ERROR {
  background: #feeceb;
  color: #b42318;
}
.mini-spinner {
  width: 13px;
  height: 13px;
  border: 2px solid #b9d2f3;
  border-top-color: #1769e0;
  border-radius: 50%;
  animation: s 1s linear infinite;
}
.document {
  margin-top: 14px;
  padding: 13px;
  background: #f5f8fb;
  border-radius: 9px;
}
.pdf-link {
  display: flex;
  align-items: center;
  gap: 9px;
  border: 0;
  background: none;
  color: #174ea6;
  padding: 0;
  font-weight: 700;
  cursor: pointer;
  text-align: left;
}
.pdf-link span {
  background: #dfeafa;
  padding: 5px 6px;
  border-radius: 5px;
  font-size: 10px;
}
.page-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
  margin-top: 10px;
}
.page-chips > span {
  background: #fff;
  border: 1px solid #d8e1ea;
  border-radius: 6px;
  padding: 5px 7px;
  font-size: 10px;
  color: #627d98;
}
.page-chips button {
  border: 0;
  color: #b42318;
  background: none;
  padding: 0 0 0 5px;
  cursor: pointer;
}
.page-chips .page-open {
  color: #174ea6;
  padding: 0;
  font-size: inherit;
}
.page-chips .page-open:hover {
  text-decoration: underline;
}
.result-sources {
  flex: 0 0 auto;
  margin-bottom: 8px;
}
.result-source-doc {
  padding: 9px 12px;
  background: #f5f8fb;
  border-radius: 9px;
  margin-bottom: 6px;
}
.result-source-doc .page-chips {
  margin-top: 7px;
}
.add select,
.info input,
.info select {
  width: 100%;
  box-sizing: border-box;
  padding: 10px;
  border: 1px solid #ccd6e0;
  border-radius: 7px;
  margin-top: 15px;
}
.info label {
  display: block;
  margin-top: 16px;
  font-size: 12px;
  color: #52606d;
}
.info p {
  color: #627d98;
  line-height: 1.6;
}
.warning {
  background: #fff7e6;
  padding: 10px;
}
.plan ol {
  padding-left: 18px;
  color: #52606d;
}
.danger {
  border: 0;
  background: none;
  color: #b42318;
  margin-top: 25px;
}
@media (max-width: 1100px) {
  .workspace {
    grid-template-columns: 250px minmax(420px, 1fr);
  }
  .workspace.has-result {
    grid-template-columns: 220px 260px minmax(440px, 1fr);
  }
  .page {
    padding: 14px;
  }
}
.inline-result {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  margin-top: 8px;
}
.result-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-height: 90px;
  color: #627d98;
}
.result-stats {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  flex: 0 0 auto;
}
.result-stats > span {
  background: #f1f5f9;
  padding: 6px 9px;
  border-radius: 6px;
  color: #627d98;
  font-size: 11px;
}
.result-stats b {
  color: #102a43;
  margin-left: 4px;
}
.open-map {
  align-self: flex-start;
  border: 1px solid #c8d2df;
  background: #fff;
  border-radius: 8px;
  padding: 9px 14px;
  font-size: 13px;
  cursor: pointer;
}
.open-map small {
  color: #627d98;
  margin-left: 8px;
  font-size: 11px;
}
.map-modal {
  position: fixed;
  inset: 0;
  z-index: 2000;
  display: grid;
  place-items: center;
  background: #102a4370;
}
.map-modal article {
  width: min(1180px, 94vw);
  height: min(860px, 92vh);
  display: flex;
  flex-direction: column;
  background: #fff;
  border-radius: 12px;
  overflow: hidden;
  box-shadow: 0 18px 50px #102a4340;
}
.map-modal header {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 11px 14px;
  border-bottom: 1px solid #dfe6ee;
}
.map-modal header h3 {
  margin: 0;
  font-size: 14px;
}
.map-modal header .close {
  margin-left: auto;
  border: 1px solid #c8d2df;
  background: #fff;
  border-radius: 6px;
  padding: 7px 10px;
}
.map-modal .map-body {
  flex: 1;
  min-height: 0;
}
.map-modal .map-body :deep(.map) {
  min-height: 0;
  height: 100%;
}
.result-tabs .map-open {
  margin-left: auto;
}
.inline-result .summary {
  display: flex;
  gap: 16px;
  padding-bottom: 8px;
  border-bottom: 1px solid #edf1f5;
}
.inline-result .summary p {
  margin: 0;
  font-size: 11px;
  color: #627d98;
}
.inline-result .summary b {
  display: block;
  font-size: 16px;
  color: #102a43;
}
.result-route h4 {
  margin: 12px 0 4px;
  font-size: 13px;
}
.result-route h4 em {
  color: #627d98;
  font-size: 11px;
  font-style: normal;
  margin-left: 6px;
}
.result-route .climb-gradient {
  margin: 0 0 4px;
  font-size: 11px;
  color: #b45309;
}
.result-route table {
  width: 100%;
  border-collapse: collapse;
  font-size: 11px;
}
.result-route td {
  padding: 3px 4px;
  border-bottom: 1px solid #f1f5f9;
}
.result-route .seq,
.result-route .pt {
  color: #627d98;
  white-space: nowrap;
}
.result-route .num,
.result-route .alt {
  text-align: right;
  white-space: nowrap;
}
.blocking-summary {
  margin-top: 12px;
  font-size: 11px;
  color: #b42318;
}
.inline-compare .compare-hint {
  font-size: 11px;
  color: #627d98;
}
.inline-compare textarea {
  width: 100%;
  box-sizing: border-box;
  margin: 8px 0;
  font-family: monospace;
  font-size: 10px;
  border: 1px solid #ccd6e0;
  border-radius: 7px;
  padding: 8px;
}
.candidate-state {
  display: inline-block;
  background: #e7f5ed !important;
  color: #237a4b !important;
  padding: 5px 7px !important;
  border-radius: 5px;
  font-size: 10px !important;
}
.candidate-state.\34 24_INCOMPLETE {
  background: #feeceb !important;
  color: #b42318 !important;
}
.result-side-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.result-side-title h2 {
  margin: 0;
}
.result-side-title span {
  font-size: 11px;
  color: #237a4b;
}
.result-tabs {
  margin: 12px 0 8px;
}
.result-tabs button {
  flex: 1;
}
.inline-legs > button {
  display: grid;
  width: 100%;
  border: 0;
  border-bottom: 1px solid #edf1f5;
  background: #fff;
  text-align: left;
  padding: 9px;
}
.inline-legs > button.active {
  background: #eaf2fd;
}
.inline-legs > button span,
.inline-legs > button em {
  color: #627d98;
  font-size: 11px;
  font-style: normal;
  margin-top: 3px;
}
.selected-leg-detail {
  display: grid;
  grid-template-columns: 1fr 1.4fr;
  gap: 7px;
  background: #f5f8fb;
  padding: 10px;
}
.selected-leg-detail dt {
  color: #627d98;
}
.selected-leg-detail dd {
  margin: 0;
}
/* 132 列定宽记录：换行会毁掉列对齐，宁可横向滚动也要保持一行一记录。 */
.inline-424 pre {
  white-space: pre;
  background: #10233e;
  color: #dcecff;
  padding: 10px;
  max-height: calc(100vh - 260px);
  overflow: auto;
  font-family: ui-monospace, "Cascadia Mono", Consolas, monospace;
  font-size: 11px;
  line-height: 1.5;
  tab-size: 4;
}
.pdf-modal {
  position: fixed;
  inset: 0;
  z-index: 2000;
  display: grid;
  place-items: center;
  background: #102a4370;
}
.pdf-modal article {
  width: min(1180px, 94vw);
  height: min(860px, 92vh);
  display: flex;
  flex-direction: column;
  background: #fff;
  border-radius: 12px;
  overflow: hidden;
  box-shadow: 0 18px 50px #102a4340;
}
.pdf-modal header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 11px 14px;
  border-bottom: 1px solid #dfe6ee;
}
.pdf-modal header b,
.pdf-modal header span {
  display: block;
}
.pdf-modal header span {
  color: #627d98;
  font-size: 11px;
  margin-top: 3px;
}
.pdf-modal header button {
  border: 1px solid #c8d2df;
  background: #fff;
  border-radius: 6px;
  padding: 7px 10px;
}
.pdf-modal iframe {
  flex: 1;
  width: 100%;
  border: 0;
}
.quality-flag {
  padding: 6px 9px;
  border-radius: 6px;
  font-size: 11px;
}
.quality-flag.bad {
  background: #feeceb;
  color: #b42318;
}
.quality-flag.warn {
  background: #fff7e6;
  color: #b45309;
}
.route-layers {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  padding: 6px 2px;
  font-size: 12px;
  color: #334e68;
  flex: 0 0 auto;
}
.route-layers label {
  display: flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
}
.result-tabs button.alert {
  color: #b42318;
  font-weight: 700;
}
.candidate-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.candidate-head small {
  color: #627d98;
}
.completeness-block {
  border: 1px solid #f0d9a8;
  border-radius: 8px;
  padding: 12px;
  margin-bottom: 14px;
  background: #fffdf7;
}
.completeness-block h4 {
  margin: 0 0 4px;
  font-size: 13px;
  color: #7a4f01;
}
.completeness-note {
  margin: 0 0 10px;
  font-size: 11px;
  color: #92610a;
}
.generated-by {
  font-size: 11px;
  color: #174ea6;
  background: #e8f1ff;
  border-radius: 4px;
  padding: 2px 6px;
}
.decision-summary {
  color: #486581;
  font-size: 12px;
  line-height: 1.6;
  margin: 8px 0 0;
  white-space: pre-wrap;
}
/* 生成偏差用中性琥珀色：它是"待人复核"，不是"这条已经错了" */
.generation-diffs {
  background: #fdf3d8;
  border-radius: 6px;
  padding: 10px 10px 10px 26px;
  margin-top: 8px;
  font-size: 12px;
  color: #7a4f01;
}
.generation-diffs b {
  font-family: ui-monospace, monospace;
  margin-right: 6px;
}
.mismatch-list {
  background: #fff7e6;
  padding: 8px;
  border-radius: 7px;
  font-size: 11px;
  margin-top: 8px;
}
.compare-block {
  margin-top: 14px;
  border-top: 1px solid #edf1f5;
  padding-top: 10px;
}
.compare-block .compare {
  width: 100%;
  border: 1px solid #c8d2df;
  background: #fff;
  padding: 8px;
  border-radius: 7px;
}
.compare-block textarea {
  width: 100%;
  box-sizing: border-box;
  margin: 8px 0;
  font-family: monospace;
  font-size: 10px;
  border: 1px solid #ccd6e0;
  border-radius: 7px;
  padding: 8px;
}
.compare-report {
  background: #f5f8fb;
  padding: 10px;
  border-radius: 7px;
  margin-top: 8px;
  font-size: 12px;
}
.compare-diff {
  color: #b45309;
  margin: 3px 0;
  font-size: 11px;
}
.inline-quality .validation {
  border: 1px solid #e2e8f0;
  border-left: 4px solid #94a3b8;
  border-radius: 7px;
  padding: 9px;
  margin-bottom: 8px;
  font-size: 12px;
}
.inline-quality .validation.BLOCKER {
  border-left-color: #b42318;
  background: #fef2f2;
}
.inline-quality .validation.ERROR {
  border-left-color: #ea580c;
  background: #fff7ed;
}
.inline-quality .validation.WARNING {
  border-left-color: #d97706;
}
.inline-quality .validation header {
  display: flex;
  gap: 7px;
  align-items: center;
}
.inline-quality .severity {
  font-size: 10px;
  background: #e2e8f0;
  padding: 2px 5px;
  border-radius: 4px;
}
.inline-quality .validation p {
  margin: 5px 0 0;
}
.inline-quality .validation small {
  color: #829ab1;
}
.evidence-links button {
  border: 1px solid #aac4e6;
  background: #eff6ff;
  color: #174ea6;
  border-radius: 5px;
  padding: 3px 7px;
  font-size: 10px;
  margin: 6px 4px 0 0;
  cursor: pointer;
}
.candidate-row {
  font-size: 11px;
  color: #52606d;
}
.unresolved-field {
  font-size: 11px;
  color: #b45309;
  margin: 3px 0;
  font-family: monospace;
}
.quality-ok {
  color: #237a4b;
  background: #e7f5ed;
  padding: 10px;
  border-radius: 7px;
}
.inline-overlay .overlay-img {
  width: 100%;
  border: 1px solid #dbe4ee;
  border-radius: 7px;
  margin-top: 8px;
}
.overlay-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  color: #627d98;
}
.debug-drawer {
  margin-top: 10px;
  flex: 0 0 auto;
  background: #fff;
  border-radius: 10px;
  padding: 8px 14px;
  color: #52606d;
  font-size: 12px;
}
.debug-drawer summary {
  cursor: pointer;
  color: #829ab1;
}
.debug-columns {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
  max-height: 260px;
  overflow: auto;
  margin-top: 8px;
}
.debug-columns p {
  margin: 4px 0;
  border-bottom: 1px solid #f1f5f9;
  padding-bottom: 4px;
}
.debug-columns .failed {
  color: #b42318;
  display: block;
  font-style: normal;
}
.pdf-modal .page-image {
  flex: 1;
  min-height: 0;
  overflow: auto;
  background: #eef2f6;
  padding: 14px;
}
.pdf-modal .page-image img {
  display: block;
  width: 100%;
  box-shadow: 0 3px 16px #102a4326;
}
</style>
