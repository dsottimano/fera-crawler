use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicI64, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::CommandChild;

use crate::db_writer::DbWriter;

// Bounded so latestStatuses can drive a small rolling sparkline / status
// pie without unbounded growth. 200 covers ~3 minutes of a 1 RPS crawl
// or ~10 seconds of a 20 RPS crawl — long enough to feel "live", short
// enough that the snapshot fits in one IPC payload trivially.
const PROGRESS_HISTORY: usize = 200;

pub struct CrawlChild {
    pub child: Mutex<Option<CommandChild>>,
    pub generation: AtomicU64,
    /// PID of the currently-running sidecar, or 0 if none. Set when spawn succeeds;
    /// cleared on Terminated. Exposed via debug_snapshot so the UI can monitor /proc.
    pub pid: AtomicI32,
    /// DB session id the active sidecar is writing rows for. 0 = no active
    /// crawl. Used by the stdout router to attribute crawl-result rows to
    /// the right session when handing them to the DbWriter.
    pub session_id: AtomicI64,
    /// Rolling counters for the live `crawl-progress` aggregate event
    /// (phase 3). Replaced fresh each start_crawl; the per-row stdout
    /// handler updates it, and a 500ms emitter task reads it.
    pub progress: Mutex<Option<Arc<Mutex<ProgressState>>>>,
}

impl Default for CrawlChild {
    fn default() -> Self {
        Self {
            child: Mutex::new(None),
            generation: AtomicU64::new(0),
            pid: AtomicI32::new(0),
            session_id: AtomicI64::new(0),
            progress: Mutex::new(None),
        }
    }
}

/// Snapshot of crawl-result counters maintained for the live aggregate
/// event. `dirty` is set on every update and cleared by the emitter so
/// the 500ms tick is a no-op when nothing changed (saves an IPC call when
/// the crawl is stalled in a delay window).
#[derive(Default)]
pub struct ProgressState {
    pub row_count: u64,
    pub error_count: u64,
    pub last_url: String,
    pub latest_statuses: VecDeque<i64>,
    pub dirty: bool,
}

impl ProgressState {
    fn record(&mut self, val: &serde_json::Value) {
        self.row_count += 1;
        if let Some(s) = val.get("error").and_then(|x| x.as_str()) {
            if !s.is_empty() {
                self.error_count += 1;
            }
        }
        if let Some(url) = val.get("url").and_then(|x| x.as_str()) {
            self.last_url = url.to_string();
        }
        if let Some(status) = val.get("status").and_then(|x| x.as_i64()) {
            self.latest_statuses.push_back(status);
            while self.latest_statuses.len() > PROGRESS_HISTORY {
                self.latest_statuses.pop_front();
            }
        }
        self.dirty = true;
    }
}

/// Snapshot of the per-spawn context that travels with stdout lines from a
/// running crawl. Carries both the generation (for stale-line filtering) and
/// the DB session id (so crawl-result rows can be enqueued to the writer
/// without re-querying state). None for non-crawl spawns (probe-matrix).
#[derive(Copy, Clone)]
struct CrawlCtx {
    gen: u64,
    session_id: i64,
}

/// Single-flight lock for the probe matrix. The probe is the only probe
/// path now, and concurrent matrices were causing havoc — two sidecars
/// fighting over the shared browser-profile dir, headed-row Chromium
/// windows from a second probe popping up while a first one was on-screen,
/// and probe-result events from both runs interleaving into the same UI
/// list. AtomicBool flipped via compare_exchange is enough — there's
/// no useful queue at the Rust layer; the frontend keeps its own
/// pending-host queue and drains it after each probe completes.
pub struct ProbeState {
    pub running: AtomicBool,
}

impl Default for ProbeState {
    fn default() -> Self {
        Self {
            running: AtomicBool::new(false),
        }
    }
}

/// App-start time in epoch seconds — exposed via debug_snapshot for uptime.
pub struct AppStart(pub u64);

