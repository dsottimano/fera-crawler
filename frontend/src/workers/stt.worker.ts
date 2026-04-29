// STT inference worker. Holds the Whisper model and runs transcription off
// the main thread so the UI never freezes during inference. Audio capture
// stays in the main thread (Web Audio API requires it); only the resampled
// Float32 PCM crosses the wire to this worker.
//
// Protocol:
//   main → worker: { type: "load" }
//   main → worker: { type: "transcribe", audio: Float32Array (16kHz mono) }
//   worker → main: { type: "loaded" }
//   worker → main: { type: "load_error", error: string }
//   worker → main: { type: "result", text: string }
//   worker → main: { type: "error", error: string }

import { pipeline, type AutomaticSpeechRecognitionPipeline } from "@huggingface/transformers";
import { PROMPT_TEXT, applyVocabularyCorrections } from "../utils/voiceVocabulary";

// Whisper-tiny is ~3× faster than -base on CPU. Accuracy hit is small for the
// short voice commands we expect here. fp32 forced because quantized variants
// (q4/q4f16/MatMulNBits) fail to instantiate in WebKitGTK's WASM runtime.
const MODEL_ID = "Xenova/whisper-tiny.en";

let asr: AutomaticSpeechRecognitionPipeline | null = null;
let loadPromise: Promise<AutomaticSpeechRecognitionPipeline> | null = null;
let promptIds: number[] | null = null;

async function ensureLoaded(): Promise<AutomaticSpeechRecognitionPipeline> {
  if (asr) return asr;
  if (!loadPromise) {
    loadPromise = pipeline("automatic-speech-recognition", MODEL_ID, {
      dtype: "fp32",
    }).then((p) => {
      asr = p as AutomaticSpeechRecognitionPipeline;
      return asr;
    });
  }
  return loadPromise;
}

// Tokenize the brand vocabulary once. Whisper consumes prompt_ids as decoder
// context, biasing it toward producing these tokens. Fails soft — if the
// tokenizer surface differs across transformers.js versions, we fall back to
// post-correction only.
async function getPromptIds(a: AutomaticSpeechRecognitionPipeline): Promise<number[] | null> {
  if (promptIds !== null) return promptIds.length ? promptIds : null;
  try {
    const tokenizer = (a as any).tokenizer;
    if (!tokenizer) { promptIds = []; return null; }
    // Whisper convention: leading space, no special tokens.
    const encoded = await tokenizer(" " + PROMPT_TEXT, { add_special_tokens: false });
    const raw = encoded?.input_ids;
    let ids: number[] = [];
    if (Array.isArray(raw)) {
      ids = (Array.isArray(raw[0]) ? raw[0] : raw) as number[];
    } else if (raw?.data) {
      ids = Array.from(raw.data as ArrayLike<number>);
    } else if (raw && typeof raw[Symbol.iterator] === "function") {
      ids = Array.from(raw as Iterable<number>);
    }
    promptIds = ids;
    return ids.length ? ids : null;
  } catch (e) {
    console.warn("[stt] prompt tokenization failed; using post-correction only", e);
    promptIds = [];
    return null;
  }
}

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data as { type: string; audio?: Float32Array };

  if (msg.type === "load") {
    try {
      await ensureLoaded();
      (self as any).postMessage({ type: "loaded" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      (self as any).postMessage({ type: "load_error", error: message });
      // Drop cached promise so a future "load" can retry.
      loadPromise = null;
    }
    return;
  }

  if (msg.type === "transcribe") {
    if (!msg.audio) {
      (self as any).postMessage({ type: "error", error: "no audio provided" });
      return;
    }
    try {
      const a = await ensureLoaded();
      const ids = await getPromptIds(a);
      const opts: Record<string, unknown> = {};
      if (ids) opts.generate_kwargs = { prompt_ids: ids };
      const result = await a(msg.audio, opts);
      const raw = Array.isArray(result) ? (result[0] as any).text : (result as any).text;
      const text = applyVocabularyCorrections(raw || "");
      (self as any).postMessage({ type: "result", text });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      (self as any).postMessage({ type: "error", error: message });
    }
  }
};
