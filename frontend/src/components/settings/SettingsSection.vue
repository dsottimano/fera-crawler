<script setup lang="ts">
import { computed } from "vue";
import type { SettingsSection, SettingDef } from "../../settings/schema";
import SettingsItem from "./SettingsItem.vue";

const props = defineProps<{
  section: SettingsSection;
  sectionKey: string;
  values: Record<string, unknown>;
  search: string;
}>();

defineEmits<{ update: [itemKey: string, value: unknown] }>();

function itemVisible(def: SettingDef, key: string): boolean {
  if (def.hidden) return false;
  if (!props.search) return true;
  const q = props.search.toLowerCase();
  return (
    key.toLowerCase().includes(q) ||
    def.label.toLowerCase().includes(q) ||
    (def.help?.toLowerCase().includes(q) ?? false)
  );
}

const visibleItems = computed(() =>
  Object.entries(props.section.items)
    .filter(([key, def]) => itemVisible(def, key))
    .map(([key, def]) => ({ key, def }))
);
</script>

<template>
  <section class="section">
    <h2 class="section-label">{{ section.label }}</h2>
    <div v-if="!visibleItems.length" class="empty">No settings match.</div>
    <ul class="item-list">
      <li v-for="{ key, def } in visibleItems" :key="key" class="item">
        <SettingsItem
          :item-key="key"
          :def="def"
          :value="values?.[key]"
          @update="(v) => $emit('update', key, v)"
        />
      </li>
    </ul>
  </section>
</template>

<style scoped>
.section {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.section-label {
  margin: 0;
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 1.2px;
  text-transform: uppercase;
  color: rgba(255, 255, 255, 0.45);
}

.item-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.item {
  padding: 0;
}

.empty {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.25);
  padding: 8px 0;
}
</style>