impl Default for AppStart {
    fn default() -> Self {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        Self(now)
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

/// `<app_data>/og-images/<session_id>` — the per-session bucket the sidecar
/// writes to when og:image download is enabled. Lives next to browser-profile.
fn og_images_dir_for_session(app: &AppHandle, session_id: i64) -> std::path::PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."))
        .join("og-images")
        .join(session_id.to_string())
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
        // Pass the profile dir as a PowerShell pipeline input rather than string-interpolating
        // it into the script — avoids injection via backticks, $(), or quotes in the path.
        let script = "$p = [Console]::In.ReadLine(); \
            Get-CimInstance Win32_Process | \
            Where-Object { $_.CommandLine -like ('*--user-data-dir=' + $p + '*') } | \
            ForEach-Object { $_.Terminate() }";
        if let Ok(mut child) = std::process::Command::new("powershell")
            .args(["-NoProfile", "-Command", script])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
        {
            if let Some(mut stdin) = child.stdin.take() {
                use std::io::Write;
                let _ = writeln!(stdin, "{}", profile_dir);
            }
            let _ = child.wait();
        }
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
    session_id: i64,
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
    capture_vitals: Option<bool>,
    stealth_config: Option<String>,
    per_host_delay: Option<u32>,
    per_host_delay_max: Option<u32>,
    per_host_concurrency: Option<u32>,
    session_warmup: Option<bool>,
    exclude_urls: Option<Vec<String>>,
    debug_log: Option<bool>,
) -> Result<(), String> {
    let state: State<CrawlChild> = app.state();

    // Kill any existing crawl and bump generation in the same critical section
    // so the old task can never observe the pre-bumped value after being killed.
    // Bump happens BEFORE the kill so any late stdout from the dying child sees
    // the advanced generation and gets filtered by route_sidecar_stdout.
    let gen = {
        let mut guard = lock_or_recover(&state.child);
        let new_gen = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
        if let Some(old_child) = guard.take() {
            let _ = old_child.kill();
        }
        new_gen
    };

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
        "--session-id".to_string(),
        session_id.to_string(),
    ];

    if let Some(ua) = user_agent {
        args.push("--user-agent".to_string());
        args.push(ua);
    }

