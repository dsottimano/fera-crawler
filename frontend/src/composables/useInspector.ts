import { ref, onUnmounted, getCurrentInstance } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface PickedSelector {
  selector: string;
  tag: string;
  text: string;
  dimensions: string;
}

export function useInspector() {
  const inspecting = ref(false);
  let cleanupListeners: (() => void) | null = null;

  async function openInspector(
    url: string,
    onPick: (picked: PickedSelector) => void,
  ) {
    if (cleanupListeners) {
      cleanupListeners();
      cleanupListeners = null;
    }

    inspecting.value = true;

    const unlistenEvent = await listen<{ event: string; selector: string; tag: string; text: string; dimensions: string }>(
      "browser-event",
      (event) => {
        const data = event.payload;
        if (data.event === "selector-picked") {
          onPick({
            selector: data.selector,
            tag: data.tag,
            text: data.text,
            dimensions: data.dimensions,
          });
        }
      },
    );

    const unlistenClose = await listen<void>("browser-closed", () => {
      inspecting.value = false;
      cleanup();
    });

    function cleanup() {
      unlistenEvent();
      unlistenClose();
      cleanupListeners = null;
    }

    cleanupListeners = cleanup;

    try {
      await invoke("open_inspector", { url });
    } catch (e) {
      console.error("Open inspector failed:", e);
      inspecting.value = false;
      cleanup();
    }
  }

  async function closeInspector() {
    try {
      await invoke("close_browser");
    } catch (e) {
      console.error("Close inspector failed:", e);
    }
    inspecting.value = false;
    if (cleanupListeners) {
      cleanupListeners();
      cleanupListeners = null;
    }
  }

  if (getCurrentInstance()) {
    onUnmounted(() => {
      if (cleanupListeners) {
        cleanupListeners();
        cleanupListeners = null;
      }
    });
  }

  return { inspecting, openInspector, closeInspector };
}
