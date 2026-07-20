<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { agentRequest, uploadForm } from "../../services/agentApi";

const route = useRoute();
const router = useRouter();
const id = String(route.params.taskId);
const task = ref<any>();
const error = ref("");
const busy = ref(false);
const append = ref<File[]>([]);

onMounted(load);
async function load() {
  try { task.value = await agentRequest(`/tasks/${id}`); }
  catch (e) { error.value = message(e); }
}
function choose(list: FileList | null) {
  append.value = Array.from(list || []).filter((file) => file.name.toLowerCase().endsWith(".pdf"));
}
async function add() {
  if (!append.value.length) return;
  busy.value = true;
  try {
    await agentRequest(`/tasks/${id}/documents`, { method: "POST", body: uploadForm(append.value) });
    append.value = [];
    await load();
  } catch (e) { error.value = message(e); }
  finally { busy.value = false; }
}
async function remove(documentId: string) {
  try {
    await agentRequest(`/tasks/${id}/documents/${documentId}`, { method: "DELETE" });
    await load();
  } catch (e) { error.value = message(e); }
}
async function analyze() {
  busy.value = true;
  try {
    await agentRequest(`/tasks/${id}/analyze`, { method: "POST" });
    await router.push(`/production-tasks/${id}`);
  } catch (e) { error.value = message(e); }
  finally { busy.value = false; }
}
function message(e: unknown) { return e instanceof Error ? e.message : String(e); }
</script>

<template>
  <main v-if="task" class="intake">
    <button class="back" @click="router.push('/production')">← 返回机场生产</button>
    <header>
      <div><span>01 · 资料准备</span><h1>{{ task.taskName }}</h1><p>确认本机场本周期的全部AD-2资料。缺文件比识别错误更难被发现，因此生产开始前先完成资料账目。</p></div>
      <aside><b>{{ task.documents.length }}</b><small>PDF文件</small></aside>
    </header>
    <p v-if="error" class="error">{{ error }}</p>
    <section class="panel">
      <div class="panel-head">
        <div><h2>源资料清单</h2><p>支持完整AD-2、拆分航图、编码表、坐标表和扫描件。</p></div>
        <label>追加PDF或文件夹<input type="file" accept="application/pdf" multiple webkitdirectory="" @change="choose(($event.target as HTMLInputElement).files)" /></label>
      </div>
      <div class="documents">
        <article v-for="doc in task.documents" :key="doc.documentId">
          <span>PDF</span><div><b>{{ doc.fileName }}</b><p>{{ (doc.sizeBytes/1024/1024).toFixed(1) }} MB · {{ doc.pageCount || '待解析' }}页</p></div>
          <em :class="doc.parseStatus">{{ doc.parseStatus }}</em>
          <button v-if="task.stage === 'UPLOAD'" @click="remove(doc.documentId)">移除</button>
        </article>
      </div>
      <div v-if="append.length" class="pending">
        <div><b>待追加 {{ append.length }} 个文件</b><p>{{ append.map((file) => file.name).join('、') }}</p></div>
        <button :disabled="busy" @click="add">确认追加</button>
      </div>
    </section>
    <footer>
      <div><b>下一步：建立机场程序清单</b><p>系统将解析页面、核对程序目录并形成SID、STAR和进近生产项。</p></div>
      <button class="primary" :disabled="busy || !task.documents.length" @click="analyze">{{ busy ? '正在建立清单…' : '确认资料并开始生产' }}</button>
    </footer>
  </main>
</template>

<style scoped>
.intake{max-width:1180px;margin:auto;padding:34px;color:#132c42}.back{border:0;background:none;color:#557087;padding:0;cursor:pointer}header{display:flex;justify-content:space-between;gap:30px;margin:26px 0}header span{font-size:12px;color:#19705d;font-weight:800;letter-spacing:.08em}h1{font-size:34px;margin:8px 0}header p,.panel-head p,footer p{color:#667d91;line-height:1.6;margin:4px 0}header aside{min-width:120px;background:#e9f6f1;border-radius:14px;display:grid;place-content:center;text-align:center}header aside b{font-size:30px;color:#12604f}header aside small{color:#557b71}.error{padding:12px;background:#fff0ef;color:#a12c27;border-radius:8px}.panel{background:#fff;border:1px solid #dfe7ed;border-radius:15px;overflow:hidden}.panel-head{display:flex;justify-content:space-between;align-items:center;padding:22px 24px}.panel-head h2{margin:0}.panel-head label,.pending button,.primary{background:#0d6a56;color:#fff;border:0;border-radius:8px;padding:10px 15px;cursor:pointer}.panel-head input{display:none}.documents article{display:flex;align-items:center;gap:14px;padding:15px 24px;border-top:1px solid #e9eef2}.documents article>span{background:#edf3f7;color:#355b76;border-radius:7px;padding:9px;font-size:12px;font-weight:700}.documents article div{flex:1}.documents p{margin:4px 0 0;color:#7c8f9f;font-size:12px}.documents em{font-style:normal;font-size:11px;color:#607789;background:#edf2f5;padding:5px 8px;border-radius:5px}.documents em.PARSED{color:#17624e;background:#e7f5ef}.documents button{border:0;background:none;color:#b23b34;cursor:pointer}.pending{display:flex;align-items:center;justify-content:space-between;padding:16px 24px;background:#f2f7f5}.pending p{max-width:800px;margin:4px 0;color:#668077;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}footer{display:flex;align-items:center;justify-content:space-between;margin-top:20px;padding:18px 22px;background:#122d3f;color:#fff;border-radius:12px}footer p{color:#aec0cb}.primary{background:#2e9b7f;font-size:14px}.primary:disabled{opacity:.5;cursor:default}
</style>
