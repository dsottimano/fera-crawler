// Read-side SQLite access for crawl_results.
//
// Phase 2 of the extreme-performance refactor: instead of the frontend
// holding every row in JavaScript and filtering/sorting in memory, the grid
// asks Rust for the page it needs via these typed query commands. SQL does
// the work on indexed columns; the webview only ever holds the visible
// window.
//
// The filter/sort types are constrained on the Rust side — the frontend
// hands over typed structures, never raw SQL — so adding a new query
// dimension is a matching change in both layers, not an ad-hoc string.
//
// Pool is opened lazily because tauri-plugin-sql runs migrations on the
// same file via its own pool; opening eagerly at startup races migrations.

use std::path::PathBuf;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions, SqliteRow};
use sqlx::{Row, SqlitePool};
use tokio::sync::OnceCell;

pub struct DbReadPool {
    db_path: PathBuf,
    pool: OnceCell<SqlitePool>,
}

impl DbReadPool {
    pub fn new(db_path: PathBuf) -> Self {
        Self {
            db_path,
            pool: OnceCell::new(),
        }
    }

    pub async fn pool(&self) -> Result<&SqlitePool, String> {
        self.pool
            .get_or_try_init(|| open_pool(self.db_path.clone()))
            .await
    }
}

async fn open_pool(db_path: PathBuf) -> Result<SqlitePool, String> {
    let opts = SqliteConnectOptions::new()
        .filename(&db_path)
        .create_if_missing(true)
        .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
        .synchronous(sqlx::sqlite::SqliteSynchronous::Normal)
        .busy_timeout(Duration::from_secs(5))
        // Read pool: more connections than the writer because the grid will
        // pipeline page-fetches against health-card aggregates against
        // detail-view loads. 4 is enough for our worst case.
        .read_only(false);
    SqlitePoolOptions::new()
        .max_connections(4)
        .connect_with(opts)
        .await
        .map_err(|e| format!("open read pool: {e}"))
}

// ── Typed filter/sort ─────────────────────────────────────────────────────
//
// All fields optional; provided fields AND together. Frontend hands a
// camelCase JSON object via Tauri; serde renames to snake_case on read.

#[derive(Deserialize, Default, Debug, Clone)]
#[serde(default, rename_all = "camelCase")]
pub struct ResultsFilter {
    /// Inclusive lower bound on status code (e.g. 400 → "client errors and up").
    pub status_min: Option<i64>,
    /// Exclusive upper bound on status code (e.g. 500 → "below server errors").
    pub status_max: Option<i64>,
    /// True → only rows where redirect_url is non-empty. False → only rows
    /// without a redirect. None → either.
    pub has_redirect: Option<bool>,
    /// Indexability slice: "indexable" | "noindex" | "nofollow".
    pub indexability: Option<String>,
    /// Rows whose `error` column starts with this prefix. Used to surface
    /// block-detector parked stubs (`host_blocked_by_detector`) without
    /// matching every other error string.
    pub error_prefix: Option<String>,
    /// Case-insensitive substring match against url OR title. Powers the
    /// search bar.
    pub text: Option<String>,
    /// Rule name (matches a key inside seo_json's `scraper` object). When
    /// set, returns rows where the rule's `.value` is empty — i.e. the
    /// scraper rule failed to capture anything for that page. Used by the
    /// "scraper rule X captured 0/100" health drill-through.
    pub empty_scraper_rule: Option<String>,
    /// Resource type slice: "HTML" | "CSS" | "JavaScript" | …
    pub resource_type: Option<String>,
    /// True → "Issues" tab equivalent: rows missing title/h1/meta-description
    /// OR status >= 400 OR is_noindex. None → no filter.
    pub issues_only: Option<bool>,
    /// Restrict to a specific URL set — used by the "Recrawl Queue" tab,
    /// which is bounded by an in-memory list rather than a row property.
    pub url_in: Option<Vec<String>>,
    /// True → only HTML rows that have a non-empty og:image. Powers the
    /// Images tab. (resourceType=HTML covers the first half; this flag
    /// adds the og_image filter.)
    pub has_og_image: Option<bool>,
}

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ResultsSort {
    pub column: String,
    /// "asc" | "desc" (case-insensitive). Anything else falls back to "asc".
    pub direction: Option<String>,
}

// Whitelist of sortable columns. Sort over arbitrary text isn't supported
// for two reasons: SQL injection prevention and the grid only ever sorts
// by a stable set of columns (anything in seo_json is JSON-extracted at
// detail view time, not in the list).
const SORTABLE: &[&str] = &[
    "id",
    "url",
    "status",
    "title",
    "h1",
    "response_time",
    "size",
    "internal_links",
    "external_links",
    "word_count",
    "content_type",
    "resource_type",
];