    // Sidecar treats `--respect-robots` as a presence flag (on when present).
    if let Some(true) = respect_robots {
        args.push("--respect-robots".to_string());
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

    // Track only temp files we actually wrote, so cleanup doesn't attempt unused paths
    // and so we can roll them back if spawn fails.
    let mut temp_files: Vec<std::path::PathBuf> = Vec::new();

    if let Some(url_list) = urls {
        if !url_list.is_empty() {
            let tmp = std::env::temp_dir().join(format!("fera-urls-{}-{}.txt", std::process::id(), gen));
            std::fs::write(&tmp, url_list.join("\n")).map_err(|e| format!("Failed to write urls file: {e}"))?;
            args.push("--urls-file".to_string());
            args.push(tmp.to_string_lossy().to_string());
            temp_files.push(tmp);
        }
    }

    if let Some(false) = headless {
        args.push("--headless".to_string());
        args.push("false".to_string());
    }

    if let Some(true) = download_og_image {
        args.push("--download-og-image".to_string());
    }

    if let Some(true) = capture_vitals {
        args.push("--capture-vitals".to_string());
    }

    if let Some(rules) = scraper_rules {
        let tmp = std::env::temp_dir().join(format!("fera-scraper-rules-{}-{}.json", std::process::id(), gen));
        std::fs::write(&tmp, &rules).map_err(|e| format!("Failed to write scraper rules: {e}"))?;
        args.push("--scraper-rules-file".to_string());
        args.push(tmp.to_string_lossy().to_string());
        temp_files.push(tmp);
    }

    // Small JSON blob — pass inline rather than via temp file. Sidecar
    // rejects invalid JSON with a clear error so we don't need to validate.
    if let Some(sc) = stealth_config {
        if !sc.is_empty() && sc != "{}" {
            args.push("--stealth-config".to_string());
            args.push(sc);
        }
    }

    if let Some(d) = per_host_delay {
        args.push("--per-host-delay".to_string());
        args.push(d.to_string());
    }

    if let Some(d) = per_host_delay_max {
        args.push("--per-host-delay-max".to_string());
        args.push(d.to_string());
    }

    if let Some(c) = per_host_concurrency {
        args.push("--per-host-concurrency".to_string());
        args.push(c.to_string());
    }

    if let Some(true) = session_warmup {
        args.push("--session-warmup".to_string());
    }

    if let Some(true) = debug_log {
        args.push("--debug-log".to_string());
    }

    if let Some(ex) = exclude_urls {
        if !ex.is_empty() {
            let tmp = std::env::temp_dir().join(format!("fera-exclude-{}-{}.txt", std::process::id(), gen));
            std::fs::write(&tmp, ex.join("\n")).map_err(|e| format!("Failed to write exclude file: {e}"))?;
            args.push("--exclude-urls-file".to_string());
            args.push(tmp.to_string_lossy().to_string());
            temp_files.push(tmp);
        }
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

    let (mut rx, child) = match cmd.spawn() {
        Ok(v) => v,
        Err(e) => {
            // Spawn failed — clean up any temp files we wrote.
            for t in &temp_files {
                let _ = std::fs::remove_file(t);
            }
            return Err(format!("Failed to spawn sidecar: {e}"));
        }
    };

    let sidecar_pid = child.pid() as i32;
    state.pid.store(sidecar_pid, Ordering::SeqCst);
    state.session_id.store(session_id, Ordering::SeqCst);
    let progress = Arc::new(Mutex::new(ProgressState::default()));
    // Seed the live counters from existing rows for resume — without
    // this, the first crawl-progress tick overwrites the loaded count
    // (e.g. 14,691) with rows-from-this-spawn-only (10), making PAGES
    // CRAWLED look like the resume threw away prior work. dirty=true so
    // the seeded value emits on the first 500ms tick instead of waiting
    // for the first new row.
    if session_id != 0 {
        if let Some(read_pool) = app.try_state::<crate::db_query::DbReadPool>() {
            if let Ok(pool) = read_pool.pool().await {
                if let Ok(snap) = crate::db_query::aggregate_health_inner(pool, session_id).await {
                    let mut g = lock_or_recover(&progress);
                    g.row_count = snap.total.max(0) as u64;
                    let failures =
                        snap.errors + snap.status_4xx + snap.status_5xx + snap.status_other;
                    g.error_count = failures.max(0) as u64;
                    g.dirty = true;
                }
            }
        }
    }
    *lock_or_recover(&state.progress) = Some(progress.clone());
    *lock_or_recover(&state.child) = Some(child);

    // Tell the UI a fresh crawl is starting so banners from prior runs clear.
    let _ = app.emit("crawl-started", gen);

    // Announce spawn to the debug channel so the UI has immediate signal.
    let _ = app.emit(
        "sidecar-log",
        serde_json::json!({
            "ts": now_ms(),
            "level": "info",
            "msg": "sidecar spawned",
            "meta": { "pid": sidecar_pid, "gen": gen, "args": args }
        }),
    );

    let app_handle = app.clone();
    let ctx = CrawlCtx { gen, session_id };

    // Aggregate progress emitter — debounced 500ms snapshots. Lives on its
    // own task so emission cadence is independent of stdout pace; exits as
    // soon as the active generation changes (start_crawl bumped, stop, or
    // crawl-complete cleared the state).
    let app_for_emitter = app.clone();
    let progress_for_emitter = progress.clone();
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_millis(500));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            if let Some(s) = app_for_emitter.try_state::<CrawlChild>() {
                if s.generation.load(Ordering::SeqCst) != gen {
                    return;
                }
            } else {
                return;
            }
            let snapshot = {
                let mut g = lock_or_recover(&progress_for_emitter);
                if !g.dirty {
                    continue;
                }
                g.dirty = false;
                serde_json::json!({
                    "rowCount": g.row_count,
                    "errorCount": g.error_count,
                    "lastUrl": g.last_url,
                    "latestStatuses": g.latest_statuses.iter().copied().collect::<Vec<_>>(),
                })
            };
            let _ = app_for_emitter.emit("crawl-progress", snapshot);
        }
    });

    tauri::async_runtime::spawn(async move {
        use tauri_plugin_shell::process::CommandEvent;

        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    let line_str = String::from_utf8_lossy(&line);
                    route_sidecar_stdout_lines(&app_handle, &line_str, Some(ctx));
                }
                CommandEvent::Stderr(line) => {
                    let line_str = String::from_utf8_lossy(&line);
                    let trimmed = line_str.trim_end().to_string();
                    eprintln!("[sidecar stderr] {}", trimmed);
                    let _ = app_handle.emit(
                        "sidecar-log",
                        serde_json::json!({
                            "ts": now_ms(),
                            "level": "stderr",
                            "msg": trimmed,
                        }),
                    );
                }
                CommandEvent::Terminated(payload) => {
                    let _ = app_handle.emit(
                        "sidecar-log",
                        serde_json::json!({
                            "ts": now_ms(),
                            "level": "info",
                            "msg": "sidecar terminated",
                            "meta": { "code": payload.code }
                        }),
                    );
                    break;
                }
                _ => {}
            }
        }

        // Only emit crawl-complete if this crawl wasn't replaced by a newer one
        if let Some(state) = app_handle.try_state::<CrawlChild>() {
            if state.generation.load(Ordering::SeqCst) == gen {
                // Final aggregate emit so any subscriber sees the
                // last-known counts even if the emitter timer had skipped
                // a tick on shutdown.
                let arc_opt = lock_or_recover(&state.progress).clone();
                if let Some(progress) = arc_opt {
                    let snapshot = {
                        let g = lock_or_recover(&progress);
                        serde_json::json!({
                            "rowCount": g.row_count,
                            "errorCount": g.error_count,
                            "lastUrl": g.last_url,
                            "latestStatuses": g.latest_statuses.iter().copied().collect::<Vec<_>>(),
                        })
                    };
                    let _ = app_handle.emit("crawl-progress", snapshot);
                }
                let _ = app_handle.emit("crawl-complete", ());
                *lock_or_recover(&state.child) = None;
                state.pid.store(0, Ordering::SeqCst);
                state.session_id.store(0, Ordering::SeqCst);
                *lock_or_recover(&state.progress) = None;
            }
        }

        for t in &temp_files {
            let _ = std::fs::remove_file(t);
        }
    });

    Ok(())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Route a single stdout NDJSON line from the sidecar. Discriminates by the
