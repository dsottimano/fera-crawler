import { ref, computed, type Ref, type ComputedRef } from "vue";

import { useProfiles } from "./useProfiles";
import { buildDefaults } from "../settings/defaults";
import type { Profile, SettingsValues } from "../settings/types";

const activeProfileId: Ref<number | null> = ref(null);
let initialized = false;

/**
 * Reactive access to the active profile's SettingsValues.
 * Stub shape for P0.2 — patch/validate helpers land in P0.3 with the UI.
 */
export function useSettings() {
  const profilesApi = useProfiles();
  const profiles = profilesApi.profiles;

  const activeProfile: ComputedRef<Profile | null> = computed(() => {
    if (activeProfileId.value === null) {
      return profiles.value.find((p) => p.isDefault) ?? profiles.value[0] ?? null;
    }
    return profiles.value.find((p) => p.id === activeProfileId.value) ?? null;
  });

  const settings: ComputedRef<SettingsValues> = computed(
    () => activeProfile.value?.values ?? buildDefaults()
  );

  async function init(): Promise<void> {
    if (initialized) return;
    await profilesApi.init();
    const def = profiles.value.find((p) => p.isDefault);
    if (def) activeProfileId.value = def.id;
    initialized = true;
  }

  async function switchProfile(id: number): Promise<void> {
    const exists = profiles.value.some((p) => p.id === id);
    if (!exists) throw new Error(`Profile ${id} not found`);
    activeProfileId.value = id;
  }

  async function save(values: SettingsValues): Promise<void> {
    const p = activeProfile.value;
    if (!p) throw new Error("No active profile");
    await profilesApi.updateValues(p.id, values);
  }

  // Immediate-save single-field patch. Used by toolbar buttons (headless,
  // og:image, mode) that flip one knob at a time — bypasses the SettingsPanel
  // draft/dirty/save cycle. No-op before init() completes.
  async function patch<S extends keyof SettingsValues, K extends keyof SettingsValues[S]>(
    section: S,
    key: K,
    value: SettingsValues[S][K],
  ): Promise<void> {
    const p = activeProfile.value;
    if (!p) return;
    const next = {
      ...p.values,
      [section]: { ...p.values[section], [key]: value },
    } as SettingsValues;
    await profilesApi.updateValues(p.id, next);
  }

  return {
    settings,
    activeProfile,
    activeProfileId,
    profiles,
    init,
    switchProfile,
    save,
    patch,
  };
}
