<script setup lang="ts">
import { computed } from "vue";

const props = defineProps<{
  id?: string;
  modelValue: string;
  presets?: readonly { label: string; value: string }[];
}>();
const emit = defineEmits<{ "update:modelValue": [value: string] }>();

// "custom" when the current value doesn't match any preset; "" for blank/default.
const activePreset = computed(() => {
  if (!props.presets?.length) return "";
  if (!props.modelValue) return "";
  const match = props.presets.find((p) => p.value === props.modelValue);
  return match ? match.label : "custom";
});

function onPreset(e: Event) {
  const key = (e.target as HTMLSelectElement).value;
  if (key === "") emit("update:modelValue", "");
  else if (key === "custom") return; // leave value as-is; user will type
  else {
    const preset = props.presets?.find((p) => p.label === key);
    if (preset) emit("update:modelValue", preset.value);
  }
}
</script>

<template>
  <div class="str-wrap">
    <select
      v-if="presets && presets.length"
      class="str-preset"
      :value="activePreset"
      @change="onPreset"
    >
      <option value="">Default (fingerprint)</option>
      <option v-for="p in presets" :key="p.label" :value="p.label">{{ p.label }}</option>
      <option value="custom">Custom…</option>
    </select>
    <input
      :id="id"
      type="text"
      class="str-input"
      :value="modelValue"
      placeholder="Leave empty for default"
      @input="$emit('update:modelValue', ($event.target as HTMLInputElement).value)"
    />
  </div>
</template>

<style scoped>
.str-wrap {
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: flex-end;
}
.str-preset {
  width: 220px;
  padding: 7px 28px 7px 12px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.04)
    url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='rgba(255,255,255,0.4)'/%3E%3C/svg%3E")
    no-repeat right 10px center;
  color: #ffffff;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.3px;
  appearance: none;
  -webkit-appearance: none;
  cursor: pointer;
  outline: none;
  transition: border-color 0.15s;
}
.str-preset:focus {
  border-color: rgba(86, 156, 214, 0.5);
  box-shadow: 0 0 0 2px rgba(86, 156, 214, 0.1);
}
.str-preset option {
  background: #141a2e;
  color: #ffffff;
  font-size: 11px;
}
.str-input {
  width: 380px;
  padding: 8px 12px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.04);
  color: #ffffff;
  font-size: 10px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  outline: none;
  transition: border-color 0.2s, box-shadow 0.2s;
}
.str-input:focus {
  border-color: rgba(86, 156, 214, 0.5);
  box-shadow: 0 0 0 2px rgba(86, 156, 214, 0.1);
}
.str-input::placeholder {
  color: rgba(255, 255, 255, 0.25);
}
</style>
