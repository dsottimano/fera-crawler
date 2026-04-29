// Voice capture + STT.
//
// Audio is captured on the main thread via Web Audio API (required — mic
// access is main-thread-only). Inference runs in a Web Worker so the UI never
// freezes during transcription. Resampling to 16kHz happens on the main
// thread before the PCM is shipped to the worker.

import { ref } from "vue";
import STTWorker from "../workers/stt.worker?worker";

const TARGET_SAMPLE_RATE = 16000;

// Singleton worker — first instantiation triggers a "load" preload so the
// model is ready (or loading) by the time the user records.
let worker: Worker | null = null;
const isModelLoading = ref(false);
const isModelLoaded = ref(false);
const modelError = ref("");

function getWorker(): Worker {
  if (!worker) {
    worker = new STTWorker();
    isModelLoading.value = true;
    worker.addEventListener("message", (e) => {
      const msg = e.data as { type: string; error?: string };
      if (msg.type === "loaded") {
        isModelLoading.value = false;
        isModelLoaded.value = true;
        modelError.value = "";
      } else if (msg.type === "load_error") {
        isModelLoading.value = false;
        isModelLoaded.value = false;
        modelError.value = msg.error || "model load failed";
      }
    });
    worker.postMessage({ type: "load" });
  }
  return worker;
}

export function preloadVoiceModel(): void {
  getWorker();
}

export function useVoiceInput() {
  const isRecording = ref(false);
  const isTranscribing = ref(false);
  const lastTranscript = ref("");
  const lastError = ref("");

  let audioCtx: AudioContext | null = null;
  let sourceNode: MediaStreamAudioSourceNode | null = null;
  let processorNode: ScriptProcessorNode | null = null;
  let stream: MediaStream | null = null;
  let captureChunks: Float32Array[] = [];
  let captureSampleRate = TARGET_SAMPLE_RATE;
  let cancelled = false;

  async function start(): Promise<void> {
    if (isRecording.value) return;
    lastError.value = "";
    cancelled = false;

    // Spin up worker (no-op if already alive). Model load is async in
    // background — the first transcription will await it.
    getWorker();
    if (modelError.value) {
      lastError.value = `Model load failed: ${modelError.value.slice(0, 200)}`;
      return;
    }

    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioCtx = new AudioContext();
      captureSampleRate = audioCtx.sampleRate;
      sourceNode = audioCtx.createMediaStreamSource(stream);
      processorNode = audioCtx.createScriptProcessor(4096, 1, 1);
      captureChunks = [];

      processorNode.onaudioprocess = (e) => {
        const input = e.inputBuffer.getChannelData(0);
        captureChunks.push(new Float32Array(input));
      };

      sourceNode.connect(processorNode);
      processorNode.connect(audioCtx.destination);
      isRecording.value = true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[voice] capture start failed:", msg);
      lastError.value = `Mic capture failed: ${msg.slice(0, 200)}`;
      await teardownCapture();
    }
  }

  async function teardownCapture(): Promise<void> {
    try { processorNode?.disconnect(); } catch {}
    try { sourceNode?.disconnect(); } catch {}
    stream?.getTracks().forEach((t) => t.stop());
    if (audioCtx && audioCtx.state !== "closed") {
      try { await audioCtx.close(); } catch {}
    }
    processorNode = null;
    sourceNode = null;
    audioCtx = null;
    stream = null;
  }

  async function stop(): Promise<string> {
    if (!isRecording.value) return "";
    isRecording.value = false;

    const totalLength = captureChunks.reduce((sum, c) => sum + c.length, 0);
    const merged = new Float32Array(totalLength);
    let offset = 0;
    for (const c of captureChunks) {
      merged.set(c, offset);
      offset += c.length;
    }
    const sourceRate = captureSampleRate;
    captureChunks = [];

    await teardownCapture();

    if (cancelled || merged.length === 0) {
      lastTranscript.value = "";
      return "";
    }

    isTranscribing.value = true;
    try {
      const audio16k = sourceRate === TARGET_SAMPLE_RATE
        ? merged
        : await resampleTo16k(merged, sourceRate);
      const text = await transcribeViaWorker(audio16k);
      lastTranscript.value = text;
      return text;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[voice] transcription failed:", msg);
      lastError.value = `Transcription failed: ${msg.slice(0, 200)}`;
      return "";
    } finally {
      isTranscribing.value = false;
    }
  }

  // Stop capture and discard — used for Escape during recording.
  async function cancel(): Promise<void> {
    if (!isRecording.value) return;
    cancelled = true;
    await stop();
  }

  async function toggle(): Promise<string> {
    if (isRecording.value) return await stop();
    await start();
    return "";
  }

  return {
    start,
    stop,
    cancel,
    toggle,
    isRecording,
    isTranscribing,
    isModelLoading,
    isModelLoaded,
    lastTranscript,
    lastError,
  };
}

function transcribeViaWorker(audio: Float32Array): Promise<string> {
  const w = getWorker();
  return new Promise((resolve, reject) => {
    const onMessage = (e: MessageEvent) => {
      const msg = e.data as { type: string; text?: string; error?: string };
      if (msg.type === "result") {
        w.removeEventListener("message", onMessage);
        resolve(msg.text || "");
      } else if (msg.type === "error") {
        w.removeEventListener("message", onMessage);
        reject(new Error(msg.error || "transcription error"));
      }
      // Ignore "loaded" / "load_error" — they're handled by the singleton listener.
    };
    w.addEventListener("message", onMessage);
    // Transfer the buffer to avoid copying ~1MB+ of audio across the boundary.
    w.postMessage({ type: "transcribe", audio }, [audio.buffer]);
  });
}

async function resampleTo16k(input: Float32Array, sourceRate: number): Promise<Float32Array> {
  const targetLength = Math.ceil((input.length * TARGET_SAMPLE_RATE) / sourceRate);
  const offline = new OfflineAudioContext(1, targetLength, TARGET_SAMPLE_RATE);
  const buf = offline.createBuffer(1, input.length, sourceRate);
  buf.copyToChannel(input as Float32Array<ArrayBuffer>, 0);
  const source = offline.createBufferSource();
  source.buffer = buf;
  source.connect(offline.destination);
  source.start();
  const rendered = await offline.startRendering();
  return rendered.getChannelData(0);
}
