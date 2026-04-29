<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from "vue";
import { SCHEMA, type SettingsSection as Section, type SettingDef } from "../../settings/schema";
import { useSettings } from "../../composables/useSettings";
import { useDebug } from "../../composables/useDebug";
import SettingsSection from "./SettingsSection.vue";
import SettingsItem from "./SettingsItem.vue";
import type { SettingsValues } from "../../settings/types";

// Sections folded into the "Crawling" tab so users see one merged surface
// instead of four near-identical knob lists. Data shape in SettingsValues is
// unchanged — only the UI grouping differs.
const CRAWLING_MERGED_INTO = new Set<string>(["performance", "authentication", "advanced"]);

// UI-only grouping for the Crawling tab. Items are referenced by (bucket, key)
// pairs into the schema; data shape stays in its original SettingsValues bucket.
type CrawlingItemRef = { bucket: keyof SettingsValues & string; key: string };
type CrawlingSubgroup = {
  heading: string;
  hint?: string;
  items: CrawlingItemRef[];
  action?: "wipe";
};

const CRAWLING_SUBGROUPS: CrawlingSubgroup[] = [
  {
    heading: "Mode & scope",
    items: [
      { bucket: "crawling", key: "mode" },
      { bucket: "crawling", key: "maxRequests" },
      { bucket: "crawling", key: "respectRobots" },
      { bucket: "crawling", key: "discoverSitemap" },
    ],
  },
  {
    heading: "Speed & throttling",
    items: [
      { bucket: "crawling", key: "concurrency" },
      { bucket: "crawling", key: "delay" },
      { bucket: "performance", key: "perHostDelay" },
      { bucket: "performance", key: "perHostDelayMax" },
      { bucket: "performance", key: "perHostConcurrency" },
      { bucket: "performance", key: "blockResources" },
      { bucket: "performance", key: "closeOnExtract" },
    ],
  },
  {
    heading: "Anti-bot resilience",
    hint: "For the full fingerprint stack, see the Stealth tab.",
    items: [
      { bucket: "performance", key: "sessionWarmup" },
      { bucket: "performance", key: "autoProbeOnBlock" },
      { bucket: "authentication", key: "headless" },
    ],
    action: "wipe",
  },
  {
    heading: "Debug",
    items: [{ bucket: "advanced", key: "debugLog" }],
  },
];

const emit = defineEmits<{ close: [] }>();

const { settings, effectiveSettings, editingPinned, activeProfile, profiles, init, switchProfile, save } = useSettings();
const { wipeBrowserProfile } = useDebug();

const searchQuery = ref("");
const activeSectionKey = ref<string | null>(null);
const draft = ref<SettingsValues | null>(null);
const dirty = ref(false);

// Modal always edits whatever is *active*: pinned snapshot when a saved crawl
// is loaded, otherwise the default-settings profile. Single editing target
// at any time — no confusion about which thing the changes affect.
const localValues = computed<SettingsValues>(() => draft.value ?? effectiveSettings.value);

onMounted(async () => {
  await init();
  draft.value = JSON.parse(JSON.stringify(effectiveSettings.value)) as SettingsValues;
  const visibleKeys = visibleSections.value.map((s) => s.key);
  if (visibleKeys.length) activeSectionKey.value = visibleKeys[0];
});

watch(activeProfile, (p) => {
  if (p && !dirty.value && !editingPinned.value) {
    draft.value = JSON.parse(JSON.stringify(p.values)) as SettingsValues;
  }
});

// If a saved crawl is loaded/cleared while the modal is open, swap draft to
// match the new editing target — but only when the user hasn't typed anything
// yet, to avoid clobbering in-flight edits.
watch(editingPinned, () => {
  if (!dirty.value) {
    draft.value = JSON.parse(JSON.stringify(effectiveSettings.value)) as SettingsValues;
  }
});

function sectionMatches(section: Section, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  if (section.label.toLowerCase().includes(q)) return true;
  return Object.entries(section.items).some(([key, def]) => itemMatches(key, def, q));
}

function itemMatches(key: string, def: SettingDef, q: string): boolean {
  if (def.hidden) return false;
  return (
    key.toLowerCase().includes(q) ||
    def.label.toLowerCase().includes(q) ||
    (def.help?.toLowerCase().includes(q) ?? false)
  );
}

type ResolvedCrawlingItem = { bucket: string; key: string; def: SettingDef };
type ResolvedCrawlingSubgroup = {
  heading: string;
  hint?: string;
  items: ResolvedCrawlingItem[];
  action?: "wipe";
};

