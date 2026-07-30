// Streaming exporter for crawl results — Screaming-Frog-style flat output.
//
// Shape (see `Stream`): one row per URL in the main file, and one file per
// unbounded relation. Nothing is left as a JSON blob in a cell, and nothing
// derived/heuristic is emitted — only raw observed facts, so the reader can
// apply their own judgement about noindex / canonicals / robots.
//
//   crawl.csv                  one row per URL, ~140 flat columns
//   crawl-outlinks.csv         source_url, target_url, link_scope
//   crawl-failed-requests.csv  page_url, resource_url
//   crawl-console.csv          page_url, message
//
// Bounded repeating fields are numbered inline (hreflang_1_lang/_url, …) and
// sized to the widest row in the session. responseHeaders and metaTags become
// one `header:<name>` / `meta:<name>` column per key actually present — this
// needs a discovery pass (`discover_schema`) before any row is written.
//
// Every output is produced by its own keyset-paginated pass over the session
// (`write_stream`). One pass per file rather than four open writers because
// zip entries must be written sequentially — a single code path serves both
// the bare-file and bundle destinations.
//
// Speed notes for big sessions (CR.org-class crawls):
//  - Destination is wrapped in a 1 MiB BufWriter so neither csv::Writer
//    nor zip::ZipWriter pay a syscall per write.
//  - The CSV entries inside the bundle are **stored, not deflated**: on a
//    multi-GB CSV the level-6 deflate is CPU-bound and dominates wall
//    time. Stored-only exports trade ~3x file size for a large speedup.
//    Images are stored too (already-compressed JPEG/PNG).
//  - sqlx `.fetch()` streams rows; we never materialize a page in a Vec.
//
// Progress callback fires every 1000 rows / every image.

use std::collections::{BTreeSet, HashSet};
use std::fs::File;
use std::io::{BufReader, BufWriter, Seek, Write};
use std::path::{Path, PathBuf};

use futures_util::TryStreamExt;
use serde_json::Value;
use sqlx::{Row, SqlitePool};
use zip::write::SimpleFileOptions;

use crate::db_query::{
    bind_value, build_where, merge_seo_overflow, row_to_json, RESULT_COLUMNS, ResultsFilter,
};

const PAGE_SIZE: i64 = 20_000;
const PROGRESS_EVERY: u64 = 1000;
const IMG_PROGRESS_EVERY: u64 = 50;
const BUF_CAPACITY: usize = 1 << 20; // 1 MiB
const IMG_READ_BUF: usize = 128 * 1024; // 128 KiB — coalesces small-image syscalls

/// Which output file a pass is producing.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Stream {
    Main,
    Outlinks,
    FailedRequests,
    Console,
}

impl Stream {
    /// Suffix appended to the destination stem. Main keeps the bare name.
    pub fn suffix(self) -> &'static str {
        match self {
            Stream::Main => "",
            Stream::Outlinks => "-outlinks",
            Stream::FailedRequests => "-failed-requests",
            Stream::Console => "-console",
        }
    }

    pub const ALL: [Stream; 4] = [
        Stream::Main,
        Stream::Outlinks,
        Stream::FailedRequests,
        Stream::Console,
    ];
}

#[derive(Default, Clone, Copy)]
pub struct ExportProgress {
    pub rows_written: u64,
    pub bytes_written: u64,
    pub images_written: u64,
}

pub enum ExportPhase {
    Csv,
    Images,
    Done,
}

// ---------------------------------------------------------------- schema

/// Fixed columns, in reading order: identity → indexability → content →
/// links → open graph → dates → structured data → perf → relation counts.
/// `(column name, seo/row JSON key)`; a key of "" is computed in `flat_record`.
const CORE: &[(&str, &str)] = &[
    ("url", "url"),
    ("status", "status"),
    ("content_type", "contentType"),
    ("resource_type", "resourceType"),
    ("size", "size"),
    ("response_time", "responseTime"),
    ("crawl_depth", "crawlDepth"),
    ("in_sitemap", "inSitemap"),
    ("error", "error"),
    ("id", "id"),
    // Indexability inputs only — no isIndexable/isNoindex/max-* derivations.
    ("blocked_by_robots", "blockedByRobots"),
    ("meta_robots", "metaRobots"),
    ("meta_googlebot", "metaGooglebot"),
    ("x_robots_tag", "xRobotsTag"),
    ("canonical", "canonical"),
    ("canonical_is_self", ""),
    ("redirect_url", "redirectUrl"),
    ("title", "title"),
    ("title_length", ""),
    ("h1", "h1"),
    ("h1_count", "h1Count"),
    ("h2", "h2"),
    ("h2_count", "h2Count"),
    ("meta_description", "metaDescription"),
    ("meta_description_length", ""),
    ("word_count", "wordCount"),
    ("content_hash", "contentHash"),
    ("internal_links", "internalLinks"),
    ("external_links", "externalLinks"),
    ("image_count", "imageCount"),
    ("images_missing_alt", "imagesMissingAlt"),
    ("missing_alt_images", "missingAltImages"),
    ("og_title", "ogTitle"),
    ("og_description", "ogDescription"),
    ("og_type", "ogType"),
    ("og_url", "ogUrl"),
    ("og_image", "ogImage"),
    ("og_image_width", "ogImageWidth"),
    ("og_image_height", "ogImageHeight"),
    ("og_image_width_real", "ogImageWidthReal"),
    ("og_image_height_real", "ogImageHeightReal"),
    ("og_image_file_size", "ogImageFileSize"),
    ("date_published", "datePublished"),
    ("date_modified", "dateModified"),
    ("date_published_time", "datePublishedTime"),
    ("date_modified_time", "dateModifiedTime"),
    ("server_header", "serverHeader"),
    ("structured_data_count", ""),
    ("structured_data_types", "structuredDataTypes"),
    ("perf_ttfb", ""),
    ("perf_dom_content_loaded", ""),
    ("perf_load_time", ""),
    ("perf_fcp", ""),
    ("perf_lcp", ""),
    ("perf_cls", ""),
    ("outlink_count", ""),
    ("hreflang_count", ""),
    ("failed_request_count", ""),
    ("console_error_count", ""),
    ("js_error_count", ""),
    ("js_errors", "jsErrors"),
];

