// Background SQLite writer for crawl_results.
//
// Phase 1 of the extreme-performance refactor: instead of crossing two IPC
// bridges per row (sidecar→Rust→webview→sqlite), Rust writes the rows from
// the sidecar's stdout NDJSON stream directly to SQLite via sqlx, in batched
// multi-row INSERTs.
//
// Contract mirrors the prior JS-side buffer: BATCH=200 rows, FLUSH=1000ms,
// DELETE-then-INSERT per (session_id, url) so re-emits (recrawls,
// block-stub recoveries) replace prior rows. seo_json is built from the
// CrawlResult's overflow fields (outlinks, metaTags, responseHeaders,
// scraper, etc.) — same shape as seoJsonFor() in useDatabase.ts.
//
// The writer runs as a single background task fed by an unbounded mpsc.
// `flush()` is a oneshot round-trip — used by frontend code that needs to
// see all in-flight rows committed (listing/loading sessions).

use std::path::PathBuf;
use std::time::{Duration, Instant};

use serde_json::{Map, Value};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::SqlitePool;
use tokio::sync::{mpsc, oneshot};

const BATCH_SIZE: usize = 200;
const FLUSH_MS: u64 = 1000;
const COLS_PER_ROW: usize = 30;

struct PendingRow {
    session_id: i64,
    value: Value,
}

enum Msg {
    Row(PendingRow),
    Flush(oneshot::Sender<Result<(), String>>),
}

#[derive(Clone)]
pub struct DbWriter {
    tx: mpsc::UnboundedSender<Msg>,
}

impl DbWriter {
    /// Push a crawl-result onto the writer's queue. Fire-and-forget: errors
    /// only surface via flush() or via stderr from the writer loop.
    pub fn enqueue(&self, session_id: i64, value: Value) {
        let _ = self.tx.send(Msg::Row(PendingRow { session_id, value }));
    }

    /// Drain pending rows and return when the batch containing this flush
    /// signal has committed. Used by frontend list/load paths that must see
    /// in-flight rows.
    pub async fn flush(&self) -> Result<(), String> {
        let (tx, rx) = oneshot::channel();
        self.tx
            .send(Msg::Flush(tx))
            .map_err(|e| format!("db_writer: send flush failed: {e}"))?;
        rx.await
            .map_err(|e| format!("db_writer: flush oneshot dropped: {e}"))?
    }
}

/// Spawn the writer task and return a clonable handle. Caller must invoke
/// from within a tokio runtime context (production: wrapped in
/// `tauri::async_runtime::block_on`; tests: `#[tokio::test]`). Pool is
/// opened lazily on the first batch so we don't race tauri-plugin-sql's
/// migration phase at startup.
pub fn spawn(db_path: PathBuf) -> DbWriter {
    let (tx, rx) = mpsc::unbounded_channel();
    tokio::spawn(writer_loop(rx, db_path));
    DbWriter { tx }
}

async fn open_pool(db_path: &std::path::Path) -> Result<SqlitePool, String> {
    // create_if_missing(true) — the migrations from tauri-plugin-sql usually
    // create the file first, but if our writer happens to fire first (e.g.
    // a probe-driven test setup), we don't want to error. Empty file is fine;
    // the table won't exist yet and the first INSERT will surface a clear
    // error that bubbles back to the flush caller.
    let opts = SqliteConnectOptions::new()
        .filename(db_path)
        .create_if_missing(true)
        .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
        .synchronous(sqlx::sqlite::SqliteSynchronous::Normal)
        .busy_timeout(Duration::from_secs(5));
    SqlitePoolOptions::new()
        .max_connections(2)
        .connect_with(opts)
        .await
        .map_err(|e| format!("open sqlite pool: {e}"))
}