fn build_where(
    filter: &ResultsFilter,
    out_clauses: &mut Vec<String>,
    out_binds: &mut Vec<Value>,
) {
    if let Some(min) = filter.status_min {
        out_clauses.push("status >= ?".to_string());
        out_binds.push(Value::Number(min.into()));
    }
    if let Some(max) = filter.status_max {
        out_clauses.push("status < ?".to_string());
        out_binds.push(Value::Number(max.into()));
    }
    match filter.has_redirect {
        Some(true) => out_clauses.push("redirect_url IS NOT NULL AND redirect_url != ''".to_string()),
        Some(false) => out_clauses.push("(redirect_url IS NULL OR redirect_url = '')".to_string()),
        None => {}
    }
    if let Some(idx) = &filter.indexability {
        match idx.as_str() {
            "indexable" => out_clauses.push("is_indexable = 1".to_string()),
            "noindex" => out_clauses.push("is_noindex = 1".to_string()),
            "nofollow" => out_clauses.push("is_nofollow = 1".to_string()),
            // Unknown indexability tokens silently drop the filter rather
            // than 500 — frontend may add new values before Rust knows them.
            _ => {}
        }
    }
    if let Some(prefix) = &filter.error_prefix {
        if !prefix.is_empty() {
            out_clauses.push("error LIKE ? ESCAPE '\\'".to_string());
            out_binds.push(Value::String(format!("{}%", escape_like(prefix))));
        }
    }
    if let Some(text) = &filter.text {
        let trimmed = text.trim();
        if !trimmed.is_empty() {
            out_clauses
                .push("(LOWER(url) LIKE ? ESCAPE '\\' OR LOWER(title) LIKE ? ESCAPE '\\')".to_string());
            let pattern = format!("%{}%", escape_like(&trimmed.to_lowercase()));
            out_binds.push(Value::String(pattern.clone()));
            out_binds.push(Value::String(pattern));
        }
    }
    if let Some(rule) = &filter.empty_scraper_rule {
        if !rule.is_empty() {
            // json_extract returns NULL when the path is missing; we want
            // both "missing key" and "empty string value" to qualify.
            out_clauses.push(
                "COALESCE(json_extract(seo_json, '$.scraper.' || ? || '.value'), '') = ''"
                    .to_string(),
            );
            out_binds.push(Value::String(rule.clone()));
        }
    }
    if let Some(rt) = &filter.resource_type {
        if !rt.is_empty() {
            out_clauses.push("resource_type = ?".to_string());
            out_binds.push(Value::String(rt.clone()));
        }
    }
    if let Some(true) = filter.issues_only {
        // Five OR'd issue conditions match the legacy "Issues" tab predicate.
        // Keep the parens — strips ambiguity when this AND's into the wider
        // WHERE clause.
        out_clauses.push(
            "(title = '' OR title IS NULL \
              OR h1 = '' OR h1 IS NULL \
              OR meta_description = '' OR meta_description IS NULL \
              OR status >= 400 \
              OR is_noindex = 1)"
                .to_string(),
        );
    }
    if let Some(urls) = &filter.url_in {
        if urls.is_empty() {
            // url_in: [] = "match nothing" — explicit empty set. Without
            // this short-circuit SQLite would parse `IN ()` as a syntax
            // error.
            out_clauses.push("0".to_string());
        } else {
            let placeholders = std::iter::repeat("?")
                .take(urls.len())
                .collect::<Vec<_>>()
                .join(",");
            out_clauses.push(format!("url IN ({})", placeholders));
            for u in urls {
                out_binds.push(Value::String(u.clone()));
            }
        }
    }
    if let Some(true) = filter.has_og_image {
        out_clauses.push("og_image IS NOT NULL AND og_image != ''".to_string());
    }
}

// Escape a user-supplied substring for use inside a LIKE pattern. Adds
// our own '%' wildcards in the caller; here we only need to neutralize
// the LIKE meta-characters '%', '_' and the escape char itself so they
// match literally when the SQL uses `LIKE ? ESCAPE '\\'`. (The previous
// version stripped them entirely — fine for paths but wrong for tokens
// like `host_blocked_by_detector` where the underscore is meaningful.)
fn escape_like(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        if matches!(ch, '\\' | '%' | '_') {
            out.push('\\');
        }
        out.push(ch);
    }
    out
}

fn order_clause(sort: Option<&ResultsSort>) -> String {
    let s = match sort {
        Some(s) if SORTABLE.contains(&s.column.as_str()) => s,
        _ => return "ORDER BY id ASC".to_string(),
    };
    let dir = match s
        .direction
        .as_deref()
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("desc") => "DESC",
        _ => "ASC",
    };
    format!("ORDER BY {} {}, id ASC", s.column, dir)
}

// ── Row shape ────────────────────────────────────────────────────────────

const RESULT_COLUMNS: &str = "id, url, status, title, h1, h2, meta_description, canonical, \
    internal_links, external_links, response_time, content_type, resource_type, size, error, \
    word_count, meta_robots, is_indexable, is_noindex, is_nofollow, og_title, og_description, \
    og_image, og_image_width, og_image_height, date_published, date_modified, redirect_url, \
    server_header";

