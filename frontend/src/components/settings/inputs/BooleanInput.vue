<script setup lang="ts">
defineProps<{ id?: string; modelValue: boolean }>();
defineEmits<{ "update:modelValue": [value: boolean] }>();
</script>

<template>
  <label class="toggle">
    <input
      :id="id"
      type="checkbox"
      :checked="modelValue"
      @change="$emit('update:modelValue', ($event.target as HTMLInputElement).checked)"
    />
    <span class="track" :class="{ 'track--on': modelValue }">
      <span class="thumb" :class="{ 'thumb--on': modelValue }"></span>
    </span>
  </label>
</template>

<style scoped>
.toggle {
  display: inline-flex;
  align-items: center;
  cursor: pointer;
}

.toggle input {
  position: absolute;
  opacity: 0;
  pointer-events: none;
}

.track {
  width: 32px;
  height: 18px;
  border-radius: 20px;
  background: rgba(255, 255, 255, 0.12);
  border: 1px solid rgba(255, 255, 255, 0.12);
  position: relative;
  transition: background 0.15s, border-color 0.15s;
}

.track--on {
  background: rgba(86, 156, 214, 0.4);
  border-color: rgba(86, 156, 214, 0.5);
}

.thumb {
  position: absolute;
  top: 1px;
  left: 1px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.7);
  transition: transform 0.15s, background 0.15s;
}

.thumb--on {
  transform: translateX(14px);
  background: #569cd6;
}

.toggle input:focus-visible + .track {
  box-shadow: 0 0 0 2px rgba(86, 156, 214, 0.3);
}
</style>