/// `type` field: log/metric/phase go to their own events; anything without
/// `type` is treated as a legacy CrawlResult and routed to crawl-result.
///
/// If `ctx` is provided, `crawl-result` and `block-detected` events are
/// dropped when the source generation no longer matches the active crawl —
/// prevents late-stdout from a killed sidecar contaminating the next crawl.
/// Probe-matrix subprocesses pass None (they're not generation-scoped).
///
/// crawl-result rows from the active generation are also handed to the
/// background DbWriter so SQLite is updated in Rust without crossing the
/// JS bridge a second time.
fn route_sidecar_stdout(app: &AppHandle, line: &str, ctx: Option<CrawlCtx>) {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return;
    }
    match serde_json::from_str::<serde_json::Value>(trimmed) {
        Ok(val) => {
            let ev_name = match val.get("type").and_then(|v| v.as_str()) {
                Some("log") => "sidecar-log",
                Some("metric") => "sidecar-metric",
                Some("phase") => "sidecar-phase",
                Some("timing") => "sidecar-timing",
                Some("block-detected") => "block-detected",
                Some("block-cooldown-cleared") => "block-cooldown-cleared",
                Some("probe-result") => "probe-result",
                Some("probe-matrix-start") => "probe-matrix-start",
                Some("probe-matrix-complete") => "probe-matrix-complete",
                _ => "crawl-result",
            };
            // Gate stale events from replaced sidecars. The dying child can
            // keep streaming for a few seconds after kill() — without this,
            // its 1Hz `metric` emitter and any in-flight `log`/`phase` events
            // arrive interleaved with the new sidecar's, producing the
            // sawtooth-flipping the user saw in the metrics panel. ctx=None
            // (probe-matrix) skips the check; probe doesn't emit these
            // event types anyway.
            if matches!(
                ev_name,
                "crawl-result"
                    | "block-detected"
                    | "block-cooldown-cleared"
                    | "sidecar-metric"
                    | "sidecar-log"
                    | "sidecar-phase"
                    | "sidecar-timing"
            ) {
                if let Some(c) = ctx {
                    if let Some(state) = app.try_state::<CrawlChild>() {
                        if state.generation.load(Ordering::SeqCst) != c.gen {
                            return;
                        }
                    }
                }
            }
            // crawl-result rows go to the background SQLite writer AND
            // update the aggregate progress counters that the 500ms
            // emitter reads. Phase-6 cleanup: the per-row event itself is
            // no longer emitted to the webview — the data grid pages over
            // query_results and the health screen reads aggregate_health,
            // so a per-row IPC tax was just memory pressure with no
            // consumer.
            if ev_name == "crawl-result" {
                if let Some(c) = ctx {
                    if c.session_id != 0 {
                        if let Some(writer) = app.try_state::<DbWriter>() {
                            writer.enqueue(c.session_id, val.clone());
                        }
                    }
                    if let Some(state) = app.try_state::<CrawlChild>() {
                        let arc_opt = lock_or_recover(&state.progress).clone();
                        if let Some(progress) = arc_opt {
                            lock_or_recover(&progress).record(&val);
                        }
                    }
                }
                return;
            }
            let _ = app.emit(ev_name, val);
        }
        Err(_) => {
            // Non-JSON stdout line — surface as a log so nothing vanishes.
            let _ = app.emit(
                "sidecar-log",
                serde_json::json!({
                    "ts": now_ms(),
                    "level": "stdout",
                    "msg": trimmed,
                }),
            );
        }
    }
}

