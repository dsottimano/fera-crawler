// Single shared mutex for all SQLite writes. Tauri's plugin-sql uses an
// sqlx-sqlite connection pool — multiple concurrent writers from different
// composables (crawl-result inserts + profile updates + session config
// updates) would otherwise race and one of them gets SQLITE_BUSY (code 5)
// because busy_timeout defaults to 0.
//
// Serializing at the JS layer is cheaper than tuning SQLite — every write
// already needs a JS turn, and writes are already infrequent compared to
// reads. WAL still keeps reads concurrent with the queued writes.

let chain: Promise<unknown> = Promise.resolve();

const BUSY_PATTERNS = [
  "database is locked",
  "(code: 5)",
  "SQLITE_BUSY",
];

function isBusyError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return BUSY_PATTERNS.some((p) => msg.includes(p));
}

// Runs `op` after every previously-queued write completes, with retry on
// transient SQLITE_BUSY (in case another process — Rust side — beats us to
// the lock). Backoff caps at ~1s; total max ~3s before giving up.
export function serializeWrite<T>(op: () => Promise<T>): Promise<T> {
  const next = chain.then(() => withBusyRetry(op));
  // Don't let a rejected write poison the chain — replace with a settled
  // promise so subsequent writes still run.
  chain = next.catch(() => undefined);
  return next;
}

async function withBusyRetry<T>(op: () => Promise<T>, attempts = 5): Promise<T> {
  let delay = 50;
  for (let i = 0; i < attempts; i++) {
    try {
      return await op();
    } catch (e) {
      if (!isBusyError(e) || i === attempts - 1) throw e;
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 1000);
    }
  }
  throw new Error("unreachable");
}
