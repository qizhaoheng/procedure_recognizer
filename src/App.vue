<template>
  <nav class="app-nav">
    <router-link class="brand" to="/production">AERODATA</router-link>
    <router-link to="/production">机场生产</router-link>
    <span>V4 · AIP → ARINC 424</span>
  </nav>
  <router-view />
</template>

<style>
.app-nav{position:sticky;top:0;z-index:1000;display:flex;align-items:center;gap:22px;height:48px;box-sizing:border-box;padding:0 24px;background:#0b1f33;color:#fff;font:14px/1.5 Inter,system-ui}.app-nav a{color:#bdc9d6;text-decoration:none}.app-nav a.router-link-active{color:#fff;font-weight:700}.app-nav .brand{font-weight:800;letter-spacing:.15em;color:#fff}.app-nav span{margin-left:auto;color:#7890a8;font-size:12px;letter-spacing:.06em}
</style>