fn route_sidecar_stdout_lines(app: &AppHandle, chunk: &str, ctx: Option<CrawlCtx>) {
    let mut routed = false;
    for line in chunk.lines() {
        if line.trim().is_empty() {
            continue;
        }
        routed = true;
        route_sidecar_stdout(app, line, ctx);
    }
    if !routed && !chunk.trim().is_empty() {
        route_sidecar_stdout(app, chunk, ctx);
    }
}

#[tauri::command]
pub async fn stop_crawl(app: AppHandle) -> Result<(), String> {
    let state: State<CrawlChild> = app.state();
    // Bump generation so any stdout still in-flight from the dying child
    // is rejected by route_sidecar_stdout's generation check.
    state.generation.fetch_add(1, Ordering::SeqCst);
    // Try a graceful shutdown first: send {"cmd":"shutdown"} so the sidecar
    // can stop its metric emitter and break out of the crawl loop instead of
    // being SIGKILL'd mid-batch. Brief grace period, then hard kill if still
    // alive. The gen-gate above already neutralizes any stale events; this
    // is purely about giving Chromium/Playwright a chance to clean up.
    let mut child_taken = lock_or_recover(&state.child).take();
    if let Some(child) = child_taken.as_mut() {
        let _ = child.write(b"{\"cmd\":\"shutdown\"}\n");
    }
    if let Some(child) = child_taken {
        // Don't block start_crawl-flavored stops — 200ms is enough for the
        // sidecar to receive the line, in practice it exits within ~50ms.
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        child.kill().map_err(|e| format!("Failed to kill sidecar: {e}"))?;
    }
    state.pid.store(0, Ordering::SeqCst);
    state.session_id.store(0, Ordering::SeqCst);
    *lock_or_recover(&state.progress) = None;
    // Also kill any Chrome processes using our profile dir
    let profile = browser_profile_dir(&app);
    kill_chrome_for_profile(&profile);
    let _ = app.emit("crawl-stopped", ());
    Ok(())
}

/// Best-effort sample of /proc/<pid>/status on Linux. Returns RSS in KB and
/// state char. None on non-Linux or if the pid isn't running.
#[cfg(target_os = "linux")]
fn sample_proc(pid: i32) -> Option<serde_json::Value> {
    use std::fs;
    let path = format!("/proc/{}/status", pid);
    let content = fs::read_to_string(&path).ok()?;
    let mut rss_kb = 0u64;
    let mut vm_kb = 0u64;
    let mut state = String::new();
    let mut threads = 0u32;
    for line in content.lines() {
        if let Some(v) = line.strip_prefix("VmRSS:") {
            rss_kb = v.split_whitespace().next().and_then(|n| n.parse().ok()).unwrap_or(0);
        } else if let Some(v) = line.strip_prefix("VmSize:") {
            vm_kb = v.split_whitespace().next().and_then(|n| n.parse().ok()).unwrap_or(0);
        } else if let Some(v) = line.strip_prefix("State:") {
            state = v.trim().to_string();
        } else if let Some(v) = line.strip_prefix("Threads:") {
            threads = v.trim().parse().unwrap_or(0);
        }
    }
    Some(serde_json::json!({
        "rssBytes": rss_kb * 1024,
        "vmBytes": vm_kb * 1024,
        "state": state,
        "threads": threads,
    }))
}

#[cfg(not(target_os = "linux"))]
fn sample_proc(_pid: i32) -> Option<serde_json::Value> {
    None
}

/// Enumerate descendant PIDs of the sidecar (Chromium children). Linux-only
/// for now — uses /proc/<pid>/task/<tid>/children. None elsewhere.
#[cfg(target_os = "linux")]
fn descendant_pids(root: i32) -> Vec<i32> {
    use std::collections::VecDeque;
    use std::fs;
    let mut out: Vec<i32> = Vec::new();
    let mut queue: VecDeque<i32> = VecDeque::new();
    queue.push_back(root);
    let mut visited: std::collections::HashSet<i32> = std::collections::HashSet::new();
    while let Some(pid) = queue.pop_front() {
        if !visited.insert(pid) {
            continue;
        }
        let task_dir = format!("/proc/{}/task", pid);
        let Ok(tasks) = fs::read_dir(&task_dir) else { continue };
        for t in tasks.flatten() {
            let children_path = t.path().join("children");
            if let Ok(content) = fs::read_to_string(&children_path) {
                for token in content.split_whitespace() {
                    if let Ok(child_pid) = token.parse::<i32>() {
                        if child_pid != root {
                            out.push(child_pid);
                        }
                        queue.push_back(child_pid);
                    }
                }
            }
        }
    }
    out.sort();
    out.dedup();
    out
}

