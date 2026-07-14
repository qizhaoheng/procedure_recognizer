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
const resultTab = ref<"legs" | "424">("legs");
const resultBundles = ref<Record<string, any>>({});
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
  } catch (e) {
    error.value = msg(e);
  } finally {
    resultLoading.value = false;
  }
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
function hasResult(pkg: any) {
  return ["COMPLETED", "COMPLETED_WITH_WARNINGS"].includes(pkg.status);
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
  if (hasResult(pkg)) return "识别完成";
  if (isPackageRunning(pkg)) return "识别中…";
  if (pkg.status === "FAILED") return "重新识别";
  return "识别此程序包";
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
    COMPLETED_WITH_WARNINGS: "识别完成，需复核",
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
              :class="{ result: hasResult(pkg) }"
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
            </div>
            <div class="result-map">
              <AgentResultMap
                :geojson="selectedResult.geojson"
                :selected-leg-id="selectedLegId"
                @select-leg="selectedLegId = $event"
              />
            </div>
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
            :class="{ active: resultTab === 'legs' }"
            @click="resultTab = 'legs'"
          >
            航段
          </button>
          <button
            :class="{ active: resultTab === '424' }"
            @click="resultTab = '424'"
          >
            ARINC 424
          </button>
        </nav>
        <section v-if="resultLoading" class="result-loading">正在加载…</section>
        <section
          v-else-if="selectedResult && resultTab === 'legs'"
          class="inline-legs"
        >
          <button
            v-for="leg in selectedPir?.legs || []"
            :key="leg.legId"
            :class="{ active: selectedLegId === leg.legId }"
            @click="selectedLegId = leg.legId"
          >
            <b>{{ leg.sequence }} · {{ leg.pathTerminator }}</b>
            <span
              >{{ fixName(leg.fromFixId) }} → {{ fixName(leg.toFixId) }}</span
            >
            <em>{{ leg.course ?? "—" }}° · {{ leg.distanceNm ?? "—" }} NM</em>
          </button>
          <dl v-if="selectedLeg" class="selected-leg-detail">
            <dt>From / To</dt>
            <dd>
              {{ fixName(selectedLeg.fromFixId) }} →
              {{ fixName(selectedLeg.toFixId) }}
            </dd>
            <dt>航向 / 距离</dt>
            <dd>
              {{ selectedLeg.course ?? "—" }}° /
              {{ selectedLeg.distanceNm ?? "—" }} NM
            </dd>
            <dt>置信度</dt>
            <dd>{{ selectedLeg.confidence ?? "—" }}</dd>
          </dl>
        </section>
        <section v-else-if="selectedResult" class="inline-424">
          <span
            :class="['candidate-state', selectedResult.candidate424?.status]"
            >{{ selectedResult.candidate424?.status }}</span
          >
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
        </section>
      </aside>
    </section>
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
.workspace.has-result {
  grid-template-columns: 320px minmax(480px, 1fr) 320px;
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
    grid-template-columns: 250px minmax(420px, 1fr) 280px;
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
.result-map {
  flex: 1;
  min-height: 0;
  border-radius: 9px;
  overflow: hidden;
}
.result-map :deep(.map) {
  min-height: 0;
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
.inline-424 pre {
  white-space: pre-wrap;
  word-break: break-all;
  background: #10233e;
  color: #dcecff;
  padding: 10px;
  max-height: calc(100vh - 260px);
  overflow: auto;
  font-size: 10px;
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