fn row_to_json(r: &SqliteRow) -> Value {
    let mut m = serde_json::Map::new();
    m.insert("id".into(), Value::Number(r.try_get::<i64, _>("id").unwrap_or(0).into()));
    m.insert("url".into(), Value::String(r.try_get::<String, _>("url").unwrap_or_default()));
    m.insert("status".into(), Value::Number(r.try_get::<i64, _>("status").unwrap_or(0).into()));
    m.insert("title".into(), Value::String(r.try_get::<String, _>("title").unwrap_or_default()));
    m.insert("h1".into(), Value::String(r.try_get::<String, _>("h1").unwrap_or_default()));
    m.insert("h2".into(), Value::String(r.try_get::<String, _>("h2").unwrap_or_default()));
    m.insert(
        "metaDescription".into(),
        Value::String(r.try_get::<String, _>("meta_description").unwrap_or_default()),
    );
    m.insert(
        "canonical".into(),
        Value::String(r.try_get::<String, _>("canonical").unwrap_or_default()),
    );
    m.insert(
        "internalLinks".into(),
        Value::Number(r.try_get::<i64, _>("internal_links").unwrap_or(0).into()),
    );
    m.insert(
        "externalLinks".into(),
        Value::Number(r.try_get::<i64, _>("external_links").unwrap_or(0).into()),
    );
    m.insert(
        "responseTime".into(),
        Value::Number(r.try_get::<i64, _>("response_time").unwrap_or(0).into()),
    );
    m.insert(
        "contentType".into(),
        Value::String(r.try_get::<String, _>("content_type").unwrap_or_default()),
    );
    m.insert(
        "resourceType".into(),
        Value::String(r.try_get::<String, _>("resource_type").unwrap_or_default()),
    );
    m.insert("size".into(), Value::Number(r.try_get::<i64, _>("size").unwrap_or(0).into()));
    let err: Option<String> = r.try_get("error").ok();
    m.insert(
        "error".into(),
        match err {
            Some(s) if !s.is_empty() => Value::String(s),
            _ => Value::Null,
        },
    );
    m.insert(
        "wordCount".into(),
        Value::Number(r.try_get::<i64, _>("word_count").unwrap_or(0).into()),
    );
    m.insert(
        "metaRobots".into(),
        Value::String(r.try_get::<String, _>("meta_robots").unwrap_or_default()),
    );
    m.insert(
        "isIndexable".into(),
        Value::Bool(r.try_get::<i64, _>("is_indexable").unwrap_or(0) != 0),
    );
    m.insert(
        "isNoindex".into(),
        Value::Bool(r.try_get::<i64, _>("is_noindex").unwrap_or(0) != 0),
    );
    m.insert(
        "isNofollow".into(),
        Value::Bool(r.try_get::<i64, _>("is_nofollow").unwrap_or(0) != 0),
    );
    m.insert(
        "ogTitle".into(),
        Value::String(r.try_get::<String, _>("og_title").unwrap_or_default()),
    );
    m.insert(
        "ogDescription".into(),
        Value::String(r.try_get::<String, _>("og_description").unwrap_or_default()),
    );
    m.insert(
        "ogImage".into(),
        Value::String(r.try_get::<String, _>("og_image").unwrap_or_default()),
    );
    m.insert(
        "ogImageWidth".into(),
        Value::Number(r.try_get::<i64, _>("og_image_width").unwrap_or(0).into()),
    );
    m.insert(
        "ogImageHeight".into(),
        Value::Number(r.try_get::<i64, _>("og_image_height").unwrap_or(0).into()),
    );
    m.insert(
        "datePublished".into(),
        Value::String(r.try_get::<String, _>("date_published").unwrap_or_default()),
    );
    m.insert(
        "dateModified".into(),
        Value::String(r.try_get::<String, _>("date_modified").unwrap_or_default()),
    );
    m.insert(
        "redirectUrl".into(),
        Value::String(r.try_get::<String, _>("redirect_url").unwrap_or_default()),
    );
    m.insert(
        "serverHeader".into(),
        Value::String(r.try_get::<String, _>("server_header").unwrap_or_default()),
    );
    Value::Object(m)
}

fn bind_value<'q>(
    q: sqlx::query::Query<'q, sqlx::Sqlite, sqlx::sqlite::SqliteArguments<'q>>,
    v: &'q Value,
) -> sqlx::query::Query<'q, sqlx::Sqlite, sqlx::sqlite::SqliteArguments<'q>> {
    match v {
        Value::String(s) => q.bind(s),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                q.bind(i)
            } else if let Some(f) = n.as_f64() {
                q.bind(f)
            } else {
                q.bind(Option::<i64>::None)
            }
        }
        Value::Bool(b) => q.bind(*b),
        _ => q.bind(Option::<i64>::None),
    }
}

// ── Pure query functions (testable without Tauri) ───────────────────────

pub async fn query_results_inner(
    pool: &SqlitePool,
    session_id: i64,
    offset: i64,
    limit: i64,
    filter: &ResultsFilter,
    sort: Option<&ResultsSort>,
) -> Result<Vec<Value>, sqlx::Error> {
    let mut clauses: Vec<String> = vec!["session_id = ?".into()];
    let mut binds: Vec<Value> = vec![Value::Number(session_id.into())];
    build_where(filter, &mut clauses, &mut binds);
    let where_clause = clauses.join(" AND ");
    let order = order_clause(sort);
    // Always include seo_json: the data grid renders user-defined scraper
    // columns (data.scraper.<rule>.value) and a few overflow OG fields.
    // ~20KB/row × 50-row page = ~1MB — bounded per page, so OK to ship
    // every time. Cheaper than a second roundtrip for those columns.
    let sql = format!(
        "SELECT {cols}, seo_json FROM crawl_results WHERE {where_clause} {order} LIMIT ? OFFSET ?",
        cols = RESULT_COLUMNS,
        where_clause = where_clause,
        order = order,
    );
    let mut q = sqlx::query(&sql);
    for b in &binds {
        q = bind_value(q, b);
    }
    q = q.bind(limit).bind(offset);
    let rows = q.fetch_all(pool).await?;
    Ok(rows.iter().map(|r| {
        let mut v = row_to_json(r);
        let seo_str: String = r.try_get("seo_json").unwrap_or_default();
        merge_seo_overflow(&mut v, &seo_str);
        v
    }).collect())
}

// Merge seo_json's overflow fields back into a row JSON object. Used by
// both query_results (so the grid sees scraper/og fields without a second
// fetch) and get_result_full (so the detail panel sees the full shape).
// `entry().or_insert` — top-level columns always win over seo_json keys
// of the same name.
fn merge_seo_overflow(target: &mut Value, seo_str: &str) {
    if let Ok(Value::Object(seo)) = serde_json::from_str::<Value>(seo_str) {
        if let Value::Object(ref mut obj) = target {
            for (k, val) in seo {
                obj.entry(k).or_insert(val);
            }
        }
    }
}

pub async fn count_results_inner(
    pool: &SqlitePool,
    session_id: i64,
    filter: &ResultsFilter,
) -> Result<i64, sqlx::Error> {
    let mut clauses: Vec<String> = vec!["session_id = ?".into()];
    let mut binds: Vec<Value> = vec![Value::Number(session_id.into())];
    build_where(filter, &mut clauses, &mut binds);
    let where_clause = clauses.join(" AND ");
    let sql = format!("SELECT COUNT(*) FROM crawl_results WHERE {where_clause}");
    let mut q = sqlx::query_scalar::<_, i64>(&sql);
    for b in &binds {
        // sqlx::query_scalar returns a different builder type; bind manually.
        q = match b {
            Value::String(s) => q.bind(s),
            Value::Number(n) => q.bind(n.as_i64().unwrap_or(0)),
            Value::Bool(b) => q.bind(*b),
            _ => q.bind(Option::<i64>::None),
        };
    }
    q.fetch_one(pool).await
}

