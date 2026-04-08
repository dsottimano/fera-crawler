<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useConfig } from "../composables/useConfig";
import { useInspector } from "../composables/useInspector";
import { useCrawl } from "../composables/useCrawl";
import { useDatabase } from "../composables/useDatabase";
import type { ScraperRule } from "../types/crawl";

const emit = defineEmits<{ close: [] }>();
const ready = ref(false);
onMounted(() => { setTimeout(() => { ready.value = true; }, 100); });
const { config } = useConfig();
const { currentSessionId } = useCrawl();
const { updateSessionConfig } = useDatabase();
const sessionSaved = ref(false);

async function handleSaveForCrawl() {
  if (currentSessionId.value) {
    await updateSessionConfig(currentSessionId.value, config);
  }
  sessionSaved.value = true;
  setTimeout(() => { emit('close'); }, 600);
}
const { inspecting, openInspector, closeInspector } = useInspector();
function handleSelectorPicked(picked: { selector: string; tag: string; text: string }) {
  const baseName = picked.tag;
  let name = baseName;
  let i = 1;
  while (config.scraperRules.some((r: ScraperRule) => r.name === name)) {
    name = baseName + "_" + (++i);
  }
  config.scraperRules.push({ name, selector: picked.selector });
}

function removeScraperRule(index: number) {
  config.scraperRules.splice(index, 1);
}

function startInspector() {
  const url = config.scraperUrl.trim();
  if (!url) return;
  openInspector(url, handleSelectorPicked);
}
</script>

<template>
  <div class="overlay" @click.self="ready && emit('close')">
    <div class="modal">
      <div class="modal-header"><h3>Scraper</h3><button class="close-btn" @click="emit('close')">&times;</button></div>
      <div class="modal-body">
        <div class="scraper-launch">
          <input v-model="config.scraperUrl" type="text" placeholder="https://example.com" class="scraper-url" />
          <button v-if="!inspecting" class="inspector-btn" @click="startInspector">Open Inspector</button>
          <button v-else class="inspector-btn inspector-btn--active" @click="closeInspector">Close Inspector</button>
        </div>
        <div v-if="inspecting" class="inspector-status">Inspecting — click elements on the page to add selectors</div>
        <div v-if="config.scraperRules.length" class="scraper-rules">
          <div v-for="(rule, i) in config.scraperRules" :key="i" class="scraper-rule">
            <input v-model="rule.name" type="text" class="rule-name" placeholder="name" />
            <input v-model="rule.selector" type="text" class="rule-selector" placeholder="CSS selector" />
            <button class="rm" @click="removeScraperRule(i)">&times;</button>
          </div>
        </div>
        <div v-if="!config.scraperRules.length && !inspecting" class="empty-state">Open the inspector on a page, then click elements to create extraction rules.</div>
      </div>
      <div class="modal-footer"><button class="btn btn-save" @click="handleSaveForCrawl">{{ sessionSaved ? 'SAVED!' : 'SAVE SETTINGS FOR THIS CRAWL' }}</button></div>
    </div>
  </div>
</template>

<style scoped>
.overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.55); display: flex; align-items: center; justify-content: center; z-index: 200; backdrop-filter: blur(6px); }
.modal { background: #141a2e; border: 1px solid rgba(255,255,255,0.1); border-radius: 12px; min-width: 400px; max-width: 520px; color: #ffffff; box-shadow: 0 20px 60px rgba(0,0,0,0.5); }
.modal-header { display: flex; align-items: center; justify-content: space-between; padding: 14px 20px; border-bottom: 1px solid rgba(255,255,255,0.06); }
.modal-header h3 { margin: 0; font-size: 11px; font-weight: 700; letter-spacing: 1px; text-transform: uppercase; color: #ffffff; }
.close-btn { background: none; border: none; color: rgba(255,255,255,0.3); font-size: 18px; cursor: pointer; }
.close-btn:hover { color: #fff; }
.modal-body { padding: 20px; display: flex; flex-direction: column; gap: 14px; }
.scraper-launch { display: flex; gap: 6px; }
.scraper-url { flex: 1; padding: 8px 12px; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; color: #fff; font-size: 11px; outline: none; }
.scraper-url:focus { border-color: rgba(86,156,214,0.5); }
.inspector-btn { padding: 8px 14px; background: rgba(78,201,176,0.1); color: #4ec9b0; border: 1px solid rgba(78,201,176,0.3); border-radius: 8px; cursor: pointer; font-size: 10px; font-weight: 700; letter-spacing: 0.5px; white-space: nowrap; transition: all 0.15s; }
.inspector-btn:hover { background: rgba(78,201,176,0.2); border-color: rgba(78,201,176,0.5); }
.inspector-btn--active { background: rgba(244,71,71,0.1); color: #f44747; border-color: rgba(244,71,71,0.3); }
.inspector-btn--active:hover { background: rgba(244,71,71,0.2); border-color: rgba(244,71,71,0.5); }
.inspector-status { font-size: 10px; color: #4ec9b0; font-weight: 600; letter-spacing: 0.5px; }
.scraper-rules { display: flex; flex-direction: column; gap: 4px; }
.scraper-rule { display: flex; align-items: center; gap: 6px; }
.rule-name { width: 100px; padding: 7px 10px; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; color: #569cd6; font-size: 11px; font-weight: 600; outline: none; }
.rule-name:focus { border-color: rgba(86,156,214,0.5); }
.rule-selector { flex: 1; padding: 7px 10px; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.06); border-radius: 8px; color: rgba(255,255,255,0.5); font-size: 11px; font-family: 'SF Mono','Cascadia Code','Consolas',monospace; outline: none; }
.rule-selector:focus { border-color: rgba(86,156,214,0.5); color: #fff; }
.rm { background: none; border: none; color: #f44747; font-size: 14px; cursor: pointer; }
.empty-state { font-size: 11px; color: rgba(255,255,255,0.25); text-align: center; padding: 20px 0; }
.modal-footer { padding: 12px 20px; border-top: 1px solid rgba(255,255,255,0.06); text-align: right; }
.btn { padding: 8px 22px; background: transparent; color: rgba(255,255,255,0.5); border: 1px solid rgba(255,255,255,0.12); border-radius: 20px; cursor: pointer; font-size: 10px; font-weight: 700; letter-spacing: 1px; transition: all 0.15s; }
.btn:hover { color: #fff; border-color: rgba(255,255,255,0.3); }
.btn-save { color: #4ec9b0; border-color: rgba(78,201,176,0.3); }
.btn-save:hover { border-color: rgba(78,201,176,0.5); }
</style>
