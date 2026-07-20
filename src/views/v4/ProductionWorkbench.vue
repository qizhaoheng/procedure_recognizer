<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import AgentResultMap from "../../components/agent/AgentResultMap.vue";
import { agentRequest } from "../../services/agentApi";

type Filter = "ALL" | "REVIEW_REQUIRED" | "BLOCKED" | "AUTO_PASS" | "PENDING";
type Tab = "EXCEPTIONS" | "DATA" | "MAP" | "ARINC424";

const route = useRoute();
const router = useRouter();
const taskId = String(route.params.taskId);
const task = ref<any>();
const production = ref<any>();
const selectedId = ref(String(route.query.package || ""));
const bundle = ref<any>();
const filter = ref<Filter>("ALL");
const tab = ref<Tab>("EXCEPTIONS");
const search = ref("");
const busy = ref(false);
const error = ref("");
let timer: number | undefined;

const assessmentMap = computed(() => new Map((production.value?.assessments || []).map((item: any) => [item.packageId, item])));
const packages = computed(() => (task.value?.packages || []).filter((pkg: any) => {
  const assessment: any = assessmentMap.value.get(pkg.packageId);
  if (filter.value !== "ALL" && assessment?.disposition !== filter.value) return false;
  return !search.value.trim() || `${pkg.procedureName} ${pkg.procedureCategory} ${pkg.runways?.join(" ")}`.toLowerCase().includes(search.value.toLowerCase());
}));
const selectedPackage = computed(() => task.value?.packages?.find((pkg: any) => pkg.packageId === selectedId.value));
const selectedAssessment = computed<any>(() => assessmentMap.value.get(selectedId.value));
const selectedResult = computed(() => bundle.value?.result);
const pir = computed(() => selectedResult.value?.pir);
const exceptions = computed(() => selectedAssessment.value?.exceptions || []);
const sourcePages = computed(() => selectedPackage.value?.packagePages || []);
const evidence = computed(() => pir.value?.sourceEvidence || []);
const running = computed(() => task.value?.status === "RUNNING" || task.value?.stage === "ANALYZING" || task.value?.stage === "RECOGNIZING");

onMounted(async () => {
  await load();
  timer = window.setInterval(() => { if (running.value) load(true); }, 2500);
});
onBeforeUnmount(() => timer && clearInterval(timer));

async function load(background = false) {
  try {
    const [workspace, summary] = await Promise.all([
      agentRequest(`/tasks/${taskId}?view=workspace`),
      agentRequest(`/tasks/${taskId}/production-summary`),
    ]);
    task.value = workspace;
    production.value = summary;
    if (!selectedId.value || !workspace.packages.some((pkg: any) => pkg.packageId === selectedId.value)) {
      selectedId.value = workspace.packages[0]?.packageId || "";
    }
    if (selectedId.value) await loadResult(selectedId.value);
    if (!background) error.value = "";
  } catch (e) { error.value = message(e); }
}
async function loadResult(packageId: string) {
  try { bundle.value = await agentRequest(`/packages/${packageId}/result`); }
  catch { bundle.value = undefined; }
}
async function selectPackage(packageId: string) {
  selectedId.value = packageId;
  bundle.value = undefined;
  tab.value = selectedAssessment.value?.disposition === "AUTO_PASS" ? "DATA" : "EXCEPTIONS";
  await loadResult(packageId);
}
async function recognize(packageIds?: string[]) {
  const ids = packageIds?.length ? packageIds : (production.value?.assessments || [])
    .filter((item: any) => item.disposition !== "AUTO_PASS")
    .map((item: any) => item.packageId);
  if (!ids.length) return;
  busy.value = true;
  try {
    await agentRequest(`/tasks/${taskId}/packages/recognize`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ packageIds: ids }),
    });
    await load();
  } catch (e) { error.value = message(e); }
  finally { busy.value = false; }
}
async function analyze() {
  busy.value = true;
  try { await agentRequest(`/tasks/${taskId}/packages/reanalyze`, { method: "POST" }); await load(); }
  catch (e) { error.value = message(e); }
  finally { busy.value = false; }
}
function openSource(page: any) {
  window.open(`/api/agent/tasks/${taskId}/documents/${page.documentId}/file#page=${page.pageNumber}`, "_blank", "noopener");
}
function dispositionLabel(value: string) {
  return ({ AUTO_PASS: "自动通过", REVIEW_REQUIRED: "待专业复核", BLOCKED: "生产阻塞", PENDING: "待生产" } as Record<string, string>)[value] || value;
}
function ownerLabel(value: string) { return value === "CHART_SPECIALIST" ? "航图制图员" : "424编码员"; }
function runwayLabel(values: string[] = []) {
  return values.map((value) => String(value).replace(/^RWY\s*/i, "")).join(", ") || "—";
}
function issueMessage(issue: any) {
  const labels: Record<string, string> = {
    CROSS_PROCEDURE_PACKAGE: "同一生产项中仍包含多个独立程序，需要重新拆分。",
    TABLE_MISSING: "未关联程序编码表；本次生产只能依据航图识别。",
    COORDINATE_SOURCE_MISSING: "未关联明确的航路点坐标来源。",
    RUNWAY_DATA_MISSING: "缺少跑道主数据来源。",
    CHART_MISSING: "缺少程序航图，无法开始生产。",
    PROCEDURE_IDENTITY_UNCLEAR: "程序身份或适用跑道不明确。",
    ARINC424_INCOMPLETE: "424产物不完整，不能导入下游。",
    CRITICAL_EVIDENCE_INCOMPLETE: "关键字段的源页证据覆盖不完整。",
    ARINC424_AI_GENERATED: "424文本由模型直接生成，必须改由确定性编译器生成。",
  };
  return labels[issue.code] || issue.message;
}
function message(e: unknown) { return e instanceof Error ? e.message : String(e); }
</script>