pub async fn get_result_full_inner(
    pool: &SqlitePool,
    session_id: i64,
    url: &str,
) -> Result<Option<Value>, sqlx::Error> {
    let sql = format!(
        "SELECT {cols}, seo_json FROM crawl_results WHERE session_id = ? AND url = ? LIMIT 1",
        cols = RESULT_COLUMNS
    );
    let row = sqlx::query(&sql)
        .bind(session_id)
        .bind(url)
        .fetch_optional(pool)
        .await?;
    Ok(row.map(|r| {
        let mut v = row_to_json(&r);
        let seo_str: String = r.try_get("seo_json").unwrap_or_default();
        merge_seo_overflow(&mut v, &seo_str);
        v
    }))
}

#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct HealthSnapshot {
    pub total: i64,
    pub status_2xx: i64,
    pub status_3xx: i64,
    pub status_4xx: i64,
    pub status_5xx: i64,
    pub status_other: i64,
    pub errors: i64,
    pub redirects: i64,
    pub indexable: i64,
    pub noindex: i64,
    pub nofollow: i64,
    pub empty_h1: i64,
    pub empty_title: i64,
    pub avg_response_time: f64,
    pub max_response_time: i64,
}

pub async fn aggregate_health_inner(
    pool: &SqlitePool,
    session_id: i64,
) -> Result<HealthSnapshot, sqlx::Error> {
    // Single SELECT with conditional aggregates — one table scan, every
    // health card's value falls out at once. SQLite pushes filter
    // expressions through the index on (session_id, url).
    let row = sqlx::query(
        "SELECT
            COUNT(*) AS total,
            SUM(CASE WHEN status >= 200 AND status < 300 THEN 1 ELSE 0 END) AS status_2xx,
            SUM(CASE WHEN status >= 300 AND status < 400 THEN 1 ELSE 0 END) AS status_3xx,
            SUM(CASE WHEN status >= 400 AND status < 500 THEN 1 ELSE 0 END) AS status_4xx,
            SUM(CASE WHEN status >= 500 AND status < 600 THEN 1 ELSE 0 END) AS status_5xx,
            SUM(CASE WHEN status < 200 OR status >= 600 THEN 1 ELSE 0 END) AS status_other,
            SUM(CASE WHEN error IS NOT NULL AND error != '' THEN 1 ELSE 0 END) AS errors,
            SUM(CASE WHEN redirect_url IS NOT NULL AND redirect_url != '' THEN 1 ELSE 0 END) AS redirects,
            SUM(CASE WHEN is_indexable = 1 THEN 1 ELSE 0 END) AS indexable,
            SUM(CASE WHEN is_noindex = 1 THEN 1 ELSE 0 END) AS noindex,
            SUM(CASE WHEN is_nofollow = 1 THEN 1 ELSE 0 END) AS nofollow,
            SUM(CASE WHEN h1 = '' OR h1 IS NULL THEN 1 ELSE 0 END) AS empty_h1,
            SUM(CASE WHEN title = '' OR title IS NULL THEN 1 ELSE 0 END) AS empty_title,
            COALESCE(AVG(response_time), 0) AS avg_response_time,
            COALESCE(MAX(response_time), 0) AS max_response_time
         FROM crawl_results WHERE session_id = ?",
    )
    .bind(session_id)
    .fetch_one(pool)
    .await?;

    let i = |c: &str| -> i64 { row.try_get::<Option<i64>, _>(c).ok().flatten().unwrap_or(0) };
    Ok(HealthSnapshot {
        total: i("total"),
        status_2xx: i("status_2xx"),
        status_3xx: i("status_3xx"),
        status_4xx: i("status_4xx"),
        status_5xx: i("status_5xx"),
        status_other: i("status_other"),
        errors: i("errors"),
        redirects: i("redirects"),
        indexable: i("indexable"),
        noindex: i("noindex"),
        nofollow: i("nofollow"),
        empty_h1: i("empty_h1"),
        empty_title: i("empty_title"),
        avg_response_time: row
            .try_get::<f64, _>("avg_response_time")
            .unwrap_or(0.0),
        max_response_time: i("max_response_time"),
    })
}

/// Returns every row for a session including the seo_json overflow merged
/// in. Phase 6 clean-up: replaces the JS-side `loadSessionResults` +
/// `enrichSeo` two-step that used to pull rows piecemeal so the grid
/// could paint fast. Use for one-shot exports / saves / report panels —
/// the Tabulator grid still pages via query_results.
pub async fn query_all_results_inner(
    pool: &SqlitePool,
    session_id: i64,
) -> Result<Vec<Value>, sqlx::Error> {
    let sql = format!(
        "SELECT {cols}, seo_json FROM crawl_results WHERE session_id = ? ORDER BY id ASC",
        cols = RESULT_COLUMNS,
    );
    let rows = sqlx::query(&sql).bind(session_id).fetch_all(pool).await?;
    Ok(rows
        .iter()
        .map(|r| {
            let mut v = row_to_json(r);
            let seo_str: String = r.try_get("seo_json").unwrap_or_default();
            merge_seo_overflow(&mut v, &seo_str);
            v
        })
        .collect())
}

/// Distinct non-zero status codes seen in a session, ascending. Used by
/// the FilterBar's "Response Codes" dropdown.
pub async fn distinct_status_codes_inner(
    pool: &SqlitePool,
    session_id: i64,
) -> Result<Vec<i64>, sqlx::Error> {
    let rows: Vec<(i64,)> = sqlx::query_as(
        "SELECT DISTINCT status FROM crawl_results
         WHERE session_id = ? AND status > 0
         ORDER BY status ASC",
    )
    .bind(session_id)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(|(c,)| c).collect())
}