async fn writer_loop(mut rx: mpsc::UnboundedReceiver<Msg>, db_path: PathBuf) {
    let mut pool: Option<SqlitePool> = None;
    let mut buffer: Vec<PendingRow> = Vec::with_capacity(BATCH_SIZE);
    let mut flush_replies: Vec<oneshot::Sender<Result<(), String>>> = Vec::new();

    loop {
        // Block for the first message of the next batch.
        match rx.recv().await {
            Some(Msg::Row(r)) => buffer.push(r),
            Some(Msg::Flush(tx)) => flush_replies.push(tx),
            None => return,
        }

        // Drain more messages until we hit BATCH_SIZE or the deadline.
        // A Flush mid-window forces an early write so the requester unblocks.
        let deadline = Instant::now() + Duration::from_millis(FLUSH_MS);
        let mut force_flush = !flush_replies.is_empty();
        while !force_flush && buffer.len() < BATCH_SIZE {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                break;
            }
            match tokio::time::timeout(remaining, rx.recv()).await {
                Ok(Some(Msg::Row(r))) => buffer.push(r),
                Ok(Some(Msg::Flush(tx))) => {
                    flush_replies.push(tx);
                    force_flush = true;
                }
                Ok(None) => return,
                Err(_) => break,
            }
        }

        // Lazy pool open. On failure: log, fail any pending flushes, drop
        // buffered rows (better than wedging the loop forever).
        if pool.is_none() {
            match open_pool(&db_path).await {
                Ok(p) => pool = Some(p),
                Err(e) => {
                    eprintln!("[db_writer] {e}");
                    for r in flush_replies.drain(..) {
                        let _ = r.send(Err(e.clone()));
                    }
                    buffer.clear();
                    continue;
                }
            }
        }
        let p = pool.as_ref().unwrap();

        let result = if buffer.is_empty() {
            Ok(())
        } else {
            let drained = std::mem::take(&mut buffer);
            write_batch(p, &drained)
                .await
                .map_err(|e| format!("write_batch: {e}"))
        };

        if let Err(ref e) = result {
            eprintln!("[db_writer] {e}");
        }

        for r in flush_replies.drain(..) {
            let _ = r.send(result.clone());
        }
    }
}

async fn write_batch(pool: &SqlitePool, batch: &[PendingRow]) -> Result<(), sqlx::Error> {
    let owned: Vec<BoundRow> = batch.iter().map(BoundRow::from_pending).collect();
    let mut tx = pool.begin().await?;

    // DELETE first so re-emitted urls (recrawls / block-stub recoveries)
    // replace prior rows. Group by session so each DELETE is one statement.
    let mut by_session: std::collections::BTreeMap<i64, Vec<&str>> = Default::default();
    for r in &owned {
        by_session
            .entry(r.session_id)
            .or_default()
            .push(r.url.as_str());
    }
    for (session_id, urls) in &by_session {
        if urls.is_empty() {
            continue;
        }
        let placeholders = std::iter::repeat("?")
            .take(urls.len())
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!(
            "DELETE FROM crawl_results WHERE session_id = ? AND url IN ({})",
            placeholders
        );
        let mut q = sqlx::query(&sql).bind(*session_id);
        for u in urls {
            q = q.bind(*u);
        }
        q.execute(&mut *tx).await?;
    }

    // Single multi-row INSERT.
    let row_placeholders = format!(
        "({})",
        std::iter::repeat("?")
            .take(COLS_PER_ROW)
            .collect::<Vec<_>>()
            .join(",")
    );
    let all_placeholders = std::iter::repeat(row_placeholders.as_str())
        .take(owned.len())
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "INSERT INTO crawl_results
            (session_id, url, status, title, h1, h2, meta_description, canonical,
             internal_links, external_links, response_time, content_type,
             resource_type, size, error, word_count, meta_robots,
             is_indexable, is_noindex, is_nofollow,
             og_title, og_description, og_image, og_image_width, og_image_height,
             date_published, date_modified, redirect_url, server_header, seo_json)
         VALUES {}",
        all_placeholders
    );

    let mut q = sqlx::query(&sql);
    for row in &owned {
        q = row.bind_all(q);
    }
    q.execute(&mut *tx).await?;

    tx.commit().await?;
    Ok(())
}

