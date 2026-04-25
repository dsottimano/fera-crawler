<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { useDatabase, type CrawlSession } from "../composables/useDatabase";
import { useCrawl } from "../composables/useCrawl";
import type { CrawlConfig } from "../types/crawl";
import { useConfig } from "../composables/useConfig";

const emit = defineEmits<{
  close: [];
  load: [startUrl: string];
}>();
const ready = ref(false);
onMounted(() => {
  refresh();
  setTimeout(() => { ready.value = true; }, 100);
});

const { listSessions, deleteSession, clearAllSessions } = useDatabase();
const { loadSession } = useCrawl();
const { applyConfig } = useConfig();

const sessions = ref<CrawlSession[]>([]);
const loading = ref(true);
const infoSession = ref<CrawlSession | null>(null);
const confirmDeleteId = ref<number | null>(null);
const confirmClearAll = ref(false);

async function refresh() {
  loading.value = true;
  sessions.value = await listSessions();
  loading.value = false;
}



const openingId = ref<number | null>(null);

async function handleOpen(session: CrawlSession) {
  openingId.value = session.id;
  try {
    const savedConfig = await loadSession(session.id);
    if (savedConfig) applyConfig(savedConfig);
    emit("load", session.start_url);
  } catch (e) {
    console.error("Failed to load session:", e);
    openingId.value = null;
  }
}

// Historical session configs — older sessions may include schema-migrated
// keys (mode, headless, delay, downloadOgImage) that are no longer on
// CrawlConfig. Accept any shape for display purposes.
const infoConfig = computed<Record<string, unknown> & Partial<CrawlConfig>>(() => {
  const json = infoSession.value?.config_json;
  if (!json) return {};
  try { return JSON.parse(json); }
  catch { return {}; }
});

async function handleDelete(id: number) {
  await deleteSession(id);
  confirmDeleteId.value = null;
  infoSession.value = null;
  await refresh();
}

async function handleClearAll() {
  await clearAllSessions();
  confirmClearAll.value = false;
  await refresh();
}

function formatDate(dateStr: string): string {
  try {
    const d = new Date(dateStr + "Z");
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
      + " " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  } catch {
    return dateStr;
  }
}

function formatUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname + u.pathname;
  } catch {
    return url;
  }
}

interface SessionMeta {
  mode: "list" | "spider";
  listTotal: number | null;
  status: "in progress" | "complete" | "stopped";
  statusColor: string;
  progressLabel: string;
}

// Derive display metadata from a session row + its config_json. Done at
// render time (not during the SQL query) so we can change the display
// without touching the schema.
function sessionMeta(s: CrawlSession): SessionMeta {
  let listTotal: number | null = null;
  if (s.config_json && s.config_json !== "{}") {
    try {
      const cfg = JSON.parse(s.config_json);
      if (Array.isArray(cfg?.urls) && cfg.urls.length > 0) {
        listTotal = cfg.urls.length;
      }
    } catch { /* ignore */ }
  }
  const mode: "list" | "spider" = listTotal !== null ? "list" : "spider";
  const crawled = s.result_count ?? 0;

  let status: SessionMeta["status"];
  let statusColor: string;
  if (s.completed_at == null) {
    status = "in progress";
    statusColor = "#dcdcaa";
  } else if (mode === "list" && listTotal !== null && crawled < listTotal) {
    status = "stopped";
    statusColor = "#ce9178";
  } else {
    status = "complete";
    statusColor = "#4ec9b0";
  }

  const progressLabel = mode === "list" && listTotal !== null
    ? `${crawled.toLocaleString()} / ${listTotal.toLocaleString()} URLs`
    : `${crawled.toLocaleString()} URLs`;

  return { mode, listTotal, status, statusColor, progressLabel };
}
</script>

