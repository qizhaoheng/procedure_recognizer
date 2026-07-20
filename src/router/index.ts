import { createRouter, createWebHistory } from 'vue-router';
import AgentTaskList from '../views/agent/AgentTaskList.vue';
import AgentTaskUpload from '../views/agent/AgentTaskUpload.vue';
import ProductionWorkbench from '../views/v4/ProductionWorkbench.vue';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/production' },
    {
      path: '/production',
      name: 'ProductionTasks',
      component: AgentTaskList,
      meta: { title: '机场航行数据生产' },
    },
    { path: '/production-tasks/:taskId/intake', name: 'ProductionIntake', component: AgentTaskUpload, meta: { title: '机场资料准备' } },
    { path: '/production-tasks/:taskId', name: 'ProductionWorkbench', component: ProductionWorkbench, meta: { title: '机场生产工作台' } },
    { path: '/autonomous-recognition', redirect: '/production' },
    { path: '/agent-tasks/:taskId/upload', redirect: (to) => `/production-tasks/${to.params.taskId}/intake` },
    { path: '/agent-tasks/:taskId/packages', redirect: (to) => `/production-tasks/${to.params.taskId}` },
    { path: '/agent-tasks/:taskId/results/:packageId', redirect: (to) => `/production-tasks/${to.params.taskId}?package=${to.params.packageId}` },
    { path: '/:pathMatch(.*)*', redirect: '/production' },
  ],
});

export default router;
