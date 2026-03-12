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
    ];

    tauri::Builder::default()
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