/// (column suffix, key inside the `perf` object).
const PERF_KEYS: &[(&str, &str)] = &[
    ("perf_ttfb", "ttfb"),
    ("perf_dom_content_loaded", "domContentLoaded"),
    ("perf_load_time", "loadTime"),
    ("perf_fcp", "fcp"),
    ("perf_lcp", "lcp"),
    ("perf_cls", "cls"),
];

/// JSON keys fully accounted for by `CORE`, the discovered columns, or the
/// companion files. Anything else found in a row becomes its own trailing
/// column so a new sidecar field can never be silently dropped again.
fn handled_keys() -> HashSet<&'static str> {
    let mut s: HashSet<&'static str> = CORE.iter().map(|(_, k)| *k).collect();
    for k in [
        "outlinks",
        "failedRequests",
        "consoleErrors",
        "metaTags",
        "responseHeaders",
        "hreflang",
        "redirectChain",
        "perf",
        // Redundant now that every response header is its own column.
        "securityHeaders",
        // Internal probe/telemetry detail, not a page fact.
        "scraper",
        // Derived verdicts, deliberately NOT exported: they're the crawler's
        // interpretation, and the raw inputs it read (meta_robots, googlebot,
        // x_robots_tag, canonical, blocked_by_robots) are all columns already.
        // Listed here so the extra_keys overflow can't reintroduce them.
        "isIndexable",
        "isNoindex",
        "isNofollow",
    ] {
        s.insert(k);
    }
    s.remove("");
    s
}

/// Column set discovered from the session. Built by a full pass before any
/// row is written, so header/meta columns match the site exactly.
pub struct ExportSchema {
    header_keys: Vec<String>,
    meta_keys: Vec<String>,
    extra_keys: Vec<String>,
    max_hreflang: usize,
    max_redirect: usize,
}

impl ExportSchema {
    /// Main-file column names, in output order.
    pub fn columns(&self) -> Vec<String> {
        let mut c: Vec<String> = CORE.iter().map(|(n, _)| (*n).to_string()).collect();
        for i in 1..=self.max_redirect {
            c.push(format!("redirect_{i}"));
        }
        for i in 1..=self.max_hreflang {
            c.push(format!("hreflang_{i}_lang"));
            c.push(format!("hreflang_{i}_url"));
        }
        c.extend(self.header_keys.iter().map(|k| format!("header:{k}")));
        c.extend(self.meta_keys.iter().map(|k| format!("meta:{k}")));
        c.extend(self.extra_keys.iter().cloned());
        c
    }
}

/// Pass 1 — collect every response-header name, meta-tag name, the widest
/// hreflang/redirect-chain row, and any row key `CORE` doesn't cover.
pub async fn discover_schema(
    pool: &SqlitePool,
    session_id: i64,
    filter: Option<&ResultsFilter>,
) -> Result<ExportSchema, String> {
    let handled = handled_keys();
    let mut header_keys: BTreeSet<String> = BTreeSet::new();
    let mut meta_keys: BTreeSet<String> = BTreeSet::new();
    let mut extra_keys: BTreeSet<String> = BTreeSet::new();
    let mut max_hreflang = 0usize;
    let mut max_redirect = 0usize;

    for_each_row(pool, session_id, filter, |v| {
        if let Some(Value::Object(h)) = v.get("responseHeaders") {
            for k in h.keys() {
                header_keys.insert(k.to_lowercase());
            }
        }
        if let Some(Value::Array(tags)) = v.get("metaTags") {
            for t in tags {
                if let Some(k) = meta_tag_key(t) {
                    meta_keys.insert(k);
                }
            }
        }
        if let Some(Value::Array(a)) = v.get("hreflang") {
            max_hreflang = max_hreflang.max(a.len());
        }
        if let Some(Value::Array(a)) = v.get("redirectChain") {
            max_redirect = max_redirect.max(a.len());
        }
        if let Value::Object(obj) = v {
            for k in obj.keys() {
                if !handled.contains(k.as_str()) {
                    extra_keys.insert(k.clone());
                }
            }
        }
    })
    .await?;

    Ok(ExportSchema {
        header_keys: header_keys.into_iter().collect(),
        meta_keys: meta_keys.into_iter().collect(),
        extra_keys: extra_keys.into_iter().collect(),
        max_hreflang,
        max_redirect,
    })
}

