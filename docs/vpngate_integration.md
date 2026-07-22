# VPNGate / proxy integration

Status as of 2026-07-21. Author: crawler hardening session.

## Goal
Let Fera route crawler traffic through a different network identity to get past
IP/prefix-level blocks (e.g. Akamai on babbel banning the user's IPv6 /64).
Constraint the user set: **rootless** and **cross-OS** (Windows/macOS/Linux).

## What shipped (working, verified)

### 1. Chromium proxy support — the portable substrate
`connection.proxyServer` / `proxyUsername` / `proxyPassword` settings (Connection
tab). Threaded: schema → `startCrawlPayload` → Rust `start_crawl`
(`--proxy-server/-username/-password`) → sidecar `index.ts` → `CrawlConfig` →
`crawler.ts` `launchPersistentContext({ proxy })`.

- Cross-OS and **unprivileged** — it's a Chromium launch option, no TUN, no root,
  no driver. Identical on all three OSes.
- Format: `scheme://host:port` — `socks5://`, `http://`, `https://`.
- This is the reliable way past commercial WAFs: point it at a **residential or
  mobile** proxy. Datacenter proxies get blanket-blocked like the user's own IP.
- It is ALSO the plug-point for the VPNGate tunnel below: the tunnel exposes a
  local `socks5://127.0.0.1:PORT`, which you set as `proxyServer`.

Follow-up (not done): the **probe matrix** (`run_probe_matrix` → `probeMatrix.ts`)
does NOT yet inherit the proxy. If a proxy is set, the probe still tests direct,
so it can report "all failed" while a proxied crawl would work. Thread the same
proxy args through `run_probe_matrix` + `runRow`'s `launchPersistentContext`.

### 2. VPNGate list fetch — the list half
`vpngate_servers` Rust command → sidecar `vpngate` subcommand (`vpngate.ts`).
Pure `GET https://www.vpngate.net/api/iphone/`, parse CSV by header, base64 field
is the last column. Returns `{hostName, ip, countryLong, countryShort, score,
ping, speedMbps, sessions, ovpnBase64}[]`. No new Rust deps (Node `fetch` +
`Buffer`). Verified live: ~95 servers, configs decode to valid `.ovpn`.

So the user's instinct was right: **getting the list is just a GET.** No client
software needed for that half.

## What's NOT done: the tunnel (rootless, cross-OS OpenVPN → local SOCKS)

This is the hard part and needs **compiled helper binaries per OS**, which is a
build/CI task, not in-app code. Confirmed mechanism (researched, not yet bundled):

- Standard OpenVPN needs a kernel TUN + route changes → privilege. To do it
  **rootless and without a kernel TUN**, run a *patched* OpenVPN that pipes
  packets to a userspace TCP/IP stack:
  - `ValdikSS/openvpn-tunpipe` (or `bendlas/openvpn-tuna`) — adds
    `--dev "|<command>"` so OpenVPN pipes to an external program instead of a TUN.
  - `russdill/tunsocks` — userspace lwIP stack that accepts the piped VPN traffic
    and exposes a **SOCKS5** listener.
  - Pipeline: `openvpn --config server.ovpn --script-security 2 --dev "|tunsocks -D <socksPort>"`
    → local `socks5://127.0.0.1:<socksPort>` → set as `connection.proxyServer`.
  - Both must be **compiled and bundled** for each target OS (Linux/macOS/Windows).
    This is the blocking work.

### Alternatives considered
- **`pkexec openvpn` (system-wide):** simplest, but root prompt per connect and
  reroutes the whole machine. Not rootless.
- **Rootless Linux netns** (`unshare -Urn` + slirp4netns + openvpn + microsocks):
  genuinely rootless BUT **Linux-only** — no Windows/macOS equivalent. Fails the
  cross-OS requirement.
- **WireGuard userspace (wireproxy/sing-box):** the ONE clean rootless+cross-OS+
  single-binary VPN→SOCKS path — but VPNGate does not offer WireGuard. Choosing
  VPNGate/OpenVPN forecloses this.
- **Docker openvpn→socks images:** cross-OS but require Docker (heavy dep, admin
  VM on Win/mac). Unacceptable for a desktop end-user.

### Reality check
Even once tunneled, VPNGate exits are volunteer/datacenter IPs that the same WAFs
(Akamai/DataDome) heavily pre-block. VPNGate is good for geo-unblocking and
soft-rate-limited sites; weak against a commercial bot wall like babbel's. For
those, a residential/mobile proxy via the proxy setting (#1) is the real answer.

## Suggested next steps
1. Bundle `openvpn-tunpipe` + `tunsocks` per OS (CI artifact) under the sidecar's
   resource dir; add a `vpn_connect(ovpn)` / `vpn_disconnect` Rust command that
   spawns the pipeline, waits for the SOCKS port, and sets `proxyServer`.
2. Thread the proxy through the probe matrix (see follow-up in #1).
3. Add a Connection-tab VPNGate picker (country/score/speed) that calls
   `vpngate_servers` and, on connect, drives `vpn_connect`.
