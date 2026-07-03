import { createRouter, createWebHistory } from 'vue-router';
import PdfProcedureRecognizer from '../views/PdfProcedureRecognizer.vue';
import ProcedureGeoJsonViewer from '../views/ProcedureGeoJsonViewer.vue';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/pdf-procedure-recognizer' },
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
