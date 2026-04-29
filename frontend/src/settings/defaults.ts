import { SCHEMA, type SettingsSchema } from "./schema";
import type { SettingsValues } from "./types";

// Per-crawl inputs aren't schema-driven knobs — they're free-form user input
// (URL list, headers map, scraper rules) that don't fit the SettingDef shape.
// Kept here as a fixed defaults blob so they're part of every fresh profile.
const INPUTS_DEFAULTS: SettingsValues["inputs"] = {
  urls: [],
  customHeaders: {},
  scraperRules: [],
  recrawlQueue: [],
};

export function buildDefaults(schema: SettingsSchema = SCHEMA): SettingsValues {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [sectionKey, section] of Object.entries(schema)) {
    const bucket: Record<string, unknown> = {};
    for (const [itemKey, def] of Object.entries(section.items)) {
      // Deep-clone default so mutations to one profile's values don't leak
      // into the schema's baked-in defaults (matters for `rules` arrays).
      bucket[itemKey] = structuredClone(def.default);
    }
    out[sectionKey] = bucket;
  }
  out.inputs = structuredClone(INPUTS_DEFAULTS);
  return out as unknown as SettingsValues;
}

// Deep-merge stored profile values under a fresh defaults skeleton. Stored
// wins for primitives and arrays; objects recurse so a missing nested key
// (e.g. profile saved before perHostConcurrency was added) gets the default
// instead of leaking `undefined` into the UI and IPC layer.
//
// `inputs.customHeaders` is a free-form Record<string,string>, so it's
// preserved verbatim; every other bucket is schema-strict and drops keys not
// in the current defaults (so retired knobs like advanced.perHostDelay go
// away on next read).
export function mergeWithDefaults(stored: unknown): SettingsValues {
  return mergeStrict(buildDefaults(), stored) as SettingsValues;
}

const FREEFORM_PATHS = new Set<string>(["inputs.customHeaders"]);

function mergeStrict(defaults: unknown, stored: unknown, path = ""): unknown {
  if (FREEFORM_PATHS.has(path)) {
    if (isPlainObject(stored)) return { ...stored };
    return defaults;
  }
  if (!isPlainObject(defaults)) return stored !== undefined ? stored : defaults;
  if (!isPlainObject(stored)) return defaults;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(defaults)) {
    out[k] = mergeStrict(defaults[k], stored[k], path ? `${path}.${k}` : k);
  }
  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export const DEFAULT_VALUES: SettingsValues = buildDefaults();
