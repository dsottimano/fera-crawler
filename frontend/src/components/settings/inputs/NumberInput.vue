<script setup lang="ts">
const props = defineProps<{
  id?: string;
  modelValue: number;
  min?: number;
  max?: number;
  unit?: string;
}>();

const emit = defineEmits<{ "update:modelValue": [value: number] }>();

function onInput(e: Event) {
  const raw = (e.target as HTMLInputElement).value;
  const n = raw === "" ? 0 : Number(raw);
  if (Number.isNaN(n)) return;
  let clamped = n;
  if (props.min !== undefined) clamped = Math.max(props.min, clamped);
  if (props.max !== undefined) clamped = Math.min(props.max, clamped);
  emit("update:modelValue", clamped);
}
</script>

<template>
  <div class="num-wrap">
    <input
      :id="id"
      type="number"
      class="num-input"
      :value="modelValue"
      :min="min"
      :max="max"
      @input="onInput"
    />
    <span v-if="unit" class="unit">{{ unit }}</span>
  </div>
</template>

<style scoped>
.num-wrap {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.num-input {
  width: 90px;
  padding: 8px 12px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.04);
  color: #ffffff;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  outline: none;
  transition: border-color 0.2s, box-shadow 0.2s;
}

.num-input:focus {
  border-color: rgba(86, 156, 214, 0.5);
  box-shadow: 0 0 0 2px rgba(86, 156, 214, 0.1);
}

.unit {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.5px;
  color: rgba(255, 255, 255, 0.45);
}
</style>