/// Per-resource-type row counts. Powers the RightSidebar donut. Sorted
/// descending by count so the chart's segment order is stable.
pub async fn aggregate_resource_types_inner(
    pool: &SqlitePool,
    session_id: i64,
) -> Result<Vec<(String, i64)>, sqlx::Error> {
    let rows: Vec<(Option<String>, i64)> = sqlx::query_as(
        "SELECT resource_type, COUNT(*) FROM crawl_results
         WHERE session_id = ?
         GROUP BY resource_type
         ORDER BY COUNT(*) DESC",
    )
    .bind(session_id)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(rt, n)| (rt.unwrap_or_default(), n))
        .collect())
}

// ── Tauri command wrappers ──────────────────────────────────────────────

#[tauri::command]
pub async fn query_results(
    app: tauri::AppHandle,
    session_id: i64,
    page: u32,
    limit: u32,
    filter: Option<ResultsFilter>,
    sort: Option<ResultsSort>,
) -> Result<Vec<Value>, String> {
    use tauri::Manager;
    let pool_state = app
        .try_state::<DbReadPool>()
        .ok_or_else(|| "DbReadPool state missing".to_string())?;
    let pool = pool_state.pool().await?;
    // Make sure any in-flight rows from the Rust writer are visible — the
    // grid otherwise sees a half-empty page during an active crawl.
    if let Some(writer) = app.try_state::<crate::db_writer::DbWriter>() {
        writer.flush().await?;
    }
    let offset = (page as i64).saturating_mul(limit as i64);
    let f = filter.unwrap_or_default();
    query_results_inner(pool, session_id, offset, limit as i64, &f, sort.as_ref())
        .await
        .map_err(|e| format!("query_results: {e}"))
}

#[tauri::command]
pub async fn count_results(
    app: tauri::AppHandle,
    session_id: i64,
    filter: Option<ResultsFilter>,
) -> Result<i64, String> {
    use tauri::Manager;
    let pool_state = app
        .try_state::<DbReadPool>()
        .ok_or_else(|| "DbReadPool state missing".to_string())?;
    let pool = pool_state.pool().await?;
    if let Some(writer) = app.try_state::<crate::db_writer::DbWriter>() {
        writer.flush().await?;
    }
    let f = filter.unwrap_or_default();
    count_results_inner(pool, session_id, &f)
        .await
        .map_err(|e| format!("count_results: {e}"))
}

#[tauri::command]
pub async fn get_result_full(
    app: tauri::AppHandle,
    session_id: i64,
    url: String,
) -> Result<Option<Value>, String> {
    use tauri::Manager;
    let pool_state = app
        .try_state::<DbReadPool>()
        .ok_or_else(|| "DbReadPool state missing".to_string())?;
    let pool = pool_state.pool().await?;
    if let Some(writer) = app.try_state::<crate::db_writer::DbWriter>() {
        writer.flush().await?;
    }
    get_result_full_inner(pool, session_id, &url)
        .await
        .map_err(|e| format!("get_result_full: {e}"))
}

#[tauri::command]
pub async fn aggregate_health(
    app: tauri::AppHandle,
    session_id: i64,
) -> Result<HealthSnapshot, String> {
    use tauri::Manager;
    let pool_state = app
        .try_state::<DbReadPool>()
        .ok_or_else(|| "DbReadPool state missing".to_string())?;
    let pool = pool_state.pool().await?;
    if let Some(writer) = app.try_state::<crate::db_writer::DbWriter>() {
        writer.flush().await?;
    }
    aggregate_health_inner(pool, session_id)
        .await
        .map_err(|e| format!("aggregate_health: {e}"))
}

#[tauri::command]
pub async fn query_all_results(
    app: tauri::AppHandle,
    session_id: i64,
) -> Result<Vec<Value>, String> {
    use tauri::Manager;
    let pool_state = app
        .try_state::<DbReadPool>()
        .ok_or_else(|| "DbReadPool state missing".to_string())?;
    let pool = pool_state.pool().await?;
    if let Some(writer) = app.try_state::<crate::db_writer::DbWriter>() {
        writer.flush().await?;
    }
    query_all_results_inner(pool, session_id)
        .await
        .map_err(|e| format!("query_all_results: {e}"))
}

#[tauri::command]
pub async fn distinct_status_codes(
    app: tauri::AppHandle,
    session_id: i64,
) -> Result<Vec<i64>, String> {
    use tauri::Manager;
    let pool_state = app
        .try_state::<DbReadPool>()
        .ok_or_else(|| "DbReadPool state missing".to_string())?;
    let pool = pool_state.pool().await?;
    if let Some(writer) = app.try_state::<crate::db_writer::DbWriter>() {
        writer.flush().await?;
    }
    distinct_status_codes_inner(pool, session_id)
        .await
        .map_err(|e| format!("distinct_status_codes: {e}"))
}

