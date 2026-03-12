<script setup lang="ts">
import { ref, computed } from "vue";
import { useConfig } from "../composables/useConfig";

const props = defineProps<{ section: string }>();
const emit = defineEmits<{ close: [] }>();
const { config } = useConfig();
const headerKey = ref("");
const headerValue = ref("");

const title = computed(() => {
  const t: Record<string, string> = { spider: "Spider Settings", robots: "Robots.txt", speed: "Speed Settings", useragent: "User-Agent", headers: "Custom Headers" };
  return t[props.section] ?? "Configuration";
});

function addHeader() { const k = headerKey.value.trim(), v = headerValue.value.trim(); if (!k) return; config.customHeaders[k] = v; headerKey.value = ""; headerValue.value = ""; }
function removeHeader(key: string) { delete config.customHeaders[key]; }
</script>

<template>
  <div class="overlay" @click.self="emit('close')">
    <div class="modal">
      <div class="modal-header"><h3>{{ title }}</h3><button class="close-btn" @click="emit('close')">&times;</button></div>
      <div class="modal-body">
        <template v-if="section === 'spider'">
          <label class="field"><span>Max Requests</span><input v-model.number="config.maxRequests" type="number" min="1" max="100000" /></label>
          <label class="field"><span>Concurrency</span><input v-model.number="config.concurrency" type="number" min="1" max="50" /></label>
          <label class="field"><span>Crawl Mode</span><select v-model="config.mode"><option value="spider">Spider</option><option value="list">List</option></select></label>
          <template v-if="config.mode === 'list'"><label class="field"><span>URLs (one per line)</span><textarea :value="config.urls.join('\n')" @input="config.urls = ($event.target as HTMLTextAreaElement).value.split('\n').filter(u => u.trim())" rows="6" placeholder="https://example.com/page1"></textarea></label></template>
        </template>
        <template v-if="section === 'robots'"><label class="field checkbox"><input v-model="config.respectRobots" type="checkbox" /><span>Respect robots.txt</span></label></template>
        <template v-if="section === 'speed'">
          <label class="field"><span>Max Concurrent</span><input v-model.number="config.concurrency" type="number" min="1" max="50" /></label>
          <label class="field"><span>Delay (ms)</span><input v-model.number="config.delay" type="number" min="0" max="10000" step="100" /></label>
        </template>
        <template v-if="section === 'useragent'"><label class="field"><span>User-Agent String</span><input v-model="config.userAgent" type="text" placeholder="Leave empty for default" /></label></template>
        <template v-if="section === 'headers'">
          <div v-if="Object.keys(config.customHeaders).length" class="header-list">
            <div v-for="(val, key) in config.customHeaders" :key="key" class="header-row"><span class="hk">{{ key }}</span><span class="hv">{{ val }}</span><button class="rm" @click="removeHeader(key as string)">&times;</button></div>
          </div>
          <div class="header-add"><input v-model="headerKey" type="text" placeholder="Header" @keyup.enter="addHeader" /><input v-model="headerValue" type="text" placeholder="Value" @keyup.enter="addHeader" /><button class="add-btn" @click="addHeader">Add</button></div>
        </template>
      </div>
      <div class="modal-footer"><button class="btn" @click="emit('close')">DONE</button></div>
    </div>
  </div>
</template>

<style scoped>
.overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.55); display: flex; align-items: center; justify-content: center; z-index: 200; backdrop-filter: blur(6px); }
.modal { background: #141a2e; border: 1px solid rgba(255,255,255,0.1); border-radius: 12px; min-width: 400px; max-width: 500px; color: #ffffff; box-shadow: 0 20px 60px rgba(0,0,0,0.5); }
.modal-header { display: flex; align-items: center; justify-content: space-between; padding: 14px 20px; border-bottom: 1px solid rgba(255,255,255,0.06); }
.modal-header h3 { margin: 0; font-size: 11px; font-weight: 700; letter-spacing: 1px; text-transform: uppercase; color: #ffffff; }
.close-btn { background: none; border: none; color: rgba(255,255,255,0.3); font-size: 18px; cursor: pointer; }
.close-btn:hover { color: #fff; }
.modal-body { padding: 20px; display: flex; flex-direction: column; gap: 14px; }
.field { display: flex; flex-direction: column; gap: 5px; font-size: 11px; }
.field span { color: rgba(255,255,255,0.35); font-size: 9px; font-weight: 600; letter-spacing: 1px; text-transform: uppercase; }
.field input[type="text"], .field input[type="number"], .field textarea {
  padding: 8px 12px; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.1);
  border-radius: 8px; color: #ffffff; font-size: 11px; font-family: inherit; outline: none; transition: border-color 0.15s;
}
.field select {
  padding: 8px 28px 8px 12px; background: rgba(255,255,255,0.04) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='rgba(255,255,255,0.4)'/%3E%3C/svg%3E") no-repeat right 10px center;
  border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; color: #ffffff; font-size: 11px;
  font-family: inherit; font-weight: 600; letter-spacing: 0.5px; outline: none;
  appearance: none; -webkit-appearance: none; cursor: pointer; transition: border-color 0.15s;
}
.field select option { background: #141a2e; color: #ffffff; font-size: 11px; }
.field input:focus, .field select:focus, .field textarea:focus { border-color: rgba(86,156,214,0.5); box-shadow: 0 0 0 2px rgba(86,156,214,0.1); }
.field textarea { resize: vertical; }
.field.checkbox { flex-direction: row; align-items: center; gap: 8px; }
.field.checkbox input { width: 14px; height: 14px; accent-color: #569cd6; }
.header-list { display: flex; flex-direction: column; gap: 4px; }
.header-row { display: flex; align-items: center; gap: 8px; padding: 7px 10px; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.06); border-radius: 8px; font-size: 11px; }
.hk { font-weight: 600; min-width: 100px; color: #569cd6; }
.hv { flex: 1; color: rgba(255,255,255,0.5); }
.rm { background: none; border: none; color: #f44747; font-size: 14px; cursor: pointer; }
.header-add { display: flex; gap: 6px; }
.header-add input { flex: 1; padding: 8px 12px; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; color: #fff; font-size: 11px; outline: none; }
.header-add input:focus { border-color: rgba(86,156,214,0.5); }
.add-btn { padding: 8px 14px; background: rgba(86,156,214,0.1); color: #569cd6; border: 1px solid rgba(86,156,214,0.3); border-radius: 8px; cursor: pointer; font-size: 10px; font-weight: 700; letter-spacing: 0.5px; }
.modal-footer { padding: 12px 20px; border-top: 1px solid rgba(255,255,255,0.06); text-align: right; }
.btn { padding: 8px 22px; background: transparent; color: rgba(255,255,255,0.5); border: 1px solid rgba(255,255,255,0.12); border-radius: 20px; cursor: pointer; font-size: 10px; font-weight: 700; letter-spacing: 1px; transition: all 0.15s; }
.btn:hover { color: #fff; border-color: rgba(255,255,255,0.3); }
</style>
