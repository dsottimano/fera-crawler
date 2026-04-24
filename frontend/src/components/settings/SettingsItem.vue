<script setup lang="ts">
import type { SettingDef } from "../../settings/schema";
import type { ScraperRule } from "../../types/crawl";
import BooleanInput from "./inputs/BooleanInput.vue";
import NumberInput from "./inputs/NumberInput.vue";
import StringInput from "./inputs/StringInput.vue";
import EnumInput from "./inputs/EnumInput.vue";
import RulesInput from "./inputs/RulesInput.vue";
import SecretInput from "./inputs/SecretInput.vue";

defineProps<{
  itemKey: string;
  def: SettingDef;
  value: unknown;
}>();

defineEmits<{ update: [value: unknown] }>();
</script>

<template>
  <div class="item-row">
    <div class="item-text">
      <label :for="itemKey" class="item-label">{{ def.label || itemKey }}</label>
      <p v-if="def.help" class="item-help">{{ def.help }}</p>
    </div>
    <div class="item-control">
      <BooleanInput
        v-if="def.type === 'boolean'"
        :id="itemKey"
        :model-value="Boolean(value)"
        @update:model-value="(v) => $emit('update', v)"
      />
      <NumberInput
        v-else-if="def.type === 'number'"
        :id="itemKey"
        :model-value="Number(value)"
        :min="def.min"
        :max="def.max"
        :unit="def.unit"
        @update:model-value="(v) => $emit('update', v)"
      />
      <EnumInput
        v-else-if="def.type === 'enum'"
        :id="itemKey"
        :model-value="String(value)"
        :options="(def.options ?? []) as readonly string[]"
        @update:model-value="(v) => $emit('update', v)"
      />
      <SecretInput
        v-else-if="def.type === 'secret'"
        :id="itemKey"
        :model-value="String(value ?? '')"
        @update:model-value="(v) => $emit('update', v)"
      />
      <RulesInput
        v-else-if="def.type === 'rules'"
        :id="itemKey"
        :model-value="(value as ScraperRule[]) ?? []"
        @update:model-value="(v) => $emit('update', v)"
      />
      <StringInput
        v-else
        :id="itemKey"
        :model-value="String(value ?? '')"
        @update:model-value="(v) => $emit('update', v)"
      />
    </div>
  </div>
</template>

<style scoped>
.item-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 20px;
}

.item-text {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.item-label {
  font-size: 12px;
  font-weight: 600;
  color: #ffffff;
  cursor: pointer;
}

.item-help {
  margin: 0;
  font-size: 11px;
  color: rgba(255, 255, 255, 0.45);
  line-height: 1.4;
}

.item-control {
  flex-shrink: 0;
  display: flex;
  align-items: center;
}
</style>