/// name → property → http-equiv, lowercased. Mirrors what the sidecar records.
fn meta_tag_key(t: &Value) -> Option<String> {
    for field in ["name", "property", "httpEquiv"] {
        if let Some(s) = t.get(field).and_then(|x| x.as_str()) {
            if !s.is_empty() {
                return Some(s.to_lowercase());
            }
        }
    }
    None
}

// ---------------------------------------------------------------- helpers

/// Collapse all whitespace runs to single spaces so one record stays one
/// grep-able line — titles and meta descriptions routinely carry newlines.
fn norm(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Neutralize spreadsheet formula injection. Excel and LibreOffice evaluate a
/// cell whose text starts with `=`, `+`, `-`, `@`, tab or CR, and every string
/// here is attacker-controlled — titles, meta descriptions and response headers
/// come from crawled third-party pages. A leading apostrophe makes the cell
/// literal text. Values that parse as numbers are left alone so a legitimate
/// `-1` stays numeric.
fn defuse(s: String) -> String {
    let Some(first) = s.chars().next() else {
        return s;
    };
    if !matches!(first, '=' | '+' | '-' | '@' | '\t' | '\r') || s.parse::<f64>().is_ok() {
        return s;
    }
    let mut out = String::with_capacity(s.len() + 1);
    out.push('\'');
    out.push_str(&s);
    out
}

fn cell(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::String(s) => defuse(norm(s)),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        // Only reached for the discovered `extra_keys` overflow columns.
        Value::Array(_) | Value::Object(_) => defuse(norm(&v.to_string())),
    }
}

fn get_str(v: &Value, k: &str) -> String {
    v.get(k).map(cell).unwrap_or_default()
}

fn arr_len(v: &Value, k: &str) -> usize {
    match v.get(k) {
        Some(Value::Array(a)) => a.len(),
        _ => 0,
    }
}

/// Host comparison for classifying an outlink, without pulling in a URL crate.
fn host_of(u: &str) -> &str {
    let rest = u
        .split_once("://")
        .map(|(_, r)| r)
        .unwrap_or(u);
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    &rest[..end]
}

/// A trailing slash is not a canonical difference worth flagging.
fn trim_slash(s: &str) -> &str {
    s.strip_suffix('/').unwrap_or(s)
}

fn flat_record(v: &Value, schema: &ExportSchema, cols: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::with_capacity(cols.len());

    let title = get_str(v, "title");
    let meta_desc = get_str(v, "metaDescription");
    let canonical = get_str(v, "canonical");
    let url = get_str(v, "url");

    for (name, key) in CORE {
        let s = match *name {
            "title" => title.clone(),
            "meta_description" => meta_desc.clone(),
            // char count, not bytes — this is a content-length check
            "title_length" => title.chars().count().to_string(),
            "meta_description_length" => meta_desc.chars().count().to_string(),
            "canonical_is_self" => {
                if canonical.is_empty() {
                    String::new()
                } else {
                    (trim_slash(&canonical) == trim_slash(&url)).to_string()
                }
            }
            "structured_data_count" => arr_len(v, "structuredDataTypes").to_string(),
            "structured_data_types" => join_str_array(v, "structuredDataTypes"),
            "js_errors" => join_str_array(v, "jsErrors"),
            "missing_alt_images" => join_str_array(v, "missingAltImages"),
            "outlink_count" => arr_len(v, "outlinks").to_string(),
            "hreflang_count" => arr_len(v, "hreflang").to_string(),
            "failed_request_count" => arr_len(v, "failedRequests").to_string(),
            "console_error_count" => arr_len(v, "consoleErrors").to_string(),
            "js_error_count" => arr_len(v, "jsErrors").to_string(),
            n if n.starts_with("perf_") => {
                let pk = PERF_KEYS.iter().find(|(c, _)| *c == n).map(|(_, k)| *k);
                match (v.get("perf"), pk) {
                    (Some(p), Some(k)) => p.get(k).map(cell).unwrap_or_default(),
                    _ => String::new(),
                }
            }
            _ => get_str(v, key),
        };
        out.push(s);
    }

    // redirect_1..N
    let chain = v.get("redirectChain").and_then(|x| x.as_array());
    for i in 0..schema.max_redirect {
        out.push(chain.and_then(|a| a.get(i)).map(cell).unwrap_or_default());
    }

    // hreflang_N_lang / _url
    let hl = v.get("hreflang").and_then(|x| x.as_array());
    for i in 0..schema.max_hreflang {
        let entry = hl.and_then(|a| a.get(i));
        out.push(entry.map(|e| get_str(e, "lang")).unwrap_or_default());
        out.push(entry.map(|e| get_str(e, "href")).unwrap_or_default());
    }

    // header:<name>
    let headers = v.get("responseHeaders");
    for k in &schema.header_keys {
        let val = headers.and_then(|h| h.as_object()).and_then(|o| {
            o.iter()
                .find(|(hk, _)| hk.to_lowercase() == *k)
                .map(|(_, hv)| cell(hv))
        });
        out.push(val.unwrap_or_default());
    }

    // meta:<name> — a name can repeat on one page (og:image, fb:pages), so
    // every occurrence is kept, joined, rather than last-write-wins.
    let tags = v.get("metaTags").and_then(|x| x.as_array());
    for k in &schema.meta_keys {
        let joined = tags
            .map(|a| {
                a.iter()
                    .filter(|t| meta_tag_key(t).as_deref() == Some(k.as_str()))
                    .map(|t| get_str(t, "content"))
                    .filter(|s| !s.is_empty())
                    .collect::<Vec<_>>()
                    .join(" | ")
            })
            .unwrap_or_default();
        out.push(joined);
    }

    for k in &schema.extra_keys {
        out.push(get_str(v, k));
    }

    debug_assert_eq!(out.len(), cols.len(), "record width must match header");
    out
}

