<script setup lang="ts">
defineProps<{ id?: string; modelValue: string }>();
defineEmits<{ "update:modelValue": [value: string] }>();
</script>

<template>
  <input
    :id="id"
    type="text"
    class="str-input"
    :value="modelValue"
    @input="$emit('update:modelValue', ($event.target as HTMLInputElement).value)"
  />
</template>

<style scoped>
.str-input {
  width: 220px;
  padding: 8px 12px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.04);
  color: #ffffff;
  font-size: 11px;
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
