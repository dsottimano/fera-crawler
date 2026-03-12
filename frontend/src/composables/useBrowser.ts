import { ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface BrowserCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: string;
}

export interface ProfileData {
  cookies: BrowserCookie[];
  localStorage: Record<string, string>;
}

export function useBrowser() {
  const browserOpen = ref(false);
  const profileData = ref<ProfileData | null>(null);

  async function openBrowser(url: string) {
    browserOpen.value = true;
    profileData.value = null;

    // Listen for profile data (cookies dumped when browser closes)
    const unlistenProfile = await listen<ProfileData>("profile-data", (event) => {
      profileData.value = event.payload;
    });

    const unlistenClose = await listen<void>("browser-closed", () => {
      browserOpen.value = false;
      // If we didn't get profile data from the browser close event,
      // fetch it explicitly
      if (!profileData.value) {
        fetchProfileData(url);
      }
      unlistenClose();
      // Keep profile listener a bit longer for late arrivals
      setTimeout(() => unlistenProfile(), 2000);
    });

    try {
      await invoke("open_browser", { url });
    } catch (e) {
      console.error("Open browser failed:", e);
      browserOpen.value = false;
      unlistenClose();
      unlistenProfile();
    }
  }

  async function closeBrowser() {
    try {
      await invoke("close_browser");
    } catch (e) {
      console.error("Close browser failed:", e);
    }
    browserOpen.value = false;
  }

  async function fetchProfileData(url: string) {
    const unlisten = await listen<ProfileData>("profile-data", (event) => {
      profileData.value = event.payload;
      unlisten();
    });

    try {
      await invoke("dump_profile", { url });
    } catch (e) {
      console.error("Dump profile failed:", e);
      unlisten();
    }
  }

  return { browserOpen, profileData, openBrowser, closeBrowser, fetchProfileData };
}