fn join_str_array(v: &Value, key: &str) -> String {
    match v.get(key) {
        Some(Value::Array(a)) => a
            .iter()
            .map(cell)
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join(" | "),
        _ => String::new(),
    }
}

// ---------------------------------------------------------------- passes

/// Keyset-paginated scan of one session, calling `f` with each row's merged
/// JSON. Shared by the discovery pass and every write pass.
async fn for_each_row<F: FnMut(&Value)>(
    pool: &SqlitePool,
    session_id: i64,
    filter: Option<&ResultsFilter>,
    mut f: F,
) -> Result<(), String> {
    let (extra_clauses, extra_binds) = match filter {
        Some(fl) => {
            let mut c = Vec::new();
            let mut b = Vec::new();
            build_where(fl, &mut c, &mut b);
            (c, b)
        }
        None => (Vec::new(), Vec::new()),
    };
    let extra_where = if extra_clauses.is_empty() {
        String::new()
    } else {
        format!(" AND {}", extra_clauses.join(" AND "))
    };
    let sql = format!(
        "SELECT {cols}, seo_json FROM crawl_results \
         WHERE session_id = ? AND id > ?{extra} ORDER BY id ASC LIMIT ?",
        cols = RESULT_COLUMNS,
        extra = extra_where,
    );

    let mut last_id: i64 = 0;
    loop {
        let mut q = sqlx::query(&sql).bind(session_id).bind(last_id);
        for v in &extra_binds {
            q = bind_value(q, v);
        }
        q = q.bind(PAGE_SIZE);

        let mut stream = q.fetch(pool);
        let mut produced: i64 = 0;
        while let Some(r) = stream
            .try_next()
            .await
            .map_err(|e| format!("export query: {e}"))?
        {
            last_id = r.try_get::<i64, _>("id").unwrap_or(last_id);
            let mut v = row_to_json(&r);
            let seo_str: String = r.try_get("seo_json").unwrap_or_default();
            merge_seo_overflow(&mut v, &seo_str);
            f(&v);
            produced += 1;
        }
        if produced < PAGE_SIZE {
            break;
        }
    }
    Ok(())
}

/// Write one output file. `schema` is only consulted for `Stream::Main`.
pub async fn write_stream<W: Write, F: FnMut(&ExportProgress, ExportPhase)>(
    pool: &SqlitePool,
    session_id: i64,
    filter: Option<&ResultsFilter>,
    stream: Stream,
    schema: &ExportSchema,
    mut writer: W,
    mut on_progress: F,
) -> Result<ExportProgress, String> {
    // UTF-8 BOM: without it Excel on Windows decodes the file as the local
    // ANSI codepage, so any non-ASCII title (Café, CJK, curly quotes) opens as
    // mojibake. Screaming Frog writes one too.
    writer
        .write_all(&[0xEF, 0xBB, 0xBF])
        .map_err(|e| format!("write bom: {e}"))?;
    let mut w = csv::Writer::from_writer(writer);
    let mut prog = ExportProgress::default();
    let cols = schema.columns();

    match stream {
        Stream::Main => w.write_record(&cols),
        Stream::Outlinks => w.write_record(["source_url", "target_url", "link_scope"]),
        Stream::FailedRequests => w.write_record(["page_url", "resource_url"]),
        Stream::Console => w.write_record(["page_url", "message"]),
    }
    .map_err(|e| format!("write csv header: {e}"))?;

    // csv::Writer errors are captured here because `for_each_row` takes a
    // plain FnMut — the first failure short-circuits the remaining rows.
    let mut err: Option<String> = None;
    for_each_row(pool, session_id, filter, |v| {
        if err.is_some() {
            return;
        }
        let url = get_str(v, "url");
        let res = match stream {
            Stream::Main => w.write_record(&flat_record(v, schema, &cols)),
            Stream::Outlinks => write_children(&mut w, v, "outlinks", &url, true),
            Stream::FailedRequests => write_children(&mut w, v, "failedRequests", &url, false),
            Stream::Console => write_children(&mut w, v, "consoleErrors", &url, false),
        };
        if let Err(e) = res {
            err = Some(format!("write csv row: {e}"));
            return;
        }
        prog.rows_written += 1;
        if prog.rows_written % PROGRESS_EVERY == 0 {
            on_progress(&prog, ExportPhase::Csv);
        }
    })
    .await?;
    if let Some(e) = err {
        return Err(e);
    }

    w.flush().map_err(|e| format!("flush csv: {e}"))?;
    on_progress(&prog, ExportPhase::Csv);
    Ok(prog)
}

