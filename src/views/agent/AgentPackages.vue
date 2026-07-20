<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import AgentResultMap from "../../components/agent/AgentResultMap.vue";
import { agentRequest } from "../../services/agentApi";
const route = useRoute(),
  router = useRouter(),
  id = String(route.params.taskId);
const task = ref<any>();
const production = ref<any>();
const selectedId = ref("");
const checked = ref<string[]>([]);
const error = ref("");
const saving = ref(false);
// 右侧常驻区域留给 424 / 对比 / 识别结果；航迹图改为按钮弹窗。
const resultTab = ref<"424" | "result" | "overlay">("424");
const mapModalOpen = ref(false);
const resultBundles = ref<Record<string, any>>({});
const overlayBundles = ref<Record<string, any>>({});
const compareState = ref<{ open: boolean; text: string; running: boolean; report?: any; error?: string }>({ open: false, text: "", running: false });
// 对比暂时收起。后端接口和 runCompare424 都留着，改回 true 即恢复。
const COMPARE_VISIBLE = false;
const showRuler = ref(true);
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
const productionByPackage = computed(() => new Map(
  (production.value?.assessments || []).map((item: any) => [item.packageId, item]),
));
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
  // 限制类型有、高度值没有时不能只印一个 "+"：那看着像个高度限制，其实什么都没说。
  const low = one(constraint.altitude1);
  const high = one(constraint.altitude2);
  if (!low && !high) return "—";
  switch (constraint.type) {
    case "AT": return low;
    case "AT_OR_ABOVE": return `${low}+`;
    case "AT_OR_BELOW": return `${low}-`;
    case "BETWEEN": return `${high}~${low}`;
    default: return low || "—";
  }
}
function packagesOf(category: string) {
  return (task.value?.packages || []).filter((p: any) => p.procedureCategory === category);
}
/** 左栏色条：把生命周期压成四档，卡片上就不用再写一行状态文字。 */
function railState(pkg: any) {
  if (isPackageRunning(pkg)) return "running";
  const disposition = (productionByPackage.value.get(pkg.packageId) as any)?.disposition;
  if (disposition === "BLOCKED") return "failed";
  if (disposition === "REVIEW_REQUIRED") return "review";
  if (disposition === "AUTO_PASS") return "done";
  if (pkg.status === "FAILED") return "failed";
  // 带警告完成的也走琥珀档：实测 SID RNP RWY04 是 COMPLETED_WITH_WARNINGS
  // 却带着 4 条 ERROR，给它一条绿条等于说"这个不用看了"。
  if (hasResult(pkg) && ["REQUIRES_REVIEW", "COMPLETED_WITH_WARNINGS"].includes(pkg.status)) return "review";
  if (hasResult(pkg)) return "done";
  return "pending";
}

const recordLines = computed(() =>
  String(selectedResult.value?.candidate424?.text || "").split("\n").filter((line: string) => line.trim()),
);
/** 每条腿两行（主记录 1E + 续行 2P），交替底色让 12 行读成 6 条腿。 */
function legBand(index: number) {
  return Math.floor(index / 2) % 2 ? "band" : "";
}

