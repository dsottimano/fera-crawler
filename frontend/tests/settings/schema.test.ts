import { describe, it, expect } from "vitest";

import { SCHEMA, SCHEMA_VERSION, type SettingDef } from "../../src/settings/schema";
import { buildDefaults, DEFAULT_VALUES } from "../../src/settings/defaults";
import { DEFAULT_PROFILES } from "../../src/settings/default-profiles";
import type { SettingsValues } from "../../src/settings/types";

function walkLeaves(cb: (sectionKey: string, itemKey: string, def: SettingDef) => void) {
  for (const [sectionKey, section] of Object.entries(SCHEMA)) {
    for (const [itemKey, def] of Object.entries(section.items)) {
      cb(sectionKey, itemKey, def);
    }
  }
}

describe("schema", () => {
  it("every leaf's default matches its declared type", () => {
    walkLeaves((sectionKey, itemKey, def) => {
      const label = `${sectionKey}.${itemKey}`;
      switch (def.type) {
        case "boolean":
          expect(typeof def.default, label).toBe("boolean");
          break;
        case "number":
          expect(typeof def.default, label).toBe("number");
          if (def.min !== undefined) expect(def.default as number).toBeGreaterThanOrEqual(def.min);
          if (def.max !== undefined) expect(def.default as number).toBeLessThanOrEqual(def.max);
          break;
        case "string":
        case "secret":
        case "url":
          expect(typeof def.default, label).toBe("string");
          break;
        case "enum":
          expect(def.options, `${label} has options`).toBeDefined();
          expect(def.options!, `${label} default in options`).toContain(def.default as string);
          break;
        case "rules":
          expect(Array.isArray(def.default), label).toBe(true);
          break;
      }
    });
  });

  it("buildDefaults produces values with same section/item shape as schema", () => {
    const values = buildDefaults() as Record<string, Record<string, unknown>>;
    for (const [sectionKey, section] of Object.entries(SCHEMA)) {
      expect(values[sectionKey], `section ${sectionKey}`).toBeDefined();
      for (const itemKey of Object.keys(section.items)) {
        expect(values[sectionKey]).toHaveProperty(itemKey);
      }
    }
  });

  it("buildDefaults satisfies SettingsValues", () => {
    const v = buildDefaults() satisfies SettingsValues;
    expect(v).toBe(v);
  });

  it("DEFAULT_VALUES is deep-cloned (no shared array identity with schema)", () => {
    const a = buildDefaults();
    const b = buildDefaults();
    expect(a.extraction.scraperRules).not.toBe(b.extraction.scraperRules);
  });
});

describe("default profiles", () => {
  it("exactly one is marked default", () => {
    expect(DEFAULT_PROFILES.filter((p) => p.isDefault)).toHaveLength(1);
  });

  it("names are unique", () => {
    const names = DEFAULT_PROFILES.map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("all carry current schema version", () => {
    for (const p of DEFAULT_PROFILES) expect(p.schemaVersion).toBe(SCHEMA_VERSION);
  });

  it("Quick scan equals schema defaults", () => {
    const quick = DEFAULT_PROFILES.find((p) => p.name === "Quick scan")!;
    expect(quick.values).toEqual(DEFAULT_VALUES);
  });
});

