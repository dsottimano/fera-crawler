mod commands;

use tauri_plugin_sql::{Builder as SqlBuilder, Migration, MigrationKind};

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
    ];

    tauri::Builder::default()
        .manage(commands::CrawlChild::default())
        .manage(commands::BrowserChild::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(
            SqlBuilder::default()
                .add_migrations("sqlite:fera.db", migrations)
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            commands::start_crawl,
            commands::stop_crawl,
            commands::open_browser,
            commands::close_browser,
            commands::dump_profile,
            commands::open_inspector,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
