use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::CommandChild;

pub struct CrawlChild {
    pub child: Mutex<Option<CommandChild>>,
    pub generation: AtomicU64,
}

impl Default for CrawlChild {
    fn default() -> Self {
        Self {
            child: Mutex::new(None),
            generation: AtomicU64::new(0),
        }
    }
}

pub struct BrowserChild {
    pub child: Mutex<Option<CommandChild>>,
    pub generation: AtomicU64,
}

impl Default for BrowserChild {
    fn default() -> Self {
        Self {
            child: Mutex::new(None),
            generation: AtomicU64::new(0),
        }
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
        // Use Command with args to avoid shell injection
        let output = std::process::Command::new("ps")
            .args(["ax", "-o", "pid,args"])
            .output();
        if let Ok(output) = output {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let needle = format!("--user-data-dir={}", profile_dir);
            for line in stdout.lines() {
                if !line.contains(&needle) {
                    continue;
                }
                if let Some(pid_str) = line.trim().split_whitespace().next() {
                    if let Ok(pid) = pid_str.parse::<i32>() {
                        if pid > 0 && pid != std::process::id() as i32 {
                            let _ = std::process::Command::new("kill")
                                .args(["-9", &pid.to_string()])
                                .output();
                        }
                    }
                }
            }
        }
    }
    #[cfg(windows)]
    {
        // Use PowerShell (wmic is removed in Windows 11 24H2+)
        let escaped = profile_dir.replace('\'', "''");
        let _ = std::process::Command::new("powershell")
            .args([
                "-NoProfile",
                "-Command",
                &format!(
                    "Get-CimInstance Win32_Process | Where-Object {{ $_.CommandLine -like '*--user-data-dir={}*' }} | ForEach-Object {{ $_.Terminate() }}",
                    escaped
                ),
            ])
            .output();
    }
    // Remove stale singleton locks
    for name in &["SingletonLock", "SingletonCookie", "SingletonSocket"] {
        let lock_path = std::path::Path::new(profile_dir).join(name);
        let _ = std::fs::remove_file(lock_path);
    }
}

fn resource_dir(app: &AppHandle) -> Option<String> {
    app.path()
        .resource_dir()
        .ok()
        .map(|p| p.to_string_lossy().to_string())
}

/// Helper to lock a mutex, recovering from poison.
fn lock_or_recover<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
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
    download_og_image: Option<bool>,
    scraper_rules: Option<String>,
) -> Result<(), String> {
    let state: State<CrawlChild> = app.state();

    // Kill any existing crawl and bump generation so the old task won't emit crawl-complete
    {
        let mut guard = lock_or_recover(&state.child);
        if let Some(old_child) = guard.take() {
            let _ = old_child.kill();
        }
    }
    let gen = state.generation.fetch_add(1, Ordering::SeqCst) + 1;

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
            let tmp = std::env::temp_dir().join(format!("fera-urls-{}-{}.txt", std::process::id(), gen));
            std::fs::write(&tmp, url_list.join("\n")).map_err(|e| format!("Failed to write urls file: {e}"))?;
            args.push("--urls-file".to_string());
            args.push(tmp.to_string_lossy().to_string());
        }
    }

    if let Some(false) = headless {
        args.push("--headless".to_string());
        args.push("false".to_string());
    }

    if let Some(true) = download_og_image {
        args.push("--download-og-image".to_string());
    }

    if let Some(rules) = scraper_rules {
        let tmp = std::env::temp_dir().join(format!("fera-scraper-rules-{}-{}.json", std::process::id(), gen));
        std::fs::write(&tmp, &rules).map_err(|e| format!("Failed to write scraper rules: {e}"))?;
        args.push("--scraper-rules-file".to_string());
        args.push(tmp.to_string_lossy().to_string());
    }

    let urls_tmp = std::env::temp_dir().join(format!("fera-urls-{}-{}.txt", std::process::id(), gen));
    let rules_tmp = std::env::temp_dir().join(format!("fera-scraper-rules-{}-{}.json", std::process::id(), gen));

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

    *lock_or_recover(&state.child) = Some(child);

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
                    break;
                }
                _ => {}
            }
        }

        // Only emit crawl-complete if this crawl wasn't replaced by a newer one
        if let Some(state) = app_handle.try_state::<CrawlChild>() {
            if state.generation.load(Ordering::SeqCst) == gen {
                let _ = app_handle.emit("crawl-complete", ());
                *lock_or_recover(&state.child) = None;
            }
        }

        // Clean up temp files
        let _ = std::fs::remove_file(&urls_tmp);
        let _ = std::fs::remove_file(&rules_tmp);
    });

    Ok(())
}

