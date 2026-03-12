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

pub struct BrowserChild(pub Mutex<Option<CommandChild>>);

impl Default for BrowserChild {
    fn default() -> Self {
        Self(Mutex::new(None))
    }
}

fn browser_profile_dir(app: &AppHandle) -> String {
    let data_dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."));
    data_dir
        .join("browser-profile")
        .to_string_lossy()
        .to_string()
}

/// Kills any Chrome/Chromium processes using the given user-data-dir.
/// Necessary because killing the Node sidecar doesn't kill its Chrome child.
fn kill_chrome_for_profile(profile_dir: &str) {
    #[cfg(unix)]
    {
        let _ = std::process::Command::new("sh")
            .args([
                "-c",
                &format!(
                    "ps ax -o pid,args | grep -- '--user-data-dir={}' | grep -v grep | awk '{{print $1}}' | xargs -r kill -9 2>/dev/null",
                    profile_dir
                ),
            ])
            .output();
    }
    #[cfg(windows)]
    {
        let escaped = profile_dir.replace('\\', "\\\\");
        let _ = std::process::Command::new("cmd")
            .args([
                "/C",
                &format!(
                    "wmic process where \"CommandLine like '%--user-data-dir={}%'\" call terminate >nul 2>&1",
                    escaped
                ),
            ])
            .output();
    }
}

fn resource_dir(app: &AppHandle) -> Option<String> {
    app.path()
        .resource_dir()
        .ok()
        .map(|p| p.to_string_lossy().to_string())
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
    headless: Option<bool>,
) -> Result<(), String> {
    if app.try_state::<CrawlChild>().is_none() {
        app.manage(CrawlChild::default());
    }

    let shell = app.shell();
    let profile = browser_profile_dir(&app);

    let mut args = vec![
        "crawl".to_string(),
        url,
        "--max-requests".to_string(),
        max_requests.to_string(),
        "--concurrency".to_string(),
        concurrency.to_string(),
        "--browser-profile".to_string(),
        profile,
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

    if let Some(false) = headless {
        args.push("--headless".to_string());
        args.push("false".to_string());
    }

    let args_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();

    let mut cmd = shell
        .sidecar("fera-crawler")
        .map_err(|e| format!("Failed to create sidecar command: {e}"))?
        .args(&args_refs);

    // Pass resource dir so the sidecar can find bundled Chromium
    if let Some(res_dir) = resource_dir(&app) {
        cmd = cmd.env("FERA_RESOURCES_DIR", res_dir);
    }

    let (mut rx, child) = cmd
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
    // Also kill any Chrome processes using our profile dir
    let profile = browser_profile_dir(&app);
    kill_chrome_for_profile(&profile);
    Ok(())
}

#[tauri::command]
pub async fn open_browser(app: AppHandle, url: String) -> Result<(), String> {
    if app.try_state::<BrowserChild>().is_none() {
        app.manage(BrowserChild::default());
    }

    let shell = app.shell();
    let profile = browser_profile_dir(&app);

    let args = vec![
        "open-browser",
        &url,
        "--browser-profile",
        &profile,
    ];

    let mut cmd = shell
        .sidecar("fera-crawler")
        .map_err(|e| format!("Failed to create sidecar command: {e}"))?
        .args(&args);

    if let Some(res_dir) = resource_dir(&app) {
        cmd = cmd.env("FERA_RESOURCES_DIR", res_dir);
    }

    let (mut rx, child) = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn browser: {e}"))?;

    let state: State<BrowserChild> = app.state();
    *state.0.lock().unwrap() = Some(child);

    let app_handle = app.clone();

    tauri::async_runtime::spawn(async move {
        use tauri_plugin_shell::process::CommandEvent;

        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    let line_str = String::from_utf8_lossy(&line);
                    if let Ok(result) = serde_json::from_str::<serde_json::Value>(&line_str) {
                        // Route profile-data events to their own Tauri event
                        // so the frontend listener picks them up
                        if result.get("event").and_then(|v| v.as_str()) == Some("profile-data") {
                            let _ = app_handle.emit("profile-data", &result);
                        } else {
                            let _ = app_handle.emit("browser-event", result);
                        }
                    }
                }
                CommandEvent::Stderr(line) => {
                    let line_str = String::from_utf8_lossy(&line);
                    eprintln!("[browser stderr] {}", line_str);
                }
                CommandEvent::Terminated(_) => {
                    let _ = app_handle.emit("browser-closed", ());
                    break;
                }
                _ => {}
            }
        }

        if let Some(state) = app_handle.try_state::<BrowserChild>() {
            *state.0.lock().unwrap() = None;
        }
    });

    Ok(())
}

#[tauri::command]
pub async fn close_browser(app: AppHandle) -> Result<(), String> {
    if let Some(state) = app.try_state::<BrowserChild>() {
        if let Some(child) = state.0.lock().unwrap().take() {
            child.kill().map_err(|e| format!("Failed to close browser: {e}"))?;
        }
    }
    let profile = browser_profile_dir(&app);
    kill_chrome_for_profile(&profile);
    Ok(())
}

#[tauri::command]
pub async fn dump_profile(app: AppHandle, url: String) -> Result<(), String> {
    let shell = app.shell();
    let profile = browser_profile_dir(&app);

    let args = vec![
        "dump-profile",
        &url,
        "--browser-profile",
        &profile,
    ];

    let mut cmd = shell
        .sidecar("fera-crawler")
        .map_err(|e| format!("Failed to create sidecar command: {e}"))?
        .args(&args);

    if let Some(res_dir) = resource_dir(&app) {
        cmd = cmd.env("FERA_RESOURCES_DIR", res_dir);
    }

    let (mut rx, _child) = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn profile dump: {e}"))?;

    let app_handle = app.clone();

    tauri::async_runtime::spawn(async move {
        use tauri_plugin_shell::process::CommandEvent;

        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    let line_str = String::from_utf8_lossy(&line);
                    if let Ok(result) = serde_json::from_str::<serde_json::Value>(&line_str) {
                        let _ = app_handle.emit("profile-data", result);
                    }
                }
                CommandEvent::Stderr(line) => {
                    let line_str = String::from_utf8_lossy(&line);
                    eprintln!("[dump-profile stderr] {}", line_str);
                }
                CommandEvent::Terminated(_) => break,
                _ => {}
            }
        }
    });

    Ok(())
}
