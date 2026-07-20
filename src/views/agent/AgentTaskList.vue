<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { agentRequest, uploadForm } from "../../services/agentApi";

const router = useRouter();
const tasks = ref<any[]>([]);
const metrics = ref<any>();
const batches = ref<any[]>([]);
const exceptionQueue = ref<any>({ total: 0, blockerCount: 0, reviewCount: 0, items: [] });
const files = ref<File[]>([]);
const taskName = ref("");
const error = ref("");
const batchMessage = ref("");
const creating = ref(false);
const dragging = ref(false);
const removing = ref("");
let refreshTimer: number | undefined;

onMounted(async () => { await load(); refreshTimer = window.setInterval(() => { if (batches.value.some((batch) => batch.status === "RUNNING")) void load(); }, 4000); });
onBeforeUnmount(() => refreshTimer && clearInterval(refreshTimer));

async function load() {
  try {
    [tasks.value, metrics.value, batches.value, exceptionQueue.value] = await Promise.all([
      agentRequest("/tasks"),
      agentRequest("/production/metrics"),
      agentRequest("/production-batches"),
      agentRequest("/production/exceptions?limit=30"),
    ]);
    error.value = "";
  } catch (e) { error.value = message(e); }
}
async function runBatch(batch: any, mode: "ANALYZE" | "FULL_PRODUCTION", retryFailed = false) {
  if (mode === "FULL_PRODUCTION" && !window.confirm(`启动批次「${batch.name}」的完整生产？系统将调用模型处理批次内全部待生产机场。`)) return;
  error.value = "";
  try {
    await agentRequest(`/production-batches/${batch.batchId}/start`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode, concurrency: batch.concurrency || 2, retryFailed }),
    });
    await load();
  } catch (e) { error.value = message(e); }
}
async function pauseBatch(batch: any) {
  try { await agentRequest(`/production-batches/${batch.batchId}/pause`, { method: "POST" }); await load(); }
  catch (e) { error.value = message(e); }
}
function batchStatus(value: string) {
  return ({ CREATED: "待启动", RUNNING: "运行中", PAUSED: "已暂停", COMPLETED: "已完成", COMPLETED_WITH_ERRORS: "有失败" } as Record<string,string>)[value] || value;
}
function ownerLabel(value: string) { return value === "CHART_SPECIALIST" ? "航图制图员" : "424编码员"; }
function fileKey(file: File) { return `${(file as any).webkitRelativePath || file.name}:${file.size}`; }
function select(list: FileList | null) {
  if (!list) return;
  const seen = new Set(files.value.map(fileKey));
  for (const file of Array.from(list)) {
    if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) continue;
    if (!seen.has(fileKey(file))) { files.value.push(file); seen.add(fileKey(file)); }
  }
}
function drop(event: DragEvent) { dragging.value = false; select(event.dataTransfer?.files || null); }
async function create() {
  if (!files.value.length) return;
  creating.value = true; error.value = ""; batchMessage.value = "";
  try {
    const folderMode = files.value.some((file) => Boolean((file as any).webkitRelativePath));
    if (folderMode) {
      const result = await agentRequest<any>("/production-batches", {
        method: "POST",
        body: uploadForm(files.value, {
          fileManifest: JSON.stringify(files.value.map((file) => ({
            relativePath: (file as any).webkitRelativePath || file.name,
          }))),
        }),
      });
      batchMessage.value = `已摄取 ${result.airportCount} 个机场、${result.documentCount} 份 PDF${result.unassignedFiles.length ? `；${result.unassignedFiles.length} 份文件未识别机场码` : ""}`;
      files.value = [];
      await load();
    } else {
      const task = await agentRequest<any>("/tasks", {
        method: "POST",
        body: uploadForm(files.value, { taskName: taskName.value || "机场航行数据生产任务" }),
      });
      await router.push(`/production-tasks/${task.taskId}/intake`);
    }
  } catch (e) { error.value = message(e); }
  finally { creating.value = false; }
}
async function remove(task: any) {
  if (!window.confirm(`删除任务「${task.taskName}」？该任务的页面渲染、识别结果与产物都会一并删除，无法恢复。`)) return;
  removing.value = task.taskId; error.value = "";
  try { await agentRequest(`/tasks/${task.taskId}`, { method: "DELETE" }); await load(); }
  catch (e) { error.value = message(e); }
  finally { removing.value = ""; }
}
function message(e: unknown) { return e instanceof Error ? e.message : String(e); }
</script>