// All values pre-extracted as owned Rust types so binding lives long enough.
struct BoundRow {
    session_id: i64,
    url: String,
    status: i64,
    title: String,
    h1: String,
    h2: String,
    meta_description: String,
    canonical: String,
    internal_links: i64,
    external_links: i64,
    response_time: i64,
    content_type: String,
    resource_type: String,
    size: i64,
    error: Option<String>,
    word_count: i64,
    meta_robots: String,
    is_indexable: i64,
    is_noindex: i64,
    is_nofollow: i64,
    og_title: String,
    og_description: String,
    og_image: String,
    og_image_width: i64,
    og_image_height: i64,
    date_published: String,
    date_modified: String,
    redirect_url: String,
    server_header: String,
    seo_json: String,
}

impl BoundRow {
    fn from_pending(r: &PendingRow) -> Self {
        let v = &r.value;
        Self {
            session_id: r.session_id,
            url: vstr(v, "url"),
            status: vi64(v, "status"),
            title: vstr(v, "title"),
            h1: vstr(v, "h1"),
            h2: vstr(v, "h2"),
            meta_description: vstr(v, "metaDescription"),
            canonical: vstr(v, "canonical"),
            internal_links: vi64(v, "internalLinks"),
            external_links: vi64(v, "externalLinks"),
            response_time: vi64(v, "responseTime"),
            content_type: vstr(v, "contentType"),
            resource_type: vstr(v, "resourceType"),
            size: vi64(v, "size"),
            error: verror(v),
            word_count: vi64(v, "wordCount"),
            meta_robots: vstr(v, "metaRobots"),
            is_indexable: vbool(v, "isIndexable"),
            is_noindex: vbool(v, "isNoindex"),
            is_nofollow: vbool(v, "isNofollow"),
            og_title: vstr(v, "ogTitle"),
            og_description: vstr(v, "ogDescription"),
            og_image: vstr(v, "ogImage"),
            og_image_width: vi64(v, "ogImageWidth"),
            og_image_height: vi64(v, "ogImageHeight"),
            date_published: vstr(v, "datePublished"),
            date_modified: vstr(v, "dateModified"),
            redirect_url: vstr(v, "redirectUrl"),
            server_header: vstr(v, "serverHeader"),
            seo_json: build_seo_json(v),
        }
    }

    fn bind_all<'q>(
        &'q self,
        q: sqlx::query::Query<'q, sqlx::Sqlite, sqlx::sqlite::SqliteArguments<'q>>,
    ) -> sqlx::query::Query<'q, sqlx::Sqlite, sqlx::sqlite::SqliteArguments<'q>> {
        q.bind(self.session_id)
            .bind(&self.url)
            .bind(self.status)
            .bind(&self.title)
            .bind(&self.h1)
            .bind(&self.h2)
            .bind(&self.meta_description)
            .bind(&self.canonical)
            .bind(self.internal_links)
            .bind(self.external_links)
            .bind(self.response_time)
            .bind(&self.content_type)
            .bind(&self.resource_type)
            .bind(self.size)
            .bind(self.error.as_deref())
            .bind(self.word_count)
            .bind(&self.meta_robots)
            .bind(self.is_indexable)
            .bind(self.is_noindex)
            .bind(self.is_nofollow)
            .bind(&self.og_title)
            .bind(&self.og_description)
            .bind(&self.og_image)
            .bind(self.og_image_width)
            .bind(self.og_image_height)
            .bind(&self.date_published)
            .bind(&self.date_modified)
            .bind(&self.redirect_url)
            .bind(&self.server_header)
            .bind(&self.seo_json)
    }
}

fn vstr(v: &Value, key: &str) -> String {
    v.get(key)
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string()
}

fn vi64(v: &Value, key: &str) -> i64 {
    v.get(key).and_then(|x| x.as_i64()).unwrap_or(0)
}

fn vbool(v: &Value, key: &str) -> i64 {
    let truthy = v
        .get(key)
        .map(|x| match x {
            Value::Bool(b) => *b,
            Value::Number(n) => n.as_i64().unwrap_or(0) != 0,
            _ => false,
        })
        .unwrap_or(false);
    if truthy {
        1
    } else {
        0
    }
}

