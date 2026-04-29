# Fera MCP Server Design

## Overview

MCP server that wraps the existing Fera sidecar CLI, exposing SEO crawl capabilities as tools for Claude Code sessions. Thin wrapper — spawns the sidecar for crawls, reads Tauri's SQLite DB for historical data, and serves downloaded og:images.

## Architecture

```
Claude Code ──stdio──> MCP Server (Node.js, mcp-server/)
                            |
                            ├──spawns──> Sidecar CLI (crawl/open-browser)
                            |               └── NDJSON stdout -> parsed & accumulated
                            |
                            ├──reads───> Tauri SQLite DB (~/.local/share/com.fera.crawler/fera.db)
                            |
                            └──reads───> og-images dir (~/.local/share/com.fera.crawler/og-images/)
```

- Stateful within a session (holds active crawl process + results in memory)
- Only one crawl at a time (Chromium profile lock)
- Reads same DB as desktop app (shared sessions)
- Token-efficient: summary-first pattern, server-side filtering, field projection

## Tools

### Live Crawl

| Tool | Params | Returns |
|------|--------|---------|
| `crawl_url` | `url`, `headed?`, `downloadOgImage?`, `userAgent?`, `customHeaders?` | Single CrawlResult (blocks) |
| `crawl_site` | `url`, `headed?`, `concurrency?`, `maxRequests?`, `downloadOgImage?`, `userAgent?`, `delay?`, `respectRobots?` | `{status, urlsFound}` (non-blocking) |
| `crawl_list` | `urls[]`, `headed?`, `downloadOgImage?`, `userAgent?` | `{status, urlsFound}` (non-blocking) |
| `stop_crawl` | — | `{status: "stopped", urlsFound}` |
| `resume_crawl` | — | `{status: "crawling", urlsFound}` |
| `get_crawl_status` | — | `{status, urlsFound, url, startedAt}` |

### Data Retrieval

| Tool | Params | Returns |
|------|--------|---------|
| `get_crawl_data` | `filter?`, `fields?`, `limit?`, `offset?` | Filtered/projected results array |
| `get_saved_crawls` | — | Sessions list from DB |
| `load_saved_crawl` | `sessionId` | Loads past crawl into memory |

### Browser

| Tool | Params | Returns |
|------|--------|---------|
| `open_browser` | `url` | `{status: "open"}` |
| `close_browser` | — | `{status: "closed"}` |

## State

```typescript
interface ServerState {
  crawlProcess: ChildProcess | null;
  results: CrawlResult[];
  status: "idle" | "crawling" | "stopped";
  startUrl: string;
  config: Partial<CrawlConfig>;
  startedAt: string | null;
}
```

## Token Efficiency

1. `fields` param — project only requested fields
2. `limit`/`offset` pagination — default 50
3. `filter` object — server-side: statusCode, resourceType, isNoindex, hasOgImage, etc.
4. Summary-first — crawl tools return counts, Claude pulls data on demand
5. No streaming — results accumulate silently, zero tokens during crawl

## Implementation

- Location: `mcp-server/` (sibling to sidecar/, frontend/, src-tauri/)
- Own package.json with `@modelcontextprotocol/sdk` + `better-sqlite3`
- Spawns sidecar via `npx tsx ../sidecar/src/index.ts`
- Reads Tauri DB at `~/.local/share/com.fera.crawler/fera.db`
- Resume deduplicates via visitedUrls set (same as frontend fix)
- ogImagePath field added to CrawlResult for image-to-result linking