<template>
  <main class="page">
    <header><p class="eyebrow">NAVIGATION DATA PRODUCTION</p><h1>机场航行数据生产</h1><p>批量组织 AIP 资料，自动生产结构化数据与 424，只把例外留给专业人员。</p></header>
    <p v-if="error" class="error">{{ error }}</p>
    <p v-if="batchMessage" class="success">{{ batchMessage }}</p>

    <section v-if="metrics" class="efficiency">
      <span><b>{{ metrics.airportCount }}</b><small>机场任务</small></span>
      <span><b>{{ metrics.programCount }}</b><small>程序总数</small></span>
      <span><b>{{ metrics.autoPassRate == null ? "—" : `${metrics.autoPassRate}%` }}</b><small>自动通过率</small></span>
      <span><b>{{ metrics.firstPassYield == null ? "—" : `${metrics.firstPassYield}%` }}</b><small>一次通过率</small></span>
      <span><b>{{ metrics.manualDecisionCount }}</b><small>人工裁决</small></span>
      <span><b>{{ metrics.manualFieldEditCount }}</b><small>字段修改</small></span>
      <span><b>{{ metrics.currentReleasedAirportCount }}</b><small>当前已放行</small></span>
      <span><b>{{ metrics.averageReleaseCycleMinutes == null ? "—" : `${metrics.averageReleaseCycleMinutes}m` }}</b><small>平均放行周期</small></span>
    </section>

    <section v-if="batches.length" class="batch-board">
      <div class="section-title"><div><p class="eyebrow">BATCH OPERATIONS</p><h2>国家生产批次</h2></div><small>并发按机场控制；暂停不会中断正在运行的机场</small></div>
      <article v-for="batch in batches" :key="batch.batchId" class="batch-card">
        <div class="batch-identity"><span :class="['batch-status',batch.status.toLowerCase()]">{{ batchStatus(batch.status) }}</span><h3>{{ batch.name }}</h3><p>{{ batch.airportCount }} 个机场 · {{ batch.mode === 'FULL_PRODUCTION' ? '完整生产' : '资料分析' }} · 并发 {{ batch.concurrency }}</p></div>
        <div class="batch-progress"><div><i :style="{width:`${batch.progress}%`}"></i></div><p>{{ batch.completedAirportCount }} 完成 · {{ batch.activeAirportCount }} 运行 · {{ batch.queuedAirportCount }} 排队 · {{ batch.failedAirportCount }} 失败</p></div>
        <div class="batch-actions">
          <button v-if="batch.status !== 'RUNNING'" @click="runBatch(batch,'ANALYZE')">只分析资料</button>
          <button v-if="batch.status !== 'RUNNING'" class="primary" @click="runBatch(batch,'FULL_PRODUCTION')">完整生产</button>
          <button v-if="batch.status === 'RUNNING'" @click="pauseBatch(batch)">暂停派发</button>
          <button v-if="batch.failedAirportCount && batch.status !== 'RUNNING'" @click="runBatch(batch,batch.mode,true)">重试失败机场</button>
        </div>
      </article>
    </section>

    <section v-if="exceptionQueue.total" class="exception-board">
      <div class="section-title"><div><p class="eyebrow">EXCEPTION QUEUE</p><h2>跨机场例外队列</h2></div><span>{{ exceptionQueue.blockerCount }} 阻断 · {{ exceptionQueue.reviewCount }} 待复核</span></div>
      <div class="exception-list">
        <button v-for="issue in exceptionQueue.items" :key="`${issue.taskId}:${issue.exceptionId}`" @click="router.push(`/production-tasks/${issue.taskId}?package=${issue.packageId}`)">
          <span :class="issue.severity.toLowerCase()">{{ issue.severity === 'BLOCKER' ? '阻断' : '复核' }}</span>
          <div><b>{{ issue.airportIcao || '未知机场' }} · {{ issue.procedureName }}</b><p>{{ issue.message }}</p></div>
          <em>{{ ownerLabel(issue.owner) }}</em>
        </button>
      </div>
    </section>

    <section class="create">
      <div class="copy"><h2>新建生产任务</h2><p>单机场 PDF 建立一个任务；选择国家或多国家文件夹时，系统依据目录中的 ICAO 四字码拆成完整机场任务。</p><input v-model="taskName" placeholder="单机场任务名称（可选）" /></div>
      <div class="drop" :class="{ dragging }" @dragover.prevent="dragging=true" @dragleave="dragging=false" @drop.prevent="drop">
        <strong>拖拽 PDF 或选择资料</strong><span>国家文件夹建议：国家 / ICAO / PDF</span>
        <div><label>选择 PDF<input type="file" accept="application/pdf" multiple @change="select(($event.target as HTMLInputElement).files)" /></label><label class="secondary">选择国家文件夹<input type="file" accept="application/pdf" multiple webkitdirectory="" @change="select(($event.target as HTMLInputElement).files)" /></label></div>
      </div>
      <div v-if="files.length" class="queue">
        <div v-for="(file,index) in files" :key="fileKey(file)"><span>PDF</span><p><b>{{ (file as any).webkitRelativePath || file.name }}</b><small>{{ (file.size/1024/1024).toFixed(1) }} MB</small></p><button @click="files.splice(index,1)">移除</button></div>
        <button class="primary" :disabled="creating" @click="create">{{ creating ? "正在摄取…" : `开始摄取（${files.length} 个文件）` }}</button>
      </div>
    </section>

    <section class="tasks">
      <div class="section-title"><h2>机场生产任务</h2><button @click="load">刷新</button></div>
      <div v-if="tasks.length" class="task-list">
        <article v-for="task in tasks" :key="task.taskId">
          <div class="identity"><span class="status">{{ task.stage }}</span><h3>{{ task.taskName }}</h3><p>{{ task.sourceCountry ? `${task.sourceCountry} · ` : "" }}{{ task.airport?.icao || "机场待识别" }} · {{ task.fileCount }} 份 PDF · {{ task.packageCount }} 个程序</p></div>
          <div class="production"><span><b>{{ task.production?.autoPassPackages || 0 }}</b><small>自动通过</small></span><span class="confirmed"><b>{{ task.production?.humanConfirmedPackages || 0 }}</b><small>人工通过</small></span><span class="review"><b>{{ task.production?.reviewPackages || 0 }}</b><small>待复核</small></span><span class="blocked"><b>{{ task.production?.blockedPackages || 0 }}</b><small>阻断</small></span><span><b>{{ task.production?.autoPassRate == null ? "—" : `${task.production.autoPassRate}%` }}</b><small>自动通过率</small></span></div>
          <button class="enter" @click="router.push(task.stage==='UPLOAD' ? `/production-tasks/${task.taskId}/intake` : `/production-tasks/${task.taskId}`)">进入</button>
          <button class="remove" :disabled="removing===task.taskId" @click="remove(task)">{{ removing===task.taskId ? "删除中…" : "删除" }}</button>
        </article>
      </div>
      <p v-else class="empty">暂无机场生产任务</p>
    </section>
  </main>
