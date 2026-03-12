<script setup lang="ts">
const props = defineProps<{ active: string }>();
const emit = defineEmits<{ select: [tab: string] }>();

const tabs = [
  "Internal", "External", "Security", "Response Codes", "URL",
  "Page Titles", "Meta Description", "H1", "H2", "Content",
  "Images", "Canonicals", "Directives", "JavaScript", "Links",
  "Structured Data", "Overview", "Issues", "Site Structure", "Response Times",
];
</script>

<template>
  <div class="category-tabs">
    <button
      v-for="tab in tabs"
      :key="tab"
      class="cat-tab"
      :class="{ 'cat-tab--active': active === tab }"
      @click="emit('select', tab)"
    >
      {{ tab }}
    </button>
  </div>
</template>

<style scoped>
.category-tabs {
  display: flex;
  background: #0c111d;
  border-bottom: 1px solid rgba(255,255,255,0.06);
  overflow-x: auto;
  flex-shrink: 0;
  gap: 0;
  padding: 0 8px;
}
.cat-tab {
  padding: 6px 11px;
  border: none;
  background: transparent;
  color: rgba(255,255,255,0.3);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.5px;
  cursor: pointer;
  white-space: nowrap;
  border-bottom: 2px solid transparent;
  transition: all 0.15s;
  text-transform: uppercase;
}
.cat-tab:hover {
  color: rgba(255,255,255,0.6);
}
.cat-tab--active {
  color: #569cd6;
  border-bottom-color: #569cd6;
  text-shadow: 0 0 12px rgba(86,156,214,0.3);
}
</style>
