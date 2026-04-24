<script setup lang="ts">
import { computed } from "vue";

const props = defineProps<{
  id?: string;
  modelValue: string;
  options: readonly string[];
}>();

defineEmits<{ "update:modelValue": [value: string] }>();

const useSegmented = computed(() => props.options.length > 0 && props.options.length <= 4);
</script>

<template>
  <div v-if="useSegmented" class="segmented" role="radiogroup" :aria-labelledby="id">
    <button
      v-for="opt in options"
      :key="opt"
      type="button"
      class="seg-btn"
      :class="{ 'seg-btn--active': opt === modelValue }"
      role="radio"
      :aria-checked="opt === modelValue"
      @click="$emit('update:modelValue', opt)"
    >
      {{ opt }}
    </button>
  </div>
  <select
    v-else
    :id="id"
    class="enum-select"
    :value="modelValue"
    @change="$emit('update:modelValue', ($event.target as HTMLSelectElement).value)"
  >
    <option v-for="opt in options" :key="opt" :value="opt">{{ opt }}</option>
  </select>
</template>

<style scoped>
.segmented {
  display: inline-flex;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 14px;
  padding: 2px;
  background: rgba(255, 255, 255, 0.04);
}

.seg-btn {
  padding: 5px 14px;
  border: none;
  background: transparent;
  color: rgba(255, 255, 255, 0.45);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.5px;
  text-transform: uppercase;
  cursor: pointer;
  border-radius: 12px;
  transition: all 0.15s;
}

.seg-btn:hover:not(.seg-btn--active) {
  color: rgba(255, 255, 255, 0.7);
}

.seg-btn--active {
  background: rgba(86, 156, 214, 0.2);
  color: #569cd6;
}

.enum-select {
  padding: 8px 28px 8px 12px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.04)
    url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='rgba(255,255,255,0.4)'/%3E%3C/svg%3E")
    no-repeat right 10px center;
  color: #ffffff;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.5px;
  appearance: none;
  -webkit-appearance: none;
  cursor: pointer;
  outline: none;
  transition: border-color 0.15s;
}
.enum-select:focus {
  border-color: rgba(86, 156, 214, 0.5);
  box-shadow: 0 0 0 2px rgba(86, 156, 214, 0.1);
}
.enum-select option {
  background: #141a2e;
  color: #ffffff;
  font-size: 11px;
}
</style>
