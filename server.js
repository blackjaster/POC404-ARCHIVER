#!/usr/bin/env node
// server.js — POC404 control server.
//
// Serves the neon control panel on http://localhost:7982, exposes a small
// JSON API, streams progress over WebSocket, runs the archiver (unlimited by
// default) and produces the final ZIP. Zero external dependencies; Node >= 18.
//
//   node server.js [--port 7982] [--host 127.0.0.1] [--out data]
"use strict";

const http = require("http");
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const { Crawler } = require("./lib/crawler");
const ws = require("./lib/ws");
const { fmtBytes } = require("./lib/crawler");

const VERSION = "1.1.0";
const PUBLIC_DIR = path.join(__dirname, "public");

/* ------------------------------------------------------------ CLI args */

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port" || a === "-p") out.port = Number(argv[++i]);
    else if (a === "--host" || a === "-H") out.host = argv[++i];
    else if (a === "--out") out.out = argv[++i];
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(`POC404 v${VERSION} — unlimited site archiver

Usage: node server.js [--port 7982] [--host 127.0.0.1] [--out data]

  --port   TCP port for the control panel   (default 7982)
  --host   bind address                     (default 127.0.0.1 — local only)
  --out    data directory for archives      (default ./data)`);
  process.exit(0);
}

const PORT = Number.isFinite(args.port) ? args.port
  : Number(process.env.POC404_PORT) || 7982;
const HOST = args.host || process.env.POC404_HOST || "127.0.0.1";
const DATA_DIR = path.resolve(__dirname, args.out || "data");
const RUNS_DIR = path.join(DATA_DIR, "runs");

/* --------------------------------------------------------------- state */

const state = {
  active: null,      // crawler currently running
  runMeta: null,     // { id, target, startedAt } for active run
  last: null,        // { id, target, zipPath, zipBytes, phase, summary }
  clients: new Set(),
  bootAt: Date.now(),
};

function broadcast(obj) {
  for (const c of state.clients) {
    try { c.send(obj); } catch { /* cleaned up on close */ }
  }
}

function log(line) {
  const stamp = new Date().toISOString().slice(11, 19);
  broadcast({ type: "log", line: `[${stamp}] ${line}` });
}

function publicState() {
  const active = state.active;
  const last = state.last;
  return {
    type: "state",
    server: {
      version: VERSION,
      port: PORT,
      host: HOST,
      uptimeSec: Math.round((Date.now() - state.bootAt) / 1000),
    },
    running: !!active,
    run: active
      ? { id: state.runMeta.id, target: state.runMeta.target, startedAt: state.runMeta.startedAt, ...active.progressSnapshot() }
      : null,
    last: last
      ? {
          id: last.id,
          target: last.target,
          phase: last.phase,
          zipBytes: last.zipBytes,
          zipReady: !!last.zipPath,
          finishedAt: last.finishedAt,
          summary: last.summary,
          error: last.error || null,
        }
      : null,
  };
}

function syncState() { broadcast(publicState()); }

/* ------------------------------------------------------- run lifecycle */

async function startRun(payload) {
  if (state.active) throw Object.assign(new Error("a run is already in progress"), { status: 409 });

  const url = String(payload.url || "").trim();
  if (!/^https?:\/\//i.test(url)) {
    throw Object.assign(new Error("target must be an http(s) URL"), { status: 400 });
  }
  let u;
  try { u = new URL(url); } catch {
    throw Object.assign(new Error("malformed URL"), { status: 400 });
  }
  if (u.protocol !== "http:" && u.protocol !== "https:")
    throw Object.assign(new Error("only http(s) targets are supported"), { status: 400 });

  // Politeness limits are gone: absent or 0 caps mean unlimited. Explicit
  // positive numbers are still honoured for API users who want scope control.
  const cap = (v, min = 1) => {
    if (v === undefined || v === null || v === "") return Infinity;
    const n = Number(v);
    if (!Number.isFinite(n) || n < min) return Infinity;
    return n;
  };
  const numOr = (v, dflt) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : dflt;
  };

  const opts = {
    startUrl: url,
    maxPages: cap(payload.maxPages, 1),
    maxDepth: cap(payload.maxDepth, 0),       // explicit 0 = single page
    maxAssets: cap(payload.maxAssets, 1),
    maxTotalBytes: cap(payload.maxTotalMiB, 1) * 1024 * 1024,
    delayMs: Math.min(60_000, Math.max(0, numOr(payload.delayMs, 0))),
    jitterMs: 0,
    timeoutMs: Math.min(120_000, Math.max(5_000, numOr(payload.timeoutMs, 30_000))),
    includeCrossOriginAssets: payload.includeCrossOriginAssets !== false,
  };

  const id = new Date().toISOString().replace(/[:.]/g, "-") + "-" + crypto.randomBytes(3).toString("hex");
  const runDir = path.join(RUNS_DIR, id);
  await fs.mkdir(runDir, { recursive: true });

  const crawler = new Crawler({ ...opts, runDir }, {
    onLog: (line) => { log(line); },
    onProgress: () => syncState(),
  });

  state.active = crawler;
  state.runMeta = { id, target: url, startedAt: Date.now() };
  syncState();

  // run to completion in the background
  (async () => {
    try {
      await crawler.run();
    } catch (err) {
      crawler.phase = "failed";
      crawler.error = err.message || String(err);
      log(`[fatal] ${crawler.error}`);
    } finally {
      state.last = {
        id,
        target: url,
        phase: crawler.phase,
        zipPath: crawler.phase === "done" || crawler.phase === "stopped"
          ? (crawler.zipBytes > 0 ? crawler.zipPath : null)
          : null,
        zipBytes: crawler.zipBytes,
        finishedAt: Date.now(),
        summary: crawler.progressSnapshot(),
        error: crawler.error,
      };
      state.active = null;
      state.runMeta = null;
      log(`[run] finished with phase "${crawler.phase}"`);
      syncState();
    }
  })();

  return { id, started: true };
}

