use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::CommandChild;

pub struct CrawlChild(pub Mutex<Option<CommandChild>>);

impl Default for CrawlChild {
    fn default() -> Self {
        Self(Mutex::new(None))
    }
}

#[tauri::command]
pub async fn start_crawl(
    app: AppHandle,
    url: String,
    max_requests: u32,
    concurrency: u32,
) -> Result<(), String> {
    // Manage state on first call
    if app.try_state::<CrawlChild>().is_none() {
        app.manage(CrawlChild::default());
    }

    let shell = app.shell();

    let (mut rx, child) = shell
        .sidecar("fera-crawler")
        .map_err(|e| format!("Failed to create sidecar command: {e}"))?
        .args([
            "crawl",
            &url,
            "--max-requests",
            &max_requests.to_string(),
            "--concurrency",
            &concurrency.to_string(),
        ])
        .spawn()
        .map_err(|e| format!("Failed to spawn sidecar: {e}"))?;

    // Store child for stop_crawl
    let state: State<CrawlChild> = app.state();
    *state.0.lock().unwrap() = Some(child);

    let app_handle = app.clone();

    tauri::async_runtime::spawn(async move {
        use tauri_plugin_shell::process::CommandEvent;

        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    let line_str = String::from_utf8_lossy(&line);
                    if let Ok(result) = serde_json::from_str::<serde_json::Value>(&line_str) {
                        let _ = app_handle.emit("crawl-result", result);
                    }
                }
                CommandEvent::Stderr(line) => {
                    let line_str = String::from_utf8_lossy(&line);
                    eprintln!("[sidecar stderr] {}", line_str);
                }
                CommandEvent::Terminated(_) => {
                    let _ = app_handle.emit("crawl-complete", ());
                    break;
                }
                _ => {}
            }
        }

        // Clear child reference
        if let Some(state) = app_handle.try_state::<CrawlChild>() {
            *state.0.lock().unwrap() = None;
        }
    });

    Ok(())
}

#[tauri::command]
pub async fn stop_crawl(app: AppHandle) -> Result<(), String> {
    if let Some(state) = app.try_state::<CrawlChild>() {
        if let Some(child) = state.0.lock().unwrap().take() {
            child.kill().map_err(|e| format!("Failed to kill sidecar: {e}"))?;
        }
    }
    Ok(())
}