<template>
  <main v-if="task && production" class="workbench">
    <header class="topbar">
      <button class="back" @click="router.push('/production')">←</button>
      <div class="airport"><span>机场生产任务</span><h1>{{ task.airportIcao || task.taskName }}</h1><p>{{ task.airportName || task.taskName }} · {{ task.documents.length }}份源文件 · {{ task.packages.length }}个程序</p></div>
      <div class="top-actions"><button @click="analyze">重新核对资料</button><button class="primary" :disabled="busy || running" @click="recognize()">{{ running ? '生产进行中…' : '生产全部未通过项' }}</button></div>
    </header>

    <p v-if="error" class="error">{{ error }}</p>
    <section class="metrics">
      <article><span>自动通过率</span><b>{{ production.autoPassRate == null ? '—' : `${production.autoPassRate}%` }}</b><small>目标 90%+</small></article>
      <article class="pass"><span>自动通过</span><b>{{ production.autoPassPackages }}</b><small>无需逐字段检查</small></article>
      <article class="review"><span>待专业复核</span><b>{{ production.reviewPackages }}</b><small>{{ production.openExceptionCount }}项有效例外</small></article>
      <article class="blocked"><span>生产阻塞</span><b>{{ production.blockedPackages }}</b><small>缺资料或产物不可用</small></article>
      <article><span>待生产</span><b>{{ production.pendingPackages }}</b><small>尚未形成结果</small></article>
      <article :class="{ pass: production.releaseReady }"><span>机场放行</span><b class="release">{{ production.releaseReady ? 'READY' : 'NOT READY' }}</b><small>{{ production.releaseReady ? '满足确定性质量门' : '仍有未关闭生产项' }}</small></article>
    </section>

    <section v-if="task.stage === 'ANALYZING'" class="notice"><i></i><div><b>正在建立机场程序清单</b><p>解析源页、识别SID/STAR/进近并核对页面归属。</p></div></section>

    <section class="workspace">
      <aside class="programs">
        <div class="aside-head"><h2>生产项</h2><span>{{ packages.length }}/{{ task.packages.length }}</span></div>
        <input v-model="search" class="search" placeholder="搜索程序、跑道…" />
        <div class="filters">
          <button v-for="item in [['ALL','全部'],['REVIEW_REQUIRED','待复核'],['BLOCKED','阻塞'],['AUTO_PASS','已通过'],['PENDING','待生产']]" :key="item[0]" :class="{ active: filter === item[0] }" @click="filter = item[0] as Filter">{{ item[1] }}</button>
        </div>
        <div class="program-list">
          <button v-for="pkg in packages" :key="pkg.packageId" :class="['program', (assessmentMap.get(pkg.packageId) as any)?.disposition?.toLowerCase(), { selected: selectedId === pkg.packageId }]" @click="selectPackage(pkg.packageId)">
            <span class="rail"></span><div><b>{{ pkg.procedureName }}</b><small>{{ pkg.procedureCategory }} · RWY {{ runwayLabel(pkg.runways) }}</small></div>
            <em>{{ (assessmentMap.get(pkg.packageId) as any)?.exceptions?.filter((item: any) => item.severity !== 'WARNING').length || '' }}</em>
          </button>
          <p v-if="!packages.length" class="empty">当前筛选没有生产项</p>
        </div>
      </aside>

      <article v-if="selectedPackage" class="detail">
        <header class="detail-head">
          <div><span :class="['disposition', selectedAssessment?.disposition?.toLowerCase()]">{{ dispositionLabel(selectedAssessment?.disposition) }}</span><h2>{{ selectedPackage.procedureName }}</h2><p>{{ selectedPackage.procedureCategory }} · RWY {{ runwayLabel(selectedPackage.runways) }} · {{ selectedPackage.navigationType || '导航类型待确认' }}</p></div>
          <button v-if="selectedAssessment?.disposition !== 'AUTO_PASS'" :disabled="busy || running" @click="recognize([selectedPackage.packageId])">重新生产此项</button>
        </header>
        <nav class="tabs">
          <button :class="{ active: tab === 'EXCEPTIONS' }" @click="tab='EXCEPTIONS'">例外 <i v-if="exceptions.length">{{ exceptions.length }}</i></button>
          <button :class="{ active: tab === 'DATA' }" @click="tab='DATA'">结构化数据</button>
          <button :class="{ active: tab === 'MAP' }" @click="tab='MAP'">航迹核对</button>
          <button :class="{ active: tab === 'ARINC424' }" @click="tab='ARINC424'">424产物</button>
        </nav>

        <div v-if="tab === 'EXCEPTIONS'" class="tab-body exception-list">
          <div v-if="!exceptions.length" class="clear"><b>没有需要人工处理的例外</b><p>该程序已通过当前V4确定性生产门。</p></div>
          <article v-for="issue in exceptions" :key="issue.exceptionId" :class="issue.severity.toLowerCase()">
            <span>{{ issue.severity === 'BLOCKER' ? '阻塞' : issue.severity === 'REVIEW' ? '复核' : '提示' }}</span>
            <div><b>{{ issueMessage(issue) }}</b><p>{{ issue.code }}<template v-if="issue.fieldPath"> · {{ issue.fieldPath }}</template></p></div>
            <em>{{ ownerLabel(issue.owner) }}</em>
          </article>
        </div>

        <div v-else-if="tab === 'DATA'" class="tab-body data-view">
          <div v-if="pir" class="data-stats"><span><b>{{ pir.routes?.length || 0 }}</b>路线</span><span><b>{{ pir.legs?.length || 0 }}</b>航段</span><span><b>{{ pir.fixes?.length || 0 }}</b>定位点</span><span><b>{{ pir.minima?.length || 0 }}</b>最低标准</span><span><b>{{ selectedAssessment?.evidenceCoverage == null ? '—' : `${Math.round(selectedAssessment.evidenceCoverage*100)}%` }}</b>证据覆盖</span></div>
          <table v-if="pir?.legs?.length"><thead><tr><th>序号</th><th>路线</th><th>PT</th><th>FROM</th><th>TO</th><th>航向</th><th>距离</th><th>高度</th></tr></thead><tbody><tr v-for="leg in pir.legs" :key="leg.legId"><td>{{ leg.sequence }}</td><td>{{ pir.routes.find((r:any)=>r.routeId===leg.routeId)?.routeType }}</td><td><b>{{ leg.pathTerminator }}</b></td><td>{{ pir.fixes.find((f:any)=>f.fixId===leg.fromFixId)?.identifier || '—' }}</td><td>{{ pir.fixes.find((f:any)=>f.fixId===leg.toFixId)?.identifier || '—' }}</td><td>{{ leg.course ?? '—' }}</td><td>{{ leg.distanceNm ?? '—' }}</td><td>{{ leg.altitudeConstraint?.rawText || leg.altitudeConstraint?.lowerFt || '—' }}</td></tr></tbody></table>
          <div v-else class="empty">尚无结构化生产结果</div>
        </div>

        <div v-else-if="tab === 'MAP'" class="tab-body map-view">
          <AgentResultMap v-if="selectedResult?.geojson" :geojson="selectedResult.geojson" />
          <div v-else class="empty">尚无可核对航迹</div>
        </div>

        <div v-else class="tab-body arinc-view">
          <div class="artifact-head"><div><b>{{ selectedResult?.candidate424?.status || '尚无424产物' }}</b><p>{{ selectedResult?.candidate424?.profile || '编码Profile待建立' }}</p></div><span>{{ String(selectedResult?.candidate424?.text || '').split('\n').filter(Boolean).length }}条记录</span></div>
          <pre v-if="selectedResult?.candidate424?.text">{{ selectedResult.candidate424.text }}</pre>
          <div v-else class="empty">尚无可导入的424文本</div>
        </div>
      </article>

      <aside v-if="selectedPackage" class="sources">
        <div class="aside-head"><h2>源资料与证据</h2><span>{{ sourcePages.length }}页</span></div>
        <section><h3>程序源页</h3><button v-for="page in sourcePages" :key="`${page.documentId}:${page.pageNumber}`" @click="openSource(page)"><span>p{{ page.pageNumber }}</span><div><b>{{ page.pageRole }}</b><small>{{ page.fileName }}</small></div><em>打开</em></button></section>
        <section><h3>字段证据</h3><button v-for="item in evidence.slice(0, 20)" :key="item.evidenceId" @click="openSource(item)"><span>p{{ item.pageNumber }}</span><div><b>{{ item.rawText?.slice(0, 46) || item.sourceType }}</b><small>{{ item.extractionMethod }} · {{ Math.round(item.confidence*100) }}%</small></div><em>查看</em></button><p v-if="!evidence.length" class="empty">暂无字段级证据</p></section>
      </aside>
    </section>
  </main>