<template>
  <div class="overlay" @click.self="ready && emit('close')">
    <div class="modal">
      <div class="modal-header">
        <h3>Saved Crawls</h3>
        <button class="close-btn" @click="emit('close')">&times;</button>
      </div>

      <div class="modal-body">
        <div v-if="loading" class="empty">Loading...</div>
        <div v-else-if="sessions.length === 0" class="empty">No saved crawls yet.</div>
        <div v-else class="session-list">
          <div
            v-for="s in sessions"
            :key="s.id"
            class="session-row"
          >
            <div class="session-info" @click="infoSession = infoSession?.id === s.id ? null : s">
              <span class="session-url" :title="s.start_url">{{ formatUrl(s.start_url) }}</span>
              <span class="session-meta">
                <span>{{ formatDate(s.started_at) }}</span>
                <span class="session-mode" :title="sessionMeta(s).mode === 'list' ? 'List mode — fixed URL list' : 'Spider mode — discovers links'">{{ sessionMeta(s).mode }}</span>
                <span class="session-count">{{ sessionMeta(s).progressLabel }}</span>
                <span class="session-status" :style="{ color: sessionMeta(s).statusColor }">{{ sessionMeta(s).status }}</span>
              </span>
            </div>
            <div class="session-actions">
              <button class="action-btn action-open" title="Open" :disabled="openingId === s.id" @click="handleOpen(s)">{{ openingId === s.id ? 'LOADING...' : 'OPEN' }}</button>
              <button
                v-if="confirmDeleteId === s.id"
                class="action-btn action-confirm-delete"
                @click="handleDelete(s.id)"
              >CONFIRM</button>
              <button
                v-else
                class="action-btn action-delete"
                title="Delete"
                @click="confirmDeleteId = s.id"
              >DELETE</button>
            </div>

            <!-- Info panel (expandable) -->
            <div v-if="infoSession?.id === s.id" class="info-panel">
              <div class="info-row"><span class="info-label">URL</span><span class="info-value info-mono">{{ s.start_url }}</span></div>
              <div class="info-row"><span class="info-label">STARTED</span><span class="info-value">{{ formatDate(s.started_at) }}</span></div>
              <div class="info-row"><span class="info-label">COMPLETED</span><span class="info-value">{{ s.completed_at ? formatDate(s.completed_at) : 'In progress' }}</span></div>
              <div class="info-row"><span class="info-label">URLS CRAWLED</span><span class="info-value">{{ s.result_count ?? 0 }}</span></div>
              <template v-if="infoSession?.id === s.id && s.config_json && s.config_json !== '{}'">
                <div class="info-row"><span class="info-label">MODE</span><span class="info-value">{{ infoConfig.mode ?? 'spider' }}</span></div>
                <div class="info-row"><span class="info-label">HEADLESS</span><span class="info-value">{{ infoConfig.headless !== false ? 'Yes' : 'No' }}</span></div>
                <div v-if="infoConfig.delay" class="info-row"><span class="info-label">DELAY</span><span class="info-value">{{ infoConfig.delay }}ms</span></div>
                <div v-if="infoConfig.downloadOgImage" class="info-row"><span class="info-label">OG:IMAGE</span><span class="info-value">Downloading</span></div>
                <div v-if="(infoConfig.scraperRules ?? []).length > 0" class="info-row"><span class="info-label">SCRAPER</span><span class="info-value">{{ infoConfig.scraperRules!.length }} rule(s)</span></div>
              </template>
            </div>
          </div>
        </div>
      </div>

      <div class="modal-footer">
        <button
          v-if="sessions.length > 0 && !confirmClearAll"
          class="btn btn-danger"
          @click="confirmClearAll = true"
        >DELETE ALL</button>
        <button
          v-if="confirmClearAll"
          class="btn btn-danger-confirm"
          @click="handleClearAll"
        >CONFIRM DELETE ALL</button>
        <button
          v-if="confirmClearAll"
          class="btn"
          @click="confirmClearAll = false"
        >CANCEL</button>
        <div class="footer-spacer"></div>
        <button class="btn" @click="emit('close')">CLOSE</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 200;
  backdrop-filter: blur(6px);
}

