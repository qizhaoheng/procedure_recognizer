import { createRouter, createWebHistory } from 'vue-router';
import ProcedureGeoJsonViewer from '../views/ProcedureGeoJsonViewer.vue';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/procedure-geojson' },
    {
      path: '/procedure-geojson',
      name: 'ProcedureGeoJsonViewer',
      component: ProcedureGeoJsonViewer,
      meta: { title: '进场程序识别预览' },
    },
  ],
});

export default router;