async function stopRun() {
  if (!state.active) throw Object.assign(new Error("no run in progress"), { status: 409 });
  state.active.stop("stopped from the control panel");
  return { stopping: true };
}

async function lastZipPath() {
  const last = state.last;
  if (!last || !last.zipPath) {
    if (state.active && state.active.zipBytes > 0) return null; // still running, not sealed
    throw Object.assign(new Error("no finished archive yet"), { status: 404 });
  }
  return last.zipPath;
}

/* ------------------------------------------------------------ handlers */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

async function readJsonBody(req, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) { req.destroy(); throw Object.assign(new Error("body too large"), { status: 413 }); }
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw Object.assign(new Error("invalid JSON body"), { status: 400 }); }
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(body);
}

async function serveStatic(res, relPath) {
  const safe = path.normalize(relPath).replace(/^(\.\.[/\\])+/, "");
  const file = path.join(PUBLIC_DIR, safe);
  if (!file.startsWith(PUBLIC_DIR + path.sep) && file !== PUBLIC_DIR)
    return sendJson(res, 403, { error: "forbidden" });
  let data;
  try { data = await fs.readFile(file); }
  catch { return sendJson(res, 404, { error: "not found" }); }
  res.writeHead(200, {
    "Content-Type": MIME[path.extname(file)] || "application/octet-stream",
    "Content-Length": data.length,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(data);
}

/* ---------------------------------------------------------- HTTP wiring */

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const p = u.pathname;

  try {
    // --- API ---
    if (req.method === "GET" && p === "/api/health") {
      return sendJson(res, 200, { ok: true, version: VERSION, running: !!state.active });
    }
    if (req.method === "GET" && p === "/api/state") {
      return sendJson(res, 200, publicState());
    }
    if (req.method === "POST" && p === "/api/start") {
      const body = await readJsonBody(req);
      const out = await startRun(body);
      return sendJson(res, 200, out);
    }
    if (req.method === "POST" && p === "/api/stop") {
      const out = await stopRun();
      return sendJson(res, 200, out);
    }
    if (req.method === "GET" && p === "/api/download") {
      let zipPath;
      try { zipPath = await lastZipPath(); }
      catch (e) { return sendJson(res, e.status || 404, { error: e.message }); }
      const data = await fs.readFile(zipPath);
      const target = state.last?.target || "";
      let host = "site";
      try { host = new URL(target).hostname.replace(/[^\w.\-]/g, "_"); } catch { /* keep */ }
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
      res.writeHead(200, {
        "Content-Type": "application/zip",
        "Content-Length": data.length,
        "Content-Disposition": `attachment; filename="poc404-${host}-${stamp}.zip"`,
        "Cache-Control": "no-store",
      });
      return res.end(data);
    }

    // --- static UI ---
    if (req.method === "GET" && (p === "/" || p === "/index.html")) {
      return serveStatic(res, "index.html");
    }
    if (req.method === "GET" && /^\/(?:style\.css|app\.js|favicon\.(?:svg|ico))$/.test(p)) {
      return serveStatic(res, p.slice(1));
    }

    return sendJson(res, 404, { error: "not found" });
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error("[server]", e);
    try { sendJson(res, status, { error: e.message || "internal error" }); }
    catch { res.end(); }
  }
});

/* ------------------------------------------------------------ WebSocket */

server.on("upgrade", (req, socket, head) => {
  const u = new URL(req.url, "http://localhost");
  if (u.pathname !== "/ws") {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }
  const conn = ws.accept(req, socket, head);
  if (!conn) return;
  state.clients.add(conn);
  conn.onclose = () => state.clients.delete(conn);
  conn.send(publicState());
});

/* ------------------------------------------------------------- startup */

async function main() {
  await fs.mkdir(RUNS_DIR, { recursive: true });
  server.listen(PORT, HOST, () => {
    console.log(`[poc404] control panel  →  http://localhost:${PORT}`);
    console.log(`[poc404] archives stored in ${RUNS_DIR}`);
    console.log(`[poc404] identity: honest UA · robots.txt Disallow honoured · no rate limits`);
  });
}

/* ------------------------------------------------------ graceful exit */

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[poc404] ${signal} received — shutting down`);
  if (state.active) {
    state.active.stop("server shutting down");
    // give the crawler a moment to seal its archive
    await new Promise(r => setTimeout(r, 1500));
  }
  for (const c of state.clients) c.close(1001);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

main().catch((err) => {
  console.error("[poc404] fatal:", err);
  process.exit(1);
});
