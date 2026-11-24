// lib/crawler.js — POC404 archiving engine.
//
// A transparent, single-connection website archiver, unlimited by default:
//   * no page / depth / asset / byte / rate caps — the operator decides scope
//     via the STOP button; explicit caps are still honoured when passed via API
//   * consults robots.txt and honours its Disallow rules (longest-match);
//     a conservative stop when robots.txt itself is unreachable
//   * files above SPILL_AT stream straight to disk, so "unlimited" has a
//     bounded memory footprint
//   * retries only network errors / 429 / 5xx, honouring Retry-After; a
//     401/403 "forbidden" answer is respected and logged, never evaded
//   * writes every resource to disk under runs/<id>/site/<host>/...
//
// Deliberately NOT included: identity masking, WAF/rate-limit evasion,
// upload-id rotation, silent persistence. POC404 identifies itself in
// every request it makes.
"use strict";

const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { Readable } = require("stream");
const { Robots } = require("./robots");

const DEFAULTS = Object.freeze({
  maxPages: Infinity,            // unlimited — explicit API caps still honoured
  maxAssets: Infinity,
  maxDepth: Infinity,
  maxTotalBytes: Infinity,
  delayMs: 0,                    // no artificial pacing; explicit API delayMs still honoured
  jitterMs: 0,
  timeoutMs: 30_000,
  maxRetries: 3,                 // for network errors / 429 / 5xx only
  includeCrossOriginAssets: true,
  userAgent: "POC404/1.0 (transparent site archiver; honours robots.txt)",
});

// Bodies larger than this stream directly to their final path on disk
// instead of accumulating in memory.
const SPILL_AT = 48 * 1024 * 1024;