fn verror(v: &Value) -> Option<String> {
    match v.get("error") {
        Some(Value::String(s)) => Some(s.clone()),
        _ => None,
    }
}

// Mirror seoJsonFor() in useDatabase.ts: stash overflow fields as a single
// JSON blob. Insertion order matches the JS so byte-for-byte round-trips
// through this writer match the prior code's output.
fn build_seo_json(v: &Value) -> String {
    let mut m = Map::new();
    let str_or_empty = |key: &str| -> Value {
        Value::String(
            v.get(key)
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string(),
        )
    };
    let i64_or_zero = |key: &str| -> Value {
        Value::Number(serde_json::Number::from(
            v.get(key).and_then(|x| x.as_i64()).unwrap_or(0),
        ))
    };
    m.insert("metaGooglebot".into(), str_or_empty("metaGooglebot"));
    m.insert("xRobotsTag".into(), str_or_empty("xRobotsTag"));
    m.insert("ogType".into(), str_or_empty("ogType"));
    m.insert("ogUrl".into(), str_or_empty("ogUrl"));
    m.insert(
        "datePublishedTime".into(),
        str_or_empty("datePublishedTime"),
    );
    m.insert("dateModifiedTime".into(), str_or_empty("dateModifiedTime"));
    m.insert(
        "outlinks".into(),
        v.get("outlinks").cloned().unwrap_or(Value::Array(vec![])),
    );
    m.insert(
        "metaTags".into(),
        v.get("metaTags").cloned().unwrap_or(Value::Array(vec![])),
    );
    m.insert(
        "responseHeaders".into(),
        v.get("responseHeaders")
            .cloned()
            .unwrap_or(Value::Object(Map::new())),
    );
    m.insert("ogImageWidthReal".into(), i64_or_zero("ogImageWidthReal"));
    m.insert(
        "ogImageHeightReal".into(),
        i64_or_zero("ogImageHeightReal"),
    );
    m.insert("ogImageFileSize".into(), i64_or_zero("ogImageFileSize"));
    m.insert(
        "scraper".into(),
        v.get("scraper")
            .cloned()
            .unwrap_or(Value::Object(Map::new())),
    );
    Value::Object(m).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    async fn fresh_pool() -> SqlitePool {
        let opts = SqliteConnectOptions::new()
            .in_memory(true)
            .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
            .synchronous(sqlx::sqlite::SqliteSynchronous::Normal);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(opts)
            .await
            .expect("open in-memory pool");
        sqlx::query(
            "CREATE TABLE crawl_results (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id INTEGER NOT NULL,
                url TEXT NOT NULL,
                status INTEGER,
                title TEXT,
                h1 TEXT,
                h2 TEXT DEFAULT '',
                meta_description TEXT,
                canonical TEXT,
                internal_links INTEGER DEFAULT 0,
                external_links INTEGER DEFAULT 0,
                response_time INTEGER DEFAULT 0,
                content_type TEXT,
                resource_type TEXT DEFAULT 'Other',
                size INTEGER DEFAULT 0,
                error TEXT,
                word_count INTEGER DEFAULT 0,
                meta_robots TEXT DEFAULT '',
                is_indexable INTEGER DEFAULT 1,
                is_noindex INTEGER DEFAULT 0,
                is_nofollow INTEGER DEFAULT 0,
                og_title TEXT DEFAULT '',
                og_description TEXT DEFAULT '',
                og_image TEXT DEFAULT '',
                og_image_width INTEGER DEFAULT 0,
                og_image_height INTEGER DEFAULT 0,
                date_published TEXT DEFAULT '',
                date_modified TEXT DEFAULT '',
                redirect_url TEXT DEFAULT '',
                server_header TEXT DEFAULT '',
                seo_json TEXT DEFAULT '{}',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )",
        )
        .execute(&pool)
        .await
        .expect("create table");
        pool
    }

    fn sample(url: &str) -> Value {
        json!({
            "url": url,
            "status": 200,
            "title": "Hi",
            "h1": "Welcome",
            "h2": "",
            "metaDescription": "",
            "canonical": "",
            "wordCount": 100,
            "metaRobots": "index,follow",
            "metaGooglebot": "",
            "xRobotsTag": "",
            "isIndexable": true,
            "isNoindex": false,
            "isNofollow": false,
            "ogTitle": "",
            "ogDescription": "",
            "ogType": "",
            "ogUrl": "",
            "ogImage": "",
            "ogImageWidth": 0,
            "ogImageHeight": 0,
            "ogImageWidthReal": 0,
            "ogImageHeightReal": 0,
            "ogImageFileSize": 0,
            "datePublished": "",
            "dateModified": "",
            "datePublishedTime": "",
            "dateModifiedTime": "",
            "internalLinks": 5,
            "externalLinks": 2,
            "outlinks": ["https://a", "https://b"],
            "responseTime": 234,
            "contentType": "text/html",
            "resourceType": "HTML",
            "size": 1234,
            "metaTags": [],
            "scraper": {},
            "responseHeaders": {"x-test": "1"}
        })
    }

    #[tokio::test]
    async fn write_batch_inserts_rows() {
        let pool = fresh_pool().await;
        let batch = vec![
            PendingRow {
                session_id: 1,
                value: sample("https://a"),
            },
            PendingRow {
                session_id: 1,
                value: sample("https://b"),
            },
        ];
        write_batch(&pool, &batch).await.expect("write_batch");

        let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM crawl_results")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count.0, 2);

        let row: (String, i64, String, String) =
            sqlx::query_as("SELECT url, status, title, seo_json FROM crawl_results WHERE url = ?")
                .bind("https://a")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(row.0, "https://a");
        assert_eq!(row.1, 200);
        assert_eq!(row.2, "Hi");
        // seo_json must be valid JSON and contain the overflow fields.
        let seo: Value = serde_json::from_str(&row.3).expect("seo_json valid");
        assert_eq!(seo.get("outlinks").unwrap().as_array().unwrap().len(), 2);
        assert_eq!(seo.get("ogType").unwrap().as_str().unwrap(), "");
        assert_eq!(
            seo.get("responseHeaders")
                .unwrap()
                .get("x-test")
                .unwrap()
                .as_str()
                .unwrap(),
            "1"
        );
    }

    #[tokio::test]
    async fn re_emitting_a_url_replaces_prior_row() {
        let pool = fresh_pool().await;
        let mut first = sample("https://a");
        first["status"] = json!(200);
        write_batch(
            &pool,
            &[PendingRow {
                session_id: 1,
                value: first,
            }],
        )
        .await
        .unwrap();

        let mut second = sample("https://a");
        second["status"] = json!(404);
        write_batch(
            &pool,
            &[PendingRow {
                session_id: 1,
                value: second,
            }],
        )
        .await
        .unwrap();

        let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM crawl_results WHERE url = ?")
            .bind("https://a")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count.0, 1, "DELETE-then-INSERT should leave one row");

        let status: (i64,) = sqlx::query_as("SELECT status FROM crawl_results WHERE url = ?")
            .bind("https://a")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(status.0, 404, "second emit wins");
    }

    #[tokio::test]
    async fn delete_only_scopes_to_session() {
        // A re-emitted url in session 1 must NOT clobber the same url in
        // session 2 (different saved crawls of the same page).
        let pool = fresh_pool().await;
        write_batch(
            &pool,
            &[
                PendingRow {
                    session_id: 1,
                    value: sample("https://a"),
                },
                PendingRow {
                    session_id: 2,
                    value: sample("https://a"),
                },
            ],
        )
        .await
        .unwrap();
        // Re-emit just session 1.
        write_batch(
            &pool,
            &[PendingRow {
                session_id: 1,
                value: sample("https://a"),
            }],
        )
        .await
        .unwrap();

        let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM crawl_results")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count.0, 2, "session 2's row must survive");
    }

    #[test]
    fn build_seo_json_matches_js_shape() {
        let v = json!({
            "metaGooglebot": "noindex",
            "xRobotsTag": "",
            "ogType": "article",
            "ogUrl": "",
            "datePublishedTime": "",
            "dateModifiedTime": "",
            "outlinks": ["a", "b"],
            "metaTags": [{"name": "x", "property": "", "content": "y"}],
            "responseHeaders": {"a": "1"},
            "ogImageWidthReal": 800,
            "ogImageHeightReal": 600,
            "ogImageFileSize": 12345,
            "scraper": {"price": {"value": "$10", "appears": true}}
        });
        let s = build_seo_json(&v);
        let parsed: Value = serde_json::from_str(&s).unwrap();
        assert_eq!(parsed["metaGooglebot"], "noindex");
        assert_eq!(parsed["ogType"], "article");
        assert_eq!(parsed["outlinks"], json!(["a", "b"]));
        assert_eq!(parsed["ogImageWidthReal"], 800);
        assert_eq!(parsed["scraper"]["price"]["value"], "$10");
    }

    #[test]
    fn build_seo_json_defaults_for_missing_fields() {
        let v = json!({"url": "x"});
        let s = build_seo_json(&v);
        let parsed: Value = serde_json::from_str(&s).unwrap();
        assert_eq!(parsed["metaGooglebot"], "");
        assert_eq!(parsed["outlinks"], json!([]));
        assert_eq!(parsed["metaTags"], json!([]));
        assert_eq!(parsed["responseHeaders"], json!({}));
        assert_eq!(parsed["scraper"], json!({}));
        assert_eq!(parsed["ogImageWidthReal"], 0);
    }

    #[tokio::test]
    async fn flush_round_trips_through_spawned_writer() {
        // Set up a real on-disk file because SqlitePool ":memory:" connections
        // can't share data across pools. Use a tempfile.
        let tmp = std::env::temp_dir().join(format!("fera-dbwriter-test-{}.db", std::process::id()));
        let _ = std::fs::remove_file(&tmp);
        // Pre-create the schema via a separate pool.
        {
            let setup_opts = SqliteConnectOptions::new()
                .filename(&tmp)
                .create_if_missing(true)
                .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal);
            let setup_pool = SqlitePoolOptions::new()
                .max_connections(1)
                .connect_with(setup_opts)
                .await
                .unwrap();
            sqlx::query(
                "CREATE TABLE crawl_results (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id INTEGER NOT NULL,
                    url TEXT NOT NULL,
                    status INTEGER, title TEXT, h1 TEXT, h2 TEXT DEFAULT '',
                    meta_description TEXT, canonical TEXT,
                    internal_links INTEGER DEFAULT 0, external_links INTEGER DEFAULT 0,
                    response_time INTEGER DEFAULT 0, content_type TEXT,
                    resource_type TEXT DEFAULT 'Other', size INTEGER DEFAULT 0,
                    error TEXT, word_count INTEGER DEFAULT 0,
                    meta_robots TEXT DEFAULT '', is_indexable INTEGER DEFAULT 1,
                    is_noindex INTEGER DEFAULT 0, is_nofollow INTEGER DEFAULT 0,
                    og_title TEXT DEFAULT '', og_description TEXT DEFAULT '',
                    og_image TEXT DEFAULT '', og_image_width INTEGER DEFAULT 0,
                    og_image_height INTEGER DEFAULT 0,
                    date_published TEXT DEFAULT '', date_modified TEXT DEFAULT '',
                    redirect_url TEXT DEFAULT '', server_header TEXT DEFAULT '',
                    seo_json TEXT DEFAULT '{}',
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )",
            )
            .execute(&setup_pool)
            .await
            .unwrap();
        }

        let writer = spawn(tmp.clone());
        writer.enqueue(1, sample("https://x"));
        writer.enqueue(1, sample("https://y"));
        writer.flush().await.expect("flush ok");

        let opts = SqliteConnectOptions::new()
            .filename(&tmp)
            .create_if_missing(false);
        let read_pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(opts)
            .await
            .unwrap();
        let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM crawl_results")
            .fetch_one(&read_pool)
            .await
            .unwrap();
        assert_eq!(count.0, 2);

        let _ = std::fs::remove_file(&tmp);
    }
}
