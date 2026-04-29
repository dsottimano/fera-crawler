// Voice flow Tauri commands.
//
// claude_turn_streaming(): spawn `claude -p` with --output-format stream-json
//   and parse events line-by-line. As assistant text blocks arrive, emit them
//   to the webview as "claude:text" events so the frontend can speak them
//   incrementally (huge perceived-latency win — first words speak within ~3s
//   even when the full turn takes 30s+ because of tool calls).
//
// speak(): pipe text through Piper TTS, play via the OS audio command.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::time::{timeout, Duration};

// --- claude_turn_streaming ---

#[derive(Serialize)]
pub struct ClaudeTurnResult {
    #[serde(rename = "sessionId")]
    pub session_id: String,
}

#[derive(Deserialize)]
struct StreamEvent {
    #[serde(rename = "type")]
    event_type: String,
    subtype: Option<String>,
    session_id: Option<String>,
    message: Option<StreamMessage>,
    is_error: Option<bool>,
    result: Option<String>,
}

#[derive(Deserialize)]
struct StreamMessage {
    content: Option<Vec<StreamContent>>,
}

#[derive(Deserialize)]
struct StreamContent {
    #[serde(rename = "type")]
    block_type: String,
    text: Option<String>,
}

const CLAUDE_TIMEOUT_SECS: u64 = 180;

const VOICE_SYSTEM_PROMPT: &str = "\
You are Fera, an SEO crawler operated by voice. The user is speaking to you, \
not typing. Reply in 1–2 short sentences max. You can answer questions and \
explain things briefly. Never investigate, debug, propose fixes, ask \
follow-up questions, or list options unless the user explicitly asks. No \
markdown, no code blocks, no bullet lists — this will be spoken aloud.";