</template>

<style scoped>
.batch-board,.exception-board{margin:18px 0;background:#fff;border:1px solid #dfe7ec;border-radius:12px;padding:18px}.section-title>small{color:#728696}.batch-card{display:grid;grid-template-columns:260px 1fr auto;align-items:center;gap:18px;padding:14px 0;border-top:1px solid #edf1f4}.batch-card h3{display:inline;margin:0 7px}.batch-card p{margin:5px 0 0;color:#6c8190;font-size:11px}.batch-status{font-size:10px;padding:4px 6px;border-radius:4px;background:#edf2f5}.batch-status.running{background:#e5f3ee;color:#08705a}.batch-status.paused{background:#fff0da;color:#935c08}.batch-status.completed_with_errors{background:#fee8e6;color:#a7352f}.batch-progress>div{height:7px;background:#e7edf1;border-radius:6px;overflow:hidden}.batch-progress i{display:block;height:100%;background:#13816a}.batch-actions{display:flex;gap:6px}.batch-actions button{border:1px solid #b8c9d3;background:#fff;color:#31596d;border-radius:6px;padding:8px 10px;cursor:pointer}.batch-actions .primary{background:#08705a;color:#fff;border-color:#08705a}.exception-board>.section-title>span{color:#a04b31}.exception-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px}.exception-list button{display:flex;align-items:flex-start;gap:9px;border:1px solid #e2e9ed;background:#fbfcfd;border-radius:8px;padding:10px;text-align:left;cursor:pointer}.exception-list button>span{font-size:9px;padding:4px 5px;border-radius:4px}.exception-list .blocker{background:#fee8e6;color:#a7352f}.exception-list .review{background:#fff0da;color:#935c08}.exception-list button div{flex:1;min-width:0}.exception-list p{margin:4px 0 0;color:#708493;font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.exception-list em{font-style:normal;font-size:10px;color:#557080}
.page{padding:30px;max-width:1400px;margin:auto;color:#102a43}.eyebrow{font-size:11px;letter-spacing:.15em;color:#08705a;font-weight:800}h1{font-size:32px;margin:4px 0}header>p:last-child,.copy p{color:#627d78}.error,.success{padding:11px 13px;border-radius:8px}.error{background:#fee2e2;color:#991b1b}.success{background:#e4f4ed;color:#07634f}.efficiency{display:grid;grid-template-columns:repeat(8,1fr);gap:8px;margin:20px 0}.efficiency span{background:#fff;border:1px solid #dfe7ec;border-radius:10px;padding:12px;text-align:center}.efficiency b,.efficiency small{display:block}.efficiency b{font-size:21px}.efficiency small{color:#718493;margin-top:3px}.create{background:#fff;border-radius:14px;padding:24px;box-shadow:0 8px 30px #102a4310;display:grid;grid-template-columns:.8fr 1.2fr;gap:24px}.copy input{width:100%;box-sizing:border-box;padding:10px;border:1px solid #ccd6e0;border-radius:7px}.drop{border:2px dashed #b8c7d9;border-radius:12px;min-height:170px;display:grid;place-content:center;text-align:center;gap:7px;background:#f8fbff}.drop.dragging{border-color:#08705a;background:#eef8f5}.drop span{color:#829ab1}.drop label{display:inline-block;background:#08705a;color:#fff;padding:9px 13px;border-radius:7px;margin:8px 4px;cursor:pointer}.drop label.secondary{background:#fff;color:#086551;border:1px solid #9bcbbb}.drop input{display:none}.queue{grid-column:1/-1}.queue>div{display:flex;align-items:center;border-top:1px solid #edf1f5;padding:9px}.queue>div>span{background:#e8f3ef;color:#08705a;padding:6px;border-radius:5px}.queue p{flex:1;margin:0 11px}.queue small{display:block;color:#829ab1}.queue button,.section-title button{border:0;background:none;color:#52606d;cursor:pointer}.primary,.enter{border:0;background:#08705a;color:#fff;border-radius:7px;padding:10px 14px;cursor:pointer}.tasks{margin-top:28px}.section-title{display:flex;justify-content:space-between}.task-list{display:grid;gap:10px}.task-list article{display:flex;align-items:center;background:#fff;border-radius:11px;padding:16px 19px;gap:14px}.identity{min-width:300px}.task-list h3{margin:5px 0}.task-list p{color:#627d98;margin:0;font-size:12px}.status{font-size:10px;color:#08705a;background:#e6f3ef;padding:4px 7px;border-radius:4px}.production{display:grid;grid-template-columns:repeat(5,minmax(62px,1fr));text-align:center;margin-left:auto}.production span{padding:5px 9px;border-left:1px solid #edf1f5}.production b,.production small{display:block}.production small{color:#829ab1;font-size:10px}.confirmed b{color:#3978b8}.review b{color:#a16207}.blocked b{color:#b42318}.remove{border:0;background:none;color:#a02c2c;cursor:pointer}.empty{text-align:center;color:#829ab1;padding:35px}@media(max-width:1100px){.efficiency{grid-template-columns:repeat(4,1fr)}.task-list article{flex-wrap:wrap}.production{order:3;width:100%;margin:0}}@media(max-width:800px){.create{grid-template-columns:1fr}.page{padding:16px}.efficiency{grid-template-columns:repeat(2,1fr)}}
</style>
