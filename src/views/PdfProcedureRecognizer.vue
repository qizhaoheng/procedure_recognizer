<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import {
  Bot,
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
  AiRequestPreview,
  ChartRole,
  NavigationType,
  PdfPageAsset,
  ProcedureCategory,
  ProcedureGroup,
  ProcedureTask,
} from '../types/procedureTask';

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

const chartRoles: ChartRole[] = ['CHART', 'TABULAR_DESCRIPTION', 'WAYPOINT_COORDINATES', 'MINIMA_TABLE', 'CHART_INDEX', 'BLANK', 'OTHER', 'UNKNOWN'];
const procedureCategories: ProcedureCategory[] = ['ARRIVAL', 'DEPARTURE', 'APPROACH', 'AERODROME', 'AIRSPACE', 'UNKNOWN'];
const groupCategories: ProcedureGroup['procedureCategory'][] = ['ARRIVAL', 'DEPARTURE', 'APPROACH', 'UNKNOWN'];
const navigationTypes: NavigationType[] = ['RNAV', 'RNP', 'ILS', 'LOC', 'VOR', 'NDB', 'DME_ARC', 'RADAR', 'CONVENTIONAL', 'UNKNOWN'];

const fileInput = ref<HTMLInputElement>();
const task = ref<ProcedureTask>();
const selectedPageNo = ref<number>();
const selectedGroupId = ref('');
const busy = ref(false);
const message = ref('等待上传 PDF');
const error = ref('');
const aiPreview = ref<AiRequestPreview>();
let pollTimer: number | undefined;

const selectedPage = computed(() => task.value?.pages.find((page) => page.pageNo === selectedPageNo.value));
const selectedGroup = computed(() => task.value?.groups.find((group) => group.groupId === selectedGroupId.value));
const taskStatusLabel = computed(() => (task.value ? statusLabels[task.value.status] || task.value.status : '未创建任务'));
const selectedGroupPages = computed(() => {
  if (!task.value || !selectedGroup.value) return [];
  const pageNos = new Set(allGroupPages(selectedGroup.value));
  return task.value.pages.filter((page) => pageNos.has(page.pageNo));
});
const hasGeoJson = computed(() => Boolean(selectedGroup.value?.geojson));

onBeforeUnmount(() => {
  stopPolling();
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
    selectedPageNo.value ??= nextTask.pages[0]?.pageNo;
    selectedGroupId.value ||= nextTask.groups[0]?.groupId || '';
    message.value = nextTask.error || `任务状态：${statusLabels[nextTask.status] || nextTask.status}`;
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
  message.value = '已重新自动分组';
}

async function createGroup() {
  if (!task.value) return;
  const groups = cloneGroups();
  const page = selectedPage.value;
  const group: ProcedureGroup = {
    groupId: `group_manual_${Date.now()}`,
    groupName: page ? `人工分组 · P${page.pageNo}` : '人工分组',
    procedureCategory: page && ['ARRIVAL', 'DEPARTURE', 'APPROACH'].includes(page.procedureCategory)
      ? (page.procedureCategory as ProcedureGroup['procedureCategory'])
      : 'UNKNOWN',
    navigationType: page?.navigationType || 'UNKNOWN',
    runway: page?.runway,
    chartPages: [],
    tabularPages: [],
    coordinatePages: [],
    minimaPages: [],
    otherPages: [],
    procedureNames: page?.procedureNames ?? [],
    status: 'GROUPED',
    reviewRequired: true,
  };
  if (page) addPageNoToGroup(group, page);
  groups.push(group);
  await saveGroups(groups);
  selectedGroupId.value = group.groupId;
}

async function deleteSelectedGroup() {
  if (!selectedGroup.value) return;
  const groups = cloneGroups().filter((group) => group.groupId !== selectedGroup.value?.groupId);
  await saveGroups(groups);
  selectedGroupId.value = groups[0]?.groupId || '';
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
  if (!task.value || !selectedGroup.value) return;
  aiPreview.value = await requestJson<AiRequestPreview>(
    `/api/procedure-tasks/${task.value.taskId}/groups/${selectedGroup.value.groupId}/ai-request-preview`,
  );
  message.value = 'AI 请求预览已生成';
}

async function runAiRecognition() {
  if (!task.value || !selectedGroup.value) return;
  busy.value = true;
  try {
    await requestJson(`/api/procedure-tasks/${task.value.taskId}/groups/${selectedGroup.value.groupId}/run-ai`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'geojson' }),
    });
    await refreshTask(false);
    message.value = 'AI 识别已完成';
  } catch (aiError) {
    error.value = toErrorMessage(aiError);
  } finally {
    busy.value = false;
  }
}

