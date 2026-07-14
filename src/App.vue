<template>
  <nav class="app-nav">
    <router-link to="/autonomous-recognition">自主识别任务</router-link>
    <router-link to="/pdf-procedure-recognizer">原识别流程</router-link>
    <router-link to="/procedure-geojson">GeoJSON 预览</router-link>
  </nav>
  <router-view />
</template>

<style>
.app-nav{position:sticky;top:0;z-index:1000;display:flex;gap:18px;padding:10px 20px;background:#10233e;color:#fff;font:14px/1.5 system-ui}.app-nav a{color:#cbd5e1;text-decoration:none}.app-nav a.router-link-active{color:#fff;font-weight:700}
</style>
