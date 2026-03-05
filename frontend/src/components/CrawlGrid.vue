<script setup lang="ts">
import { ref, onMounted, watch } from "vue";
import { TabulatorFull as Tabulator } from "tabulator-tables";
import type { CrawlResult } from "../types/crawl";
import "tabulator-tables/dist/css/tabulator_midnight.min.css";

const props = defineProps<{ results: CrawlResult[] }>();

const tableRef = ref<HTMLDivElement>();
let table: Tabulator | null = null;

onMounted(() => {
  if (!tableRef.value) return;

  table = new Tabulator(tableRef.value, {
    data: props.results,
    reactiveData: false,
    height: "100%",
    layout: "fitColumns",
    virtualDom: true,
    columns: [
      { title: "URL", field: "url", widthGrow: 3, tooltip: true },
      { title: "Status", field: "status", width: 80, hozAlign: "center",
        formatter(cell: any) {
          const val = cell.getValue() as number;
          const color = val >= 200 && val < 300 ? "#4caf50" : val >= 300 && val < 400 ? "#ff9800" : "#f44336";
          return `<span style="color:${color};font-weight:600">${val}</span>`;
        }
      },
      { title: "Title", field: "title", widthGrow: 2, tooltip: true },
      { title: "H1", field: "h1", widthGrow: 1.5, tooltip: true },
      { title: "Meta Description", field: "metaDescription", widthGrow: 2, tooltip: true },
      { title: "Canonical", field: "canonical", widthGrow: 1.5, tooltip: true },
      { title: "Int. Links", field: "internalLinks", width: 90, hozAlign: "center" },
      { title: "Ext. Links", field: "externalLinks", width: 90, hozAlign: "center" },
      { title: "Time (ms)", field: "responseTime", width: 100, hozAlign: "right" },
      { title: "Type", field: "contentType", width: 120 },
    ],
  });
});

watch(() => props.results.length, () => {
  if (!table) return;
  table.setData(props.results);
});
</script>

<template>
  <div ref="tableRef" class="crawl-table"></div>
</template>

<style scoped>
.crawl-table {
  height: 100%;
}
</style>
