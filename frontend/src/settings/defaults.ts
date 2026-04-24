import { SCHEMA, type SettingsSchema } from "./schema";
import type { SettingsValues } from "./types";

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
  return out as unknown as SettingsValues;
}

export const DEFAULT_VALUES: SettingsValues = buildDefaults();
