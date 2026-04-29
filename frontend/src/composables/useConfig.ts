import { useSettings } from "./useSettings";
import { useCrawl } from "./useCrawl";
import type { SettingsValues } from "../settings/types";

type Inputs = SettingsValues["inputs"];

const LEGACY_STORAGE_KEY = "fera-config-defaults";
try { localStorage.removeItem(LEGACY_STORAGE_KEY); } catch {}

// Per-crawl inputs (URL list, custom headers, scraper rules, recrawl queue)
// live in the active SettingsValues.inputs bucket — single source of truth.
// The "active" SettingsValues is the pinned snapshot when a saved crawl is
// loaded, otherwise the default-settings profile. This Proxy keeps existing
// callsites (`config.urls`, `config.customHeaders[k] = v`, …) working
// unchanged while routing reads/writes to whichever blob is in effect.
export function useConfig() {
  const { settings } = useSettings();
  const { pinnedSettings } = useCrawl();

  function effectiveInputs(): Inputs {
    return (pinnedSettings.value ?? settings.value).inputs;
  }

  const config = new Proxy({} as Inputs, {
    get(_t, prop) {
      return (effectiveInputs() as Record<string | symbol, unknown>)[prop as string];
    },
    set(_t, prop, value) {
      (effectiveInputs() as Record<string | symbol, unknown>)[prop as string] = value;
      return true;
    },
    deleteProperty(_t, prop) {
      delete (effectiveInputs() as Record<string | symbol, unknown>)[prop as string];
      return true;
    },
    has(_t, prop) {
      return prop in (effectiveInputs() as object);
    },
    ownKeys() {
      return Reflect.ownKeys(effectiveInputs() as object);
    },
    getOwnPropertyDescriptor(_t, prop) {
      return Object.getOwnPropertyDescriptor(effectiveInputs(), prop);
    },
  });

  function reset() {
    const inputs = effectiveInputs();
    inputs.urls = [];
    inputs.customHeaders = {};
    inputs.scraperRules = [];
    inputs.recrawlQueue = [];
  }

  return { config, reset };
}