/// Emit one companion row per element of `key`. `scope` adds the
/// internal/external classification the outlinks file carries.
fn write_children<W: Write>(
    w: &mut csv::Writer<W>,
    v: &Value,
    key: &str,
    url: &str,
    scope: bool,
) -> Result<(), csv::Error> {
    let Some(Value::Array(items)) = v.get(key) else {
        return Ok(());
    };
    let page_host = host_of(url);
    for it in items {
        let val = cell(it);
        if scope {
            let s = if host_of(&val) == page_host {
                "internal"
            } else {
                "external"
            };
            w.write_record([url, &val, s])?;
        } else {
            w.write_record([url, &val])?;
        }
    }
    Ok(())
}

/// Sibling scratch path an export streams into before being renamed into
/// place. Same directory, so the rename stays on one filesystem.
fn part_path(path: &Path) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(".part");
    path.with_file_name(name)
}

/// Export a session to `dest_path` plus its companion files, named by
/// appending each stream's suffix to the destination stem.
pub async fn write_flat_export<F: FnMut(&ExportProgress, ExportPhase)>(
    pool: &SqlitePool,
    session_id: i64,
    filter: Option<&ResultsFilter>,
    dest_path: &Path,
    mut on_progress: F,
) -> Result<(ExportProgress, Vec<PathBuf>), String> {
    let schema = discover_schema(pool, session_id, filter).await?;
    let stem = dest_path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "crawl".into());
    let dir = dest_path.parent().unwrap_or_else(|| Path::new("."));
    let ext = dest_path
        .extension()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "csv".into());

    let mut main_prog = ExportProgress::default();

    // Every stream streams into a `.part` sibling and is renamed into place
    // only once all of them have finished. A mid-export failure (disk full,
    // io error) then leaves the user's previous export untouched instead of
    // a truncated file that looks like a complete one.
    let written: Vec<PathBuf> = Stream::ALL
        .iter()
        .map(|stream| {
            if *stream == Stream::Main {
                dest_path.to_path_buf()
            } else {
                dir.join(format!("{stem}{}.{ext}", stream.suffix()))
            }
        })
        .collect();
    let temps: Vec<PathBuf> = written.iter().map(|p| part_path(p)).collect();

    let mut failure: Option<String> = None;
    for ((stream, path), temp) in Stream::ALL.iter().zip(written.iter()).zip(temps.iter()) {
        let attempt: Result<ExportProgress, String> = async {
            let file =
                File::create(temp).map_err(|e| format!("create {}: {e}", temp.display()))?;
            let buf = BufWriter::with_capacity(BUF_CAPACITY, file);
            write_stream(
                pool,
                session_id,
                filter,
                *stream,
                &schema,
                buf,
                |p, ph| on_progress(p, ph),
            )
            .await
        }
        .await;
        match attempt {
            Ok(prog) => {
                if *stream == Stream::Main {
                    main_prog = prog;
                }
            }
            Err(e) => {
                failure = Some(format!("{}: {e}", path.display()));
                break;
            }
        }
    }

    if let Some(e) = failure {
        for temp in &temps {
            let _ = std::fs::remove_file(temp);
        }
        return Err(e);
    }

    for (temp, path) in temps.iter().zip(written.iter()) {
        std::fs::rename(temp, path)
            .map_err(|e| format!("finalize {}: {e}", path.display()))?;
    }

    // Sum the finalized files. `write_stream` can't report this itself — it
    // writes through a BufWriter it doesn't own — and leaving it unset made
    // every CSV export report 0 bytes to the UI.
    main_prog.bytes_written = written
        .iter()
        .filter_map(|p| std::fs::metadata(p).ok())
        .map(|m| m.len())
        .sum();

    on_progress(&main_prog, ExportPhase::Done);
    Ok((main_prog, written))
}