.modal {
  background: #141a2e;
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 12px;
  min-width: 520px;
  max-width: 640px;
  max-height: 80vh;
  color: #ffffff;
  box-shadow: 0 20px 60px rgba(0,0,0,0.5);
  display: flex;
  flex-direction: column;
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 20px;
  border-bottom: 1px solid rgba(255,255,255,0.06);
  flex-shrink: 0;
}
.modal-header h3 {
  margin: 0;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 1px;
  text-transform: uppercase;
  color: #ffffff;
}
.close-btn {
  background: none;
  border: none;
  color: rgba(255,255,255,0.3);
  font-size: 18px;
  cursor: pointer;
}
.close-btn:hover { color: #fff; }

.modal-body {
  padding: 12px 20px;
  overflow-y: auto;
  flex: 1;
}

.empty {
  color: rgba(255,255,255,0.25);
  font-size: 11px;
  text-align: center;
  padding: 32px 0;
}

.session-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.session-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  padding: 8px 12px;
  background: rgba(255,255,255,0.03);
  border: 1px solid rgba(255,255,255,0.04);
  border-radius: 8px;
  transition: border-color 0.15s;
}
.session-row:hover {
  border-color: rgba(255,255,255,0.1);
}

.session-info {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
  cursor: pointer;
  min-width: 0;
}

.session-url {
  font-size: 11px;
  font-weight: 600;
  color: #ffffff;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.session-meta {
  font-size: 9px;
  color: rgba(255,255,255,0.35);
  display: flex;
  gap: 8px;
  letter-spacing: 0.5px;
  flex-wrap: wrap;
  align-items: center;
}

.session-count {
  color: #569cd6;
  font-weight: 600;
}

.session-mode {
  text-transform: uppercase;
  font-weight: 600;
  color: rgba(255,255,255,0.5);
}

.session-status {
  text-transform: uppercase;
  font-weight: 700;
  letter-spacing: 1px;
}

.session-actions {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
  margin-left: 12px;
}

.action-btn {
  padding: 4px 10px;
  border-radius: 20px;
  font-size: 8px;
  font-weight: 700;
  letter-spacing: 1px;
  cursor: pointer;
  transition: all 0.15s;
  background: transparent;
}

.action-open {
  color: #4ec9b0;
  border: 1px solid rgba(78,201,176,0.3);
}
.action-open:hover {
  background: rgba(78,201,176,0.1);
  border-color: #4ec9b0;
}

.action-delete {
  color: rgba(255,255,255,0.3);
  border: 1px solid rgba(255,255,255,0.08);
}
.action-delete:hover {
  color: #f44747;
  border-color: rgba(244,71,71,0.3);
}

.action-confirm-delete {
  color: #f44747;
  border: 1px solid rgba(244,71,71,0.5);
  background: rgba(244,71,71,0.1);
}

/* Info panel — expandable below the row */
.info-panel {
  width: 100%;
  margin-top: 8px;
  padding: 8px 12px;
  background: rgba(255,255,255,0.02);
  border-top: 1px solid rgba(255,255,255,0.04);
  border-radius: 0 0 8px 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.info-row {
  display: flex;
  gap: 12px;
  font-size: 10px;
}

.info-label {
  color: rgba(255,255,255,0.25);
  font-size: 8px;
  font-weight: 600;
  letter-spacing: 1.5px;
  text-transform: uppercase;
  min-width: 100px;
  flex-shrink: 0;
  padding-top: 1px;
}

.info-value {
  color: rgba(255,255,255,0.7);
  word-break: break-all;
}

.info-mono {
  font-family: 'SF Mono', 'Cascadia Code', 'Consolas', monospace;
}

.modal-footer {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 12px 20px;
  border-top: 1px solid rgba(255,255,255,0.06);
  flex-shrink: 0;
}

.footer-spacer { flex: 1; }

.btn {
  padding: 8px 22px;
  background: transparent;
  color: rgba(255,255,255,0.5);
  border: 1px solid rgba(255,255,255,0.12);
  border-radius: 20px;
  cursor: pointer;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 1px;
  transition: all 0.15s;
}
.btn:hover {
  color: #fff;
  border-color: rgba(255,255,255,0.3);
}

.btn-danger {
  color: rgba(244,71,71,0.6);
  border-color: rgba(244,71,71,0.2);
}
.btn-danger:hover {
  color: #f44747;
  border-color: rgba(244,71,71,0.4);
}

.btn-danger-confirm {
  color: #f44747;
  border-color: rgba(244,71,71,0.5);
  background: rgba(244,71,71,0.1);
}
.btn-danger-confirm:hover {
  background: rgba(244,71,71,0.15);
}
</style>