const visibleCrawlingSubgroups = computed<ResolvedCrawlingSubgroup[]>(() => {
  const q = searchQuery.value.toLowerCase();
  const out: ResolvedCrawlingSubgroup[] = [];
  for (const group of CRAWLING_SUBGROUPS) {
    const items: ResolvedCrawlingItem[] = [];
    for (const ref of group.items) {
      const def = SCHEMA[ref.bucket]?.items[ref.key];
      if (!def) continue;
      if (def.hidden) continue;
      if (q && !itemMatches(ref.key, def, q) && !group.heading.toLowerCase().includes(q)) continue;
      items.push({ bucket: ref.bucket, key: ref.key, def });
    }
    const hasAction = group.action === "wipe" && (!q || "wipe browser profile".includes(q));
    if (items.length || hasAction) {
      out.push({ heading: group.heading, hint: group.hint, items, action: hasAction ? group.action : undefined });
    }
  }
  return out;
});

const visibleSections = computed(() => {
  return Object.entries(SCHEMA)
    .filter(([key]) => !key.startsWith("_"))
    .filter(([key]) => !CRAWLING_MERGED_INTO.has(key))
    .filter(([, section]) => {
      // Hide sections whose every item is explicitly hidden.
      return Object.values(section.items).some((def) => !def.hidden);
    })
    .filter(([key, section]) => {
      if (key === "crawling") {
        // Crawling tab is visible if any of its subgroups have a visible item.
        return visibleCrawlingSubgroups.value.length > 0;
      }
      return sectionMatches(section, searchQuery.value);
    })
    .map(([key, section]) => ({ key, section }));
});

const activeSection = computed(() => {
  const found = visibleSections.value.find((s) => s.key === activeSectionKey.value);
  return found ?? visibleSections.value[0] ?? null;
});

watch(visibleSections, (sections) => {
  if (!sections.find((s) => s.key === activeSectionKey.value)) {
    activeSectionKey.value = sections[0]?.key ?? null;
  }
});

function updateItem(sectionKey: string, itemKey: string, value: unknown) {
  if (!draft.value) return;
  const bucket = (draft.value as unknown as Record<string, Record<string, unknown>>)[sectionKey];
  if (!bucket) return;
  bucket[itemKey] = value;
  dirty.value = true;
}

async function handleSave() {
  if (!draft.value) return;
  await save(draft.value);
  dirty.value = false;
}

const wipeState = ref<"idle" | "wiping" | "done">("idle");
async function handleWipeProfile() {
  if (!confirm(
    "Wipe the browser profile?\n\n" +
    "Deletes cookies, cache, and anti-bot tokens (Akamai _abck, Cloudflare __cf_bm) " +
    "that may be causing instant 403 blocks. Kills any running crawl first. " +
    "Sign-in sessions will be lost."
  )) return;
  wipeState.value = "wiping";
  try {
    await wipeBrowserProfile();
    wipeState.value = "done";
    setTimeout(() => { wipeState.value = "idle"; }, 2000);
  } catch (e) {
    wipeState.value = "idle";
    alert(`Wipe failed: ${e}`);
  }
}

async function handleSwitchProfile(e: Event) {
  const id = Number((e.target as HTMLSelectElement).value);
  if (dirty.value) {
    const ok = confirm("Discard unsaved changes?");
    if (!ok) return;
  }
  await switchProfile(id);
  if (activeProfile.value) {
    draft.value = JSON.parse(JSON.stringify(activeProfile.value.values)) as SettingsValues;
    dirty.value = false;
  }
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") emit("close");
}
onMounted(() => window.addEventListener("keydown", onKeydown));
onUnmounted(() => window.removeEventListener("keydown", onKeydown));
</script>