#[tauri::command]
pub async fn stop_crawl(app: AppHandle) -> Result<(), String> {
    let state: State<CrawlChild> = app.state();
    if let Some(child) = lock_or_recover(&state.child).take() {
        child.kill().map_err(|e| format!("Failed to kill sidecar: {e}"))?;
    }
    // Also kill any Chrome processes using our profile dir
    let profile = browser_profile_dir(&app);
    kill_chrome_for_profile(&profile);
    Ok(())
}

#[tauri::command]
pub async fn open_browser(app: AppHandle, url: String) -> Result<(), String> {
    let state: State<BrowserChild> = app.state();

    // Kill any existing browser and bump generation
    {
        let mut guard = lock_or_recover(&state.child);
        if let Some(old_child) = guard.take() {
            let _ = old_child.kill();
        }
    }
    let gen = state.generation.fetch_add(1, Ordering::SeqCst) + 1;

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

    *lock_or_recover(&state.child) = Some(child);

    let app_handle = app.clone();

    tauri::async_runtime::spawn(async move {
        use tauri_plugin_shell::process::CommandEvent;

        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    let line_str = String::from_utf8_lossy(&line);
                    if let Ok(result) = serde_json::from_str::<serde_json::Value>(&line_str) {
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
                    break;
                }
                _ => {}
            }
        }

        // Only emit browser-closed if this browser wasn't replaced by a newer one
        if let Some(state) = app_handle.try_state::<BrowserChild>() {
            if state.generation.load(Ordering::SeqCst) == gen {
                let _ = app_handle.emit("browser-closed", ());
                *lock_or_recover(&state.child) = None;
            }
        }
    });

    Ok(())
}

#[tauri::command]
pub async fn open_inspector(app: AppHandle, url: String) -> Result<(), String> {
    let state: State<BrowserChild> = app.state();

    {
        let mut guard = lock_or_recover(&state.child);
        if let Some(old_child) = guard.take() {
            let _ = old_child.kill();
        }
    }
    let gen = state.generation.fetch_add(1, Ordering::SeqCst) + 1;

    let shell = app.shell();
    let profile = browser_profile_dir(&app);

    let args = vec!["inspect", &url, "--browser-profile", &profile];

    let mut cmd = shell
        .sidecar("fera-crawler")
        .map_err(|e| format!("Failed to create sidecar command: {e}"))?
        .args(&args);

    if let Some(res_dir) = resource_dir(&app) {
        cmd = cmd.env("FERA_RESOURCES_DIR", res_dir);
    }

    let (mut rx, child) = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn inspector: {e}"))?;

    *lock_or_recover(&state.child) = Some(child);

    let app_handle = app.clone();

    tauri::async_runtime::spawn(async move {
        use tauri_plugin_shell::process::CommandEvent;

        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    let line_str = String::from_utf8_lossy(&line);
                    if let Ok(result) = serde_json::from_str::<serde_json::Value>(&line_str) {
                        if result.get("event").and_then(|v| v.as_str()) == Some("profile-data") {
                            let _ = app_handle.emit("profile-data", &result);
                        } else {
                            let _ = app_handle.emit("browser-event", result);
                        }
                    }
                }
                CommandEvent::Stderr(line) => {
                    let line_str = String::from_utf8_lossy(&line);
                    eprintln!("[inspector stderr] {}", line_str);
                }
                CommandEvent::Terminated(_) => {
                    break;
                }
                _ => {}
            }
        }

        if let Some(state) = app_handle.try_state::<BrowserChild>() {
            if state.generation.load(Ordering::SeqCst) == gen {
                let _ = app_handle.emit("browser-closed", ());
                *lock_or_recover(&state.child) = None;
            }
        }
    });

    Ok(())
}

#[tauri::command]
pub async fn close_browser(app: AppHandle) -> Result<(), String> {
    let state: State<BrowserChild> = app.state();
    if let Some(child) = lock_or_recover(&state.child).take() {
        child.kill().map_err(|e| format!("Failed to close browser: {e}"))?;
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

    let (mut rx, child) = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn profile dump: {e}"))?;

    let app_handle = app.clone();

    // Move `child` into the async task so it lives until output is fully read
    tauri::async_runtime::spawn(async move {
        use tauri_plugin_shell::process::CommandEvent;

        let _child = child; // prevent drop until task completes

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
