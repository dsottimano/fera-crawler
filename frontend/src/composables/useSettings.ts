import { ref, computed, type Ref, type ComputedRef } from "vue";

import { useProfiles } from "./useProfiles";
import { useCrawl } from "./useCrawl";
import { useDatabase } from "./useDatabase";
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

  // What the running crawl actually uses: pinned snapshot if a saved crawl is
  // loaded, otherwise the default-settings profile. Save/patch follow the
  // same rule — edits go to the pinned snapshot when loaded so the modal
  // always edits exactly one thing: whatever's actually in effect.
  const { pinnedSettings, currentSessionId } = useCrawl();
  const { updateSessionConfig } = useDatabase();
  const effectiveSettings: ComputedRef<SettingsValues> = computed(
    () => pinnedSettings.value ?? settings.value
  );
  const editingPinned: ComputedRef<boolean> = computed(
    () => pinnedSettings.value !== null
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
    if (pinnedSettings.value && currentSessionId.value) {
      await updateSessionConfig(currentSessionId.value, values);
      pinnedSettings.value = JSON.parse(JSON.stringify(values)) as SettingsValues;
      return;
    }
    const p = activeProfile.value;
    if (!p) throw new Error("No active profile");
    await profilesApi.updateValues(p.id, values);
  }

  // Immediate-save single-field patch. Used by toolbar buttons (headless,
  // og:image, mode) that flip one knob at a time — bypasses the SettingsPanel
  // draft/dirty/save cycle. Routes to pinned snapshot when a saved crawl is
  // loaded so toolbar toggles affect the running crawl, not the default
  // profile. No-op before init() completes.
  async function patch<S extends keyof SettingsValues, K extends keyof SettingsValues[S]>(
    section: S,
    key: K,
    value: SettingsValues[S][K],
  ): Promise<void> {
    if (pinnedSettings.value && currentSessionId.value) {
      const next = {
        ...pinnedSettings.value,
        [section]: { ...pinnedSettings.value[section], [key]: value },
      } as SettingsValues;
      await updateSessionConfig(currentSessionId.value, next);
      pinnedSettings.value = next;
      return;
    }
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
    effectiveSettings,
    editingPinned,
    activeProfile,
    activeProfileId,
    profiles,
    init,
    switchProfile,
    save,
    patch,
  };
}