#[cfg(not(target_os = "linux"))]
fn descendant_pids(_root: i32) -> Vec<i32> {
    Vec::new()
}

#[tauri::command]
pub async fn debug_snapshot(app: AppHandle) -> Result<serde_json::Value, String> {
    let crawl_state: State<CrawlChild> = app.state();
    let app_start: State<AppStart> = app.state();

    let sidecar_pid = crawl_state.pid.load(Ordering::SeqCst);
    let generation = crawl_state.generation.load(Ordering::SeqCst);

    let data_dir = app
        .path()
        .app_data_dir()
        .ok()
        .map(|p| p.to_string_lossy().to_string());

    let db_path = app
        .path()
        .app_data_dir()
        .ok()
        .map(|p| p.join("fera.db"));
    let db_size = db_path
        .as_ref()
        .and_then(|p| std::fs::metadata(p).ok())
        .map(|m| m.len())
        .unwrap_or(0);

    let host_pid = std::process::id();
    let host_proc = sample_proc(host_pid as i32);
    let sidecar_proc = if sidecar_pid > 0 { sample_proc(sidecar_pid) } else { None };
    let children: Vec<serde_json::Value> = if sidecar_pid > 0 {
        descendant_pids(sidecar_pid)
            .into_iter()
            .map(|cp| {
                let info = sample_proc(cp).unwrap_or_else(|| serde_json::json!({}));
                serde_json::json!({ "pid": cp, "proc": info })
            })
            .collect()
    } else {
        Vec::new()
    };

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    Ok(serde_json::json!({
        "appStartEpoch": app_start.0,
        "uptimeSec": now.saturating_sub(app_start.0),
        "hostPid": host_pid,
        "hostProc": host_proc,
        "sidecarPid": sidecar_pid,
        "sidecarProc": sidecar_proc,
        "sidecarChildren": children,
        "crawlGeneration": generation,
        "dataDir": data_dir,
        "dbPath": db_path.map(|p| p.to_string_lossy().to_string()),
        "dbSizeBytes": db_size,
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
    }))
}

/// Wipes the Chromium user-data-dir. Used to recover from poisoned anti-bot
/// cookies (Akamai `_abck` stamped `~-1~`, Cloudflare `__cf_bm` invalidated)
/// that persist across sessions and cause instant 403s on every subsequent
/// crawl. Kills any running sidecar + chrome first so the directory isn't
/// locked when we try to remove it.
/// Walks `<app_data>/og-images/<session_id>` and reports image count + total
/// bytes on disk. Returns zeros if the dir doesn't exist (no images yet).
#[tauri::command]
pub async fn get_session_image_stats(app: AppHandle, session_id: i64) -> Result<serde_json::Value, String> {
    let dir = og_images_dir_for_session(&app, session_id);
    let mut count: u64 = 0;
    let mut bytes: u64 = 0;
    if dir.exists() {
        let mut stack = vec![dir];
        while let Some(d) = stack.pop() {
            let entries = match std::fs::read_dir(&d) {
                Ok(e) => e,
                Err(_) => continue,
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if let Ok(meta) = entry.metadata() {
                    if meta.is_dir() {
                        stack.push(path);
                    } else if meta.is_file() {
                        count += 1;
                        bytes += meta.len();
                    }
                }
            }
        }
    }
    Ok(serde_json::json!({ "count": count, "bytes": bytes }))
}

