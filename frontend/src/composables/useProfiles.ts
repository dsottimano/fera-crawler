import { ref, type Ref } from "vue";
import Database from "@tauri-apps/plugin-sql";

import { SCHEMA_VERSION } from "../settings/schema";
import { buildDefaults } from "../settings/defaults";
import { DEFAULT_PROFILES } from "../settings/default-profiles";
import type { Profile, SettingsValues } from "../settings/types";

let dbPromise: Promise<Database> | null = null;
function getDb(): Promise<Database> {
  if (!dbPromise) dbPromise = Database.load("sqlite:fera.db");
  return dbPromise;
}

interface ProfileRow {
  id: number;
  name: string;
  schema_version: number;
  values_json: string;
  is_default: number;
  start_url: string | null;
  created_at: string;
  updated_at: string;
}

function rowToProfile(r: ProfileRow): Profile {
  let values: SettingsValues;
  try {
    values = JSON.parse(r.values_json) as SettingsValues;
  } catch {
    values = buildDefaults();
  }
  return {
    id: r.id,
    name: r.name,
    schemaVersion: r.schema_version,
    values,
    isDefault: r.is_default === 1,
    startUrl: r.start_url ?? undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const profiles: Ref<Profile[]> = ref([]);
let seeded = false;

async function seedIfEmpty(): Promise<void> {
  if (seeded) return;
  const d = await getDb();
  const rows = await d.select<{ c: number }[]>("SELECT COUNT(*) as c FROM profiles");
  if (rows[0]?.c === 0) {
    for (const p of DEFAULT_PROFILES) {
      await d.execute(
        `INSERT INTO profiles (name, schema_version, values_json, is_default)
         VALUES ($1, $2, $3, $4)`,
        [p.name, p.schemaVersion, JSON.stringify(p.values), p.isDefault ? 1 : 0]
      );
    }
  }
  seeded = true;
}

async function refresh(): Promise<void> {
  const d = await getDb();
  const rows = await d.select<ProfileRow[]>(
    "SELECT id, name, schema_version, values_json, is_default, start_url, created_at, updated_at FROM profiles ORDER BY id"
  );
  profiles.value = rows.map(rowToProfile);
}

export function useProfiles() {
  async function init(): Promise<void> {
    await seedIfEmpty();
    await refresh();
  }

  async function create(opts: { name: string; basedOn?: number; values?: SettingsValues }): Promise<Profile> {
    const d = await getDb();
    let values = opts.values;
    if (!values && opts.basedOn !== undefined) {
      const rows = await d.select<ProfileRow[]>(
        "SELECT id, name, schema_version, values_json, is_default, start_url, created_at, updated_at FROM profiles WHERE id = $1",
        [opts.basedOn]
      );
      if (rows[0]) values = rowToProfile(rows[0]).values;
    }
    if (!values) values = buildDefaults();

    const res = await d.execute(
      `INSERT INTO profiles (name, schema_version, values_json, is_default)
       VALUES ($1, $2, $3, 0)`,
      [opts.name, SCHEMA_VERSION, JSON.stringify(values)]
    );
    await refresh();
    const newId = Number(res.lastInsertId ?? 0);
    return profiles.value.find((p) => p.id === newId)!;
  }

  async function duplicate(id: number, newName: string): Promise<Profile> {
    return create({ name: newName, basedOn: id });
  }

  async function rename(id: number, newName: string): Promise<void> {
    const d = await getDb();
    await d.execute(
      "UPDATE profiles SET name = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2",
      [newName, id]
    );
    await refresh();
  }

  async function remove(id: number): Promise<void> {
    const d = await getDb();
    const target = profiles.value.find((p) => p.id === id);
    if (target?.isDefault) {
      throw new Error("Cannot delete the default profile. Mark another as default first.");
    }
    await d.execute("DELETE FROM profiles WHERE id = $1", [id]);
    await refresh();
  }

  async function setDefault(id: number): Promise<void> {
    const d = await getDb();
    // Partial unique index forbids two defaults. Clear first, then set.
    await d.execute("UPDATE profiles SET is_default = 0 WHERE is_default = 1");
    await d.execute(
      "UPDATE profiles SET is_default = 1, updated_at = CURRENT_TIMESTAMP WHERE id = $1",
      [id]
    );
    await refresh();
  }

  async function updateValues(id: number, values: SettingsValues): Promise<void> {
    const d = await getDb();
    await d.execute(
      "UPDATE profiles SET values_json = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2",
      [JSON.stringify(values), id]
    );
    await refresh();
  }

  return {
    profiles,
    init,
    refresh,
    create,
    duplicate,
    rename,
    remove,
    setDefault,
    updateValues,
  };
}