function previewGeoJson() {
  if (!task.value || !selectedGroup.value) return;
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
  aiPreview.value = undefined;
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
  return [...group.chartPages, ...group.tabularPages, ...group.coordinatePages, ...group.minimaPages, ...group.otherPages].sort((a, b) => a - b);
}

function candidatePreview(group: ProcedureGroup | undefined) {
  return (group?.textCandidates ?? []).slice(0, 10);
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
        <p>{{ task?.fileName || '上传 AIP AD PDF，按组发送给 AI，并跳转现有 GeoJSON 预览页校核。' }}</p>
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
      <aside class="column pages">
        <div class="column-head">
          <h2>PDF 页面列表</h2>
          <span>{{ task?.pages.length || 0 }} 页</span>
        </div>
        <button
          v-for="page in task?.pages"
          :key="page.pageNo"
          type="button"
          class="page-row"
          :class="{ active: page.pageNo === selectedPageNo }"
          @click="selectPage(page)"
        >
          <img v-if="page.thumbnailUrl" :src="page.thumbnailUrl" alt="" />
          <div>
            <strong>P{{ page.pageNo }} {{ page.aipPageNo || '' }}</strong>
            <span>{{ page.chartRole }} · {{ page.procedureCategory }} · {{ page.navigationType }}</span>
            <span>{{ page.runway || '未识别跑道' }} · 置信度 {{ page.confidence ?? '-' }}</span>
            <em v-if="page.reviewRequired">需复核</em>
          </div>
        </button>
        <p v-if="!task?.pages.length" class="empty">上传 PDF 并开始解析后显示页面。</p>
      </aside>

      <section class="column groups">
        <div class="column-head">
          <h2>程序分组</h2>
          <div class="mini-actions">
            <button type="button" :disabled="!task" title="重新自动分组" @click="autoRegroup">
              <Wand2 :size="15" />
            </button>
            <button type="button" :disabled="!task" title="新建分组" @click="createGroup">
              <Plus :size="15" />
            </button>
          </div>
        </div>

        <button
          v-for="group in task?.groups"
          :key="group.groupId"
          type="button"
          class="group-row"
          :class="{ active: group.groupId === selectedGroupId }"
          @click="selectGroup(group)"
        >
          <strong>{{ group.groupName }}</strong>
          <span>{{ group.procedureCategory }} · {{ group.navigationType }} · {{ group.runway || 'RWY?' }}</span>
          <span>P{{ allGroupPages(group).join(', ') || '未分配页面' }}</span>
          <em>{{ statusLabels[group.status] || group.status }}</em>
        </button>
        <p v-if="!task?.groups.length" class="empty">解析后自动生成分组，也可以人工新建。</p>
      </section>

      <section class="column detail">
        <div class="column-head">
          <h2>分组详情 / 操作</h2>
          <span>{{ selectedGroup ? statusLabels[selectedGroup.status] || selectedGroup.status : '未选择' }}</span>
        </div>

        <div v-if="selectedPage" class="editor">
          <h3>当前页 P{{ selectedPage.pageNo }}</h3>
          <img v-if="selectedPage.imageUrl" class="preview-image" :src="selectedPage.imageUrl" alt="" />
          <div class="form-grid">
            <label>图件编号<input v-model="selectedPage.aipPageNo" /></label>
            <label>页类型<select v-model="selectedPage.chartRole"><option v-for="role in chartRoles" :key="role">{{ role }}</option></select></label>
            <label>程序类别<select v-model="selectedPage.procedureCategory"><option v-for="category in procedureCategories" :key="category">{{ category }}</option></select></label>
            <label>导航类型<select v-model="selectedPage.navigationType"><option v-for="type in navigationTypes" :key="type">{{ type }}</option></select></label>
            <label>跑道<input v-model="selectedPage.runway" placeholder="RWY16" /></label>
          </div>
          <div class="button-row">
            <button type="button" @click="saveSelectedPage">保存页识别</button>
            <button type="button" :disabled="!selectedGroup" @click="addSelectedPageToGroup">加入当前分组</button>
            <button type="button" :disabled="!selectedGroup" @click="removeSelectedPageFromGroup">移出当前分组</button>
          </div>
          <details>
            <summary>OCR / 文本层摘要</summary>
            <pre>{{ (selectedPage.ocrText || selectedPage.textLayerText || '').slice(0, 2200) }}</pre>
          </details>
        </div>

        <div v-if="selectedGroup" class="editor">
          <h3>{{ selectedGroup.groupName }}</h3>
          <div class="form-grid">
            <label>分组名<input v-model="selectedGroup.groupName" /></label>
            <label>程序类别<select v-model="selectedGroup.procedureCategory"><option v-for="category in groupCategories" :key="category">{{ category }}</option></select></label>
            <label>导航类型<input v-model="selectedGroup.navigationType" /></label>
            <label>跑道<input v-model="selectedGroup.runway" /></label>
          </div>
          <div class="button-row">
            <button type="button" @click="saveGroupMetadata">保存分组</button>
            <button type="button" @click="extractSelectedCandidates">提取候选</button>
            <button type="button" @click="loadAiPreview">
              <FileJson :size="15" /> AI 请求预览
            </button>
            <button type="button" class="primary" @click="runAiRecognition">
              <Bot :size="15" /> 发送AI识别
            </button>
            <button type="button" :disabled="!hasGeoJson" @click="previewGeoJson">
              <Eye :size="15" /> 预览GeoJSON
            </button>
            <button type="button" :disabled="!hasGeoJson" @click="downloadGroupGeoJson">下载GeoJSON</button>
            <button type="button" class="danger" @click="deleteSelectedGroup">
              <Trash2 :size="15" /> 删除分组
            </button>
          </div>

          <div class="thumb-strip">
            <button v-for="page in selectedGroupPages" :key="page.pageNo" type="button" @click="selectPage(page)">
              <img v-if="page.thumbnailUrl" :src="page.thumbnailUrl" alt="" />
              <span>P{{ page.pageNo }}</span>
            </button>
          </div>

          <section class="summary">
            <h4>候选摘要</h4>
            <p>文字 {{ selectedGroup.textCandidates?.length || 0 }} · 坐标 {{ selectedGroup.waypointCandidates?.length || 0 }} · 表格 {{ selectedGroup.tableCandidates?.length || 0 }} · 几何 {{ selectedGroup.geometryCandidates?.length || 0 }}</p>
            <p v-if="!selectedGroup.geometryCandidates?.length">几何候选暂未提取/待实现。</p>
            <ul>
              <li v-for="candidate in candidatePreview(selectedGroup)" :key="candidate.id">
                P{{ candidate.pageNo }} · {{ candidate.typeCandidate }} · {{ candidate.text }}
              </li>
            </ul>
          </section>

          <details v-if="aiPreview" open>
            <summary>AI 请求预览</summary>
            <pre>{{ aiPreview.prompt }}</pre>
          </details>
          <details v-if="selectedGroup.aiResponse">
            <summary>AI 返回结果</summary>
            <pre>{{ selectedGroup.aiResponse.rawText.slice(0, 3600) }}</pre>
          </details>
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
.page-row span,
.group-row span,
.summary p {
  color: #64748b;
  font-size: 12px;
}

.actions,
.button-row,
.mini-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
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
  grid-template-columns: minmax(250px, 0.85fr) minmax(270px, 0.95fr) minmax(420px, 1.35fr);
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

.page-row,
.group-row {
  width: 100%;
  justify-content: flex-start;
  gap: 10px;
  min-height: 84px;
  margin-bottom: 8px;
  border-color: #e2e8f0;
  background: #fff;
  text-align: left;
}

.page-row.active,
.group-row.active {
  border-color: #2563eb;
  box-shadow: inset 3px 0 0 #2563eb;
}

.page-row img {
  width: 58px;
  height: 78px;
  object-fit: cover;
  border: 1px solid #e2e8f0;
  background: #fff;
}

.page-row div,
.group-row {
  display: grid;
  align-content: center;
}

.page-row strong,
.group-row strong {
  color: #172033;
  font-size: 13px;
}

em {
  width: fit-content;
  color: #b45309;
  font-size: 11px;
  font-style: normal;
}

.editor {
  display: grid;
  gap: 12px;
  margin-bottom: 14px;
  border-bottom: 1px solid #e2e8f0;
  padding-bottom: 14px;
}

.preview-image {
  width: 100%;
  max-height: 360px;
  object-fit: contain;
  border: 1px solid #e2e8f0;
  background: #fff;
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

details {
  border: 1px solid #e2e8f0;
  border-radius: 7px;
  background: #fff;
  padding: 9px;
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

.thumb-strip {
  display: flex;
  gap: 8px;
  overflow-x: auto;
}

.thumb-strip button {
  display: grid;
  gap: 4px;
  min-width: 68px;
  height: auto;
  padding: 6px;
}

.thumb-strip img {
  width: 54px;
  height: 72px;
  object-fit: cover;
}

.summary {
  display: grid;
  gap: 7px;
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
}
</style>