<template>
  <div class="overlay" @click.self="emit('close')">
    <div class="panel" role="dialog" aria-label="Settings">
      <header class="panel-header">
        <div class="panel-title">SETTINGS</div>
        <div class="header-controls">
          <div v-if="editingPinned" class="profile-select profile-select--locked" title="A saved crawl is loaded — editing its pinned settings.">
            Pinned (this crawl)
          </div>
          <select
            v-else-if="profiles.length"
            class="profile-select"
            :value="activeProfile?.id ?? ''"
            @change="handleSwitchProfile"
          >
            <option v-for="p in profiles" :key="p.id" :value="p.id">
              {{ p.name }}{{ p.isDefault ? ' (default)' : '' }}
            </option>
          </select>
          <input
            v-model="searchQuery"
            type="search"
            placeholder="Search settings"
            class="search-input"
          />
          <button class="btn-close" @click="emit('close')" aria-label="Close">&#x2715;</button>
        </div>
      </header>

      <div v-if="editingPinned" class="pin-banner">
        Editing the loaded crawl's pinned settings. Changes apply only to this crawl. New crawls use the default profile.
      </div>

      <div class="panel-body">
        <nav class="section-nav" aria-label="Settings sections">
          <button
            v-for="{ key, section } in visibleSections"
            :key="key"
            class="nav-item"
            :class="{ 'nav-item--active': key === activeSectionKey }"
            @click="activeSectionKey = key"
          >
            {{ section.label }}
          </button>
        </nav>

        <div class="section-content">
          <template v-if="activeSection && activeSection.key === 'crawling' && draft">
            <section
              v-for="group in visibleCrawlingSubgroups"
              :key="group.heading"
              class="subgroup"
            >
              <h2 class="subgroup-label">{{ group.heading }}</h2>
              <p v-if="group.hint" class="subgroup-hint">{{ group.hint }}</p>
              <ul class="item-list">
                <li v-for="it in group.items" :key="`${it.bucket}.${it.key}`" class="item">
                  <SettingsItem
                    :item-key="it.key"
                    :def="it.def"
                    :value="(localValues as unknown as Record<string, Record<string, unknown>>)[it.bucket]?.[it.key]"
                    @update="(v) => updateItem(it.bucket, it.key, v)"
                  />
                </li>
                <li v-if="group.action === 'wipe'" class="item">
                  <div class="action-row">
                    <div class="action-text">
                      <div class="action-label">Wipe browser profile</div>
                      <p class="action-help">
                        Deletes cookies, cache, and anti-bot tokens (Akamai _abck, Cloudflare __cf_bm).
                        Use when a site starts instant-403ing. Sign-in sessions will be lost.
                      </p>
                    </div>
                    <button
                      class="btn-pill btn-wipe"
                      :disabled="wipeState === 'wiping'"
                      @click="handleWipeProfile"
                    >
                      {{ wipeState === 'wiping' ? 'WIPING…' : wipeState === 'done' ? 'WIPED' : 'WIPE PROFILE' }}
                    </button>
                  </div>
                </li>
              </ul>
            </section>
          </template>
          <SettingsSection
            v-else-if="activeSection && draft"
            :section="activeSection.section"
            :section-key="activeSection.key"
            :values="(localValues as unknown as Record<string, Record<string, unknown>>)[activeSection.key]"
            :search="searchQuery"
            @update="(itemKey, value) => updateItem(activeSection!.key, itemKey, value)"
          />
        </div>
      </div>

      <footer class="panel-footer">
        <span v-if="dirty" class="dirty-flag">UNSAVED CHANGES</span>
        <div class="footer-actions">
          <button class="btn-pill btn-cancel" @click="emit('close')">CLOSE</button>
          <button
            class="btn-pill btn-save"
            :disabled="!dirty"
            @click="handleSave"
          >
            SAVE
          </button>
        </div>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 300;
  backdrop-filter: blur(6px);
}

.panel {
  width: min(920px, 92vw);
  height: min(640px, 88vh);
  background: #141a2e;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 12px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
  display: flex;
  flex-direction: column;
  color: #ffffff;
  overflow: hidden;
}

.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 20px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  gap: 12px;
  flex-shrink: 0;
}

.panel-title {
  font-size: 14px;
  font-weight: 700;
  letter-spacing: 1px;
  text-transform: uppercase;
  color: #ffffff;
}

.header-controls {
  display: flex;
  align-items: center;
  gap: 12px;
}

.profile-select {
  padding: 6px 28px 6px 12px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.04)
    url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='rgba(255,255,255,0.4)'/%3E%3C/svg%3E")
    no-repeat right 10px center;
  color: #ffffff;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.5px;
  appearance: none;
  -webkit-appearance: none;
  cursor: pointer;
  outline: none;
  transition: border-color 0.15s;
}
.profile-select:focus {
  border-color: rgba(86, 156, 214, 0.5);
  box-shadow: 0 0 0 2px rgba(86, 156, 214, 0.1);
}
.profile-select option {
  background: #141a2e;
  color: #ffffff;
  font-size: 11px;
}

