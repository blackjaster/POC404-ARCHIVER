// lib/robots.js — robots.txt fetching, parsing and gating (RFC 9309 flavoured).
//
// POC404 is transparent: it asks robots.txt before touching anything and
// backs off when a site says no. Cached per origin; unreachable robots
// endpoints are treated conservatively (disallow) after retries, per the
// "responsible crawler" guidance.
"use strict";

const RETRY_DELAYS_MS = [500, 1500];

class Robots {
  /**
   * @param {object} opts
   * @param {string} opts.userAgent  Product token used both for matching and for the request.
   * @param {number} [opts.timeoutMs]
   * @param {AbortSignal} [opts.signal]
   */
  constructor(opts) {
    this.userAgent = opts.userAgent;
    this.timeoutMs = opts.timeoutMs || 10_000;
    this.signal = opts.signal || null;
    /** origin -> { groups, delaySec, status, note, fetchedAt, mode } */
    this.cache = new Map();
  }

  _productTokens() {
    // "POC404/1.0 (transparent site archiver)" -> ["poc404", "poc404/1.0"]
    const ua = this.userAgent.toLowerCase();
    const tokens = new Set(["*"]);
    const m = ua.match(/^([a-z0-9_\-]+)/);
    if (m) { tokens.add(m[1]); tokens.add(ua.split(/\s+/)[0]); }
    return [...tokens];
  }

  async _fetchText(origin) {
    const url = origin + "/robots.txt";
    let lastErr = null;
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      if (this.signal?.aborted) throw new Error("aborted");
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(new Error("robots timeout")), this.timeoutMs);
      const onAbort = () => ctl.abort(new Error("aborted"));
      if (this.signal) {
        if (this.signal.aborted) onAbort();
        else this.signal.addEventListener("abort", onAbort, { once: true });
      }
      try {
        const res = await fetch(url, {
          signal: ctl.signal,
          redirect: "follow",
          headers: { "User-Agent": this.userAgent, Accept: "text/plain,*/*" },
        });
        if (res.status >= 200 && res.status < 300) {
          return { status: res.status, text: await res.text() };
        }
        if (res.status === 404 || res.status === 410) {
          return { status: res.status, text: "" }; // no robots = open, per spec
        }
        // 429 / 5xx: back off and retry, then fall through to conservative mode
        await res.body?.cancel().catch(() => {});
        lastErr = new Error(`robots HTTP ${res.status}`);
        if (attempt < RETRY_DELAYS_MS.length) {
          await new Promise(r => setTimeout(r, RETRY_DELAYS_MS[attempt]));
          continue;
        }
        return { status: res.status, text: null, error: lastErr };
      } catch (err) {
        if (this.signal?.aborted) throw err;
        lastErr = err;
        if (attempt < RETRY_DELAYS_MS.length) {
          await new Promise(r => setTimeout(r, RETRY_DELAYS_MS[attempt]));
          continue;
        }
        return { status: 0, text: null, error: lastErr };
      } finally {
        clearTimeout(timer);
        if (this.signal) this.signal.removeEventListener("abort", onAbort);
      }
    }
    return { status: 0, text: null, error: lastErr };
  }

  /**
   * Get (and cache) the robots policy for an origin.
   * @returns {Promise<{mode:'allow'|'disallow', delayMs:number, note:string}>}
   */
  async inspect(origin) {
    const cached = this.cache.get(origin);
    if (cached && Date.now() - cached.fetchedAt < 10 * 60_000) return cached;

    const result = await this._fetchText(origin);
    let entry;
    if (result.text !== null) {
      const groups = parseRobots(result.text);
      const match = pickGroup(groups, this._productTokens());
      entry = {
        mode: "allow",
        delayMs: match?.delay ? Math.round(match.delay * 1000) : 0,
        status: result.status,
        note: result.status === 404 || result.status === 410
          ? "robots.txt absent — open by default"
          : "robots.txt loaded",
        rules: match ? match.rules : [],
        fetchedAt: Date.now(),
      };
    } else {
      // Unreachable robots endpoint: be conservative, allow nothing.
      entry = {
        mode: "disallow",
        delayMs: 0,
        status: result.status,
        note: `robots.txt unreachable (${result.status || "network error"}) — archiving halted to stay on the safe side`,
        rules: [{ type: "disallow", value: "/" }],
        fetchedAt: Date.now(),
      };
    }
    this.cache.set(origin, entry);
    return entry;
  }

  /**
   * Check one absolute URL against the cached policy of its origin.
   * Fetches the policy first if needed. Never throws.
   * @returns {Promise<{allowed:boolean, delayMs:number, note:string}>}
   */
  async check(url) {
    let u;
    try { u = new URL(url); } catch { return { allowed: false, delayMs: 0, note: "malformed URL" }; }
    if (u.protocol !== "http:" && u.protocol !== "https:")
      return { allowed: false, delayMs: 0, note: "non-http(s) URL" };

    const policy = await this.inspect(u.origin);
    const allowed =
      policy.mode === "allow" &&
      isAllowedByRules(u.pathname + u.search, policy.rules);
    return { allowed, delayMs: policy.delayMs || 0, note: policy.note };
  }
}

/* ------------------------------------------------------------ parsing */

function parseRobots(text) {
  const groups = [];
  let current = null;
  let lastWasAgent = false;

  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (field === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [], delay: 0 };
        groups.push(current);
      }
      if (value) current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;

    if (field === "disallow") {
      if (value === "") continue;         // empty Disallow = no restriction
      current.rules.push({ type: "disallow", value });
    } else if (field === "allow") {
      if (value === "") continue;
      current.rules.push({ type: "allow", value });
    } else if (field === "crawl-delay") {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) current.delay = n;
    }
  }
  return groups;
}

/** Pick the most specific group for our product tokens (exact match beats '*'). */
function pickGroup(groups, tokens) {
  let best = null;
  let bestScore = -1;
  for (const g of groups) {
    for (const a of g.agents) {
      const score = a === "*" ? 0 : tokens.includes(a) ? 1 + g.agents.indexOf(a) : -1;
      if (score > bestScore) { bestScore = score; best = g; }
    }
  }
  return best;
}

/** Compile one robots pattern ('*' wildcard, trailing '$' anchor). */
function compilePattern(value) {
  const anchored = value.endsWith("$");
  const body = anchored ? value.slice(0, -1) : value;
  let re = "^";
  let len = 0; // specificity = number of literal chars (longest match wins)
  for (const ch of body) {
    if (ch === "*") { re += ".*"; continue; }
    re += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    len += 1;
  }
  if (anchored) re += "$";
  return { regex: new RegExp(re), len };
}

/** RFC 9309 longest-match: more specific rule wins; ties go to Allow. */
function isAllowedByRules(pathAndQuery, rules) {
  let bestAllow = -1;
  let bestDisallow = -1;
  for (const r of rules || []) {
    const { regex, len } = compilePattern(r.value);
    if (!regex.test(pathAndQuery)) continue;
    if (r.type === "allow") bestAllow = Math.max(bestAllow, len);
    else bestDisallow = Math.max(bestDisallow, len);
  }
  if (bestDisallow === -1 && bestAllow === -1) return true;
  if (bestDisallow === -1) return true;
  if (bestAllow === -1) return false;
  return bestAllow >= bestDisallow;
}

module.exports = { Robots, parseRobots, pickGroup, isAllowedByRules, compilePattern };
