// VPNGate public relay list — a plain HTTP GET, no client software required.
// The list itself is free/unauthenticated; each row carries a base64-encoded
// OpenVPN config in its last column. This module fetches + parses it and
// prints a JSON array to stdout so the Rust side can hand it to the UI.
//
// NOTE: fetching the list needs nothing but `fetch`. ACTUALLY tunneling
// traffic through a chosen server needs a userspace OpenVPN→SOCKS bridge
// (see docs/vpngate_integration.md) whose local SOCKS port is then set as
// the crawler's proxy. This file is only the list half.

const VPNGATE_API = "https://www.vpngate.net/api/iphone/";

export interface VpnGateServer {
  hostName: string;
  ip: string;
  countryLong: string;
  countryShort: string;
  score: number;
  ping: number;
  // Raw VPNGate "Speed" is bits/sec (a throughput estimate); expose Mbps.
  speedMbps: number;
  sessions: number;
  // Base64-encoded OpenVPN (.ovpn) config — decode to get the full profile.
  ovpnBase64: string;
}

// The API returns CSV: a "*vpn_servers" marker line, a header line starting
// with '#', then one row per server. Fields are comma-separated and NOT
// quoted, so a stray comma inside CountryLong/Message can shift middle
// columns — but HostName/IP are always first and the base64 config is always
// last (its alphabet has no commas), so we anchor on those and parse the
// numeric middle fields best-effort by header index.
export function parseVpnGateCsv(text: string): VpnGateServer[] {
  const lines = text.split(/\r?\n/);
  const headerLine = lines.find((l) => l.startsWith("#"));
  if (!headerLine) return [];
  const headers = headerLine.replace(/^#/, "").split(",").map((h) => h.trim());
  const col = (name: string) => headers.indexOf(name);
  const iScore = col("Score");
  const iPing = col("Ping");
  const iSpeed = col("Speed");
  const iCountryLong = col("CountryLong");
  const iCountryShort = col("CountryShort");
  const iSessions = col("NumVpnSessions");

  const num = (fields: string[], idx: number): number => {
    if (idx < 0 || idx >= fields.length) return 0;
    const n = parseInt(fields[idx], 10);
    return Number.isNaN(n) ? 0 : n;
  };

  const out: VpnGateServer[] = [];
  for (const line of lines) {
    if (!line || line.startsWith("#") || line.startsWith("*")) continue;
    const fields = line.split(",");
    if (fields.length < 6) continue;
    const ovpnBase64 = fields[fields.length - 1].trim();
    // Sanity: the last field must look like base64 (long, base64 alphabet).
    if (ovpnBase64.length < 100 || !/^[A-Za-z0-9+/=]+$/.test(ovpnBase64)) continue;
    out.push({
      hostName: fields[0].trim(),
      ip: fields[1].trim(),
      score: num(fields, iScore),
      ping: num(fields, iPing),
      speedMbps: Math.round((num(fields, iSpeed) / 1_000_000) * 10) / 10,
      countryLong: iCountryLong >= 0 ? (fields[iCountryLong]?.trim() ?? "") : "",
      countryShort: iCountryShort >= 0 ? (fields[iCountryShort]?.trim() ?? "") : "",
      sessions: num(fields, iSessions),
      ovpnBase64,
    });
  }
  return out;
}

export async function fetchVpnGateServers(): Promise<VpnGateServer[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(VPNGATE_API, {
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 (fera-crawler)" },
    });
    if (!res.ok) throw new Error(`VPNGate API returned HTTP ${res.status}`);
    const text = await res.text();
    return parseVpnGateCsv(text);
  } finally {
    clearTimeout(timer);
  }
}
