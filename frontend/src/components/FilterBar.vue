<script setup lang="ts">
import { ref, computed, watch, onMounted } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { TAB_FILTERS, type FilterOption } from "../utils/gridFilter";

const props = defineProps<{
  totalResults: number;
  filteredCount: number;
  activeTab?: string;
  sessionId?: number | null;
}>();
const emit = defineEmits<{ search: [query: string]; export: []; filterType: [type: string]; selectAll: [] }>();

const searchQuery = ref("");
// Holds the FilterOption.value (a tagged token like "missing:title"), not
// the human-readable label. The dropdown maps label↔value; everything else
// (gridFilter parsing, emit) sees only the token.
const filterValue = ref("all");
const distinctStatuses = ref<number[]>([]);

const FALLBACK_OPTIONS: FilterOption[] = [{ label: "All", value: "all" }];

// Distinct status codes for the Response Codes tab come from a Rust
// aggregate. Refreshes on session change AND on tab change.
async function refreshDistinctStatuses() {
  if (props.sessionId == null) {
    distinctStatuses.value = [];
    return;
  }
  try {
    distinctStatuses.value = await invoke<number[]>("distinct_status_codes", { sessionId: props.sessionId });
  } catch (e) {
    console.error("distinct_status_codes failed:", e);
    distinctStatuses.value = [];
  }
}

// Compose the dropdown options for the active tab. Response Codes is
// special-cased: each distinct status code becomes its own option. Every
// other tab uses the static TAB_FILTERS table.
const filterOptions = computed<FilterOption[]>(() => {
  if (props.activeTab === "Response Codes") {
    return [
      { label: "All", value: "all" },
      ...distinctStatuses.value.map((s) => ({ label: String(s), value: String(s) })),
    ];
  }
  return TAB_FILTERS[props.activeTab ?? ""] ?? FALLBACK_OPTIONS;
});

watch(() => props.activeTab, (tab) => {
  // Reset selection on tab change. The "All" sentinel maps to value "all"
  // which gridFilter treats as no-op.
  filterValue.value = "all";
  emit("filterType", "All");
  if (tab === "Response Codes") void refreshDistinctStatuses();
});
watch(() => props.sessionId, () => {
  if (props.activeTab === "Response Codes") void refreshDistinctStatuses();
});
onMounted(() => {
  if (props.activeTab === "Response Codes") void refreshDistinctStatuses();
});

function onSearch() { emit("search", searchQuery.value); }
function onFilterChange() {
  // The "All" sentinel keeps the legacy "All" string for downstream callers
  // that haven't migrated to tagged tokens. Anything else emits the tagged
  // value (gridFilter parses it).
  emit("filterType", filterValue.value === "all" ? "All" : filterValue.value);
}
</script>

<template>
  <div class="filter-bar">
    <div class="filter-left">
      <select v-model="filterValue" class="filter-select" @change="onFilterChange">
        <option v-for="opt in filterOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
      </select>
      <button class="toolbar-btn" @click="emit('export')">EXPORT</button>
      <button class="toolbar-btn" @click="emit('selectAll')">SELECT ALL VISIBLE</button>
    </div>
    <div class="filter-right">
      <div class="search-wrap">
        <svg class="search-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.25)" stroke-width="2">
          <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
        </svg>
        <input v-model="searchQuery" type="text" class="search-input" placeholder="Search..." @input="onSearch" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.filter-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 12px;
  background: rgba(255,255,255,0.02);
  border-bottom: 1px solid rgba(255,255,255,0.06);
  flex-shrink: 0;
}
.filter-left { display: flex; align-items: center; gap: 8px; }
.filter-select {
  padding: 4px 28px 4px 12px;
  border: 1px solid rgba(255,255,255,0.12);
  border-radius: 14px;
  background: rgba(255,255,255,0.04) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='rgba(255,255,255,0.4)'/%3E%3C/svg%3E") no-repeat right 8px center;
  font-family: 'Ubuntu', sans-serif;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.5px;
  color: #ffffff;
  cursor: pointer;
  outline: none;
  appearance: none;
  -webkit-appearance: none;
  transition: border-color 0.15s;
}
.filter-select:focus {
  border-color: rgba(86,156,214,0.5);
  box-shadow: 0 0 0 2px rgba(86,156,214,0.1);
}
.filter-select option {
  background: #141a2e;
  color: #ffffff;
  font-size: 11px;
}
.toolbar-btn {
  padding: 4px 12px;
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 14px;
  background: transparent;
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 1px;
  cursor: pointer;
  color: rgba(255,255,255,0.4);
  transition: all 0.15s;
}
.toolbar-btn:hover { color: #ffffff; border-color: rgba(255,255,255,0.25); }
.filter-right { display: flex; align-items: center; }
.search-wrap {
  display: flex;
  align-items: center;
  gap: 6px;
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 14px;
  padding: 3px 10px;
  background: rgba(255,255,255,0.03);
  transition: border-color 0.15s;
}
.search-wrap:focus-within { border-color: rgba(86,156,214,0.4); }
.search-icon { flex-shrink: 0; }
.search-input {
  padding: 2px 0;
  border: none;
  font-size: 11px;
  width: 150px;
  background: transparent;
  color: #ffffff;
  outline: none;
}
.search-input::placeholder { color: rgba(255,255,255,0.18); }
</style>