.profile-select--locked {
  background: rgba(220, 220, 170, 0.08);
  border-color: rgba(220, 220, 170, 0.3);
  color: #dcdcaa;
  cursor: default;
  display: flex;
  align-items: center;
  height: 28px;
}

.pin-banner {
  padding: 10px 20px;
  background: rgba(220, 220, 170, 0.06);
  border-bottom: 1px solid rgba(220, 220, 170, 0.18);
  color: #dcdcaa;
  font-size: 11px;
  line-height: 1.4;
  flex-shrink: 0;
}

.search-input {
  padding: 6px 12px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.04);
  color: #ffffff;
  font-size: 11px;
  outline: none;
  width: 200px;
  transition: border-color 0.2s, box-shadow 0.2s;
}
.search-input::placeholder {
  color: rgba(255, 255, 255, 0.25);
}
.search-input:focus {
  border-color: rgba(86, 156, 214, 0.5);
  box-shadow: 0 0 0 2px rgba(86, 156, 214, 0.1);
}

.btn-close {
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: transparent;
  color: rgba(255, 255, 255, 0.7);
  width: 24px;
  height: 24px;
  border-radius: 50%;
  cursor: pointer;
  font-size: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s;
}
.btn-close:hover {
  color: #ffffff;
  border-color: rgba(255, 255, 255, 0.25);
}

.panel-body {
  display: flex;
  flex: 1;
  overflow: hidden;
}

.section-nav {
  width: 200px;
  flex-shrink: 0;
  border-right: 1px solid rgba(255, 255, 255, 0.06);
  padding: 12px 8px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.nav-item {
  padding: 7px 14px;
  border: none;
  background: transparent;
  color: rgba(255, 255, 255, 0.6);
  font-size: 11px;
  font-weight: 500;
  text-align: left;
  cursor: pointer;
  border-radius: 5px;
  transition: all 0.15s;
}
.nav-item:hover {
  background: rgba(86, 156, 214, 0.08);
  color: #ffffff;
}
.nav-item--active {
  background: rgba(86, 156, 214, 0.15);
  color: #569cd6;
  font-weight: 600;
}

.section-content {
  flex: 1;
  overflow-y: auto;
  padding: 20px;
}

.panel-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 20px;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  flex-shrink: 0;
}

.dirty-flag {
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 1.2px;
  color: #dcdcaa;
}

.footer-actions {
  display: flex;
  gap: 8px;
  margin-left: auto;
}

.btn-pill {
  padding: 6px 16px;
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 20px;
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 1.2px;
  cursor: pointer;
  transition: all 0.2s;
  background: transparent;
}

.btn-cancel {
  color: rgba(255, 255, 255, 0.4);
  border-color: rgba(255, 255, 255, 0.1);
}
.btn-cancel:hover {
  color: #ffffff;
  border-color: rgba(255, 255, 255, 0.25);
}

.btn-save {
  color: #4ec9b0;
  border-color: rgba(78, 201, 176, 0.3);
}
.btn-save:hover:not(:disabled) {
  background: rgba(78, 201, 176, 0.1);
  border-color: #4ec9b0;
  box-shadow: 0 0 16px rgba(78, 201, 176, 0.15);
}
.btn-save:disabled {
  opacity: 0.25;
  cursor: default;
}

.btn-wipe {
  color: #f44747;
  border-color: rgba(244, 71, 71, 0.3);
}
.btn-wipe:hover:not(:disabled) {
  background: rgba(244, 71, 71, 0.08);
  border-color: #f44747;
  box-shadow: 0 0 16px rgba(244, 71, 71, 0.15);
}
.btn-wipe:disabled {
  opacity: 0.5;
  cursor: default;
}

.subgroup {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding-bottom: 20px;
  margin-bottom: 20px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}
.subgroup:last-child {
  border-bottom: none;
  margin-bottom: 0;
  padding-bottom: 0;
}

.subgroup-label {
  margin: 0;
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 1.2px;
  text-transform: uppercase;
  color: #569cd6;
}

.subgroup-hint {
  margin: -8px 0 0 0;
  font-size: 11px;
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

.action-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 20px;
}

.action-text {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.action-label {
  font-size: 12px;
  font-weight: 600;
  color: #ffffff;
}

.action-help {
  margin: 0;
  font-size: 11px;
  color: rgba(255, 255, 255, 0.45);
  line-height: 1.4;
}
</style>
