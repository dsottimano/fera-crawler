---
name: determine-optimal-crawl-config
description: Use before crawling any site with the fera-crawler MCP to find the cheapest stealth/rate-limit config that (1) returns 2xx, (2) delivers real content instead of a WAF stub or challenge page, and (3) isn't being cloaked. Triggers on phrases like "crawl [site]", "probe [site]", "what config should I use for X", or when a crawl returns 403/429/503 or suspicious low-content responses.
---

## When to invoke this skill

**Proactively, before any crawl where the site behaviour is unknown:**
- "Crawl X" for a site not already in `list_crawl_configs`
- "Why is this crawl returning 403s?"
- "This site is giving me garbage results"
- "What's the fastest way to crawl Y?"
- Before launching a long-running spider — you want to know the config works first

**Do NOT re-invoke** if:
- `get_crawl_config` shows a cached config probed within the last ~7 days and the user isn't reporting problems
- The user explicitly passed `skipProbe: true` or supplied a full config

## The probe's three gates

Every rung is tested against:

1. **Ability** — `status ∈ 2xx/3xx`. A 403/429/503 fails.
2. **Not-garbage** — `body.innerText` scanned for WAF challenge phrases and structural anomalies. Any **fatal flag** fails the gate:
   - `fake-200` — title/h1 matches "Access Denied", "Cloudflare", "captcha", "enable javascript", etc.
   - `bot-verdict-visible` — visible text matches "checking your browser", "unusual traffic", "please verify you are human", "just a moment", "bot behavior detected"
   - Plus soft flags (≤1 allowed): `thin-body-lt5kb`, `low-content-lt30w`, `no-seo-all3`, `zero-outlinks`
3. **Speed** — for each gate-passing rung, 5 same-origin sample URLs are fetched. Winner = lowest `medianMs`.

## The ladder (cheapest → most aggressive)

| Rung | Config | When it wins |
|---|---|---|
| `stealth-off-headless` | Patchright binary patches only, no UA/header override | Sites with weak/no bot detection |
| `stealth-on-headless` | + custom UA, Sec-CH-UA, JS patches (webdriver/canvas/etc.) | Most WAF-protected sites (Akamai/Cloudflare light) |
| `stealth-on-warmup` | + session-warmup `GET /` to seed challenge cookies | Cookie-based gates (Akamai `_abck`, Cloudflare `__cf_bm`) |
| `stealth-on-slow` | + per-host-delay 1500ms, concurrency 1 | Rate-limit-sensitive origins; sometimes serial beats parallel |
| `stealth-on-headed` | Full stack with a visible window | Last resort; needs `DISPLAY`; not always viable |

## How to use

### Standard flow for a new site

```
1. probe_crawl_config({ url: "https://example.com/" })
2. Read response.winningLabel + response.winningConfig
3. If winningLabel is non-null → proceed with crawl (cached config applied automatically)
4. If winningLabel is null → every rung failed; see "When no rung passes" below
```

### The crawl tools auto-probe

You usually don't need to call `probe_crawl_config` explicitly. `crawl_url`, `crawl_site`, and `crawl_list` check the cache first and invoke the probe if the domain is unknown. The response includes `_configApplied: { label, probedNow }` so you can see what was used.

Call `probe_crawl_config` explicitly when:
- The user asks "what config should I use for X"
- You want to inspect the full ranking/attempts detail
- You need to force a re-probe (also works by calling `delete_crawl_config` + crawling)

### When no rung passes

`winningLabel: null` means every rung failed at least one gate. Check the `ranking` + `attempts`:

| Symptom | Diagnosis | Suggested action |
|---|---|---|
| All rungs: `status: 403` | IP-level block or Cloudflare-high | Try a proxy / residential IP; stealth alone can't fix this |
| All rungs: `fake-200` / `bot-verdict-visible` | JS challenge the browser isn't solving | Manual `open_browser` → pass challenge → persist profile → retry |
| All rungs: `thin-body-lt5kb` + status 200 | SPA that hasn't hydrated | Raise the wait time (sidecar has a 1.5s wait — JS-heavy SPAs may need more) |
| All `zero-outlinks` | Honeypot or redirect loop | Try a deeper URL instead of homepage |
| Network errors (`error` populated, status null) | Bad URL or DNS/network issue | Verify URL with `fetch` manually |

### Interpreting the ranking

The ranking is sorted **passing rungs by `medianMs` ascending, then failing rungs**. Read from top:
- **First row** = winner, used by default
- Rows with close `medianMs` (within ~50ms) → any of them is fine; the probe picked the cheapest
- Large `medianMs` gap between #1 and #2 → the winner matters; re-probing should give the same answer
- Winner is `stealth-on-slow` → site throttles; **do not** override `perHostConcurrency` / `perHostDelay` upward even if the crawl feels slow (you'll get rate-limited)

## Applying a probed config manually

The cached config is auto-applied, but you can read + override:

```
get_crawl_config({ url: "https://example.com/" })
// → { config: { stealthConfig: {enabled:true}, headless:true, sessionWarmup:false, perHostDelay:1500, perHostConcurrency:1, concurrency:1 }, winningLabel: "stealth-on-slow", probedAt: "..." }

// Override only what you need — user-supplied wins:
crawl_site({
  url: "https://example.com/",
  maxRequests: 100,
  // stealthConfig and rate limits auto-applied from cache
})
```

## Cost/latency budget

- Probe runs **all 5 rungs** (no early-exit) + 5 sample pages each = ~20–40s per probe
- Probe is cached per domain; amortized over many crawls it's free
- `skipProbe: true` bypasses if you already know the right config and want to crawl immediately

## When to re-probe

- Site reports that a previously-working crawl now returns 403 → cache is stale, delete + re-probe
- It's been >1 month since the probe
- You've changed the browser profile or cleared cookies
- Site ran a WAF update (bot walls evolve every 30–60 days)

Trigger re-probe with:
```
delete_crawl_config({ domain: "example.com" })
// next crawl will auto-probe
```

## Relationship to other Fera knobs

Probed configs set **defaults**, not overrides. Any opt the user supplies to `crawl_*` wins over the probe. The merge order (later wins):

1. Sidecar defaults (concurrency 5, perHostDelay 500, perHostConcurrency 2, stealth patches off, etc.)
2. Cached probe config (if present)
3. User-supplied tool args

If the user insists on `stealthConfig: { enabled: false }` on a site where the probe picked stealth-on, respect that — they may be testing, debugging, or have out-of-band context (e.g., they passed the challenge in a headed browser first).