// 132 列是位置编码，列位就是语义。标尺按渲染器（simpleLegsTo424Text）的实际写入
// 下标标注，两边改了要一起改——标错的标尺比没有标尺更坏。
// 标签只能用半角：中文在等宽字体里占两格，一个中文标签就会把整条标尺推错位。
const RULER_FIELDS: Array<[number, string]> = [
  [0, "HDR"], [6, "ARPT"], [10, "RG"], [12, "S"], [13, "ROUTE"], [19, "T"],
  [20, "QUALIF"], [26, "SEQ"], [29, "FIX"], [34, "RG"], [36, "SC"], [38, "C"],
  [39, "DS"], [43, "T"], [47, "PT"], [50, "NAVAID"], [70, "CRS"], [74, "DIST"],
  [82, "S"], [84, "ALT"], [89, "ALT2"], [99, "SPD"], [106, "NAVAID"], [118, "QL"],
];
const rulerLabels = computed(() => {
  const chars = new Array<string>(132).fill(" ");
  for (const [pos, label] of RULER_FIELDS) {
    for (let i = 0; i < label.length && pos + i < 132; i += 1) chars[pos + i] = label[i];
  }
  return chars.join("").replace(/\s+$/, "");
});
const rulerTicks = computed(() => {
  const chars = new Array<string>(132).fill(".");
  for (const [pos] of RULER_FIELDS) chars[pos] = "|";
  return chars.join("");
});

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
    const [workspace, productionSummary] = await Promise.all([
      agentRequest(`/tasks/${id}?view=workspace`),
      agentRequest(`/tasks/${id}/production-summary`),
    ]);
    task.value = workspace;
    production.value = productionSummary;
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
    <section v-if="production" class="production-strip">
      <div>
        <small>V4生产状态</small>
        <b>{{ production.releaseReady ? "具备机场放行条件" : "尚未具备机场放行条件" }}</b>
      </div>
      <dl>
        <div><dt>自动通过</dt><dd>{{ production.autoPassPackages }}</dd></div>
        <div><dt>待专业复核</dt><dd class="review-count">{{ production.reviewPackages }}</dd></div>
        <div><dt>阻塞</dt><dd class="blocked-count">{{ production.blockedPackages }}</dd></div>
        <div><dt>未完成</dt><dd>{{ production.pendingPackages }}</dd></div>
        <div><dt>自动通过率</dt><dd>{{ production.autoPassRate == null ? "—" : `${production.autoPassRate}%` }}</dd></div>
      </dl>
      <p v-if="production.openExceptionCount">
        {{ production.openExceptionCount }} 项有效例外等待处理；警告不计入阻塞。
      </p>
    </section>
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
    <section v-else class="workspace">
      <!-- 左栏只回答一个问题：该看哪个包。名称能扫、状态用色条、来源问题收成一个角标。
           原来每张卡片都印同一串"程序身份不明确·缺编码表·缺坐标源·缺跑道数据"，
           14 个包印 14 遍——对所有包都成立的信息不能区分任何包，只是噪声。 -->
      <aside class="rail">
        <template v-for="category in ['SID', 'STAR', 'APPROACH']" :key="category">
          <div v-if="packagesOf(category).length" class="rail-group">
            <h3>{{ category }}<em>{{ packagesOf(category).length }}</em></h3>
            <div
              v-for="pkg in packagesOf(category)"
              :key="pkg.packageId"
              :class="['rail-item', railState(pkg), { active: selected?.packageId === pkg.packageId }]"
            >
              <input
                type="checkbox"
                :checked="checked.includes(pkg.packageId)"
                :aria-label="`选择 ${pkg.procedureName}`"
                @click="toggle(pkg.packageId)"
              />
              <button class="rail-pick" @click="selectPackage(pkg)">
                <b>{{ pkg.procedureName }}</b>
                <small>
                  RWY {{ pkg.runways.join(", ") || "—" }} · {{ pkg.packagePages.length }} 页
                  <span v-if="sourceIssues(pkg).length" class="rail-warn" :title="sourceIssues(pkg).join(' · ')">
                    ⚠ {{ sourceIssues(pkg).length }}
                  </span>
                </small>
              </button>
              <span v-if="isPackageRunning(pkg)" class="mini-spinner"></span>
            </div>
          </div>
        </template>
      </aside>

      <section v-if="selected" class="main">
        <!-- 包头把原来中间那一整列压成三行：身份、来源、指标。
             中间列在识别完成后只剩这些内容，却占着 1fr 的宽度。 -->
        <header class="main-head">
          <div class="head-line">
            <span class="cat">{{ selected.procedureCategory }}</span>
            <h2>{{ selected.procedureName }}</h2>
            <small>RWY {{ selected.runways.join(", ") || "—" }}</small>
            <span :class="['run-state', railState(selected)]">
              {{ packageFeedback[selected.packageId]?.message || statusText(selected.status) }}
            </span>
            <button
              class="primary head-act"
              :disabled="isPackageRunning(selected) || anotherPackageRunning(selected)"
              @click="recognize([selected.packageId])"
            >
              {{ hasResult(selected) ? "重新识别" : packageAction(selected) }}
            </button>
          </div>

          <div class="head-sources">
            <template v-for="[docId, pages] in groupedPages" :key="docId">
              <button class="pdf-link" @click="openPdf(docId, pages[0]?.pageNumber || 1)">
                <span>PDF</span>{{ docName(docId) }}
              </button>
              <span v-for="page in pages" :key="page.pageNumber" class="page-chip">
                <button
                  class="page-open"
                  :title="`仅预览第 ${page.pageNumber} 页`"
                  @click="openPage(docId, page.pageNumber)"
                >
                  P{{ page.pageNumber }} · {{ page.pageRole }}
                </button>
                <button v-if="!showingResult" aria-label="移除页面" @click="removePage(page)">×</button>
              </span>
            </template>
            <select
              v-if="!showingResult"
              class="add-page"
              @change="
                addPage(($event.target as HTMLSelectElement).value);
                ($event.target as HTMLSelectElement).value = '';
              "
            >
              <option value="">+ 加页</option>
              <optgroup v-for="doc in task.documents" :key="doc.documentId" :label="doc.fileName">
                <option
                  v-for="page in availablePages.filter((p: any) => p.documentId === doc.documentId)"
                  :key="page.pageNumber"
                  :value="`${doc.documentId}:${page.pageNumber}`"
                >
                  P{{ page.pageNumber }} {{ page.title }}
                </option>
              </optgroup>
            </select>
          </div>

          <!-- 指标行允许换行。原来它在 300px 的列里横向溢出，把 "⛔ 4 ERROR"
               ——整屏最该看见的一条——裁在滚动条外面。 -->
          <div v-if="showingResult && selectedResult" class="head-stats">
            <span
              v-if="validationCounts.BLOCKER || validationCounts.ERROR"
              class="stat bad"
            >⛔ {{ validationCounts.BLOCKER }} BLOCKER · {{ validationCounts.ERROR }} ERROR</span>
            <span v-else-if="validationCounts.WARNING" class="stat warn">⚠ {{ validationCounts.WARNING }} 警告</span>
            <span v-else class="stat ok">✓ 校验通过</span>
            <span :class="['stat', 'code', selectedResult.candidate424?.status]">
              {{ selectedResult.candidate424?.status }}
            </span>
            <span class="stat">Route <b>{{ selectedPir?.routes?.length || 0 }}</b></span>
            <span class="stat">Leg <b>{{ selectedPir?.legs?.length || 0 }}</b></span>
            <span class="stat">Fix <b>{{ resolvedFixCount }}/{{ selectedPir?.fixes?.length || 0 }}</b></span>
            <span v-if="selectedPir?.quality?.unresolvedFields?.length" class="stat warn">
              {{ selectedPir.quality.unresolvedFields.length }} 个未解决字段
            </span>
          </div>
        </header>

        <div v-if="!showingResult" class="empty-pane">
          <p>该程序包尚未识别。</p>
          <small>确认上面的源页齐了，再点「{{ packageAction(selected) }}」。</small>
        </div>
        <div v-else-if="resultLoading" class="empty-pane">
          <span class="mini-spinner"></span> 正在加载识别结果…
        </div>
        <template v-else-if="selectedResult">
          <nav class="result-tabs">
            <button :class="{ active: resultTab === '424' }" @click="resultTab = '424'">ARINC 424</button>
            <button :class="{ active: resultTab === 'result' }" @click="resultTab = 'result'">识别结果</button>
            <button :class="{ active: resultTab === 'overlay' }" @click="resultTab = 'overlay'">原图叠加</button>
            <!-- 航迹图开的是弹窗，不是第四个页签：做成描边按钮，别让它看着像标签页 -->
            <button class="map-open" @click="mapModalOpen = true">
              航迹图 <em>{{ selectedResult.geojson?.features?.length || 0 }}</em>
            </button>
          </nav>

          <section
            v-if="resultTab === '424'"
            :class="['pane', 'pane-424', { 'no-compare': !COMPARE_VISIBLE }]"
          >
            <div class="record-toolbar">
              <label><input v-model="showRuler" type="checkbox" />列标尺</label>
              <span class="record-count">{{ recordLines.length }} 条记录 · 132 列定宽</span>
            </div>
            <!-- 132 列是位置编码：不给标尺，人得用手指在屏幕上数到第 47 列。
                 标尺与记录同宽同字体、一起横向滚动，列位才对得上。 -->
            <div class="record-scroll">
              <pre v-if="recordLines.length" class="records"><code
                v-if="showRuler"
                class="ruler"
              >{{ rulerLabels }}
{{ rulerTicks }}</code><code
                v-for="(line, i) in recordLines"
                :key="i"
                :class="['record', legBand(i)]"
              >{{ line }}</code></pre>
              <p v-else class="empty-pane">尚未生成 424 Candidate</p>
            </div>
            <section v-if="COMPARE_VISIBLE" class="inline-compare">
              <h4>与 Jeppesen 424 对比</h4>
              <p class="compare-hint">粘贴同一程序的参考记录，逐字段比对上面的结果。</p>
              <textarea v-model="compareState.text" rows="6" placeholder="粘贴参考 424 静态文本（132 列记录）"></textarea>
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
                    {{ compareState.report.matchRate == null ? "—" : Math.round(compareState.report.matchRate * 100) + "%" }}</b>
                  · {{ compareState.report.matchedLegs }}/{{ compareState.report.totalLegs }} 腿匹配 ·
                  {{ compareState.report.partialLegs }} 部分 · {{ compareState.report.mismatchedLegs }} 不匹配
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
          </section>

          <section v-else-if="resultTab === 'result'" class="pane pane-result">
            <div v-for="route in selectedPir?.routes || []" :key="route.routeId" class="result-route">
              <h4>{{ route.identifier }}<em>{{ route.routeType }}</em></h4>
              <p v-if="route.climbGradient?.percent" class="climb-gradient">
                最低爬升梯度 {{ route.climbGradient.percent }}%<template v-if="route.climbGradient.untilAltitudeFt">，直至通过 {{ route.climbGradient.untilAltitudeFt }} FT</template>
              </p>
              <table>
                <thead>
                  <tr><th>#</th><th>PT</th><th>航段</th><th>航向</th><th>距离</th><th>高度</th></tr>
                </thead>
                <tbody>
                  <tr v-for="leg in legsOfRoute(route)" :key="leg.legId">
                    <td class="seq">{{ leg.sequence }}</td>
                    <td class="pt">{{ leg.pathTerminator }}</td>
                    <td>{{ fixName(leg.fromFixId) }} → {{ fixName(leg.toFixId) }}</td>
                    <td class="num">{{ leg.course ?? "—" }}°</td>
                    <td class="num">{{ leg.distanceNm ?? "—" }} NM</td>
                    <td class="num">{{ constraintText(leg.altitudeConstraint) }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <!-- 第 5 点要的"提示缺失信息"：源上有、结果没有 -->
            <section v-if="completenessFindings.length" class="completeness-block">
              <h4>源页比对：结果中缺失的内容（{{ completenessFindings.length }}）</h4>
              <p class="sub">由 AI 读原始页面得出，供人复核——它与识别同源，不作为拒出依据。</p>
              <p v-for="(v, i) in completenessFindings" :key="i" class="finding">{{ v.message }}</p>
            </section>
            <p v-if="blockingValidations.length" class="blocking-summary">
              另有 {{ blockingValidations.length }} 项规则校验未通过：{{ blockingValidations.map((v: any) => v.ruleCode).join("、") }}
            </p>
            <section v-if="selectedResult.candidate424" class="gen-meta">
              <h4>424 生成</h4>
              <p>
                <span :class="['stat', 'code', selectedResult.candidate424.status]">{{ selectedResult.candidate424.status }}</span>
                <span v-if="selectedResult.candidate424.generatedBy === 'AI'" class="generated-by">AI 生成</span>
                <small v-if="selectedResult.candidate424.roundTrip">
                  Round-trip {{ selectedResult.candidate424.roundTrip.parsedLegs }}/{{ selectedResult.candidate424.roundTrip.emittedLegs }} 腿 ·
                  {{ selectedResult.candidate424.roundTrip.fieldMismatches?.length || 0 }} 字段差异
                </small>
              </p>
              <p v-if="selectedResult.candidate424.decisionSummary" class="decision-summary">
                {{ selectedResult.candidate424.decisionSummary }}
              </p>
              <p v-for="(diff, i) in selectedResult.candidate424.diffs || []" :key="'d' + i" class="finding">
                <b>{{ diff.code }}</b> {{ diff.detail }}
              </p>
              <p v-for="field in selectedResult.candidate424.missingFields || []" :key="field" class="finding">
                缺字段：{{ field }}
              </p>
              <details v-if="selectedResult.candidate424.roundTrip?.fieldMismatches?.length" class="mismatch-list">
                <summary>Round-trip 字段差异</summary>
                <p v-for="(m, i) in selectedResult.candidate424.roundTrip.fieldMismatches" :key="i">
                  {{ m.key }} · {{ m.field }}：导出 {{ m.emitted ?? "—" }} / 回读 {{ m.reparsed ?? "—" }}
                </p>
              </details>
            </section>
          </section>

          <section v-else class="pane pane-overlay">
            <template v-if="selectedOverlay?.overlays?.length">
              <div v-for="(v, i) in selectedOverlay.verifications" :key="i" class="overlay-meta">
                <span :class="['stat', 'code', v.status === 'VERIFIED' ? '' : '424_INCOMPLETE']">{{ v.status }}</span>
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
            <p v-else class="empty-pane">
              {{ selectedOverlay?.verifications?.length ? "叠加未完成配准（控制点不足），已标记 NOT_GEOREFERENCED。" : "该程序尚未生成原图叠加。重新识别后自动执行配准与叠加校验。" }}
            </p>
          </section>
        </template>
        <div v-else class="empty-pane">该程序包尚无识别结果。</div>
      </section>
      <div v-else class="empty-pane">从左侧选择一个程序包。</div>
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
.production-strip {
  display: grid;
  grid-template-columns: minmax(220px, .8fr) minmax(480px, 1.4fr) minmax(220px, .8fr);
  gap: 20px;
  align-items: center;
  margin: 0 0 10px;
  padding: 12px 16px;
  background: #fff;
  border: 1px solid #dce5ee;
  border-radius: 10px;
  flex: 0 0 auto;
}
.production-strip small,
.production-strip p,
.production-strip dt { color: #64748b; }
.production-strip b { display: block; margin-top: 3px; }
.production-strip dl { display: grid; grid-template-columns: repeat(5, 1fr); margin: 0; }
.production-strip dl div { padding: 0 10px; border-left: 1px solid #e7edf3; text-align: center; }
.production-strip dt { font-size: 11px; }
.production-strip dd { margin: 3px 0 0; font-size: 18px; font-weight: 700; }
.production-strip .review-count { color: #a16207; }
.production-strip .blocked-count { color: #b42318; }
.production-strip p { margin: 0; font-size: 12px; line-height: 1.5; }
@media (max-width: 1080px) {
  .production-strip { grid-template-columns: 1fr; }
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
/* 两列：左栏定宽只管选包，右侧主区域全归识别产物。
   原来是三列（320 / 1fr / 320），中间列在识别完成后只剩包头和统计，
   却始终占着主宽度；产物被挤到 320px 的右栏里横竖都不够看。 */
.workspace {
  display: grid;
  grid-template-columns: 260px minmax(0, 1fr);
  background: #fff;
  border-radius: 14px;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
.rail {
  background: #f5f8fb;
  border-right: 1px solid #e4eaf0;
  padding: 14px 10px;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
}
.rail-group h3 {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  letter-spacing: 0.06em;
  color: #829ab1;
  margin: 16px 0 6px 8px;
}
.rail-group:first-child h3 {
  margin-top: 0;
}
.rail-group h3 em {
  font-style: normal;
  background: #e2e9f1;
  color: #52606d;
  border-radius: 9px;
  padding: 1px 6px;
  font-size: 10px;
}
.rail-item {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  padding: 7px 8px 7px 5px;
  border-radius: 8px;
  border-left: 3px solid transparent;
}
.rail-item:hover {
  background: #eef3f9;
}
.rail-item.active {
  background: #e6effb;
}
/* 状态用左侧色条，不再每张卡片写一行状态文字 */
.rail-item.done {
  border-left-color: #35a06a;
}
.rail-item.review {
  border-left-color: #e0a52e;
}
.rail-item.failed {
  border-left-color: #d0453b;
}
.rail-item.running {
  border-left-color: #1769e0;
}
.rail-pick {
  border: 0;
  background: none;
  padding: 0;
  text-align: left;
  min-width: 0;
  cursor: pointer;
}
.rail-pick b {
  display: block;
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rail-pick small {
  display: flex;
  align-items: center;
  gap: 6px;
  color: #7b8ea3;
  font-size: 11px;
  margin-top: 2px;
}
/* 来源问题收成一个角标：完整清单挂在 title 上，鼠标悬停可看。
   原来把 4 条问题全文印在每张卡片上，14 个包印了 14 遍同一串字。 */
.rail-warn {
  color: #92610a;
  background: #fdf3d8;
  border-radius: 4px;
  padding: 0 5px;
  font-size: 10px;
  cursor: help;
  flex: 0 0 auto;
}
button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.main {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}
.main-head {
  flex: 0 0 auto;
  padding: 14px 18px 10px;
  border-bottom: 1px solid #e4eaf0;
}
.head-line {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.head-line .cat {
  font-size: 11px;
  background: #e8f1ff;
  color: #174ea6;
  padding: 3px 7px;
  border-radius: 5px;
}
.head-line h2 {
  margin: 0;
  font-size: 17px;
}
.head-line small {
  color: #7b8ea3;
  font-size: 12px;
}
.head-line .run-state {
  font-size: 12px;
  color: #52606d;
}
.head-line .run-state.done {
  color: #237a4b;
}
.head-line .run-state.review {
  color: #b45309;
}
.head-line .run-state.failed {
  color: #b42318;
}
.head-line .run-state.running {
  color: #1769e0;
}
.head-act {
  margin-left: auto;
}
.head-sources {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 9px;
}
.head-sources .page-chip {
  display: inline-flex;
}
.add-page {
  border: 1px dashed #c8d2df;
  background: #fff;
  border-radius: 6px;
  padding: 4px 6px;
  font-size: 11px;
  color: #52606d;
}
/* 指标行换行，不横向滚动。原来它在 300px 的列里溢出，
   把 "⛔ 4 ERROR"——整屏最该被看见的一条——裁到滚动条外面去了。 */
.head-stats {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 10px;
}
.head-stats .stat {
  font-size: 11px;
  background: #f1f5f9;
  color: #52606d;
  border-radius: 5px;
  padding: 3px 8px;
}
.head-stats .stat b {
  color: #102a43;
}
.head-stats .stat.ok {
  background: #e7f5ed;
  color: #237a4b;
}
.head-stats .stat.warn {
  background: #fff7e6;
  color: #b45309;
}
.head-stats .stat.bad {
  background: #feeceb;
  color: #b42318;
  font-weight: 700;
}
.stat.code {
  background: #e7f5ed;
  color: #237a4b;
  font-family: ui-monospace, Consolas, monospace;
}
/* 类名以数字开头，CSS 里必须转义首字符：\34 是 "4"，后面的空格是转义终止符。 */
.stat.code.\34 24_INCOMPLETE,
.stat.code.\34 24_DERIVED {
  background: #fff7e6;
  color: #b45309;
}

.result-tabs {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 0 18px;
  border-bottom: 1px solid #e4eaf0;
}
/* 下划线式页签，不是撑满整行的大色块 */
.result-tabs button {
  border: 0;
  background: none;
  color: #52606d;
  padding: 10px 12px;
  font-size: 13px;
  border-bottom: 2px solid transparent;
  cursor: pointer;
}
.result-tabs button.active {
  color: #174ea6;
  font-weight: 700;
  border-bottom-color: #1769e0;
}
/* 航迹图开的是弹窗，做成描边按钮，别让它看着像第四个页签 */
.result-tabs .map-open {
  margin-left: auto;
  border: 1px solid #c8d2df;
  border-radius: 6px;
  padding: 5px 10px;
  font-size: 12px;
}
.result-tabs .map-open em {
  font-style: normal;
  color: #829ab1;
  margin-left: 4px;
}
.result-tabs .map-open:hover {
  border-color: #9db9df;
  color: #174ea6;
}

.pane {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 14px 18px 18px;
}
.pane-424 {
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.record-toolbar {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 11px;
  color: #7b8ea3;
  padding-bottom: 8px;
}
.record-toolbar label {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
}
.record-count {
  margin-left: auto;
}
.record-scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
  background: #10233e;
  border-radius: 8px;
}
/* 132 列定宽：不折行，横向滚动，标尺与记录同宽同字体一起滚 */
.records {
  margin: 0;
  padding: 10px 12px;
  font-family: ui-monospace, "Cascadia Mono", Consolas, monospace;
  font-size: 11px;
  line-height: 1.55;
  white-space: pre;
  display: table;
}
.records code {
  display: block;
  color: #dcecff;
}
.records .ruler {
  position: sticky;
  top: -10px;
  background: #10233e;
  color: #6d90bd;
  border-bottom: 1px solid #24405f;
  padding-bottom: 2px;
  margin-bottom: 4px;
  z-index: 1;
}
/* 一条腿两行（主记录 1E + 续行 2P）：隔条底色让 12 行读成 6 条腿 */
.records .record.band {
  background: #16304f;
}
.empty-pane {
  padding: 28px 18px;
  color: #7b8ea3;
  font-size: 13px;
}
.empty-pane small {
  display: block;
  margin-top: 6px;
  color: #9fb0c2;
}
.pane-result table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
.pane-result thead th {
  text-align: left;
  font-weight: 600;
  color: #829ab1;
  font-size: 10px;
  letter-spacing: 0.04em;
  border-bottom: 1px solid #e4eaf0;
  padding: 4px;
}
.pane-result thead th:nth-child(n + 4) {
  text-align: right;
}
.pane-overlay .overlay-img {
  width: 100%;
  border: 1px solid #dbe4ee;
  border-radius: 7px;
  margin-bottom: 8px;
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
.inline-424.no-compare pre{max-height:calc(100vh - 260px)}
.inline-424 .inline-compare{margin-top:16px;border-top:1px solid #edf1f5;padding-top:12px}
.inline-424 .inline-compare h4{margin:0 0 4px;font-size:13px}
.inline-result .gen-meta{margin-top:14px;border-top:1px solid #edf1f5;padding-top:10px}
.inline-result .gen-meta h4{margin:0 0 6px;font-size:13px}
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
  max-height: calc(100vh - 430px);
  min-height: 220px;
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