/// Removes the per-session og:images directory. Called from the frontend
/// alongside the SQL `DELETE FROM crawl_results / crawl_sessions` so deleting
/// a saved crawl also reclaims its image disk usage. Idempotent — silent
/// success when the dir doesn't exist.
#[tauri::command]
pub async fn delete_session_images(app: AppHandle, session_id: i64) -> Result<(), String> {
    let dir = og_images_dir_for_session(&app, session_id);
    if dir.exists() {
        std::fs::remove_dir_all(&dir)
            .map_err(|e| format!("Failed to remove {}: {}", dir.display(), e))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn wipe_browser_profile(app: AppHandle) -> Result<String, String> {
    let crawl_state: State<CrawlChild> = app.state();
    if let Some(child) = lock_or_recover(&crawl_state.child).take() {
        let _ = child.kill();
    }
    crawl_state.pid.store(0, Ordering::SeqCst);

    let browser_state: State<BrowserChild> = app.state();
    if let Some(child) = lock_or_recover(&browser_state.child).take() {
        let _ = child.kill();
    }

    let profile = browser_profile_dir(&app);
    kill_chrome_for_profile(&profile);

    // Brief pause so the OS releases file handles before we rm -rf.
    std::thread::sleep(std::time::Duration::from_millis(300));

    let path = std::path::Path::new(&profile);
    if path.exists() {
        std::fs::remove_dir_all(path)
            .map_err(|e| format!("Failed to wipe profile at {}: {}", profile, e))?;
    }

    let _ = app.emit(
        "sidecar-log",
        serde_json::json!({
            "ts": now_ms(),
            "level": "warn",
            "msg": "browser profile wiped",
            "ctx": { "path": &profile },
        }),
    );
    Ok(profile)
}

#[tauri::command]
pub async fn kill_sidecar(app: AppHandle) -> Result<(), String> {
    let state: State<CrawlChild> = app.state();
    state.generation.fetch_add(1, Ordering::SeqCst);
    if let Some(child) = lock_or_recover(&state.child).take() {
        child.kill().map_err(|e| format!("Failed to kill sidecar: {e}"))?;
    }
    state.pid.store(0, Ordering::SeqCst);
    state.session_id.store(0, Ordering::SeqCst);
    *lock_or_recover(&state.progress) = None;
    let profile = browser_profile_dir(&app);
    kill_chrome_for_profile(&profile);
    let _ = app.emit("crawl-stopped", ());
    let _ = app.emit(
        "sidecar-log",
        serde_json::json!({
            "ts": now_ms(),
            "level": "warn",
            "msg": "sidecar killed by user (debug panel)",
        }),
    );
    Ok(())
}

#[tauri::command]
pub async fn open_browser(app: AppHandle, url: String) -> Result<(), String> {
    let state: State<BrowserChild> = app.state();

    // Kill any existing browser and bump generation in the same critical section.
    let gen = {
        let mut guard = lock_or_recover(&state.child);
        if let Some(old_child) = guard.take() {
            let _ = old_child.kill();
        }
        state.generation.fetch_add(1, Ordering::SeqCst) + 1
    };

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

    // Kill and bump generation atomically.
    let gen = {
        let mut guard = lock_or_recover(&state.child);
        if let Some(old_child) = guard.take() {
            let _ = old_child.kill();
        }
        state.generation.fetch_add(1, Ordering::SeqCst) + 1
    };

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

fn write_crawl_stdin(app: &AppHandle, cmd_json: &str) -> Result<(), String> {
    let state: State<CrawlChild> = app.state();
    let mut guard = lock_or_recover(&state.child);
    let child = guard.as_mut().ok_or("no active crawl")?;
    let mut line = cmd_json.as_bytes().to_vec();
    line.push(b'\n');
    child
        .write(&line)
        .map_err(|e| format!("stdin write failed: {e}"))
}

#[tauri::command]
pub async fn resume_host(app: AppHandle, host: String) -> Result<(), String> {
    let json = serde_json::json!({ "cmd": "resume-host", "host": host });
    write_crawl_stdin(&app, &json.to_string())
}

#[tauri::command]
pub async fn stop_host(app: AppHandle, host: String) -> Result<(), String> {
    let json = serde_json::json!({ "cmd": "stop-host", "host": host });
    write_crawl_stdin(&app, &json.to_string())
}

/// Spawns a fresh sidecar in probe-matrix mode for the given sample URL.
/// Streams probe-result events back through the normal route_sidecar_stdout path
/// (same `block-detected`/`probe-result` routing). Non-blocking — returns once
/// the probe child is spawned.
///
/// Single-flight: rejects with an error if another probe matrix is already
/// running. The lock releases when the probe sidecar terminates so the
/// frontend's queued-host-probe drain can pick up the next host. Without
/// this guard a second invocation (manual probe during auto-probe, or two
/// hosts blocking nearly simultaneously) used to spawn a second sidecar
/// that fought the first over the shared browser profile.
#[tauri::command]
pub async fn run_probe_matrix(app: AppHandle, sample_url: String) -> Result<(), String> {
    let probe_state: State<ProbeState> = app.state();
    if probe_state
        .running
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err("Another probe matrix is already running".to_string());
    }

    let shell = app.shell();
    // Use an isolated profile dir so the probe doesn't collide with the
    // main crawl's Playwright process on the shared user-data-dir (Chrome
    // won't allow two concurrent processes on the same profile).
    let data_dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."));
    let probe_profile = data_dir
        .join("browser-profile-probe")
        .to_string_lossy()
        .to_string();

    let args = vec![
        "probe-matrix".to_string(),
        sample_url,
        "--browser-profile".to_string(),
        probe_profile,
    ];
    let args_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();

    // Helper to release the probe lock — called from every exit path so a
    // setup failure doesn't strand the lock and bake "probe stuck" into the
    // app for the rest of the session.
    let release_lock = |handle: &AppHandle| {
        if let Some(state) = handle.try_state::<ProbeState>() {
            state.running.store(false, Ordering::SeqCst);
        }
    };

    let mut cmd = match shell.sidecar("fera-crawler") {
        Ok(c) => c.args(&args_refs),
        Err(e) => {
            release_lock(&app);
            return Err(format!("Failed to create sidecar command: {e}"));
        }
    };

    if let Some(res_dir) = resource_dir(&app) {
        cmd = cmd.env("FERA_RESOURCES_DIR", res_dir);
    }

    let (mut rx, child) = match cmd.spawn() {
        Ok(v) => v,
        Err(e) => {
            release_lock(&app);
            return Err(format!("Failed to spawn probe-matrix: {e}"));
        }
    };

    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        use tauri_plugin_shell::process::CommandEvent;
        // Keep child alive until the event loop drains (mirrors dump_profile).
        let _child = child;
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    let line_str = String::from_utf8_lossy(&line);
                    route_sidecar_stdout_lines(&app_handle, &line_str, None::<CrawlCtx>);
                }
                CommandEvent::Stderr(line) => {
                    let line_str = String::from_utf8_lossy(&line);
                    eprintln!("[probe-matrix stderr] {}", line_str.trim_end());
                }
                CommandEvent::Terminated(_) => break,
                _ => {}
            }
        }
        // Sidecar exited (normal completion OR crash). Release lock so the
        // next queued probe can run.
        if let Some(state) = app_handle.try_state::<ProbeState>() {
            state.running.store(false, Ordering::SeqCst);
        }
    });

    Ok(())
}

