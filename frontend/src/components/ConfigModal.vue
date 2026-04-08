<script setup lang="ts">
import { ref, watch, onMounted } from "vue";
import { useConfig } from "../composables/useConfig";
import { useCrawl } from "../composables/useCrawl";
import { useDatabase } from "../composables/useDatabase";

const emit = defineEmits<{ close: [] }>();
const ready = ref(false);
onMounted(() => { setTimeout(() => { ready.value = true; }, 100); });
const { config, saveDefaults } = useConfig();
const { currentSessionId } = useCrawl();
const { updateSessionConfig } = useDatabase();
const saved = ref(false);
const sessionSaved = ref(false);

function handleSaveDefaults() {
  saveDefaults();
  saved.value = true;
  setTimeout(() => { saved.value = false; }, 2000);
}

async function handleSaveForCrawl() {
  if (currentSessionId.value) {
    await updateSessionConfig(currentSessionId.value, config);
  }
  sessionSaved.value = true;
  setTimeout(() => { emit('close'); }, 600);
}
const headerKey = ref("");
const headerValue = ref("");

const UA_PRESETS = [
  { label: "Googlebot Desktop", value: "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)" },
  { label: "Googlebot Mobile", value: "Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.135 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)" },
  { label: "Bingbot", value: "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)" },
  { label: "Yandexbot", value: "Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)" },
  { label: "Chrome Desktop", value: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36" },
  { label: "Chrome Mobile", value: "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36" },
];

const uaPreset = ref(
  config.userAgent === "" ? "default" : UA_PRESETS.find(p => p.value === config.userAgent)?.label ?? "custom"
);

watch(uaPreset, (key) => {
  if (key === "default") config.userAgent = "";
  else if (key !== "custom") {
    const preset = UA_PRESETS.find(p => p.label === key);
    if (preset) config.userAgent = preset.value;
  }
});

function addHeader() { const k = headerKey.value.trim(), v = headerValue.value.trim(); if (!k) return; config.customHeaders[k] = v; headerKey.value = ""; headerValue.value = ""; }
function removeHeader(key: string) { delete config.customHeaders[key]; }

</script>

<template>
  <div class="overlay" @click.self="ready && emit('close')">
    <div class="modal">
      <div class="modal-header"><h3>Configuration</h3><button class="close-btn" @click="emit('close')">&times;</button></div>
      <div class="modal-body">
        <!-- Spider -->
        <div class="section-label">Spider</div>
        <label class="field"><span>Max Requests</span><input v-model.number="config.maxRequests" type="number" min="1" max="100000" /></label>
        <label class="field"><span>Concurrency</span><input v-model.number="config.concurrency" type="number" min="1" max="50" /></label>
        <label class="field"><span>Crawl Mode</span><select v-model="config.mode"><option value="spider">Spider</option><option value="list">List</option></select></label>
        <template v-if="config.mode === 'list'"><label class="field"><span>URLs (one per line)</span><textarea :value="config.urls.join('\n')" @input="config.urls = ($event.target as HTMLTextAreaElement).value.split('\n').filter(u => u.trim())" rows="6" placeholder="https://example.com/page1"></textarea></label></template>

        <!-- Robots.txt -->
        <div class="divider" />
        <div class="section-label">Robots.txt</div>
        <label class="field checkbox"><input v-model="config.respectRobots" type="checkbox" /><span>Respect robots.txt</span></label>

        <!-- Browser -->
        <div class="divider" />
        <div class="section-label">Browser</div>
        <label class="field checkbox"><input v-model="config.headless" type="checkbox" /><span>Headless Mode</span></label>
        <label class="field checkbox"><input v-model="config.downloadOgImage" type="checkbox" /><span>Download OG:Image</span></label>

        <!-- Speed -->
        <div class="divider" />
        <div class="section-label">Speed</div>
        <label class="field"><span>Delay (ms)</span><input v-model.number="config.delay" type="number" min="0" max="10000" step="100" /></label>

        <!-- User-Agent -->
        <div class="divider" />
        <div class="section-label">User-Agent</div>
        <label class="field">
          <span>Preset</span>
          <select v-model="uaPreset">
            <option value="default">Default (Playwright)</option>
            <option v-for="p in UA_PRESETS" :key="p.label" :value="p.label">{{ p.label }}</option>
            <option value="custom">Custom</option>
          </select>
        </label>
        <label class="field">
          <span>User-Agent String</span>
          <input v-model="config.userAgent" type="text" placeholder="Leave empty for default" :readonly="uaPreset !== 'custom' && uaPreset !== 'default'" />
        </label>

        <!-- Custom Headers -->
        <div class="divider" />
        <div class="section-label">Custom Headers</div>
        <div v-if="Object.keys(config.customHeaders).length" class="header-list">
          <div v-for="(val, key) in config.customHeaders" :key="key" class="header-row"><span class="hk">{{ key }}</span><span class="hv">{{ val }}</span><button class="rm" @click="removeHeader(key as string)">&times;</button></div>
        </div>
        <div class="header-add"><input v-model="headerKey" type="text" placeholder="Header" @keyup.enter="addHeader" /><input v-model="headerValue" type="text" placeholder="Value" @keyup.enter="addHeader" /><button class="add-btn" @click="addHeader">Add</button></div>

      </div>
      <div class="modal-footer">
        <button class="btn" @click="handleSaveDefaults">{{ saved ? 'SAVED!' : 'SAVE AS DEFAULT' }}</button>
        <div class="footer-spacer"></div>
        <button class="btn btn-save" @click="handleSaveForCrawl">{{ sessionSaved ? 'SAVED!' : 'SAVE SETTINGS FOR THIS CRAWL' }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.55); display: flex; align-items: center; justify-content: center; z-index: 200; backdrop-filter: blur(6px); }
