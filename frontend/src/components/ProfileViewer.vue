<script setup lang="ts">
import { computed, ref, watch, onMounted } from "vue";
import type { ProfileData } from "../composables/useBrowser";

const props = defineProps<{ data: ProfileData }>();
const emit = defineEmits<{ close: [] }>();
const ready = ref(false);
onMounted(() => { setTimeout(() => { ready.value = true; }, 100); });

const cookieCount = computed(() => props.data.cookies.length);
const localStorageCount = computed(() => Object.keys(props.data.localStorage || {}).length);

const expandedDomains = ref<Set<string>>(new Set());

const domains = computed(() => {
  const map = new Map<string, typeof props.data.cookies>();
  for (const c of props.data.cookies) {
    const d = c.domain.replace(/^\./, "");
    if (!map.has(d)) map.set(d, []);
    map.get(d)!.push(c);
  }
  return Array.from(map.entries()).sort((a, b) => b[1].length - a[1].length);
});

// Auto-expand the first 3 domains reactively
watch(domains, (newDomains) => {
  expandedDomains.value = new Set();
  for (let i = 0; i < Math.min(3, newDomains.length); i++) {
    expandedDomains.value.add(newDomains[i][0]);
  }
}, { immediate: true });

function toggleDomain(domain: string) {
  const next = new Set(expandedDomains.value);
  if (next.has(domain)) next.delete(domain);
  else next.add(domain);
  expandedDomains.value = next;
}

function formatExpiry(expires: number): string {
  if (expires === -1 || expires === 0) return "Session";
  const d = new Date(expires * 1000);
  return d.toLocaleDateString() + " " + d.toLocaleTimeString();
}

function truncate(val: string, max: number): string {
  return val.length > max ? val.slice(0, max) + "\u2026" : val;
}
</script>

<template>
  <div class="overlay" @click.self="ready && emit('close')">
    <div class="pv-modal">
      <div class="pv-header">
        <h3>Browser Profile Data</h3>
        <div class="pv-stats">
          <span class="pv-badge">{{ cookieCount }} cookies</span>
          <span v-if="localStorageCount" class="pv-badge pv-badge--ls">{{ localStorageCount }} localStorage keys</span>
        </div>
        <button class="close-btn" @click="emit('close')">&times;</button>
      </div>

      <div class="pv-body">
        <!-- Cookies by domain -->
        <div v-for="[domain, cookies] in domains" :key="domain" class="pv-domain">
          <button class="pv-domain-header" @click="toggleDomain(domain)">
            <span class="pv-chevron" :class="{ 'pv-chevron--open': expandedDomains.has(domain) }">&#9654;</span>
            <span class="pv-domain-name">{{ domain }}</span>
            <span class="pv-domain-count">{{ cookies.length }} cookie{{ cookies.length !== 1 ? 's' : '' }}</span>
          </button>

          <div v-if="expandedDomains.has(domain)" class="pv-cookie-list">
            <div v-for="c in cookies" :key="c.name + c.domain + c.path" class="pv-cookie">
              <div class="pv-cookie-top">
                <span class="pv-cookie-name">{{ c.name }}</span>
                <div class="pv-flags">
                  <span v-if="c.httpOnly" class="pv-flag pv-flag--http">HttpOnly</span>
                  <span v-if="c.secure" class="pv-flag pv-flag--secure">Secure</span>
                  <span class="pv-flag pv-flag--same">{{ c.sameSite || 'None' }}</span>
                  <span class="pv-flag pv-flag--exp">{{ formatExpiry(c.expires) }}</span>
                </div>
              </div>
              <div class="pv-cookie-val" :title="c.value">{{ truncate(c.value, 120) }}</div>
            </div>
          </div>
        </div>

        <!-- LocalStorage -->
        <div v-if="localStorageCount" class="pv-domain">
          <button class="pv-domain-header" @click="toggleDomain('__localStorage__')">
            <span class="pv-chevron" :class="{ 'pv-chevron--open': expandedDomains.has('__localStorage__') }">&#9654;</span>
            <span class="pv-domain-name pv-domain-name--ls">localStorage</span>
            <span class="pv-domain-count">{{ localStorageCount }} key{{ localStorageCount !== 1 ? 's' : '' }}</span>
          </button>

          <div v-if="expandedDomains.has('__localStorage__')" class="pv-cookie-list">
            <div v-for="(val, key) in data.localStorage" :key="key" class="pv-cookie">
              <div class="pv-cookie-top">
                <span class="pv-cookie-name">{{ key }}</span>
              </div>
              <div class="pv-cookie-val" :title="val">{{ truncate(val, 120) }}</div>
            </div>
          </div>
        </div>

        <div v-if="!cookieCount && !localStorageCount" class="pv-empty">
          No cookies or storage data found. Try signing in first.
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.overlay {
  position: fixed; inset: 0;
  background: rgba(0,0,0,0.6);
  display: flex; align-items: center; justify-content: center;
  z-index: 200;
  backdrop-filter: blur(6px);
}