#[tauri::command]
pub async fn claude_turn_streaming(
    app: AppHandle,
    message: String,
    session_id: Option<String>,
) -> Result<ClaudeTurnResult, String> {
    let mut cmd = Command::new("claude");
    cmd.arg("-p").arg(&message);
    cmd.arg("--output-format").arg("stream-json");
    cmd.arg("--verbose"); // required by claude when stream-json is used
    cmd.arg("--dangerously-skip-permissions");
    // Voice mode: terse, action-first. Without this, Claude defaults to its
    // keyboard persona and explains, investigates, and offers follow-ups —
    // burning seconds and turning a 5-word answer into a paragraph.
    cmd.arg("--append-system-prompt").arg(VOICE_SYSTEM_PROMPT);
    if let Some(id) = session_id.as_ref().filter(|s| !s.is_empty()) {
        cmd.arg("--resume").arg(id);
    }
    if let Some(home) = dirs_home() {
        cmd.current_dir(home);
    }
    cmd.stdin(std::process::Stdio::null());
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("spawn claude failed: {}", e))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "no stdout from claude".to_string())?;
    let mut lines = BufReader::new(stdout).lines();

    let mut final_session_id = session_id.unwrap_or_default();
    let mut error_message: Option<String> = None;

    let parse_loop = async {
        while let Some(line) = lines
            .next_line()
            .await
            .map_err(|e| format!("read claude stdout: {}", e))?
        {
            if line.trim().is_empty() {
                continue;
            }
            let event: StreamEvent = match serde_json::from_str(&line) {
                Ok(e) => e,
                Err(_) => continue, // ignore malformed lines (rare)
            };

            match event.event_type.as_str() {
                "system" => {
                    if event.subtype.as_deref() == Some("init") {
                        if let Some(sid) = event.session_id.clone() {
                            final_session_id = sid;
                        }
                    }
                }
                "assistant" => {
                    if let Some(message) = event.message {
                        if let Some(blocks) = message.content {
                            for block in blocks {
                                if block.block_type == "text" {
                                    if let Some(text) = block.text {
                                        let trimmed = text.trim();
                                        if !trimmed.is_empty() {
                                            // Best-effort emit. If it fails, the turn still
                                            // completes — the user just won't hear that block.
                                            let _ = app.emit("claude:text", trimmed);
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                "result" => {
                    if let Some(sid) = event.session_id.clone() {
                        final_session_id = sid;
                    }
                    if event.is_error.unwrap_or(false) {
                        error_message = Some(event.result.unwrap_or_default());
                    }
                }
                _ => {}
            }
        }
        Ok::<(), String>(())
    };

    timeout(Duration::from_secs(CLAUDE_TIMEOUT_SECS), parse_loop)
        .await
        .map_err(|_| format!("claude timed out after {}s", CLAUDE_TIMEOUT_SECS))??;

    let status = child
        .wait()
        .await
        .map_err(|e| format!("claude wait failed: {}", e))?;
    if !status.success() {
        let mut stderr = String::new();
        if let Some(mut err_pipe) = child.stderr.take() {
            use tokio::io::AsyncReadExt;
            let _ = err_pipe.read_to_string(&mut stderr).await;
        }
        return Err(format!(
            "claude exited {}: {}",
            status,
            stderr.chars().take(500).collect::<String>()
        ));
    }

    if let Some(msg) = error_message {
        return Err(format!("claude reported error: {}", msg));
    }

    Ok(ClaudeTurnResult {
        session_id: final_session_id,
    })
}

fn dirs_home() -> Option<PathBuf> {
    #[cfg(unix)]
    {
        std::env::var_os("HOME").map(PathBuf::from)
    }
    #[cfg(windows)]
    {
        std::env::var_os("USERPROFILE").map(PathBuf::from)
    }
}

// --- speak (Piper TTS) ---
//
// Strict Piper-only. If the voice env var isn't set or the binary fails, the
// frontend gets a clear error and the user reads the response in the modal.

#[tauri::command]
pub async fn speak(text: String) -> Result<(), String> {
    if text.trim().is_empty() {
        return Ok(());
    }

    let voice = std::env::var("FERA_PIPER_VOICE").map_err(|_| {
        "FERA_PIPER_VOICE env var not set — point it at a piper voice .onnx file".to_string()
    })?;
    let voice_path = PathBuf::from(&voice);
    if !voice_path.exists() {
        return Err(format!("piper voice not found at {}", voice));
    }

    speak_piper(&text, &voice_path).await
}

async fn speak_piper(text: &str, voice_path: &PathBuf) -> Result<(), String> {
    let wav_path = std::env::temp_dir().join(format!(
        "fera_speak_{}_{}.wav",
        std::process::id(),
        chrono_micros()
    ));

    let piper_bin = std::env::var("FERA_PIPER_BIN").unwrap_or_else(|_| "piper".to_string());

    let length_scale: f32 = std::env::var("FERA_PIPER_LENGTH_SCALE")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(1.0_f32)
        .clamp(0.5, 2.0);

    let mut child = Command::new(&piper_bin)
        .arg("--model")
        .arg(voice_path)
        .arg("--output_file")
        .arg(&wav_path)
        .arg("--length_scale")
        .arg(format!("{:.2}", length_scale))
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| {
            format!(
                "piper not on PATH or failed to spawn: {} (install piper-tts)",
                e
            )
        })?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(text.as_bytes())
            .await
            .map_err(|e| format!("piper stdin write failed: {}", e))?;
        drop(stdin);
    }

    let output = timeout(Duration::from_secs(30), child.wait_with_output())
        .await
        .map_err(|_| "piper timed out after 30s".to_string())?
        .map_err(|e| format!("piper wait failed: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "piper exited {}: {}",
            output.status,
            stderr.chars().take(500).collect::<String>()
        ));
    }

    play_wav(&wav_path).await?;
    let _ = std::fs::remove_file(&wav_path);
    Ok(())
}

fn chrono_micros() -> u128 {
    use std::time::SystemTime;
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_micros())
        .unwrap_or(0)
}

#[cfg(target_os = "linux")]
async fn play_wav(path: &std::path::Path) -> Result<(), String> {
    let paplay = Command::new("paplay")
        .arg(path)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .await;
    if let Ok(s) = paplay {
        if s.success() {
            return Ok(());
        }
    }
    Command::new("aplay")
        .arg(path)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .await
        .map_err(|e| format!("no audio player worked (tried paplay, aplay): {}", e))?;
    Ok(())
}

#[cfg(target_os = "macos")]
async fn play_wav(path: &std::path::Path) -> Result<(), String> {
    let status = Command::new("afplay")
        .arg(path)
        .status()
        .await
        .map_err(|e| format!("afplay failed: {}", e))?;
    if !status.success() {
        return Err(format!("afplay exited {}", status));
    }
    Ok(())
}

#[cfg(target_os = "windows")]
async fn play_wav(path: &std::path::Path) -> Result<(), String> {
    let path_str = path.display().to_string().replace('\'', "''");
    let script = format!(
        "(New-Object System.Media.SoundPlayer '{}').PlaySync()",
        path_str
    );
    let status = Command::new("powershell")
        .args(["-NoProfile", "-Command", &script])
        .status()
        .await
        .map_err(|e| format!("powershell SoundPlayer failed: {}", e))?;
    if !status.success() {
        return Err(format!("powershell SoundPlayer exited {}", status));
    }
    Ok(())
}
