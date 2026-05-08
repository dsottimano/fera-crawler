// Streaming exporter for crawl results.
//
// Two output paths share the same row source:
//   - write_csv_streaming → bare CSV file (optionally filtered)
//   - write_bundle        → zip with crawl.csv + og-images/<host>/<file>
//
// Rows are paginated 20k at a time keyed by id (no OFFSET — keyset
// pagination stays cheap on huge sessions). Header keys come from the
// first row's JSON shape to match what the JS exporter used to emit; if
// later rows carry seo_json keys the first row didn't, those keys are
// dropped — same trade-off the JS path made. Cells holding nested JSON
// (objects/arrays) are stringified as JSON, which is strictly more useful
// than the JS path's "[object Object]" but doesn't add columns.
//
// Speed notes for big sessions (CR.org-class crawls):
//  - Destination is wrapped in a 1 MiB BufWriter so neither csv::Writer
//    nor zip::ZipWriter pay a syscall per write.
//  - The CSV entry inside the bundle is **stored, not deflated**: on a
//    multi-GB CSV the level-6 deflate is CPU-bound and dominates wall
//    time. Stored-only exports trade ~3x file size for a large speedup.
//    Images are stored too (already-compressed JPEG/PNG).
//  - sqlx `.fetch()` streams rows; we never materialize a 20k-row Vec.
//
// Progress callback fires every 1000 rows / every image.

use std::fs::File;
use std::io::{BufWriter, Seek, Write};
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
const BUF_CAPACITY: usize = 1 << 20; // 1 MiB

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

/// Stream all rows for a session into the given writer as CSV. If
/// `filter` is `None`, all rows for the session are emitted; otherwise
/// the same WHERE/bind machinery the grid uses is applied.
pub async fn write_csv_streaming<W: Write, F: FnMut(&ExportProgress, ExportPhase)>(
    pool: &SqlitePool,
    session_id: i64,
    filter: Option<&ResultsFilter>,
    writer: W,
    mut on_progress: F,
) -> Result<ExportProgress, String> {
    let mut csv_w = csv::Writer::from_writer(writer);
    let mut headers: Option<Vec<String>> = None;
    let mut last_id: i64 = 0;
    let mut prog = ExportProgress::default();

    let (extra_clauses, extra_binds) = match filter {
        Some(f) => {
            let mut c = Vec::new();
            let mut b = Vec::new();
            build_where(f, &mut c, &mut b);
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

    loop {
        let mut q = sqlx::query(&sql).bind(session_id).bind(last_id);
        for v in &extra_binds {
            q = bind_value(q, v);
        }
        q = q.bind(PAGE_SIZE);

        // .fetch() streams rows from sqlite without buffering them in a Vec.
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

            if headers.is_none() {
                if let Value::Object(ref obj) = v {
                    let hs: Vec<String> = obj.keys().cloned().collect();
                    csv_w
                        .write_record(&hs)
                        .map_err(|e| format!("write csv header: {e}"))?;
                    headers = Some(hs);
                }
            }
            let hs = headers.as_ref().unwrap();
            let record: Vec<String> = hs
                .iter()
                .map(|h| v.get(h).map(value_to_cell).unwrap_or_default())
                .collect();
            csv_w
                .write_record(&record)
                .map_err(|e| format!("write csv row: {e}"))?;

            prog.rows_written += 1;
            produced += 1;
            if prog.rows_written % PROGRESS_EVERY == 0 {
                on_progress(&prog, ExportPhase::Csv);
            }
        }
        if produced < PAGE_SIZE {
            break;
        }
    }
    csv_w
        .flush()
        .map_err(|e| format!("flush csv: {e}"))?;
    on_progress(&prog, ExportPhase::Csv);
    Ok(prog)
}

fn value_to_cell(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        Value::Array(_) | Value::Object(_) => v.to_string(),
    }
}

/// Wrap dest file in a 1 MiB BufWriter and write the bundle. CSV entry is
/// **Stored** (not Deflated) — on multi-GB exports, deflate dominates
/// wall time and the user can recompress externally if size matters.
pub async fn write_bundle<F: FnMut(&ExportProgress, ExportPhase)>(
    pool: &SqlitePool,
    session_id: i64,
    og_dir: &Path,
    dest: File,
    mut on_progress: F,
) -> Result<ExportProgress, String> {
    let buf = BufWriter::with_capacity(BUF_CAPACITY, dest);
    let mut zip = zip::ZipWriter::new(buf);

    let stored = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    zip.start_file("crawl.csv", stored)
        .map_err(|e| format!("zip start crawl.csv: {e}"))?;

    let mut prog = write_csv_streaming(pool, session_id, None, &mut zip, |p, _| {
        on_progress(p, ExportPhase::Csv);
    })
    .await?;

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
                let mut f = File::open(&path)
                    .map_err(|e| format!("open {}: {e}", path.display()))?;
                std::io::copy(&mut f, &mut zip)
                    .map_err(|e| format!("copy {}: {e}", path.display()))?;
                prog.images_written += 1;
                on_progress(&prog, ExportPhase::Images);
            }
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
