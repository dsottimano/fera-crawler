<script setup lang="ts">
import { ref } from "vue";

defineProps<{ id?: string; modelValue: string }>();
defineEmits<{ "update:modelValue": [value: string] }>();

const reveal = ref(false);
</script>

<template>
  <div class="secret-wrap">
    <input
      :id="id"
      :type="reveal ? 'text' : 'password'"
      class="secret-input"
      :value="modelValue"
      @input="$emit('update:modelValue', ($event.target as HTMLInputElement).value)"
    />
    <button
      type="button"
      class="btn-reveal"
      :aria-label="reveal ? 'Hide' : 'Show'"
      @click="reveal = !reveal"
    >
      {{ reveal ? 'HIDE' : 'SHOW' }}
    </button>
  </div>
</template>

<style scoped>
.secret-wrap {
  display: inline-flex;
  gap: 6px;
  align-items: center;
}

.secret-input {
  width: 220px;
  padding: 8px 12px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.04);
  color: #ffffff;
  font-size: 11px;
  font-family: 'SF Mono', 'Cascadia Code', 'Consolas', monospace;
  outline: none;
  transition: border-color 0.2s, box-shadow 0.2s;
}
.secret-input:focus {
  border-color: rgba(86, 156, 214, 0.5);
  box-shadow: 0 0 0 2px rgba(86, 156, 214, 0.1);
}

.btn-reveal {
  padding: 6px 12px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 14px;
  background: transparent;
  color: rgba(255, 255, 255, 0.6);
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 1.2px;
  cursor: pointer;
  transition: all 0.15s;
}
.btn-reveal:hover {
  color: #ffffff;
  border-color: rgba(255, 255, 255, 0.25);
}
</style>
