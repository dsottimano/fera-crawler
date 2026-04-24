// Per-host robots.txt fetcher, parser, and matcher.
// Standards: RFC 9309 + the de-facto Google extensions (Allow, wildcards, $ anchor).

interface Rule {
  allow: boolean;
  pattern: string;
}

interface HostRules {
  rules: Rule[];
  sitemaps: string[];
  fetched: boolean;
}

function matchesPattern(path: string, pattern: string): boolean {
  // Translate robots-glob to regex: * → .*, $ anchors end, literal everything else.
  let re = "^";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") re += ".*";
    else if (c === "$" && i === pattern.length - 1) re += "$";
    else re += c.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  try {
    return new RegExp(re).test(path);
  } catch {
    return false;
  }
}

function parseRobots(text: string, userAgent: string): HostRules {
  const lines = text.split(/\r?\n/);
  const ua = userAgent.toLowerCase();

  // Build groups keyed by user-agent token, plus collect sitemaps.
  const groups: Array<{ agents: string[]; rules: Rule[] }> = [];
  const sitemaps: string[] = [];
  let current: { agents: string[]; rules: Rule[] } | null = null;
  let lastWasAgent = false;

  for (const raw of lines) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (field === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if (field === "disallow" && current) {
      if (value !== "") current.rules.push({ allow: false, pattern: value });
      lastWasAgent = false;
    } else if (field === "allow" && current) {
      if (value !== "") current.rules.push({ allow: true, pattern: value });
      lastWasAgent = false;
    } else if (field === "sitemap") {
      if (value) sitemaps.push(value);
      lastWasAgent = false;
    } else {
      lastWasAgent = false;
    }
  }

  // Pick the most specific matching group: exact UA > UA prefix match > "*".
  const uaToken = ua.split("/")[0];
  let best: { agents: string[]; rules: Rule[] } | null = null;
  let bestScore = -1;
  for (const g of groups) {
    for (const agent of g.agents) {
      let score = -1;
      if (agent === uaToken) score = 3;
      else if (agent !== "*" && uaToken.includes(agent)) score = 2;
      else if (agent === "*") score = 1;
      if (score > bestScore) {
        bestScore = score;
        best = g;
      }
    }
  }

  return { rules: best?.rules ?? [], sitemaps, fetched: true };
}

function isAllowedFor(path: string, rules: Rule[]): boolean {
  // Longest-match wins. On tie, Allow beats Disallow (Google behavior).
  let best: Rule | null = null;
  for (const rule of rules) {
    if (!matchesPattern(path, rule.pattern)) continue;
    if (!best || rule.pattern.length > best.pattern.length) best = rule;
    else if (rule.pattern.length === best.pattern.length && rule.allow) best = rule;
  }
  return best ? best.allow : true;
}

export class RobotsCache {
  private cache = new Map<string, Promise<HostRules>>();

  constructor(
    private userAgent: string = "Feracrawler",
    private fetchTimeout = 8000,
  ) {}

  private async fetchHost(origin: string): Promise<HostRules> {
    const url = origin + "/robots.txt";
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(this.fetchTimeout),
        headers: { "User-Agent": this.userAgent },
        redirect: "follow",
      });
      if (!res.ok) return { rules: [], sitemaps: [], fetched: true };
      const text = await res.text();
      return parseRobots(text, this.userAgent);
    } catch {
      // Network error or timeout → treat as no rules (fail-open).
      return { rules: [], sitemaps: [], fetched: true };
    }
  }

  private get(origin: string): Promise<HostRules> {
    let entry = this.cache.get(origin);
    if (!entry) {
      entry = this.fetchHost(origin);
      this.cache.set(origin, entry);
    }
    return entry;
  }

  async isAllowed(rawUrl: string): Promise<boolean> {
    try {
      const u = new URL(rawUrl);
      const rules = await this.get(u.origin);
      return isAllowedFor(u.pathname + u.search, rules.rules);
    } catch {
      return true;
    }
  }

  async getSitemaps(origin: string): Promise<string[]> {
    const rules = await this.get(origin);
    return rules.sitemaps;
  }
}

// Exposed for unit testing.
export const __test = { parseRobots, matchesPattern, isAllowedFor };
