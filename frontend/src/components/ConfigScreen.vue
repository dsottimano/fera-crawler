<script setup lang="ts">
// Top-level CONFIG screen — replaces the old right-sidebar config tab.
// Read-only summary of the active settings (pinned snapshot when a saved
// crawl is loaded, otherwise the active profile). The "Edit settings"
// button at the top is the single mutation entry point — keep this view
// pure-display so it's safe to leave open while running a crawl.
import { computed } from "vue";
import { useSettings } from "../composables/useSettings";
import { useConfig } from "../composables/useConfig";

const emit = defineEmits<{ "edit-settings": [] }>();

const { effectiveSettings: settings } = useSettings();
const { config } = useConfig();

// Stealth tier mapping mirrors probeMatrix.ts patchesFor() so the user
// sees the same vocabulary in this summary, in probe results, and in
// the win-row blurb.
const stealthTier = computed<string>(() => {
  const s = settings.value.stealth;
  if (!s.enabled) return "off";
  if (!s.canvasNoise && !s.userAgentData) return "tier-1";
  return "tier-2";
});

const customHeaderCount = computed(() => Object.keys(config.customHeaders).length);
</script>

<template>
  <div class="config-screen">
    <header class="config-header">
      <div>
        <h1 class="config-title">Active configuration</h1>
        <p class="config-subtitle">
          Read-only summary of the settings driving the running crawl.
          Pinned to the saved snapshot when a session is loaded; the
          active profile otherwise.
        </p>
      </div>
      <button class="btn-edit-settings" title="Open the full settings panel" @click="emit('edit-settings')">
        &#x2699; Edit settings
      </button>
    </header>

    <div class="config-grid">
      <section class="config-card">
        <div class="config-card-title">CRAWL</div>
        <div class="config-row"><span class="config-label">Mode</span><span class="config-value">{{ settings.crawling.mode }}</span></div>
        <div v-if="settings.crawling.mode === 'list'" class="config-row"><span class="config-label">List size</span><span class="config-value">{{ config.urls.length.toLocaleString() }} URLs</span></div>
        <div class="config-row"><span class="config-label">Concurrency</span><span class="config-value">{{ settings.crawling.concurrency }}</span></div>
        <div class="config-row"><span class="config-label">Max requests</span><span class="config-value">{{ settings.crawling.maxRequests || '∞' }}</span></div>
        <div class="config-row"><span class="config-label">Delay</span><span class="config-value">{{ settings.crawling.delay }}ms</span></div>
        <div class="config-row"><span class="config-label">Robots.txt</span><span class="config-value" :class="{ 'config-value--off': !settings.crawling.respectRobots }">{{ settings.crawling.respectRobots ? 'Respect' : 'Ignore' }}</span></div>
      </section>

      <section class="config-card">
        <div class="config-card-title">PERFORMANCE</div>
        <div class="config-row">
          <span class="config-label">Per-host delay</span>
          <span class="config-value">{{ settings.performance.perHostDelayMax > settings.performance.perHostDelay ? `${settings.performance.perHostDelay}–${settings.performance.perHostDelayMax}ms` : `${settings.performance.perHostDelay}ms` }}</span>
        </div>
        <div class="config-row"><span class="config-label">Per-host concurrency</span><span class="config-value">{{ settings.performance.perHostConcurrency }}</span></div>
        <div class="config-row"><span class="config-label">Session warmup</span><span class="config-value" :class="{ 'config-value--off': !settings.performance.sessionWarmup }">{{ settings.performance.sessionWarmup ? 'On' : 'Off' }}</span></div>
        <div class="config-row"><span class="config-label">Auto-probe on block</span><span class="config-value" :class="{ 'config-value--off': !settings.performance.autoProbeOnBlock }">{{ settings.performance.autoProbeOnBlock ? 'On' : 'Off' }}</span></div>
      </section>

      <section class="config-card">
        <div class="config-card-title">STEALTH</div>
        <div class="config-row">
          <span class="config-label">Tier</span>
          <span class="config-value" :class="{ 'config-value--off': stealthTier === 'off' }">{{ stealthTier }}</span>
        </div>
        <div v-if="settings.stealth.userAgent" class="config-row">
          <span class="config-label">UA override</span>
          <span class="config-value config-mono" :title="settings.stealth.userAgent">
            {{ settings.stealth.userAgent.length > 36 ? settings.stealth.userAgent.slice(0, 34) + '…' : settings.stealth.userAgent }}
          </span>
        </div>
      </section>

      <section class="config-card">
        <div class="config-card-title">BROWSER</div>
        <div class="config-row"><span class="config-label">Headless</span><span class="config-value">{{ settings.authentication.headless ? 'Yes' : 'No' }}</span></div>
      </section>

      <section class="config-card">
        <div class="config-card-title">EXTRACTION</div>
        <div class="config-row"><span class="config-label">Capture vitals</span><span class="config-value" :class="{ 'config-value--off': !settings.extraction.captureVitals }">{{ settings.extraction.captureVitals ? 'On' : 'Off' }}</span></div>
        <div class="config-row"><span class="config-label">OG:image download</span><span class="config-value" :class="{ 'config-value--off': !settings.extraction.downloadOgImage }">{{ settings.extraction.downloadOgImage ? 'On' : 'Off' }}</span></div>
        <div class="config-row"><span class="config-label">Scraper rules</span><span class="config-value">{{ config.scraperRules.length }}</span></div>
        <div v-if="customHeaderCount > 0" class="config-row"><span class="config-label">Custom headers</span><span class="config-value">{{ customHeaderCount }}</span></div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.config-screen {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  background: #0c111d;
}

.config-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 4px 0;
}

.config-title {
  margin: 0;
  font-size: 14px;
  font-weight: 700;
  color: #ffffff;
  letter-spacing: 0.3px;
}

.config-subtitle {
  margin: 4px 0 0;
  font-size: 11px;
  color: rgba(255, 255, 255, 0.45);
  max-width: 600px;
  line-height: 1.5;
}

.btn-edit-settings {
  flex-shrink: 0;
  padding: 8px 16px;
  background: rgba(86, 156, 214, 0.08);
  border: 1px solid rgba(86, 156, 214, 0.3);
  border-radius: 20px;
  color: #569cd6;
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 1.2px;
  text-transform: uppercase;
  cursor: pointer;
  transition: all 0.15s;
  font-family: inherit;
}
.btn-edit-settings:hover {
  background: rgba(86, 156, 214, 0.15);
  border-color: #569cd6;
  box-shadow: 0 0 12px rgba(86, 156, 214, 0.2);
}

.config-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 12px;
}

.config-card {
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 12px;
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.config-card-title {
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 1.2px;
  color: rgba(255, 255, 255, 0.45);
  text-transform: uppercase;
  margin-bottom: 4px;
}

.config-row {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  padding: 4px 0;
  font-size: 11px;
  align-items: baseline;
}

.config-label {
  color: rgba(255, 255, 255, 0.45);
  flex-shrink: 0;
}

.config-value {
  color: #ffffff;
  font-weight: 600;
  text-align: right;
  font-variant-numeric: tabular-nums;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-transform: capitalize;
}

.config-value--off {
  color: rgba(255, 255, 255, 0.3);
  font-weight: 400;
  text-transform: none;
}

.config-mono {
  font-family: 'SF Mono', 'Cascadia Code', 'Consolas', monospace;
  font-size: 10px;
  text-transform: none;
}
</style>