.modal { background: #141a2e; border: 1px solid rgba(255,255,255,0.1); border-radius: 12px; min-width: 600px; max-width: 750px; color: #ffffff; box-shadow: 0 20px 60px rgba(0,0,0,0.5); }
.modal-header { display: flex; align-items: center; justify-content: space-between; padding: 14px 20px; border-bottom: 1px solid rgba(255,255,255,0.06); }
.modal-header h3 { margin: 0; font-size: 11px; font-weight: 700; letter-spacing: 1px; text-transform: uppercase; color: #ffffff; }
.close-btn { background: none; border: none; color: rgba(255,255,255,0.3); font-size: 18px; cursor: pointer; }
.close-btn:hover { color: #fff; }
.modal-body { padding: 20px; display: flex; flex-direction: column; gap: 14px; max-height: 70vh; overflow-y: auto; }
.section-label { font-size: 9px; font-weight: 700; letter-spacing: 1.2px; text-transform: uppercase; color: #569cd6; }
.divider { border-top: 1px solid rgba(255,255,255,0.06); margin: 4px 0; }
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
.field input[readonly] { opacity: 0.5; cursor: default; }
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
.modal-footer { display: flex; align-items: center; gap: 6px; padding: 12px 20px; border-top: 1px solid rgba(255,255,255,0.06); }
.footer-spacer { flex: 1; }
.btn { padding: 8px 22px; background: transparent; color: rgba(255,255,255,0.5); border: 1px solid rgba(255,255,255,0.12); border-radius: 20px; cursor: pointer; font-size: 10px; font-weight: 700; letter-spacing: 1px; transition: all 0.15s; }
.btn:hover { color: #fff; border-color: rgba(255,255,255,0.3); }
.btn-save { color: #4ec9b0; border-color: rgba(78,201,176,0.3); }
.btn-save:hover { border-color: rgba(78,201,176,0.5); }
.modal-body::-webkit-scrollbar { width: 6px; }
.modal-body::-webkit-scrollbar-track { background: transparent; }
.modal-body::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 3px; }
.modal-body::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.2); }
</style>
