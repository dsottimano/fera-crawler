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
    user_agent: Option<String>,
    respect_robots: Option<bool>,
    delay: Option<u32>,
    custom_headers: Option<String>,
    mode: Option<String>,
    urls: Option<Vec<String>>,
) -> Result<(), String> {
    if app.try_state::<CrawlChild>().is_none() {
        app.manage(CrawlChild::default());
    }

    let shell = app.shell();

    let mut args = vec![
        "crawl".to_string(),
        url,
        "--max-requests".to_string(),
        max_requests.to_string(),
        "--concurrency".to_string(),
        concurrency.to_string(),
    ];

    if let Some(ua) = user_agent {
        args.push("--user-agent".to_string());
        args.push(ua);
    }

    if let Some(false) = respect_robots {
        args.push("--respect-robots".to_string());
        args.push("false".to_string());
    }

    if let Some(d) = delay {
        if d > 0 {
            args.push("--delay".to_string());
            args.push(d.to_string());
        }
    }

    if let Some(headers) = custom_headers {
        args.push("--custom-headers".to_string());
        args.push(headers);
    }

    if let Some(m) = mode {
        args.push("--mode".to_string());
        args.push(m);
    }

    if let Some(url_list) = urls {
        if !url_list.is_empty() {
            args.push("--urls".to_string());
            args.push(url_list.join(","));
        }
    }

    let args_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();

    let (mut rx, child) = shell
        .sidecar("fera-crawler")
        .map_err(|e| format!("Failed to create sidecar command: {e}"))?
        .args(&args_refs)
        .spawn()
        .map_err(|e| format!("Failed to spawn sidecar: {e}"))?;

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
