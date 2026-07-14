<script setup lang="ts">
const props = defineProps<{ current: number }>();
const steps = ['上传文件', '程序包分组', '程序识别', '识别结果'];
</script>
<template><ol class="workflow"><li v-for="(step,index) in steps" :key="step" :class="{active:index===props.current,done:index<props.current}"><span>{{ index+1 }}</span>{{ step }}</li></ol></template>
<style scoped>.workflow{display:flex;list-style:none;padding:0;margin:0;gap:0}.workflow li{display:flex;align-items:center;gap:8px;color:#718096;flex:1}.workflow li:not(:last-child)::after{content:'';height:1px;background:#d7dee8;flex:1;margin:0 14px}.workflow span{display:grid;place-items:center;width:28px;height:28px;border-radius:50%;background:#e8edf4;color:#667085;font-weight:700}.workflow .active{color:#174ea6;font-weight:700}.workflow .active span{background:#174ea6;color:#fff}.workflow .done span{background:#d9eadf;color:#237a4b}@media(max-width:760px){.workflow li{font-size:0}.workflow li:not(:last-child)::after{margin:0 6px}}</style>
