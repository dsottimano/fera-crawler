import { SCHEMA_VERSION } from "./schema";
import { buildDefaults } from "./defaults";
import type { Profile, SettingsValues } from "./types";

export type SeedProfile = Omit<Profile, "id" | "createdAt" | "updatedAt">;

function withOverrides(patch: (v: SettingsValues) => void): SettingsValues {
  const v = buildDefaults();
  patch(v);
  return v;
}

export const DEFAULT_PROFILES: SeedProfile[] = [
  {
    name: "Quick scan",
    schemaVersion: SCHEMA_VERSION,
    isDefault: true,
    values: buildDefaults(),
  },
  {
    name: "Media audit",
    schemaVersion: SCHEMA_VERSION,
    isDefault: false,
    values: withOverrides((v) => {
      v.extraction.downloadOgImage = true;
    }),
  },
  {
    name: "Deep audit",
    schemaVersion: SCHEMA_VERSION,
    isDefault: false,
    values: withOverrides((v) => {
      v.extraction.captureVitals = true;
      v.extraction.downloadOgImage = true;
      v.performance.blockResources = false;
    }),
  },
];