/// Wrap dest file in a 1 MiB BufWriter and write the bundle. CSV entries are
/// **Stored** (not Deflated) — on multi-GB exports, deflate dominates
/// wall time and the user can recompress externally if size matters.
pub async fn write_bundle<F: FnMut(&ExportProgress, ExportPhase)>(
    pool: &SqlitePool,
    session_id: i64,
    og_dir: &Path,
    dest: File,
    mut on_progress: F,
) -> Result<ExportProgress, String> {
    let schema = discover_schema(pool, session_id, None).await?;
    let buf = BufWriter::with_capacity(BUF_CAPACITY, dest);
    let mut zip = zip::ZipWriter::new(buf);
    // `large_file` forces zip64 headers. Entries are Stored, so an entry's
    // byte count is the raw CSV size — without this, any stream over 4 GiB
    // aborts mid-entry with "Large file option has not been set".
    let stored = SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Stored)
        .large_file(true);

    let mut prog = ExportProgress::default();
    for stream in Stream::ALL {
        let name = format!("crawl{}.csv", stream.suffix());
        zip.start_file(&name, stored)
            .map_err(|e| format!("zip start {name}: {e}"))?;
        let p = write_stream(pool, session_id, None, stream, &schema, &mut zip, |p, ph| {
            on_progress(p, ph)
        })
        .await?;
        if stream == Stream::Main {
            prog = p;
        }
    }

    if og_dir.is_dir() {
        let mut stack: Vec<PathBuf> = vec![og_dir.to_path_buf()];
        while let Some(dir) = stack.pop() {
            let entries = match std::fs::read_dir(&dir) {
                Ok(e) => e,
                Err(e) => return Err(format!("read_dir {}: {e}", dir.display())),
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    stack.push(path);
                    continue;
                }
                let rel = path
                    .strip_prefix(og_dir)
                    .map_err(|e| format!("strip_prefix: {e}"))?;
                let zip_path = format!("og-images/{}", rel.to_string_lossy().replace('\\', "/"));
                zip.start_file(&zip_path, stored)
                    .map_err(|e| format!("zip start {zip_path}: {e}"))?;
                let f = File::open(&path)
                    .map_err(|e| format!("open {}: {e}", path.display()))?;
                let mut f = BufReader::with_capacity(IMG_READ_BUF, f);
                std::io::copy(&mut f, &mut zip)
                    .map_err(|e| format!("copy {}: {e}", path.display()))?;
                prog.images_written += 1;
                if prog.images_written % IMG_PROGRESS_EVERY == 0 {
                    on_progress(&prog, ExportPhase::Images);
                }
            }
        }
        // Final image-phase tick so the UI's last-known count matches the
        // actual total even when it's not a multiple of IMG_PROGRESS_EVERY.
        if prog.images_written > 0 {
            on_progress(&prog, ExportPhase::Images);
        }
    }

    let mut buf = zip
        .finish()
        .map_err(|e| format!("finish zip: {e}"))?;
    buf.flush().map_err(|e| format!("flush bundle: {e}"))?;
    let mut final_file = buf
        .into_inner()
        .map_err(|e| format!("unwrap bufwriter: {e}"))?;
    prog.bytes_written = final_file.stream_position().unwrap_or(0);
    on_progress(&prog, ExportPhase::Done);
    Ok(prog)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // A crawled page controls its own title, so an export must not hand Excel
    // a live formula. Numbers stay untouched or numeric columns break.
    #[test]
    fn cell_defuses_formulas_but_not_numbers() {
        let f = |s: &str| cell(&json!(s));
        assert_eq!(f("=HYPERLINK(\"http://evil\",\"x\")"), "'=HYPERLINK(\"http://evil\",\"x\")");
        assert_eq!(f("+1+1"), "'+1+1");
        assert_eq!(f("@SUM(A1)"), "'@SUM(A1)");
        assert_eq!(f("-2+3"), "'-2+3");

        // Left alone: ordinary text and anything that parses as a number.
        assert_eq!(f("-42"), "-42");
        assert_eq!(f("-3.5e2"), "-3.5e2");
        assert_eq!(f("Normal title"), "Normal title");
        assert_eq!(f(""), "");
        assert_eq!(cell(&json!(-7)), "-7");
    }

    fn schema_for(rows: &[Value]) -> ExportSchema {
        let handled = handled_keys();
        let mut header_keys = BTreeSet::new();
        let mut meta_keys = BTreeSet::new();
        let mut extra_keys = BTreeSet::new();
        let (mut max_hreflang, mut max_redirect) = (0, 0);
        for v in rows {
            if let Some(Value::Object(h)) = v.get("responseHeaders") {
                header_keys.extend(h.keys().map(|k| k.to_lowercase()));
            }
            if let Some(Value::Array(t)) = v.get("metaTags") {
                meta_keys.extend(t.iter().filter_map(meta_tag_key));
            }
            max_hreflang = max_hreflang.max(arr_len(v, "hreflang"));
            max_redirect = max_redirect.max(arr_len(v, "redirectChain"));
            if let Value::Object(o) = v {
                for k in o.keys() {
                    if !handled.contains(k.as_str()) {
                        extra_keys.insert(k.clone());
                    }
                }
            }
        }
        ExportSchema {
            header_keys: header_keys.into_iter().collect(),
            meta_keys: meta_keys.into_iter().collect(),
            extra_keys: extra_keys.into_iter().collect(),
            max_hreflang,
            max_redirect,
        }
    }

    fn row() -> Value {
        json!({
            "url": "https://ex.com/a/",
            "status": 200,
            "title": "Hello\n  World",
            "canonical": "https://ex.com/a",
            "metaDescription": "desc",
            "hreflang": [{"lang": "en", "href": "https://ex.com/a"},
                         {"lang": "de", "href": "https://de.ex.com/a"}],
            "responseHeaders": {"Content-Type": "text/html", "X-Cache": "Hit"},
            "metaTags": [
                {"name": "robots", "content": "noindex"},
                {"property": "og:image", "content": "a.png"},
                {"property": "og:image", "content": "b.png"}
            ],
            "outlinks": ["https://ex.com/b", "https://other.com/c"],
            "consoleErrors": ["boom"],
            "failedRequests": [],
            "redirectChain": [],
            "structuredDataTypes": ["Article", "WebPage"],
            "perf": {"ttfb": 12, "lcp": 900},
        })
    }

    #[test]
    fn record_width_matches_header() {
        let r = row();
        let s = schema_for(&[r.clone()]);
        let cols = s.columns();
        assert_eq!(flat_record(&r, &s, &cols).len(), cols.len());
    }

    #[test]
    fn no_derived_indexability_columns() {
        let s = schema_for(&[row()]);
        let cols = s.columns();
        for banned in [
            "is_indexable", "isIndexable", "is_noindex", "isNoindex",
            "max_snippet", "maxSnippet", "security_headers", "securityHeaders",
        ] {
            assert!(!cols.iter().any(|c| c == banned), "{banned} must not be exported");
        }
        // ...but the raw inputs must be present.
        for required in ["meta_robots", "x_robots_tag", "blocked_by_robots", "canonical"] {
            assert!(cols.iter().any(|c| c == required), "{required} missing");
        }
    }

    #[test]
    fn no_cell_contains_json() {
        let r = row();
        let s = schema_for(&[r.clone()]);
        let rec = flat_record(&r, &s, &s.columns());
        for c in &rec {
            assert!(!c.starts_with("[{") && !c.starts_with("{\""), "leaked JSON: {c}");
        }
    }

    #[test]
    fn newlines_collapsed_to_single_line() {
        let r = row();
        let s = schema_for(&[r.clone()]);
        let cols = s.columns();
        let rec = flat_record(&r, &s, &cols);
        let i = cols.iter().position(|c| c == "title").unwrap();
        assert_eq!(rec[i], "Hello World");
    }

    #[test]
    fn hreflang_and_headers_and_meta_flatten() {
        let r = row();
        let s = schema_for(&[r.clone()]);
        let cols = s.columns();
        let rec = flat_record(&r, &s, &cols);
        let at = |n: &str| cols.iter().position(|c| c == n).map(|i| rec[i].clone());

        assert_eq!(at("hreflang_count").as_deref(), Some("2"));
        assert_eq!(at("hreflang_1_lang").as_deref(), Some("en"));
        assert_eq!(at("hreflang_2_url").as_deref(), Some("https://de.ex.com/a"));
        assert_eq!(at("header:content-type").as_deref(), Some("text/html"));
        assert_eq!(at("header:x-cache").as_deref(), Some("Hit"));
        assert_eq!(at("meta:robots").as_deref(), Some("noindex"));
        // repeated meta name keeps every occurrence
        assert_eq!(at("meta:og:image").as_deref(), Some("a.png | b.png"));
        assert_eq!(at("structured_data_types").as_deref(), Some("Article | WebPage"));
        assert_eq!(at("structured_data_count").as_deref(), Some("2"));
        assert_eq!(at("perf_ttfb").as_deref(), Some("12"));
        assert_eq!(at("perf_lcp").as_deref(), Some("900"));
        // absent perf key stays blank rather than defaulting to 0
        assert_eq!(at("perf_cls").as_deref(), Some(""));
    }

    #[test]
    fn canonical_self_ignores_trailing_slash() {
        let r = row();
        let s = schema_for(&[r.clone()]);
        let cols = s.columns();
        let rec = flat_record(&r, &s, &cols);
        let i = cols.iter().position(|c| c == "canonical_is_self").unwrap();
        assert_eq!(rec[i], "true");
    }

    #[test]
    fn counts_mirror_companion_files() {
        let r = row();
        let s = schema_for(&[r.clone()]);
        let cols = s.columns();
        let rec = flat_record(&r, &s, &cols);
        let at = |n: &str| cols.iter().position(|c| c == n).map(|i| rec[i].clone());
        assert_eq!(at("outlink_count").as_deref(), Some("2"));
        assert_eq!(at("console_error_count").as_deref(), Some("1"));
        assert_eq!(at("failed_request_count").as_deref(), Some("0"));
    }

    #[test]
    fn outlink_scope_split_by_host() {
        let r = row();
        let mut w = csv::Writer::from_writer(vec![]);
        write_children(&mut w, &r, "outlinks", "https://ex.com/a/", true).unwrap();
        let out = String::from_utf8(w.into_inner().unwrap()).unwrap();
        assert!(out.contains("https://ex.com/b,internal"));
        assert!(out.contains("https://other.com/c,external"));
    }

    #[test]
    fn unknown_key_becomes_its_own_column() {
        let mut r = row();
        r.as_object_mut()
            .unwrap()
            .insert("brandNewField".into(), json!("v1"));
        let s = schema_for(&[r.clone()]);
        let cols = s.columns();
        let i = cols
            .iter()
            .position(|c| c == "brandNewField")
            .expect("unmapped field must not be silently dropped");
        assert_eq!(flat_record(&r, &s, &cols)[i], "v1");
    }

    #[test]
    fn host_of_handles_paths_and_bare_hosts() {
        assert_eq!(host_of("https://ex.com/a?b=1"), "ex.com");
        assert_eq!(host_of("http://sub.ex.com"), "sub.ex.com");
        assert_eq!(host_of("ex.com/a"), "ex.com");
    }

    // ---- end-to-end over a real SQLite pool -------------------------------

    async fn seeded_pool() -> sqlx::SqlitePool {
        use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
        let opts = SqliteConnectOptions::new().in_memory(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(opts)
            .await
            .expect("open pool");
        sqlx::query(
            "CREATE TABLE crawl_results (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id INTEGER NOT NULL, url TEXT NOT NULL, status INTEGER,
                title TEXT, h1 TEXT, h2 TEXT DEFAULT '', meta_description TEXT,
                canonical TEXT, internal_links INTEGER DEFAULT 0,
                external_links INTEGER DEFAULT 0, response_time INTEGER DEFAULT 0,
                content_type TEXT, resource_type TEXT DEFAULT 'Other',
                size INTEGER DEFAULT 0, error TEXT, word_count INTEGER DEFAULT 0,
                meta_robots TEXT DEFAULT '', is_indexable INTEGER DEFAULT 1,
                is_noindex INTEGER DEFAULT 0, is_nofollow INTEGER DEFAULT 0,
                og_title TEXT DEFAULT '', og_description TEXT DEFAULT '',
                og_image TEXT DEFAULT '', og_image_width INTEGER DEFAULT 0,
                og_image_height INTEGER DEFAULT 0, date_published TEXT DEFAULT '',
                date_modified TEXT DEFAULT '', redirect_url TEXT DEFAULT '',
                server_header TEXT DEFAULT '', seo_json TEXT DEFAULT '{}'
            )",
        )
        .execute(&pool)
        .await
        .expect("create table");

        // Row 1 carries hreflang/headers/meta; row 2 is deliberately sparser so
        // the discovered column set must be the UNION across rows.
        let seo1 = json!({
            "hreflang": [{"lang":"en","href":"https://ex.com/a"}],
            "responseHeaders": {"Content-Type":"text/html","X-Cache":"Hit"},
            "metaTags": [{"name":"robots","content":"noindex"}],
            "outlinks": ["https://ex.com/b","https://other.com/c"],
            "consoleErrors": ["boom"], "failedRequests": ["https://ex.com/x.js"],
            "blockedByRobots": false, "contentHash": "abc",
        })
        .to_string();
        let seo2 = json!({
            "hreflang": [{"lang":"en","href":"https://ex.com/b"},
                         {"lang":"fr","href":"https://fr.ex.com/b"}],
            "responseHeaders": {"Server":"nginx"},
            "metaTags": [{"property":"og:image","content":"i.png"}],
            "outlinks": [], "consoleErrors": [], "failedRequests": [],
            "blockedByRobots": true,
        })
        .to_string();
        for (url, title, seo) in [
            ("https://ex.com/a", "A\nmultiline", seo1),
            ("https://ex.com/b", "B", seo2),
        ] {
            sqlx::query(
                "INSERT INTO crawl_results (session_id, url, status, title, seo_json)
                 VALUES (1, ?, 200, ?, ?)",
            )
            .bind(url)
            .bind(title)
            .bind(&seo)
            .execute(&pool)
            .await
            .expect("insert");
        }
        pool
    }

    #[tokio::test]
    async fn end_to_end_writes_main_and_companion_files() {
        let pool = seeded_pool().await;
        let dir = std::env::temp_dir().join("fera-export-e2e");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let dest = dir.join("crawl.csv");

        let (prog, files) = write_flat_export(&pool, 1, None, &dest, |_, _| {})
            .await
            .expect("export");
        assert_eq!(prog.rows_written, 2);
        assert_eq!(files.len(), 4);

        // All four files exist with the expected names.
        for name in [
            "crawl.csv",
            "crawl-outlinks.csv",
            "crawl-failed-requests.csv",
            "crawl-console.csv",
        ] {
            assert!(dir.join(name).is_file(), "{name} not written");
        }
        // No `.part` scratch file survives a successful export.
        for f in &files {
            assert!(!part_path(f).exists(), "leftover part file for {}", f.display());
        }
        // bytes_written reaches the UI — it read a flat 0 for every CSV export
        // until it was summed from the finalized files.
        let on_disk: u64 = files
            .iter()
            .map(|p| std::fs::metadata(p).unwrap().len())
            .sum();
        assert_eq!(prog.bytes_written, on_disk);
        assert!(prog.bytes_written > 0);

        let raw = std::fs::read_to_string(&dest).unwrap();
        // Excel on Windows needs the BOM to decode the file as UTF-8 rather
        // than the local ANSI codepage.
        let main = raw
            .strip_prefix('\u{feff}')
            .expect("export must start with a UTF-8 BOM")
            .to_string();
        let mut lines = main.lines();
        let header: Vec<&str> = lines.next().unwrap().split(',').collect();

        // Discovered columns are the UNION across both rows.
        for c in ["header:content-type", "header:x-cache", "header:server",
                  "meta:robots", "meta:og:image",
                  "hreflang_1_lang", "hreflang_2_url"] {
            assert!(header.contains(&c), "missing discovered column {c}");
        }
        // url leads; no derived indexability columns survived.
        assert_eq!(header[0], "url");
        assert!(!header.iter().any(|c| c.starts_with("is_") || *c == "isIndexable"));
        // Every data row matches the header width.
        for l in main.lines().skip(1) {
            let n = l.matches(',').count();
            assert!(n >= header.len() - 1, "row narrower than header");
        }
        // The embedded newline in row 1's title did not become a second record.
        assert_eq!(main.lines().count(), 3, "expected header + 2 rows");
        assert!(main.contains("A multiline"));
        // blockedByRobots now reaches the export.
        assert!(header.contains(&"blocked_by_robots"));

        let outlinks = std::fs::read_to_string(dir.join("crawl-outlinks.csv")).unwrap();
        assert_eq!(outlinks.lines().count(), 3); // header + 2 links
        assert!(outlinks.contains("https://ex.com/b,internal"));
        assert!(outlinks.contains("https://other.com/c,external"));

        let console = std::fs::read_to_string(dir.join("crawl-console.csv")).unwrap();
        assert_eq!(console.lines().count(), 2); // header + 1
        assert!(console.contains("https://ex.com/a,boom"));

        let _ = std::fs::remove_dir_all(&dir);
    }
}