.pv-modal {
  background: #0f1524;
  border: 1px solid rgba(255,255,255,0.12);
  border-radius: 12px;
  width: 780px;
  max-width: 94vw;
  max-height: 85vh;
  color: #fff;
  box-shadow: 0 24px 80px rgba(0,0,0,0.6);
  display: flex;
  flex-direction: column;
}

/* ── Header ── */
.pv-header {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 18px 24px;
  border-bottom: 1px solid rgba(255,255,255,0.08);
  flex-shrink: 0;
}
.pv-header h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 700;
  letter-spacing: 1px;
}
.pv-stats { display: flex; gap: 8px; flex: 1; }
.pv-badge {
  padding: 4px 12px;
  background: rgba(86,156,214,0.15);
  border: 1px solid rgba(86,156,214,0.3);
  border-radius: 14px;
  font-size: 11px;
  font-weight: 600;
  color: #7ab8e8;
}
.pv-badge--ls {
  background: rgba(78,201,176,0.12);
  border-color: rgba(78,201,176,0.3);
  color: #6edbc4;
}
.close-btn {
  background: none; border: none;
  color: rgba(255,255,255,0.4); font-size: 24px; cursor: pointer;
  line-height: 1;
}
.close-btn:hover { color: #fff; }

/* ── Body ── */
.pv-body {
  padding: 16px 24px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* ── Domain sections ── */
.pv-domain {
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 10px;
  overflow: hidden;
}

.pv-domain-header {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 12px 18px;
  border: none;
  background: rgba(255,255,255,0.04);
  color: #fff;
  cursor: pointer;
  text-align: left;
  font-family: inherit;
  font-size: 12px;
  transition: background 0.15s;
}
.pv-domain-header:hover {
  background: rgba(255,255,255,0.07);
}

.pv-chevron {
  font-size: 10px;
  color: rgba(255,255,255,0.3);
  transition: transform 0.2s;
  flex-shrink: 0;
}
.pv-chevron--open {
  transform: rotate(90deg);
  color: rgba(255,255,255,0.6);
}

.pv-domain-name {
  font-weight: 700;
  color: #7ab8e8;
  flex: 1;
}
.pv-domain-name--ls {
  color: #6edbc4;
}

.pv-domain-count {
  font-size: 11px;
  font-weight: 500;
  color: rgba(255,255,255,0.35);
}

/* ── Cookie list ── */
.pv-cookie-list {
  border-top: 1px solid rgba(255,255,255,0.06);
}

.pv-cookie {
  padding: 10px 18px;
  border-bottom: 1px solid rgba(255,255,255,0.05);
}
.pv-cookie:last-child { border-bottom: none; }

.pv-cookie-top {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 4px;
}

.pv-cookie-name {
  font-size: 12px;
  font-weight: 700;
  color: #fff;
  flex-shrink: 0;
}

.pv-flags {
  display: flex;
  gap: 5px;
  flex-wrap: wrap;
}

.pv-flag {
  padding: 1px 7px;
  border-radius: 4px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.3px;
}
.pv-flag--http {
  background: rgba(78,201,176,0.15);
  color: #6edbc4;
}
.pv-flag--secure {
  background: rgba(86,156,214,0.15);
  color: #7ab8e8;
}
.pv-flag--same {
  background: rgba(255,255,255,0.06);
  color: rgba(255,255,255,0.5);
}
.pv-flag--exp {
  background: rgba(255,255,255,0.04);
  color: rgba(255,255,255,0.35);
  font-variant-numeric: tabular-nums;
}

.pv-cookie-val {
  font-size: 11px;
  font-family: 'Ubuntu Mono', monospace;
  color: rgba(255,255,255,0.5);
  word-break: break-all;
  line-height: 1.5;
}

/* ── Empty state ── */
.pv-empty {
  text-align: center;
  padding: 48px;
  color: rgba(255,255,255,0.3);
  font-size: 11px;
}
</style>
