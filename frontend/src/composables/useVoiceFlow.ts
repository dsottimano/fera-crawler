// Voice turn orchestrator (streaming).
//
// Wraps useVoiceInput (capture + STT) and chains the result through the
// streaming claude_turn_streaming Tauri command. As Claude emits text events
// (one per assistant message block — there can be multiple in a multi-step
// turn with tool calls), they are appended to a transcript and queued for
// Piper TTS, so playback starts within seconds of the first response chunk
// instead of after the entire turn completes.
//
// State machine the modal renders against:
//   idle → loading → recording → transcribing → thinking → speaking → idle
//
// `thinking` and `speaking` can both be true simultaneously while Claude is
// still generating future blocks — `state` resolves to "speaking" in that
// case so the user sees the right indicator.
//
// Session continuity: claude session_id persisted in localStorage so turns
// chain across app restarts.

import { ref, computed } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useVoiceInput } from "./useVoiceInput";
import { normalizeVoiceTranscript } from "../utils/voiceVocabulary";

const SESSION_STORAGE_KEY = "fera.voice.claude_session_id";

export type VoiceFlowState =
  | "idle"
  | "loading"
  | "recording"
  | "transcribing"
  | "thinking"
  | "speaking"
  | "error";

interface ClaudeTurnResult {
  sessionId: string;
}

export function useVoiceFlow() {
  const voice = useVoiceInput();

  const isThinking = ref(false);
  const isSpeaking = ref(false);
  const claudeText = ref("");
  const flowError = ref("");

  // Speech queue. Each completed assistant text block is pushed here and
  // played sequentially so audio doesn't overlap.
  const speechQueue: string[] = [];
  let speechWorkerActive = false;

  const state = computed<VoiceFlowState>(() => {
    if (flowError.value || voice.lastError.value) return "error";
    if (voice.isRecording.value) return "recording";
    if (voice.isTranscribing.value) return "transcribing";
    // Speaking takes priority over thinking — once first block lands, the
    // user is hearing audio, that's what should be shown.
    if (isSpeaking.value) return "speaking";
    if (isThinking.value) return "thinking";
    if (voice.isModelLoading.value) return "loading";
    return "idle";
  });

  const errorText = computed(() => flowError.value || voice.lastError.value || "");
  const userTranscript = computed(() => voice.lastTranscript.value);

  function loadSessionId(): string | null {
    try {
      return localStorage.getItem(SESSION_STORAGE_KEY) || null;
    } catch {
      return null;
    }
  }

  function saveSessionId(id: string): void {
    try {
      if (id) localStorage.setItem(SESSION_STORAGE_KEY, id);
    } catch {}
  }

  function resetSession(): void {
    try {
      localStorage.removeItem(SESSION_STORAGE_KEY);
    } catch {}
  }

  async function processSpeechQueue(): Promise<void> {
    if (speechWorkerActive) return;
    speechWorkerActive = true;
    isSpeaking.value = true;
    try {
      while (speechQueue.length > 0) {
        const next = speechQueue.shift()!;
        try {
          await invoke("speak", { text: next });
        } catch (e) {
          // TTS failure is non-fatal — text is already shown in the modal.
          console.warn("[voice] speak failed:", e);
        }
      }
    } finally {
      speechWorkerActive = false;
      isSpeaking.value = false;
    }
  }

  async function press(): Promise<void> {
    if (flowError.value) {
      flowError.value = "";
      return;
    }
    if (voice.isRecording.value) {
      await endTurn();
      return;
    }
    if (isThinking.value || isSpeaking.value || voice.isTranscribing.value) return;
    claudeText.value = "";
    flowError.value = "";
    await voice.start();
  }

  async function cancel(): Promise<void> {
    if (voice.isRecording.value) await voice.cancel();
    flowError.value = "";
  }

  async function endTurn(): Promise<void> {
    // Claim "busy" state immediately so the modal doesn't briefly hit "idle"
    // between transcribing-finished and thinking-started, which would trigger
    // the auto-close watcher.
    isThinking.value = true;
    try {
      const transcript = await voice.stop();
      if (!transcript) {
        isThinking.value = false;
        return;
      }
      const normalized = normalizeVoiceTranscript(transcript);
      await runClaudeAndSpeak(normalized);
    } catch (e) {
      isThinking.value = false;
      throw e;
    }
  }

  async function runClaudeAndSpeak(message: string): Promise<void> {
    isThinking.value = true;
    claudeText.value = "";

    let unlisten: UnlistenFn | null = null;
    try {
      unlisten = await listen<string>("claude:text", (event) => {
        const chunk = (event.payload || "").trim();
        if (!chunk) return;
        claudeText.value = claudeText.value
          ? `${claudeText.value}\n\n${chunk}`
          : chunk;
        speechQueue.push(chunk);
        processSpeechQueue(); // fire-and-forget; serializes internally
      });

      const sessionId = loadSessionId();
      const result = await invoke<ClaudeTurnResult>("claude_turn_streaming", {
        message,
        sessionId,
      });
      if (result.sessionId) saveSessionId(result.sessionId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[voice] claude_turn_streaming failed:", msg);
      flowError.value = `Claude: ${msg.slice(0, 200)}`;
    } finally {
      if (unlisten) unlisten();
      isThinking.value = false;
      // Wait for the speech queue to fully drain before allowing modal to
      // close. Otherwise the user would see "Speaking..." vanish mid-sentence.
      await waitForSpeechToFinish();
    }
  }

  async function waitForSpeechToFinish(): Promise<void> {
    while (speechQueue.length > 0 || speechWorkerActive) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  return {
    press,
    cancel,
    resetSession,
    state,
    errorText,
    userTranscript,
    claudeText,
  };
}