</template>

<style scoped>
.workbench{min-height:calc(100vh - 48px);padding:18px 22px 24px;background:#f3f6f8;color:#142d40;box-sizing:border-box}.topbar{display:flex;align-items:center;gap:13px}.back{width:34px;height:34px;border:1px solid #ccd8e1;background:#fff;border-radius:8px;color:#496477;cursor:pointer}.airport span{font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:#23826d;font-weight:800}.airport h1{display:inline;margin:0 8px;font-size:23px}.airport p{display:inline;color:#6b7f8f;font-size:12px}.top-actions{margin-left:auto}.top-actions button,.detail-head button{border:1px solid #bdccd7;background:#fff;color:#36566c;padding:9px 13px;border-radius:7px;margin-left:8px;cursor:pointer}.top-actions .primary{background:#0d6b57;color:#fff;border-color:#0d6b57}.error{background:#ffedeb;color:#a12d28;padding:10px 13px;border-radius:8px}.metrics{display:grid;grid-template-columns:repeat(6,1fr);gap:9px;margin:16px 0}.metrics article{background:#fff;border:1px solid #dfe7ec;border-radius:10px;padding:12px 14px}.metrics span,.metrics small{display:block;color:#708493;font-size:11px}.metrics b{display:block;font-size:25px;margin:3px 0}.metrics .pass b{color:#08735a}.metrics .review b{color:#a36308}.metrics .blocked b{color:#b33a33}.metrics .release{font-size:17px;margin:9px 0 8px}.notice{display:flex;align-items:center;gap:13px;background:#eaf5f2;border:1px solid #cce6de;padding:12px 16px;border-radius:9px;margin-bottom:10px}.notice i{width:18px;height:18px;border:2px solid #49a48d;border-top-color:transparent;border-radius:50%;animation:spin 1s linear infinite}.notice p{margin:3px 0 0;color:#628177;font-size:12px}@keyframes spin{to{transform:rotate(360deg)}}.workspace{display:grid;grid-template-columns:270px minmax(520px,1fr) 290px;gap:10px;height:calc(100vh - 208px);min-height:580px}.programs,.detail,.sources{background:#fff;border:1px solid #dfe7ec;border-radius:11px;overflow:hidden}.aside-head{display:flex;justify-content:space-between;align-items:center;padding:14px 15px}.aside-head h2{margin:0;font-size:15px}.aside-head span{color:#718697;font-size:12px}.search{box-sizing:border-box;width:calc(100% - 24px);margin:0 12px 9px;padding:8px 10px;border:1px solid #d3dee6;border-radius:7px}.filters{display:flex;gap:4px;padding:0 10px 9px;overflow:auto}.filters button{border:0;background:#edf2f5;color:#657a8a;padding:5px 7px;border-radius:5px;white-space:nowrap;font-size:11px;cursor:pointer}.filters button.active{background:#dcefe9;color:#086a55;font-weight:700}.program-list{overflow:auto;height:calc(100% - 106px)}.program{position:relative;width:100%;display:flex;align-items:center;gap:9px;border:0;border-top:1px solid #edf1f4;background:#fff;padding:11px 11px 11px 15px;text-align:left;cursor:pointer}.program.selected{background:#f0f7f5}.program .rail{position:absolute;left:0;width:4px;height:100%;background:#aebcc6}.program.auto_pass .rail{background:#189477}.program.review_required .rail{background:#d18a1d}.program.blocked .rail{background:#cf4b43}.program div{min-width:0;flex:1}.program b,.program small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.program small{color:#728696;margin-top:4px;font-size:10px}.program em{font-style:normal;background:#f6e8d2;color:#9b620d;border-radius:10px;min-width:18px;text-align:center}.detail{display:flex;flex-direction:column}.detail-head{display:flex;justify-content:space-between;align-items:center;padding:16px 18px;border-bottom:1px solid #e8edf1}.detail-head h2{display:inline;margin:0 8px;font-size:19px}.detail-head p{margin:5px 0 0;color:#708391;font-size:12px}.disposition{font-size:10px;padding:4px 6px;border-radius:4px;background:#edf2f5;color:#587080}.disposition.auto_pass{background:#e1f3ed;color:#08705a}.disposition.review_required{background:#fff0db;color:#975c05}.disposition.blocked{background:#fee8e6;color:#aa332d}.tabs{display:flex;border-bottom:1px solid #e5ebef;padding:0 12px}.tabs button{border:0;background:none;padding:11px 12px;color:#687d8c;cursor:pointer;border-bottom:2px solid transparent}.tabs button.active{color:#0b6b57;border-bottom-color:#0b6b57;font-weight:700}.tabs i{font-style:normal;background:#f4d9b3;color:#925b0a;border-radius:8px;padding:1px 5px}.tab-body{flex:1;overflow:auto}.exception-list{padding:12px}.exception-list article{display:flex;align-items:flex-start;gap:10px;padding:12px;border:1px solid #e4eaee;border-radius:8px;margin-bottom:8px}.exception-list article>span{font-size:10px;padding:4px 6px;border-radius:4px;background:#eef2f5}.exception-list article.blocker{border-left:4px solid #c9433c}.exception-list article.review{border-left:4px solid #d58b18}.exception-list article.warning{opacity:.72}.exception-list article div{flex:1}.exception-list article p{margin:5px 0 0;color:#788a98;font-size:11px}.exception-list article em{font-style:normal;font-size:11px;color:#4f697a}.clear{padding:50px;text-align:center;color:#237760}.clear p{color:#748b82}.data-stats{display:grid;grid-template-columns:repeat(5,1fr);border-bottom:1px solid #e5ebef}.data-stats span{padding:13px;text-align:center;color:#6a7f8d;font-size:11px}.data-stats b{display:block;color:#17384b;font-size:19px}table{width:100%;border-collapse:collapse;font-size:11px}th,td{padding:8px;border-bottom:1px solid #edf1f3;text-align:left}th{position:sticky;top:0;background:#f7f9fa;color:#657988}.map-view{min-height:420px}.map-view :deep(.map-wrap){height:100%}.artifact-head{display:flex;justify-content:space-between;padding:13px 16px;border-bottom:1px solid #e5ebef}.artifact-head p{margin:4px 0 0;color:#768997;font-size:11px}.arinc-view pre{margin:0;padding:14px;min-width:max-content;font:11px/1.55 Consolas,monospace;background:#10283a;color:#d7e5ec}.sources{overflow:auto}.sources section{border-top:1px solid #e6ecef;padding:11px}.sources h3{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#718593;margin:0 0 8px}.sources section button{display:flex;width:100%;align-items:center;gap:8px;border:0;background:#f6f8f9;margin-bottom:6px;padding:8px;border-radius:6px;text-align:left;cursor:pointer}.sources section button>span{font-size:10px;color:#396177;background:#e5edf2;padding:4px;border-radius:4px}.sources section button div{min-width:0;flex:1}.sources section button b,.sources section button small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.sources section button b{font-size:11px}.sources section button small{font-size:9px;color:#7c8d99;margin-top:3px}.sources section button em{font-style:normal;font-size:10px;color:#0b715b}.empty{text-align:center;color:#81929e;padding:35px}.error{margin-bottom:10px}@media(max-width:1200px){.workspace{grid-template-columns:250px 1fr}.sources{display:none}.metrics{grid-template-columns:repeat(3,1fr)}}
</style>
