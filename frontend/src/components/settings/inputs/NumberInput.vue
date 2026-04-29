<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { clamp, commitNumericDraft, formatNumber, parseNumericDraft } from "../../../utils/numericInput";

const props = defineProps<{
  id?: string;
  modelValue: number;
  min?: number;
  max?: number;
  unit?: string;
}>();

const emit = defineEmits<{ "update:modelValue": [value: number] }>();

const focused = ref(false);
const draft = ref<string>(String(props.modelValue ?? 0));

const displayValue = computed(() =>
  focused.value ? draft.value : formatNumber(Number(props.modelValue))
);

watch(
  () => props.modelValue,
  (v) => {
    if (!focused.value) draft.value = String(v ?? 0);
  }
);

function onFocus(e: FocusEvent) {
  focused.value = true;
  draft.value = String(props.modelValue ?? 0);
  (e.target as HTMLInputElement).select();
}

function onInput(e: Event) {
  const raw = (e.target as HTMLInputElement).value;
  const cleaned = raw.replace(/[^\d,-]/g, "");
  draft.value = cleaned;
  const parsed = parseNumericDraft(cleaned);
  if (parsed === null) return;
  emit("update:modelValue", clamp(parsed, { min: props.min, max: props.max }));
}

function onBlur() {
  focused.value = false;
  const committed = commitNumericDraft(draft.value, props.modelValue, {
    min: props.min,
    max: props.max,
  });
  if (committed !== props.modelValue) emit("update:modelValue", committed);
  draft.value = String(committed);
}
</script>

<template>
  <div class="num-wrap">
    <input
      :id="id"
      type="text"
      inputmode="numeric"
      class="num-input"
      :value="displayValue"
      @focus="onFocus"
      @input="onInput"
      @blur="onBlur"
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
  appearance: none;
  -webkit-appearance: none;
  -moz-appearance: textfield;
  transition: border-color 0.2s, box-shadow 0.2s;
}

.num-input::-webkit-inner-spin-button,
.num-input::-webkit-outer-spin-button {
  -webkit-appearance: none;
  appearance: none;
  margin: 0;
  display: none;
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
