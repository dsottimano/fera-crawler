mod commands;
mod db_query;
mod db_writer;
mod voice_commands;

use tauri_plugin_sql::{Builder as SqlBuilder, Migration, MigrationKind};

// WebKitGTK denies media (mic/camera) by default, and even with permission
// granted requires the media-stream feature to be enabled at the settings
// level. We do both: flip the settings on, and auto-allow any permission
// request the webview makes (we trust our own UI).
#[cfg(target_os = "linux")]
fn enable_webview_media_linux(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    use webkit2gtk::{PermissionRequestExt, SettingsExt, WebViewExt};
    window.with_webview(|webview| {
        let wv = webview.inner();
        if let Some(settings) = WebViewExt::settings(&wv) {
            settings.set_enable_media_stream(true);
            settings.set_enable_mediasource(true);
            settings.set_enable_media(true);
        }
        wv.connect_permission_request(|_, request| {
            request.allow();
            true
        });
    })?;
    Ok(())
}

pub fn run() {
    let migrations = vec![
        Migration {
            version: 1,
            description: "create crawl tables",
            sql: "CREATE TABLE IF NOT EXISTS crawl_sessions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                start_url TEXT NOT NULL,
                started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                completed_at DATETIME
            );
            CREATE TABLE IF NOT EXISTS crawl_results (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id INTEGER NOT NULL,
                url TEXT NOT NULL,
                status INTEGER,
                title TEXT,
                h1 TEXT,
                meta_description TEXT,
                canonical TEXT,
                internal_links INTEGER DEFAULT 0,
                external_links INTEGER DEFAULT 0,
                response_time INTEGER DEFAULT 0,
                content_type TEXT,
                error TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (session_id) REFERENCES crawl_sessions(id)
            );",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "add resource_type and size columns",
            sql: "ALTER TABLE crawl_results ADD COLUMN resource_type TEXT DEFAULT 'Other';
                  ALTER TABLE crawl_results ADD COLUMN size INTEGER DEFAULT 0;",
            kind: MigrationKind::Up,
        },
        // seo_json stores overflow fields as JSON: metaGooglebot, xRobotsTag,
        // ogType, ogUrl, datePublishedTime, dateModifiedTime, outlinks[],
        // metaTags[], responseHeaders{}. Kept in JSON to avoid excessive columns.
        Migration {
            version: 3,
            description: "add SEO columns for full crawl data",
            sql: "ALTER TABLE crawl_results ADD COLUMN h2 TEXT DEFAULT '';
                  ALTER TABLE crawl_results ADD COLUMN word_count INTEGER DEFAULT 0;
                  ALTER TABLE crawl_results ADD COLUMN meta_robots TEXT DEFAULT '';
                  ALTER TABLE crawl_results ADD COLUMN is_indexable INTEGER DEFAULT 1;
                  ALTER TABLE crawl_results ADD COLUMN is_noindex INTEGER DEFAULT 0;
                  ALTER TABLE crawl_results ADD COLUMN is_nofollow INTEGER DEFAULT 0;
                  ALTER TABLE crawl_results ADD COLUMN og_title TEXT DEFAULT '';
                  ALTER TABLE crawl_results ADD COLUMN og_description TEXT DEFAULT '';
                  ALTER TABLE crawl_results ADD COLUMN og_image TEXT DEFAULT '';
                  ALTER TABLE crawl_results ADD COLUMN og_image_width INTEGER DEFAULT 0;
                  ALTER TABLE crawl_results ADD COLUMN og_image_height INTEGER DEFAULT 0;
                  ALTER TABLE crawl_results ADD COLUMN date_published TEXT DEFAULT '';
                  ALTER TABLE crawl_results ADD COLUMN date_modified TEXT DEFAULT '';
                  ALTER TABLE crawl_results ADD COLUMN redirect_url TEXT DEFAULT '';
                  ALTER TABLE crawl_results ADD COLUMN server_header TEXT DEFAULT '';
                  ALTER TABLE crawl_results ADD COLUMN seo_json TEXT DEFAULT '{}';",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 4,
            description: "add config_json to crawl_sessions",
            sql: "ALTER TABLE crawl_sessions ADD COLUMN config_json TEXT DEFAULT '{}';",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 5,
            description: "create profiles table",
            sql: "CREATE TABLE IF NOT EXISTS profiles (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE,
                schema_version INTEGER NOT NULL,
                values_json TEXT NOT NULL,
                is_default INTEGER NOT NULL DEFAULT 0,
                start_url TEXT,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_default
                ON profiles(is_default) WHERE is_default = 1;",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 6,
            description: "create crawl_configs table (per-domain probe results)",
            sql: "CREATE TABLE IF NOT EXISTS crawl_configs (
                domain TEXT PRIMARY KEY,
                config_json TEXT NOT NULL,
                winning_label TEXT,
                attempts_json TEXT NOT NULL DEFAULT '[]',
                probed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );",
            kind: MigrationKind::Up,
        },
        // Without this, every grid load full-scans crawl_results, and every
        // recrawl-dedup DELETE does the same. Composite covers both
        // `WHERE session_id = ?` and `WHERE session_id = ? AND url = ?`.
        Migration {
            version: 7,
            description: "index crawl_results on (session_id, url)",
            sql: "CREATE INDEX IF NOT EXISTS idx_crawl_results_session_url
                  ON crawl_results(session_id, url);",
            kind: MigrationKind::Up,
        },
    ];

    tauri::Builder::default()
        .manage(commands::CrawlChild::default())
        .manage(commands::BrowserChild::default())
        .manage(commands::AppStart::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(
            SqlBuilder::default()
                .add_migrations("sqlite:fera.db", migrations)
                .build(),
        )
        .setup(|app| {
            // Phase 1: Rust owns crawl_results writes. Spawn the background
            // batched writer keyed off the same fera.db file the SQL plugin
            // uses. tauri-plugin-sql resolves a bare `sqlite:fera.db`
            // against `app_config_dir` (NOT app_data_dir — the two are
            // distinct on Linux: ~/.config/<bundle> vs ~/.local/share/<bundle>).
            // Pointing our writer/reader at app_data_dir created an empty
            // SQLite file in the wrong place and queries silently saw no
            // tables. Stay aligned with the plugin's resolution.
            use tauri::Manager;
            let db_path = app
                .path()
                .app_config_dir()
                .map(|p| p.join("fera.db"))
                .unwrap_or_else(|_| std::path::PathBuf::from("fera.db"));
            let writer = tauri::async_runtime::block_on(async {
                db_writer::spawn(db_path.clone())
            });
            app.manage(writer);
            app.manage(db_query::DbReadPool::new(db_path));

            #[cfg(target_os = "linux")]
            {
                if let Some(window) = app.get_webview_window("main") {
                    if let Err(e) = enable_webview_media_linux(&window) {
                        eprintln!("[fera] failed to enable webview media: {}", e);
                    }
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::start_crawl,
            commands::stop_crawl,
            commands::open_browser,
            commands::close_browser,
            commands::dump_profile,
            commands::open_inspector,
            commands::debug_snapshot,
            commands::kill_sidecar,
            commands::wipe_browser_profile,
            commands::probe_crawl_config,
            commands::resume_host,
            commands::stop_host,
            commands::run_probe_matrix,
            commands::flush_crawl_writes,
            db_query::query_results,
            db_query::count_results,
            db_query::get_result_full,
            db_query::aggregate_health,
            db_query::query_all_results,
            db_query::distinct_status_codes,
            db_query::aggregate_resource_types,
            voice_commands::claude_turn_streaming,
            voice_commands::speak,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