/// Drain any pending crawl_results rows from the Rust DbWriter buffer and
/// commit them. The frontend invokes this before any session-level read
/// (list/load/count) that must observe in-flight rows — replaces the
/// JS-side `flushPendingInserts` from the pre-Phase-1 design.
#[tauri::command]
pub async fn flush_crawl_writes(app: AppHandle) -> Result<(), String> {
    let writer = app
        .try_state::<DbWriter>()
        .ok_or_else(|| "DbWriter state missing".to_string())?;
    writer.flush().await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn progress_state_records_row_url_and_status() {
        let mut p = ProgressState::default();
        p.record(&json!({"url": "https://a", "status": 200, "title": ""}));
        p.record(&json!({"url": "https://b", "status": 301, "title": ""}));
        assert_eq!(p.row_count, 2);
        assert_eq!(p.error_count, 0);
        assert_eq!(p.last_url, "https://b");
        assert_eq!(p.latest_statuses, vec![200, 301]);
        assert!(p.dirty);
    }

    #[test]
    fn progress_state_counts_errors_only_for_non_empty_strings() {
        // The crawler emits `error: ""` for clean rows in some paths and
        // `error: null` (omitted) for others. Both must NOT count.
        let mut p = ProgressState::default();
        p.record(&json!({"url": "a", "status": 200}));
        p.record(&json!({"url": "b", "status": 200, "error": ""}));
        p.record(&json!({"url": "c", "status": 0, "error": "host_blocked_by_detector:akamai"}));
        assert_eq!(p.row_count, 3);
        assert_eq!(p.error_count, 1);
    }

    #[test]
    fn progress_state_history_is_bounded() {
        // Should never grow past PROGRESS_HISTORY — a million-row crawl
        // can't bloat the IPC payload via this path.
        let mut p = ProgressState::default();
        for i in 0..(PROGRESS_HISTORY as i64 + 50) {
            p.record(&json!({"url": "x", "status": 200 + i}));
        }
        assert_eq!(p.latest_statuses.len(), PROGRESS_HISTORY);
        // Front of the deque is the oldest retained value (the first 50
        // entries got popped when we exceeded the bound).
        assert_eq!(*p.latest_statuses.front().unwrap(), 200 + 50);
    }

    #[test]
    fn progress_state_dirty_is_set_on_each_record() {
        let mut p = ProgressState::default();
        assert!(!p.dirty);
        p.record(&json!({"url": "x", "status": 200}));
        assert!(p.dirty);
        p.dirty = false;
        p.record(&json!({"url": "y", "status": 200}));
        assert!(p.dirty);
    }
}