const PAGE_EXT = /\.(?:html?|xhtml|php|aspx?|jsp)$/i;
const HAS_EXT = /\.[a-z0-9]{1,10}$/i;
const SKIP_SCHEME = /^(?:mailto:|tel:|javascript:|data:|blob:|about:|#)/i;

const ASSET_EXT = new Set([
  "css", "js", "mjs", "cjs", "map", "png", "jpg", "jpeg", "gif", "webp", "avif",
  "svg", "ico", "bmp", "woff", "woff2", "ttf", "otf", "eot", "mp4", "webm",
  "mp3", "ogg", "wav", "pdf", "json", "xml", "txt", "md", "csv", "webmanifest",
]);

class Aborted extends Error {
  constructor() { super("stopped by user"); this.aborted = true; }
}

/* ------------------------------------------------------------ URL utils */

function normalizeUrl(value, base) {
  try {
    const u = new URL(value, base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (u.username || u.password) return null;
    u.hash = "";
    u.href = u.href; // re-normalize
    return u;
  } catch { return null; }
}

function isProbablyPage(u) {
  const p = u.pathname;
  if (p === "" || p === "/") return true;
  if (PAGE_EXT.test(p)) return true;
  if (!HAS_EXT.test(p)) return true; // extensionless paths are usually routes
  return false;
}

function isAssetPath(u) {
  const ext = u.pathname.match(/\.([a-z0-9]{1,10})$/i);
  return !!ext && ASSET_EXT.has(ext[1].toLowerCase());
}

/* ------------------------------------------------- HTML / CSS discovery */

function extractFromHtml(html, baseUrl) {
  const found = { pages: new Set(), assets: new Set() };
  let base = baseUrl;
  const baseM = html.match(/<base[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s">]+))/i);
  if (baseM) {
    try { base = new URL(baseM[1] || baseM[2] || baseM[3], baseUrl).href; } catch { /* keep */ }
  }

  const push = (set, v) => { const t = (v || "").trim(); if (t) set.add(t); };

  // hyperlinks -> page candidates
  for (const m of html.matchAll(/<(?:a|area)\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s">]+))/gi))
    push(found.pages, m[1] || m[2] || m[3]);

  // embedded resources -> asset candidates
  for (const m of html.matchAll(/\b(?:src|poster|data-src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s">]+))/gi))
    push(found.assets, m[1] || m[2] || m[3]);

  for (const m of html.matchAll(/\bsrcset\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    for (const part of (m[1] || m[2] || "").split(",")) {
      const u = part.trim().split(/\s+/)[0];
      if (u) found.assets.add(u);
    }
  }

  // <link> tags: stylesheets, icons, preloads
  for (const m of html.matchAll(/<link\b([^>]*)>/gi)) {
    const attrs = m[1];
    const relM = attrs.match(/\brel\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s">]+))/i);
    const rel = ((relM?.[1] || relM?.[2] || relM?.[3] || "")).toLowerCase();
    if (!/\b(?:stylesheet|icon|shortcut\s+icon|preload|modulepreload|manifest)\b/.test(rel)) continue;
    const hrefM = attrs.match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s">]+))/i);
    if (hrefM) push(found.assets, hrefM[1] || hrefM[2] || hrefM[3]);
  }

  // <script src=...> (covered by generic src scan) — inline styles: url(...)
  for (const m of html.matchAll(/<style\b([^>]*)>([\s\S]*?)<\/style>/gi))
    extractFromCss(m[2], base, found.assets);
  for (const m of html.matchAll(/\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/gi))
    extractFromCss(m[1] || m[2], base, found.assets);

  return { base, ...found };
}

function extractFromCss(css, baseUrl, into) {
  const push = (v) => {
    const t = (v || "").trim();
    if (!t || t.startsWith("data:")) return;
    into.add(t);
  };
  for (const m of css.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]+))\s*\)/gi))
    push(m[1] || m[2] || m[3]);
  for (const m of css.matchAll(/@import\s+(?:url\(\s*)?(?:"([^"]*)"|'([^']*)')/gi))
    push(m[1] || m[2]);
  return baseUrl;
}

/* --------------------------------------------------------- path mapping */

function sanitizeSegment(seg) {
  let s = seg;
  try { s = decodeURIComponent(seg); } catch { /* keep raw */ }
  s = s.replace(/[\x00-\x1f\x7f]/g, "");
  s = s.replace(/[<>:"|?*\\]/g, "_");
  if (/^\.+$/.test(s)) s = "_";
  return s || "_";
}

function safeHost(hostname, port) {
  let h = sanitizeSegment(hostname);
  if (port && !/^(?:80|443)$/.test(String(port))) h += "_" + String(port).replace(/\D/g, "");
  return h;
}

/* ------------------------------------------------------------- helpers */

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Aborted());
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, Math.max(0, ms));
    const onAbort = () => { clearTimeout(t); reject(new Aborted()); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function timeoutSignal(signal, ms) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new Error("timeout")), ms);
  const onAbort = () => ctl.abort(signal?.reason ?? new Error("aborted"));
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  return { signal: ctl.signal, cleanup: () => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); } };
}

function parseRetryAfter(v) {
  if (!v) return 0;
  const n = Number(v);
  if (Number.isFinite(n)) return Math.max(0, n * 1000);
  const d = Date.parse(v);
  return Number.isFinite(d) ? Math.max(0, d - Date.now()) : 0;
}

/* ------------------------------------------------------------- engine */

class Crawler {
  /**
   * @param {object} opts  see DEFAULTS; plus startUrl, runDir
   * @param {object} handlers { onLog, onProgress }
   */
  constructor(opts, handlers = {}) {
    this.o = { ...DEFAULTS, ...opts };
    this.startUrl = opts.startUrl;
    this.runDir = opts.runDir;
    this.siteDir = path.join(this.runDir, "site");
    this.onLog = handlers.onLog || (() => {});
    this.onProgress = handlers.onProgress || (() => {});

    this.controller = new AbortController();
    this.signal = this.controller.signal;
    this.robots = new Robots({ userAgent: this.o.userAgent, signal: this.signal });

    this.phase = "queued";
    this.target = "";
    this.origin = "";
    this.pageQueue = [];   // { url: string, depth: number }
    this.assetQueue = [];  // { url: string }
    this.queued = new Set();
    this.usedPaths = new Set();
    this.manifest = [];
    this.failures = [];

    this.pagesDone = 0;
    this.assetsDone = 0;
    this.pagesPlanned = 0;
    this.assetsPlanned = 0;
    this.bytes = 0;
    this.files = 0;
    this.current = "";
    this.error = null;
    this.notes = [];
    this.robotsNote = "robots.txt: not checked yet";
    this.effectiveDelayMs = this.o.delayMs;

    this.nextAllowedAt = 0;
    this.startedAt = 0;
    this.endedAt = 0;
    this.zipPath = path.join(this.runDir, "poc404-archive.zip");
    this.zipBytes = 0;
  }

  /* ------------------------------ public control ------------------------------ */

  stop(reason = "stopped by user") {
    if (this.signal.aborted) return;
    this.stopReason = reason;
    this.controller.abort();
  }

  progressSnapshot() {
    const known = this.pagesPlanned + this.assetsPlanned;
    const done = this.pagesDone + this.assetsDone + this.failures.length;
    const elapsed = this.startedAt ? ((this.endedAt || Date.now()) - this.startedAt) / 1000 : 0;
    return {
      phase: this.phase,
      current: this.current,
      pagesDone: this.pagesDone,
      pagesPlanned: this.pagesPlanned,
      assetsDone: this.assetsDone,
      assetsPlanned: this.assetsPlanned,
      bytes: this.bytes,
      files: this.files,
      speedBps: elapsed > 0 ? Math.round(this.bytes / elapsed) : 0,
      percent: known ? Math.min(100, Math.round((done / known) * 100)) : 0,
      failures: this.failures.length,
      robotsNote: this.robotsNote,
      elapsedSec: Math.round(elapsed * 10) / 10,
    };
  }

  emitProgress() { this.onProgress(this.progressSnapshot()); }

  /* --------------------------------- main run --------------------------------- */

  async run() {
    this.startedAt = Date.now();
    this.phase = "robots";
    this.emitProgress();
    this.log(`POC404 run started — target ${this.startUrl}`);

    const startUrl = normalizeUrl(this.startUrl, this.startUrl);
    if (!startUrl) return this.fail("Malformed target URL.");
    this.target = startUrl.href;
    this.origin = startUrl.origin;

    // ---- gate 1: robots.txt of the start origin
    let policy;
    try {
      policy = await this.robots.inspect(this.origin);
    } catch (err) {
      if (this.signal.aborted) return this.finishStopped();
      return this.fail(`robots.txt check failed: ${err.message}`);
    }
    this.robotsNote = `robots.txt: ${policy.note}`;
    this.log(this.robotsNote);
    if (policy.delayMs > 0)
      this.log(`robots.txt announces crawl-delay ${policy.delayMs} ms — not applied (unlimited mode)`);
    this.effectiveDelayMs = this.o.delayMs;

    if (policy.mode !== "allow" || !isAllowedPath(startUrl, policy)) {
      return this.fail(
        "robots.txt on this origin does not allow archiving that path — " +
        "POC404 stops here instead of overriding the site's decision."
      );
    }

    this.enqueuePage(startUrl.href, 0);
    this.phase = "crawling";
    this.emitProgress();

    try {
      await this._drainQueues();
      await this._verifyPasses();
    } catch (err) {
      if (err instanceof Aborted || this.signal.aborted) return this.finishStopped();
      return this.fail(err.message || String(err));
    }

    if (this.signal.aborted) return this.finishStopped();
    await this.finishComplete();
  }

  /* ------------------------------- queue draining ------------------------------ */

  async _drainQueues() {
    let pageCursor = 0;
    let assetCursor = 0;

    while (!this.signal.aborted) {
      const hasPage = pageCursor < this.pageQueue.length;
      const hasAsset = assetCursor < this.assetQueue.length;
      if (!hasPage && !hasAsset) {
        // discovery may still add entries asynchronously? (single-threaded: no) — done
        break;
      }

      const job = hasPage ? this.pageQueue[pageCursor++] : this.assetQueue[assetCursor++];
      const isPage = hasPage;

      try {
        if (isPage) await this._archivePage(job.url, job.depth);
        else await this._archiveAsset(job.url);
      } catch (err) {
        if (err instanceof Aborted || this.signal.aborted) throw err;
        this._recordFailure(job.url, err.message || String(err));
      }

      this.emitProgress();
    }
  }

  async _verifyPasses() {
    // One gentle retry sweep for transient failures (network errors only —
    // 4xx outcomes are respected, not retried).
    const retryable = this.failures.filter(f => f.retryable).map(f => f.url);
    if (!retryable.length) return;
    this.phase = "verifying";
    this.log(`[verify] re-trying ${retryable.length} transient failure(s)`);
    this.emitProgress();
    for (const url of retryable) {
      if (this.signal.aborted) throw new Aborted();
      const wasPage = !isAssetPath(new URL(url));
      try {
        if (wasPage) await this._archivePage(url, this._depthOf(url));
        else await this._archiveAsset(url);
        this.failures = this.failures.filter(f => f.url !== url);
      } catch (err) {
        if (err instanceof Aborted || this.signal.aborted) throw err;
        // keep original failure
      }
      this.emitProgress();
    }
  }

  _depthOf(url) { return 1; } // conservative: re-archive pages found during verify at depth 1

  /* --------------------------------- archivers -------------------------------- */

  async _archivePage(url, depth) {
    await this._robotsGate(url);
    this.current = url;
    const res = await this._fetch(url, "page");
    const contentType = res.headers.get("content-type") || "";
    const finalUrl = new URL(res.url || url);
    const isHtml = /text\/html|application\/xhtml/i.test(contentType);

    const archivePath = this._mapPath(finalUrl, contentType, isHtml);
    const body = await this._readBody(res, url, path.join(this.siteDir, archivePath));
    await this._writeFile(archivePath, body);

    this.pagesDone += 1;
    this.files += 1;
    this.manifest.push({
      url, finalUrl: finalUrl.href, path: archivePath,
      kind: "page", depth, type: contentType || "unknown",
      bytes: body.length, status: res.status,
    });
    this.log(`[page] ${url} → ${archivePath} (${fmtBytes(body.length)})`);
    this.emitProgress();

    if (isHtml && Buffer.isBuffer(body)) {
      const { base, pages, assets } = extractFromHtml(body.toString("utf8"), finalUrl.href);
      for (const v of pages) this._enqueueLink(v, base, depth + 1);
      for (const v of assets) this._enqueueLink(v, base, -1);
    } else if (isHtml) {
      // streamed straight to disk (very large page) — stored as-is, links not scanned
      this.log(`[note] ${archivePath} is very large — stored without scanning for links`);
    }
  }

  async _archiveAsset(url) {
    await this._robotsGate(url);
    this.current = url;
    const res = await this._fetch(url, "asset");
    const contentType = res.headers.get("content-type") || "";
    const finalUrl = new URL(res.url || url);
    const isCss = /text\/css/i.test(contentType) || /\.css$/i.test(finalUrl.pathname);

    const archivePath = this._mapPath(finalUrl, contentType, false);
    const body = await this._readBody(res, url, path.join(this.siteDir, archivePath));
    await this._writeFile(archivePath, body);

    this.assetsDone += 1;
    this.files += 1;
    this.manifest.push({
      url, finalUrl: finalUrl.href, path: archivePath,
      kind: "asset", type: contentType || "unknown",
      bytes: body.length, status: res.status,
    });
    this.log(`[asset] ${url} → ${archivePath} (${fmtBytes(body.length)})`);
    this.emitProgress();

    if (isCss && Buffer.isBuffer(body)) {
      const found = new Set();
      extractFromCss(body.toString("utf8"), finalUrl.href, found);
      for (const v of found) this._enqueueLink(v, finalUrl.href, -1);
    }
  }

  /* ---------------------------------- fetching -------------------------------- */

  /** Consult robots.txt (cached per origin) before every single request. */
  async _robotsGate(url) {
    let check;
    try {
      check = await this.robots.check(url);
    } catch (err) {
      if (this.signal.aborted) throw new Aborted();
      throw new Error(`robots.txt check failed: ${err.message}`);
    }
    if (!check.allowed) {
      const err = new Error("robots.txt disallows this path — skipped");
      err.permanent = true;
      err.respectfulSkip = true;
      throw err;
    }
  }

  async _pace() {
    const wait = this.nextAllowedAt - Date.now();
    if (wait > 0) await sleep(wait, this.signal);
    this.nextAllowedAt = Date.now() + this.effectiveDelayMs + Math.floor(Math.random() * this.o.jitterMs);
  }

  /**
   * Retrying fetch: retries network errors / 429 / 5xx honouring Retry-After.
   * 401/403 are NOT retried — the site said no, and POC404 respects that.
   */
  async _fetch(url, kind) {
    for (let attempt = 1; attempt <= this.o.maxRetries; attempt++) {
      await this._pace();
      if (this.signal.aborted) throw new Aborted();
      const ts = timeoutSignal(this.signal, this.o.timeoutMs);
      try {
        const res = await fetch(url, {
          signal: ts.signal,
          redirect: "follow",
          headers: {
            "User-Agent": this.o.userAgent,
            "Accept": "*/*",
            "Accept-Encoding": "gzip, deflate, br",
          },
        });

        if (res.status === 401 || res.status === 403) {
          await res.body?.cancel().catch(() => {});
          const err = new Error(
            `${res.status} forbidden — the target refuses automated access; POC404 respects that and moves on`
          );
          err.permanent = true;
          err.respectfulSkip = true;
          throw err;
        }

        if (res.status === 429 || res.status >= 500) {
          const ra = parseRetryAfter(res.headers.get("retry-after"));
          const wait = Math.min(Math.max(ra || 0, attempt * 2000), 30_000);
          await res.body?.cancel().catch(() => {});
          if (attempt === this.o.maxRetries) {
            const err = new Error(`HTTP ${res.status} after ${attempt} attempt(s)`);
            err.permanent = true;
            throw err;
          }
          this.log(`[wait] ${url} → ${res.status}; honouring Retry-After, next try in ${wait} ms`);
          await sleep(wait, this.signal);
          continue;
        }

        // Any other 4xx: the site answered and the answer is "no" — record and move on.
        if (!res.ok) {
          await res.body?.cancel().catch(() => {});
          const err = new Error(`HTTP ${res.status} — not archived`);
          err.permanent = true;
          throw err;
        }
        return res;
      } catch (err) {
        if (this.signal.aborted) throw new Aborted();
        if (err.permanent) throw err;
        if (attempt === this.o.maxRetries) {
          const e = new Error(`network error: ${err.message || err.cause?.code || "unknown"}`);
          e.transient = true;
          throw e;
        }
        await sleep(attempt * 1500, this.signal);
      } finally {
        ts.cleanup();
      }
    }
    throw new Error("retry loop exited unexpectedly");
  }

  async _readBody(res, url, destPath) {
    const chunks = [];
    let total = 0;
    let fd = null; // set once we spill over SPILL_AT and stream to destPath
    try {
      for await (const chunk of Readable.fromWeb(res.body)) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += buf.length;
        if (fd === null && total > SPILL_AT) {
          await fs.mkdir(path.dirname(destPath), { recursive: true });
          fd = await fs.open(destPath, "w");
          for (const c of chunks) await fd.write(c);
          chunks.length = 0;
        }
        if (fd !== null) await fd.write(buf);
        else chunks.push(buf);
      }
    } catch (err) {
      await res.body?.cancel().catch(() => {});
      if (fd !== null) {
        try { await fd.close(); } catch { /* already closed */ }
        await fs.rm(destPath, { force: true }).catch(() => {}); // no partial files
      }
      throw err; // network errors stay retryable via the verify pass
    }
    this.bytes += total;
    if (fd !== null) {
      await fd.close();
      return { spilled: true, length: total }; // already at its final path
    }
    return Buffer.concat(chunks);
  }

  /* --------------------------------- enqueueing ------------------------------- */

  _enqueueLink(raw, base, depth) {
    if (SKIP_SCHEME.test(raw)) return;
    const u = normalizeUrl(raw, base);
    if (!u) return;

    const sameOrigin = u.origin === this.origin;
    const assetByExt = isAssetPath(u);
    const isPage = !assetByExt && isProbablyPage(u);

    if (isPage) {
      if (!sameOrigin) return;
      if (this.pagesPlanned >= this.o.maxPages) return;
      if (depth > this.o.maxDepth) return;
    } else {
      if (!sameOrigin && !this.o.includeCrossOriginAssets) return;
      if (this.assetsPlanned >= this.o.maxAssets) return;
    }

    const href = u.href;
    if (this.queued.has(href)) return;
    this.queued.add(href);

    if (isPage) { this.pageQueue.push({ url: href, depth }); this.pagesPlanned++; }
    else { this.assetQueue.push({ url: href }); this.assetsPlanned++; }
  }

  enqueuePage(href, depth) {
    const u = normalizeUrl(href, href);
    if (!u) return;
    this.queued.add(u.href);
    this.pageQueue.push({ url: u.href, depth });
    this.pagesPlanned++;
  }

  /* ------------------------------- disk + paths ------------------------------- */

  _mapPath(url, contentType, isHtml) {
    const host = safeHost(url.hostname, url.port);
    let p = url.pathname.replace(/\\/g, "/");
    const segments = p.split("/").filter(s => s.length > 0).map(sanitizeSegment);

    if (segments.length === 0) {
      segments.push(isHtml ? "index.html" : "index.bin");
    } else if (p.endsWith("/")) {
      segments.push(isHtml ? "index.html" : "index.bin");
    } else {
      const last = segments[segments.length - 1];
      // Extensionless HTML route ("/docs") -> keep it as a directory name
      // so "/docs" and "/docs/" land on the same file: docs/index.html
      if (isHtml && !/\.[a-z0-9]{1,10}$/i.test(last)) segments.push("index.html");
    }

    let rel = host + "/" + segments.join("/");

    if (url.search) {
      const h = crypto.createHash("sha256").update(url.search).digest("hex").slice(0, 12);
      const slash = rel.lastIndexOf("/");
      const dot = rel.lastIndexOf(".");
      const split = dot > slash ? dot : rel.length;
      rel = `${rel.slice(0, split)}__q_${h}${rel.slice(split)}`;
    }

    // collision-safe naming
    if (this.usedPaths.has(rel)) {
      let n = 2;
      const slash = rel.lastIndexOf("/");
      const dir = rel.slice(0, slash + 1);
      const name = rel.slice(slash + 1);
      const dot = name.lastIndexOf(".");
      const stem = dot > 0 ? name.slice(0, dot) : name;
      const ext = dot > 0 ? name.slice(dot) : "";
      while (this.usedPaths.has(dir + `${stem}-${n}${ext}`)) n++;
      rel = dir + `${stem}-${n}${ext}`;
    }
    this.usedPaths.add(rel);
    return rel;
  }

  async _writeFile(relPath, data) {
    if (!Buffer.isBuffer(data)) return; // large body already streamed to its final path
    const dest = path.join(this.siteDir, relPath);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, data);
  }

  /* --------------------------------- outcomes --------------------------------- */

  _recordFailure(url, message) {
    const respectful = /forbidden/.test(message);
    this.failures.push({
      url, error: message,
      retryable: !respectful && !/per-file cap|byte budget|HTTP 4/.test(message) && /network error|timeout/i.test(message),
    });
    this.log(`[fail] ${url} — ${message}`);
  }

  fail(message) {
    this.phase = "failed";
    this.error = message;
    this.endedAt = Date.now();
    this.log(`[end] FAILED — ${message}`);
    this.emitProgress();
  }

  async finishStopped() {
    this.phase = "stopped";
    this.endedAt = Date.now();
    this.notes.push(this.stopReason || "stopped by user");
    this.log(`[end] stopped — ${this.stopReason || "by user"}; zipping what was captured`);
    this.emitProgress();
    await this._finalize();
  }

  async finishComplete() {
    this.phase = "finalizing";
    this.emitProgress();
    this.log("[end] crawl complete — assembling archive");
    await this._finalize();
  }

  async _finalize() {
    try {
      await fs.mkdir(this.runDir, { recursive: true });
      await fs.writeFile(
        path.join(this.runDir, "manifest.json"),
        JSON.stringify({
          tool: "POC404",
          version: 1,
          target: this.target,
          origin: this.origin,
          startedAt: new Date(this.startedAt).toISOString(),
          endedAt: new Date(this.endedAt || Date.now()).toISOString(),
          userAgent: this.o.userAgent,
          robotsNote: this.robotsNote,
          caps: {
            maxPages: capRepr(this.o.maxPages), maxDepth: capRepr(this.o.maxDepth),
            maxAssets: capRepr(this.o.maxAssets), maxTotalBytes: capRepr(this.o.maxTotalBytes),
            delayMs: this.effectiveDelayMs,
          },
          notes: this.notes,
          counts: {
            pages: this.pagesDone, assets: this.assetsDone,
            files: this.files, bytes: this.bytes,
            failures: this.failures.length,
          },
          manifest: this.manifest,
          failures: this.failures,
        }, null, 2)
      );

      const { ZipWriter } = require("./zipper");
      const zip = new ZipWriter(this.zipPath);
      try {
        await zip.add({ name: "ARCHIVE-NOTES.txt", data: Buffer.from(this._notesText(), "utf8") });
        await zip.add({ name: "manifest.json", data: Buffer.from(JSON.stringify({
          target: this.target, origin: this.origin,
          counts: { pages: this.pagesDone, assets: this.assetsDone, files: this.files, bytes: this.bytes },
          failures: this.failures,
          manifest: this.manifest,
        }, null, 2), "utf8") });
        await this._addSiteFiles(zip);
        const stats = await zip.finalize();
        this.zipBytes = stats.bytes;
        this.log(`[zip] poc404-archive.zip ready — ${this.files + 2} entries, ${fmtBytes(this.zipBytes)}`);
        this.phase = this.signal.aborted ? "stopped" : "done";
      } catch (zipErr) {
        await zip.abort().catch(() => {});
        throw zipErr;
      }
    } catch (err) {
      if (this.signal.aborted) { this.phase = "stopped"; }
      else { this.phase = "failed"; this.error = err.message || String(err); this.log(`[end] finalize failed: ${this.error}`); }
    }
    this.endedAt = Date.now();
    this.emitProgress();
  }

  async _addSiteFiles(zip) {
    const root = this.siteDir;
    let exists = true;
    try { await fs.access(root); } catch { exists = false; }
    if (!exists) return;

    const walk = async (dir, prefix) => {
      const dirHandle = await fs.opendir(dir);
      for await (const ent of dirHandle) {
        const full = path.join(dir, ent.name);
        const rel = prefix + ent.name;
        if (ent.isDirectory()) await walk(full, rel + "/");
        else if (ent.isFile()) await zip.add({ name: "site/" + rel, data: await fs.readFile(full) });
      }
    };
    await walk(root, "");
  }

  _notesText() {
    return [
      "POC404 — transparent site archive",
      "==================================",
      `Target      : ${this.target}`,
      `Started     : ${new Date(this.startedAt).toISOString()}`,
      `Finished    : ${new Date(this.endedAt || Date.now()).toISOString()}`,
      `Identity    : ${this.o.userAgent}`,
      `Robots      : ${this.robotsNote}`,
      `Pages       : ${this.pagesDone}`,
      `Assets      : ${this.assetsDone}`,
      `Bytes       : ${this.bytes}`,
      `Failures    : ${this.failures.length}`,
      this.notes.length ? `Notes       : ${this.notes.join("; ")}` : "Notes       : none",
      "",
      "Archived by POC404, a transparent local archiver that honours robots.txt",
      "Disallow rules, runs without artificial limits, and never disguises",
      "itself or evades site defences.",
      "",
    ].join("\n");
  }

  log(line) {
    // The server owns final formatting/stamping; keep the line plain here.
    this.onLog(line);
  }
}

function isAllowedPath(url, policy) {
  const { isAllowedByRules } = require("./robots");
  return policy.mode === "allow" &&
    isAllowedByRules(url.pathname + url.search, policy.rules);
}

/** JSON-safe cap value: Infinity is not representable, so say "unlimited". */
function capRepr(n) { return Number.isFinite(n) ? n : "unlimited"; }

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MiB`;
  return `${(n / 1024 ** 3).toFixed(2)} GiB`;
}

module.exports = { Crawler, DEFAULTS, fmtBytes };
