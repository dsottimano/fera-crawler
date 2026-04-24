<script setup lang="ts">
import type { ScraperRule } from "../../../types/crawl";

const props = defineProps<{
  id?: string;
  modelValue: ScraperRule[];
}>();

const emit = defineEmits<{ "update:modelValue": [value: ScraperRule[]] }>();

function updateAt(i: number, field: "name" | "selector", value: string) {
  const next = props.modelValue.map((r, idx) => (idx === i ? { ...r, [field]: value } : r));
  emit("update:modelValue", next);
}

function removeAt(i: number) {
  emit("update:modelValue", props.modelValue.filter((_, idx) => idx !== i));
}

function addRule() {
  emit("update:modelValue", [...props.modelValue, { name: "", selector: "" }]);
}
</script>

<template>
  <div class="rules">
    <div v-if="!modelValue.length" class="empty">No custom extractors defined.</div>
    <ul v-else class="rule-list">
      <li v-for="(rule, i) in modelValue" :key="i" class="rule-row">
        <input
          class="rule-input"
          placeholder="Field name"
          :value="rule.name"
          @input="updateAt(i, 'name', ($event.target as HTMLInputElement).value)"
        />
        <input
          class="rule-input rule-input--selector"
          placeholder="CSS selector"
          :value="rule.selector"
          @input="updateAt(i, 'selector', ($event.target as HTMLInputElement).value)"
        />
        <button class="btn-remove" type="button" @click="removeAt(i)" aria-label="Remove rule">
          &#x2715;
        </button>
      </li>
    </ul>
    <button class="btn-add" type="button" @click="addRule">+ ADD RULE</button>
  </div>
</template>

<style scoped>
.rules {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 320px;
}

.empty {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.25);
  padding: 4px 0;
}

.rule-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.rule-row {
  display: flex;
  gap: 6px;
  align-items: center;
}

.rule-input {
  padding: 6px 10px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.04);
  color: #ffffff;
  font-size: 11px;
  font-family: 'SF Mono', 'Cascadia Code', 'Consolas', monospace;
  outline: none;
  transition: border-color 0.2s, box-shadow 0.2s;
}
.rule-input:focus {
  border-color: rgba(86, 156, 214, 0.5);
  box-shadow: 0 0 0 2px rgba(86, 156, 214, 0.1);
}

.rule-input:first-child {
  width: 120px;
}

.rule-input--selector {
  flex: 1;
}

.btn-remove {
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: transparent;
  color: rgba(255, 255, 255, 0.45);
  width: 24px;
  height: 24px;
  border-radius: 50%;
  cursor: pointer;
  font-size: 10px;
  flex-shrink: 0;
  transition: all 0.15s;
}
.btn-remove:hover {
  color: #f44747;
  border-color: rgba(244, 71, 71, 0.3);
}

.btn-add {
  align-self: flex-start;
  padding: 6px 16px;
  border: 1px solid rgba(86, 156, 214, 0.3);
  border-radius: 20px;
  background: transparent;
  color: #569cd6;
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 1.2px;
  cursor: pointer;
  transition: all 0.2s;
}
.btn-add:hover {
  background: rgba(86, 156, 214, 0.1);
  border-color: #569cd6;
}
</style>