#[tauri::command]
pub async fn aggregate_resource_types(
    app: tauri::AppHandle,
    session_id: i64,
) -> Result<Vec<(String, i64)>, String> {
    use tauri::Manager;
    let pool_state = app
        .try_state::<DbReadPool>()
        .ok_or_else(|| "DbReadPool state missing".to_string())?;
    let pool = pool_state.pool().await?;
    if let Some(writer) = app.try_state::<crate::db_writer::DbWriter>() {
        writer.flush().await?;
    }
    aggregate_resource_types_inner(pool, session_id)
        .await
        .map_err(|e| format!("aggregate_resource_types: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn fixture_pool() -> SqlitePool {
        let opts = SqliteConnectOptions::new()
            .in_memory(true)
            .journal_mode(sqlx::sqlite::SqliteJournalMode::Memory)
            .synchronous(sqlx::sqlite::SqliteSynchronous::Off);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(opts)
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
        .execute(&pool)
        .await
        .unwrap();
        pool
    }

    async fn insert_fixture_rows(pool: &SqlitePool) {
        // 10 rows covering the dimensions the tests exercise:
        //  - status mix (2xx/3xx/4xx/5xx)
        //  - some redirects, some without
        //  - mix of indexable/noindex/nofollow
        //  - one row with an error string
        //  - varying response times
        //  - varying titles for text-search
        //  - one row with empty h1, one with empty title
        //  - one row with a stale scraper rule (empty .price.value)
        let rows = vec![
            (1, "https://a.com/1", 200, "Welcome", "Hello", 100, "", "HTML", false, false, false, None::<&str>, "{}"),
            (1, "https://a.com/2", 301, "Old URL", "", 50, "https://a.com/2-new", "HTML", true, false, false, None, "{}"),
            (1, "https://a.com/3", 404, "Not Found", "", 30, "", "HTML", false, true, false, None, "{}"),
            (1, "https://a.com/4", 500, "Server Error", "", 800, "", "HTML", false, false, false, Some("host_blocked_by_detector:akamai"), "{}"),
            (1, "https://a.com/5", 200, "Pricing Page", "Plans", 250, "", "HTML", true, false, false, None, r#"{"scraper":{"price":{"value":"","appears":false}}}"#),
            (1, "https://a.com/6", 200, "Article", "Big Heading", 450, "", "HTML", true, false, false, None, r#"{"scraper":{"price":{"value":"$10","appears":true}}}"#),
            (1, "https://a.com/7", 200, "About", "About Us", 75, "", "HTML", true, false, true, None, "{}"),
            (1, "https://a.com/8", 204, "", "", 12, "", "HTML", true, false, false, None, "{}"),
            (1, "https://a.com/9", 200, "Resource", "", 90, "", "JavaScript", false, false, false, None, "{}"),
            // Different session — must NOT bleed into session 1 queries.
            (2, "https://b.com/1", 200, "Other crawl", "Hi", 10, "", "HTML", true, false, false, None, "{}"),
        ];
        for (sid, url, status, title, h1, rt, redirect, rtype, indexable, noindex, nofollow, error, seo) in rows {
            sqlx::query(
                "INSERT INTO crawl_results (session_id, url, status, title, h1, response_time, redirect_url, resource_type, is_indexable, is_noindex, is_nofollow, error, seo_json)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(sid)
            .bind(url)
            .bind(status)
            .bind(title)
            .bind(h1)
            .bind(rt)
            .bind(redirect)
            .bind(rtype)
            .bind(if indexable { 1 } else { 0 })
            .bind(if noindex { 1 } else { 0 })
            .bind(if nofollow { 1 } else { 0 })
            .bind(error)
            .bind(seo)
            .execute(pool)
            .await
            .unwrap();
        }
    }

    #[tokio::test]
    async fn empty_filter_returns_session_rows_only() {
        let pool = fixture_pool().await;
        insert_fixture_rows(&pool).await;
        let f = ResultsFilter::default();
        let rows = query_results_inner(&pool, 1, 0, 100, &f, None).await.unwrap();
        assert_eq!(rows.len(), 9, "session 2's row must be excluded");
        let count = count_results_inner(&pool, 1, &f).await.unwrap();
        assert_eq!(count, 9);
    }

    #[tokio::test]
    async fn status_range_filter() {
        let pool = fixture_pool().await;
        insert_fixture_rows(&pool).await;
        let f = ResultsFilter {
            status_min: Some(400),
            status_max: Some(600),
            ..Default::default()
        };
        let rows = query_results_inner(&pool, 1, 0, 100, &f, None).await.unwrap();
        // 404 + 500 = 2 rows
        assert_eq!(rows.len(), 2);
        let count = count_results_inner(&pool, 1, &f).await.unwrap();
        assert_eq!(count, 2);
    }

    #[tokio::test]
    async fn has_redirect_filter() {
        let pool = fixture_pool().await;
        insert_fixture_rows(&pool).await;
        let yes = ResultsFilter { has_redirect: Some(true), ..Default::default() };
        let no = ResultsFilter { has_redirect: Some(false), ..Default::default() };
        assert_eq!(count_results_inner(&pool, 1, &yes).await.unwrap(), 1);
        assert_eq!(count_results_inner(&pool, 1, &no).await.unwrap(), 8);
    }

    #[tokio::test]
    async fn indexability_filter() {
        let pool = fixture_pool().await;
        insert_fixture_rows(&pool).await;
        let idx = ResultsFilter { indexability: Some("indexable".into()), ..Default::default() };
        let nx = ResultsFilter { indexability: Some("noindex".into()), ..Default::default() };
        let nf = ResultsFilter { indexability: Some("nofollow".into()), ..Default::default() };
        let bogus = ResultsFilter { indexability: Some("garbage".into()), ..Default::default() };
        assert_eq!(count_results_inner(&pool, 1, &idx).await.unwrap(), 5);
        assert_eq!(count_results_inner(&pool, 1, &nx).await.unwrap(), 1);
        assert_eq!(count_results_inner(&pool, 1, &nf).await.unwrap(), 1);
        // Unknown indexability tokens fall through silently; total = all 9.
        assert_eq!(count_results_inner(&pool, 1, &bogus).await.unwrap(), 9);
    }

    #[tokio::test]
    async fn error_prefix_filter_targets_block_stubs() {
        let pool = fixture_pool().await;
        insert_fixture_rows(&pool).await;
        let f = ResultsFilter {
            error_prefix: Some("host_blocked_by_detector".into()),
            ..Default::default()
        };
        assert_eq!(count_results_inner(&pool, 1, &f).await.unwrap(), 1);
    }

    #[tokio::test]
    async fn text_search_matches_url_and_title_case_insensitive() {
        let pool = fixture_pool().await;
        insert_fixture_rows(&pool).await;
        // "PRICING" in title (case-insensitive) → matches "Pricing Page"
        let f = ResultsFilter { text: Some("PRICING".into()), ..Default::default() };
        let rows = query_results_inner(&pool, 1, 0, 100, &f, None).await.unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["title"], "Pricing Page");
    }

    #[tokio::test]
    async fn empty_scraper_rule_filter_finds_stale_selectors() {
        // The "scraper rule X captured 0/N" health drill must surface
        // exactly the rows where the rule failed, not the row where it
        // succeeded.
        let pool = fixture_pool().await;
        insert_fixture_rows(&pool).await;
        let f = ResultsFilter {
            empty_scraper_rule: Some("price".into()),
            ..Default::default()
        };
        let rows = query_results_inner(&pool, 1, 0, 100, &f, None).await.unwrap();
        // 8 rows total: row 5 (empty .price.value) + 7 rows where scraper.price is missing entirely.
        // The successful row 6 ("$10") must be excluded.
        assert_eq!(rows.len(), 8);
        for r in &rows {
            assert_ne!(r["url"], "https://a.com/6", "successful row must not match");
        }
    }

    #[tokio::test]
    async fn sort_by_response_time_desc_orders_correctly() {
        let pool = fixture_pool().await;
        insert_fixture_rows(&pool).await;
        let s = ResultsSort {
            column: "response_time".into(),
            direction: Some("desc".into()),
        };
        let rows = query_results_inner(&pool, 1, 0, 3, &ResultsFilter::default(), Some(&s))
            .await
            .unwrap();
        // top 3: 800 (server error), 450 (article), 250 (pricing)
        assert_eq!(rows[0]["responseTime"], 800);
        assert_eq!(rows[1]["responseTime"], 450);
        assert_eq!(rows[2]["responseTime"], 250);
    }

    #[tokio::test]
    async fn sort_falls_back_to_id_for_unwhitelisted_columns() {
        // Anything outside SORTABLE → "ORDER BY id ASC". Frontend can ask
        // for an unknown column without producing an error.
        let pool = fixture_pool().await;
        insert_fixture_rows(&pool).await;
        let s = ResultsSort {
            column: "evil; DROP TABLE crawl_results;--".into(),
            direction: None,
        };
        let rows = query_results_inner(&pool, 1, 0, 3, &ResultsFilter::default(), Some(&s))
            .await
            .unwrap();
        // First three by id ASC: rows 1/2/3.
        assert_eq!(rows[0]["url"], "https://a.com/1");
        assert_eq!(rows[1]["url"], "https://a.com/2");
        assert_eq!(rows[2]["url"], "https://a.com/3");

        // And the table still exists (the bogus column never made it into SQL).
        sqlx::query("SELECT 1 FROM crawl_results")
            .execute(&pool)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn pagination_returns_correct_window() {
        let pool = fixture_pool().await;
        insert_fixture_rows(&pool).await;
        let f = ResultsFilter::default();
        let page0 = query_results_inner(&pool, 1, 0, 3, &f, None).await.unwrap();
        let page1 = query_results_inner(&pool, 1, 3, 3, &f, None).await.unwrap();
        let page2 = query_results_inner(&pool, 1, 6, 3, &f, None).await.unwrap();
        assert_eq!(page0.len(), 3);
        assert_eq!(page1.len(), 3);
        assert_eq!(page2.len(), 3);
        // Last page is short.
        let page3 = query_results_inner(&pool, 1, 9, 3, &f, None).await.unwrap();
        assert_eq!(page3.len(), 0);
    }

    #[tokio::test]
    async fn get_result_full_merges_seo_overflow() {
        let pool = fixture_pool().await;
        insert_fixture_rows(&pool).await;
        let r = get_result_full_inner(&pool, 1, "https://a.com/6")
            .await
            .unwrap()
            .expect("row exists");
        // Both top-level columns AND seo_json fields visible in one shape.
        assert_eq!(r["url"], "https://a.com/6");
        assert_eq!(r["scraper"]["price"]["value"], "$10");
    }

    #[tokio::test]
    async fn get_result_full_returns_none_for_missing_url() {
        let pool = fixture_pool().await;
        insert_fixture_rows(&pool).await;
        let r = get_result_full_inner(&pool, 1, "https://nope.com").await.unwrap();
        assert!(r.is_none());
    }

    #[tokio::test]
    async fn issues_only_filter_matches_legacy_predicate() {
        // Legacy "Issues" tab: !title || !h1 || !meta_description || status >= 400 || isNoindex.
        // Fixture rows that should match:
        //   row 2 (h1 = "")                                 ✓
        //   row 3 (h1 = "" AND status 404)                  ✓
        //   row 4 (h1 = "" AND status 500)                  ✓
        //   row 8 (title = "" AND h1 = "")                  ✓
        //   row 9 (h1 = "")                                 ✓
        //   row 5 (Pricing Page / "Plans") — no missing fields, status 200, indexable.
        //     But meta_description = '' (default) → matches.  ✓
        //   rows 1, 6, 7 — all have h1, no status problem, but meta_description = '' → match.
        // So all rows that have an empty meta_description match. Fixture
        // never sets meta_description, which means all rows have ''.
        // → all 9 rows in session 1 match the issues predicate.
        let pool = fixture_pool().await;
        insert_fixture_rows(&pool).await;
        let f = ResultsFilter { issues_only: Some(true), ..Default::default() };
        assert_eq!(count_results_inner(&pool, 1, &f).await.unwrap(), 9);

        // Force a clean row by inserting one with everything filled.
        sqlx::query(
            "INSERT INTO crawl_results (session_id, url, status, title, h1, meta_description, is_indexable)
             VALUES (1, 'https://clean.com', 200, 'OK', 'OK', 'present', 1)"
        )
        .execute(&pool)
        .await
        .unwrap();
        // Issues count unchanged (10 rows, 9 issues, 1 clean).
        assert_eq!(count_results_inner(&pool, 1, &f).await.unwrap(), 9);
    }

    #[tokio::test]
    async fn url_in_filter_powers_recrawl_queue_tab() {
        let pool = fixture_pool().await;
        insert_fixture_rows(&pool).await;
        // Pick three urls; the rest are excluded.
        let f = ResultsFilter {
            url_in: Some(vec![
                "https://a.com/1".into(),
                "https://a.com/3".into(),
                "https://a.com/8".into(),
            ]),
            ..Default::default()
        };
        let rows = query_results_inner(&pool, 1, 0, 100, &f, None).await.unwrap();
        assert_eq!(rows.len(), 3);
        let urls: Vec<&str> = rows.iter().map(|r| r["url"].as_str().unwrap()).collect();
        assert!(urls.contains(&"https://a.com/1"));
        assert!(urls.contains(&"https://a.com/3"));
        assert!(urls.contains(&"https://a.com/8"));
    }

    #[tokio::test]
    async fn url_in_empty_returns_no_rows_not_a_syntax_error() {
        // An empty Recrawl Queue should be selectable without erroring.
        let pool = fixture_pool().await;
        insert_fixture_rows(&pool).await;
        let f = ResultsFilter {
            url_in: Some(vec![]),
            ..Default::default()
        };
        assert_eq!(count_results_inner(&pool, 1, &f).await.unwrap(), 0);
    }

    #[tokio::test]
    async fn query_results_includes_scraper_overflow_from_seo_json() {
        // The grid renders user-defined scraper columns directly off the
        // row's `scraper` field — that field lives in seo_json, not as a
        // top-level column. Verifying the merge here protects against
        // silent regressions when query_results' SELECT shape changes.
        let pool = fixture_pool().await;
        insert_fixture_rows(&pool).await;
        let rows = query_results_inner(&pool, 1, 0, 100, &ResultsFilter::default(), None)
            .await
            .unwrap();
        let row6 = rows.iter().find(|r| r["url"] == "https://a.com/6").unwrap();
        assert_eq!(row6["scraper"]["price"]["value"], "$10");
        let row5 = rows.iter().find(|r| r["url"] == "https://a.com/5").unwrap();
        assert_eq!(row5["scraper"]["price"]["value"], "");
    }

    #[tokio::test]
    async fn query_all_results_returns_every_row_with_seo_overflow() {
        let pool = fixture_pool().await;
        insert_fixture_rows(&pool).await;
        let rows = query_all_results_inner(&pool, 1).await.unwrap();
        assert_eq!(rows.len(), 9, "session 1 only");
        // Seo overflow merged.
        let row6 = rows.iter().find(|r| r["url"] == "https://a.com/6").unwrap();
        assert_eq!(row6["scraper"]["price"]["value"], "$10");
    }

    #[tokio::test]
    async fn distinct_status_codes_excludes_zero_and_other_sessions() {
        let pool = fixture_pool().await;
        insert_fixture_rows(&pool).await;
        // Add one row with status 0 (request never got a response) — must NOT
        // appear in the dropdown (a 0 isn't a useful code to filter by).
        sqlx::query(
            "INSERT INTO crawl_results (session_id, url, status) VALUES (1, 'https://x', 0)",
        )
        .execute(&pool)
        .await
        .unwrap();
        let codes = distinct_status_codes_inner(&pool, 1).await.unwrap();
        assert_eq!(codes, vec![200, 204, 301, 404, 500]);
    }

    #[tokio::test]
    async fn aggregate_resource_types_counts_by_type() {
        let pool = fixture_pool().await;
        insert_fixture_rows(&pool).await;
        let agg = aggregate_resource_types_inner(&pool, 1).await.unwrap();
        // 8 HTML rows (rows 1-8) + 1 JavaScript (row 9).
        let html = agg.iter().find(|(t, _)| t == "HTML").unwrap();
        let js = agg.iter().find(|(t, _)| t == "JavaScript").unwrap();
        assert_eq!(html.1, 8);
        assert_eq!(js.1, 1);
        // Sorted descending by count: HTML first.
        assert_eq!(agg[0].0, "HTML");
    }

    #[tokio::test]
    async fn aggregate_health_computes_every_card_in_one_query() {
        let pool = fixture_pool().await;
        insert_fixture_rows(&pool).await;
        let h = aggregate_health_inner(&pool, 1).await.unwrap();
        assert_eq!(h.total, 9);
        // 5 rows in 200..300 (rows 1, 5, 6, 7, 9 = 200; row 8 = 204) = 6
        assert_eq!(h.status_2xx, 6);
        assert_eq!(h.status_3xx, 1);
        assert_eq!(h.status_4xx, 1);
        assert_eq!(h.status_5xx, 1);
        assert_eq!(h.errors, 1);
        assert_eq!(h.redirects, 1);
        assert_eq!(h.indexable, 5);
        assert_eq!(h.noindex, 1);
        assert_eq!(h.nofollow, 1);
        // Empty h1 rows: 2, 3, 5 (Plans), 6, 8, 9 → wait, let me check fixture.
        // h1 values in fixture: "Hello", "", "", "", "Plans", "Big Heading", "About Us", "", ""
        // Empty: rows 2,3,4,8,9 → 5 rows.
        assert_eq!(h.empty_h1, 5);
        // Empty title: only row 8 → 1.
        assert_eq!(h.empty_title, 1);
        assert_eq!(h.max_response_time, 800);
        assert!(h.avg_response_time > 0.0);
    }
}
