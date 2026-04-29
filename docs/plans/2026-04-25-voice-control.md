# Voice Control for Fera — Current State + Open Decisions

**Status:** Tabled 2026-04-25 for further thought. Working end-to-end but with real latency limits.
**Owner:** Dave
**Trigger to revisit:** When latency is acceptable for the demo profile, or when an architectural decision below is made.

---

## What works today

Press `/` (anywhere except inside a text input) → modal opens → speak → press `/` again → modal stays up through the whole turn → Claude responds with text + Piper speaks it.

Full pipeline:

```
User holds /          ──▶ MediaRecorder + AudioContext capture (Float32 PCM)
                                ↓
                         Resample to 16kHz mono (main thread)
                                ↓
                         Web Worker: Whisper-tiny.en (fp32 ONNX/WASM)
                                ↓
                         Vocabulary post-correction ("Farah" → "Fera")
                                ↓
                         URL normalization ("dot com" → ".com")
                                ↓
                         Tauri claude_turn_streaming Rust command
                                ↓
                         claude -p --output-format stream-json \
                                  --append-system-prompt <voice persona> \
                                  --resume <session_id> \
                                  --dangerously-skip-permissions
                                ↓
                         Parse JSONL events line-by-line
                                ↓
                         Each "assistant" text block emits "claude:text" event
                                ↓
                         Frontend appends to FERA bubble + queues for Piper
                                ↓
                         Piper TTS (en_GB-southern_english_female-low, fp32)
                                ↓
                         paplay/aplay/afplay/PowerShell SoundPlayer
```

### Files

| File | Purpose |
|------|---------|
| `frontend/src/composables/useVoiceInput.ts` | Audio capture, resample, send to STT worker |
| `frontend/src/workers/stt.worker.ts` | Whisper-tiny.en inference + prompt biasing + post-correction |
| `frontend/src/utils/voiceVocabulary.ts` | Brand corrections + URL/path normalization |
| `frontend/src/composables/useVoiceFlow.ts` | Orchestrates capture → claude → speak. Owns state machine + speech queue. |
| `frontend/src/components/VoiceRecorderModal.vue` | Centered modal with YOU/FERA bubbles, pulse rings, kbd hints |
| `frontend/src/App.vue` | `/` keybinding + modal mount + preload |
| `src-tauri/src/voice_commands.rs` | `claude_turn_streaming` + `speak` Tauri commands |
| `src-tauri/src/lib.rs` | `enable_webview_media_linux` (WebKitGTK mic permissions) + command registration |

### Required env vars (dev only)

```bash
export FERA_PIPER_BIN=$HOME/.local/bin/piper
export FERA_PIPER_VOICE=$HOME/.local/share/piper-voices/en_GB-southern_english_female-low.onnx
export FERA_PIPER_LENGTH_SCALE=1.15      # optional, slows playback ~15%
```

Without these, `speak` returns a clear error and the modal still shows the response text.

---

## Why we tabled it: the latency reality

| Phase | Floor | Realistic |
|-------|-------|-----------|
| Whisper STT | 1s | 1–2s |
| `claude` CLI cold start | 2s | 3–5s |
| Claude API first response | 1s | 2–4s |
| MCP tool call (`crawl_site` probe matrix) | 0s | **20–40s** |
| TTS first audio chunk | 1s | 2–3s |

**Floor for "crawl this URL" with auto-probe: ~30s before audio.** Streaming mitigates *perceived* latency (Claude can speak "Starting the crawl…" within ~5s while tools run), but the wall-clock turn time is unchanged.

For commands without tool calls (status queries, summaries), turns are 8–12s. Acceptable.
For commands that trigger heavy MCP work, 30–45s. Not acceptable for Tony Stark feel.

---

## Architectural decisions parked

### Decision 1: How to address tool latency

Three paths, mutually compatible:

1. **System prompt steering** *(implemented)* — voice persona tells Claude to prefer `crawl_url` over `crawl_site` for single URLs (no probe). Helps where applicable, doesn't fix `crawl_site`.
2. **Fire-and-forget MCP tools** *(not implemented)* — `crawl_site` returns immediately ("started, probing in background"), Tauri autonomously announces results when probe completes via subprocess pattern. ~half-day of work. Highest ROI for "voice-driven full crawl" use case.
3. **Hybrid local command parser** *(not implemented)* — regex-parse common commands locally (e.g. "crawl X"), call MCP bridge directly, skip Claude. ~3s response time. Loses conversational feel for those commands. Bigger refactor; needs explicit decision about voice persona.

### Decision 2: Persistent Claude session vs ephemeral

Investigated, **rejected**. Persistent session would save ~3–5s cold start per turn but:
- Doesn't save tokens (API call structure is identical per turn either way)
- Claude Code CLI doesn't cleanly support stdin-pipe of multiple turns (intended pattern is `--resume` per call)
- Implementation cost: ~1 day + ongoing fragility (process recovery, stdin framing)

Pursue **prompt-cache pre-warm** at app start instead (~30 LOC, ~80% of the benefit). Not yet implemented.

### Decision 3: Distribution path for Piper

