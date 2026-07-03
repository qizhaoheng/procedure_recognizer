<script setup lang="ts">
export interface LayerVisibility {
  procedureTrack: boolean;
  procedureLeg: boolean;
  procedureFix: boolean;
  derivedFix: boolean;
  navaid: boolean;
  runway: boolean;
  dmeArc: boolean;
  radial: boolean;
  leadRadial: boolean;
  msaSector: boolean;
  directionArrows: boolean;
  labels: boolean;
  reviewOnly: boolean;
}

const props = defineProps<{
  modelValue: LayerVisibility;
}>();

const emit = defineEmits<{
  'update:modelValue': [value: LayerVisibility];
}>();

const controls = [
  { key: 'procedureTrack', label: '程序航迹' },
  { key: 'procedureLeg', label: '分段腿段' },
  { key: 'procedureFix', label: '航路点' },
  { key: 'derivedFix', label: '派生点' },
  { key: 'navaid', label: '导航台' },
  { key: 'runway', label: '跑道' },
  { key: 'dmeArc', label: 'DME ARC / 参考圆' },
  { key: 'radial', label: '径向' },
  { key: 'leadRadial', label: 'Lead Radial' },
  { key: 'msaSector', label: 'MSA 扇区' },
  { key: 'directionArrows', label: '方向箭头' },
  { key: 'labels', label: '文字标签' },
  { key: 'reviewOnly', label: '只显示 Review Required' },
] as const;

function toggle(key: keyof LayerVisibility) {
  emit('update:modelValue', { ...props.modelValue, [key]: !props.modelValue[key] });
}
</script>

<template>
  <section class="panel">
    <h2>图层控制</h2>
    <label v-for="control in controls" :key="control.key" class="row">
      <input
        type="checkbox"
        :checked="modelValue[control.key]"
        @change="toggle(control.key)"
      />
      <span>{{ control.label }}</span>
    </label>
  </section>
</template>

<style scoped>
.panel {
  display: grid;
  gap: 9px;
}

h2 {
  margin: 0 0 2px;
  color: #172033;
  font-size: 14px;
}

.row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 24px;
  color: #263548;
  font-size: 12px;
  cursor: pointer;
}

input {
  width: 15px;
  height: 15px;
  accent-color: #246bd6;
}
</style>
