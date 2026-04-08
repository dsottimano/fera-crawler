import { reactive } from "vue";
import { type CrawlConfig, defaultConfig } from "../types/crawl";

const STORAGE_KEY = "fera-config-defaults";

function loadSaved(): Partial<CrawlConfig> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

const config = reactive<CrawlConfig>({ ...defaultConfig, ...loadSaved() });

export function useConfig() {
  function reset() {
    Object.assign(config, defaultConfig);
    localStorage.removeItem(STORAGE_KEY);
  }

  function saveDefaults() {
    const toSave: Partial<CrawlConfig> = {
      maxRequests: config.maxRequests,
      concurrency: config.concurrency,
      userAgent: config.userAgent,
      respectRobots: config.respectRobots,
      delay: config.delay,
      headless: config.headless,
      downloadOgImage: config.downloadOgImage,
      mode: config.mode,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(toSave));
  }

  function applyConfig(incoming: Partial<CrawlConfig>) {
    // Skip empty config from old sessions (pre-config-save)
    if (!incoming || Object.keys(incoming).length === 0) return;
    Object.assign(config, { ...defaultConfig, ...incoming });
  }

  return { config, reset, saveDefaults, applyConfig };
}