Currently dev-only via env vars. For shipping:
- Bundle standalone Piper C++ binaries (per platform, ~30MB each) via Tauri `externalBin`
- Bundle voice model (~60MB) via `resources`
- Rust resolves bundled paths if env vars not set

Documented in earlier conversation. ~half-day of work, queued behind tabling decision.

### Decision 4: STT model choice

Locked on **Whisper-tiny.en fp32** for now. Notes:
- Moonshine Tiny tried first — accuracy too low past ~3s utterances (tuned for very short commands)
- Whisper-base.en tried — better accuracy but ~2× latency
- fp32 forced because q4/q4f16 variants fail to instantiate in WebKitGTK's WASM ONNX runtime
- ~150MB model download on first use, cached forever

Reasonable to revisit later. Not blocking.

---

## Known gotchas (so future-you doesn't rediscover)

1. **Tauri WebKitGTK denies mic by default.** `enable_webview_media_linux` in `lib.rs` flips three settings + auto-grants permission requests. Without it, `getUserMedia` throws `NotAllowedError`.
2. **MediaRecorder is unsupported in many WebKitGTK builds.** We use raw `AudioContext` + `ScriptProcessorNode` instead. Captures Float32 PCM directly — no WebM round-trip.
3. **Quantized Whisper variants fail to instantiate** in WebKitGTK's WASM ONNX runtime (`MatMulNBits` missing scale metadata). Force `dtype: "fp32"` explicitly. Same applies to Moonshine if revisited.
4. **`claude -p` refuses MCP tool calls without `--dangerously-skip-permissions`.** Headless permission prompt has nowhere to go. Voice mode trust matches user's interactive `--dangerously-skip-permissions` setup.
5. **Session continuity requires consistent `cwd`.** Claude Code keys sessions by absolute working directory. We spawn from `$HOME` for stability. localStorage holds `session_id` so turns chain across app restarts.
6. **`--output-format stream-json` is message-level, not token-level.** Each assistant text block arrives complete, not as deltas. We get streaming benefit *between* assistant turns (e.g., "Starting…" then later "Done"), not within one.
7. **Modal close timing.** `state` briefly resolves to `idle` between `transcribing` ending and `thinking` starting, which would trigger auto-close. Fix: claim `isThinking=true` *before* awaiting `voice.stop()` so there's no gap. Already implemented — keep this in mind if state-machine is refactored.
8. **`getActiveSession()` in MCP must handle missing tables gracefully.** Throws `no such table: crawl_sessions` on fresh installs. Already wrapped in try/catch + `sqlite_master` existence check. Don't remove that defensive layer.
9. **WebKitGTK GStreamer warnings on stderr** (`automatic-eos`, `gst_stream_*`) are harmless cosmetic noise. Always print when audio pipeline init runs. Not actionable.
10. **Whisper transcribes URLs phonetically.** "example dot com" — `normalizeVoiceTranscript` rewrites these before sending to Claude. New TLDs go in the `TLDS` array.

---

## What to think about

The decision Dave is taking time on:

> Is voice the right interface for Fera, given the current latency floor?

Sub-questions:

- For which user actions is voice actually faster than clicking? (Mostly: querying state, stopping/starting, simple summaries. Not: configuring a complex crawl.)
- Is the demo audience patient with 30s turns, or is this a non-starter?
- Would a hybrid (voice for queries, GUI for config) be more honest than full voice?
- Does the "Tony Stark feel" *require* sub-3s turns, or is "responsive but considered" acceptable?
- Is the right path to invest in fire-and-forget MCP tools (real architecture work) or to scope voice down to fast-path commands only?

When you decide, the implementation paths above are well-understood — most are clearly described elsewhere in this doc.

---

## What to revert / clean up if abandoned

If voice gets cut entirely, the surface to remove is small and well-isolated:

| Remove |
|--------|
| `frontend/src/composables/useVoiceInput.ts`, `useVoiceFlow.ts` |
| `frontend/src/workers/stt.worker.ts` |
| `frontend/src/utils/voiceVocabulary.ts` |
| `frontend/src/components/VoiceRecorderModal.vue` |
| `src-tauri/src/voice_commands.rs` |
| `@huggingface/transformers` dep in `frontend/package.json` |
| `tokio` features `process` + `time` in `src-tauri/Cargo.toml` (if not used elsewhere) |
| `webkit2gtk` Linux dep in `src-tauri/Cargo.toml` |
| `enable_webview_media_linux` setup hook in `lib.rs` (only needed for mic) |
| `/` keybinding + voice imports + modal mount in `App.vue` |
| Voice command registrations in `lib.rs` invoke handler |

The `fera-bridge` WebSocket (Tauri ↔ MCP routing) is **not** voice-specific — keep it. It's the foundation for any future Claude-Code-driven UI control.

---

## Don't lose

- The **fera-bridge** architecture (WS at port 1422 routing MCP → Tauri events → Vue handlers via `fera:start-crawl` / `fera:stop-crawl`) is independently valuable. It makes any external Claude Code session capable of driving the UI through `crawl_url` / `crawl_site` MCP tools. Keep this whether or not voice continues.
- The **mcp-server backlog item** (bundle into installer + auto-register with Claude Code) is unaffected by the voice decision.
