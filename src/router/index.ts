import { createRouter, createWebHistory } from 'vue-router';
import PdfProcedureRecognizer from '../views/PdfProcedureRecognizer.vue';
import ProcedureGeoJsonViewer from '../views/ProcedureGeoJsonViewer.vue';
import AgentTaskList from '../views/agent/AgentTaskList.vue';
import AgentTaskUpload from '../views/agent/AgentTaskUpload.vue';
import AgentPackages from '../views/agent/AgentPackages.vue';
import AgentResults from '../views/agent/AgentResults.vue';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/pdf-procedure-recognizer' },
    {
      path: '/autonomous-recognition',
      name: 'AutonomousRecognitionTasks',
      component: AgentTaskList,
      meta: { title: '自主识别任务' },
    },
    { path: '/agent-tasks/:taskId/upload', name: 'AgentTaskUpload', component: AgentTaskUpload, meta: { title: '上传机场文件' } },
    { path: '/agent-tasks/:taskId/packages', name: 'AgentPackages', component: AgentPackages, meta: { title: 'AI 程序包分组' } },
    { path: '/agent-tasks/:taskId/results/:packageId', name: 'AgentResults', component: AgentResults, meta: { title: '识别结果' } },
    {
      path: '/pdf-procedure-recognizer',
      name: 'PdfProcedureRecognizer',
      component: PdfProcedureRecognizer,
      meta: { title: 'PDF 程序识别流程' },
    },
    {
      path: '/procedure-geojson',
      name: 'ProcedureGeoJsonViewer',
      component: ProcedureGeoJsonViewer,
      meta: { title: 'GeoJSON 程序图预览器' },
    },
  ],
});

export default router;
