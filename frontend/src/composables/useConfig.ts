import { reactive } from "vue";
import { type CrawlConfig, defaultConfig } from "../types/crawl";

const LEGACY_STORAGE_KEY = "fera-config-defaults";

// Transient per-crawl state. Nothing here persists across launches — persistent
// knobs (concurrency, delay, mode, headless, UA, …) are profile settings now.
// One-shot cleanup of the legacy localStorage blob that used to hold persistent
// defaults (including a bot-identifying userAgent that overrode stealth).
try { localStorage.removeItem(LEGACY_STORAGE_KEY); } catch {}

const config = reactive<CrawlConfig>({ ...defaultConfig });

export function useConfig() {
  function reset() {
    Object.assign(config, defaultConfig);
  }

  function applyConfig(incoming: Partial<CrawlConfig>) {
    if (!incoming || Object.keys(incoming).length === 0) return;
    // Older .fera files and DB session configs may include schema-migrated
    // keys (mode, concurrency, userAgent, …). Spreading over defaultConfig
    // drops the extras; TypeScript-unknown keys are harmless at runtime.
    Object.assign(config, { ...defaultConfig, ...incoming });
  }

  return { config, reset, applyConfig };
}
