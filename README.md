# POC404 — Site Archiver

A fast, unlimited, transparent website archiver with a neon-white-on-black
control panel. Point it at a URL, watch the crawl live, download the finished
site as a ZIP.

Runs on **`http://localhost:7982`** by default. Zero external dependencies —
plain Node.js (>= 18.17), nothing to install.

```
node server.js          # → http://localhost:7982
```

---

## What it is

POC404 crawls a website you point it at, saves every page, stylesheet, script,
image and font it links to, and hands you a single ZIP containing a browsable
mirror of the site plus a `manifest.json` describing every file.

It is built to be **open about what it is**:

* Every HTTP request carries an honest `POC404/1.0 (transparent site archiver)`
  User-Agent.
* `robots.txt` is fetched first and its **Disallow rules are honoured per URL**
  (RFC 9309 longest-match), including the conservative stop when a robots
  endpoint is unreachable. A robots `Crawl-delay` is reported in the log but
  **not applied** — POC404 runs unlimited.
* **No politeness limits.** No max pages, no max depth, no asset or byte
  budgets, no delay between requests — defaults are unlimited/infinite.
  Explicit caps can still be set per run through the API (see below).
* Cross-origin assets (CDN fonts, images, scripts) are included by default.
* Bodies larger than 48 MiB stream straight to disk, so an unlimited archive
  still has a bounded memory footprint.
* A `401`/`403` answer is respected: the URL is logged as skipped and the crawl
  moves on. POC404 does not retry, rotate identities, or otherwise work around
  a site that refuses automated access. `Retry-After` on `429`/`5xx` is still
  honoured — that wait only ever happens when the target server itself asks
  for it.

## What it deliberately does not do

No stealth mode. No identity masking, no referrer stripping, no WAF or
rate-limit evasion, no upload-id rotation, no silent service-worker
persistence. If a target signals "stop", POC404 stops. Archives made with
POC404 can honestly say they were collected with the target's cooperation.

## Features

* **Web control panel** — black `#000` glass, neon-white type and buttons,
  live progress bar, stat chips, robots.txt status, and a streaming log
  console over WebSocket. The panel disables the right-click context menu and
  the `Ctrl/Cmd+U` view-source shortcut (client-side deterrent only).
* **Unlimited engine** — robots.txt Disallow gating per URL, serial requests
  with no artificial pacing, honest retries (network errors and `429`/`5xx`
  only).
* **Unlimited by default** — no page/depth/asset/byte caps, zero delay.
  Optional caps (`maxPages`, `maxDepth`, `maxAssets`, `maxTotalMiB`,
  `delayMs`) remain available through `/api/start` for scope control.
* **Cross-origin assets included by default** — CDN fonts, images and scripts
  are archived too (toggle in the panel).
* **Resumable-safe output** — every resource written under
  `data/runs/<id>/site/<host>/…` with collision-safe, query-hash filenames;
  very large files stream to disk instead of memory.
* **ZIP export** — one click; the archive includes `ARCHIVE-NOTES.txt` (target,
  timing, caps, robots status) and a full `manifest.json` (URL → path, type,
  size, status, depth).
* **Stop anytime** — stopping seals a valid ZIP of everything captured so far.
* **Safe by default** — binds to `127.0.0.1`, no CORS wildcard, size-limited
  request bodies, path-traversal-guarded static serving, graceful shutdown.

## CLI

```
node server.js [--port 7982] [--host 127.0.0.1] [--out data]
```

| Flag     | Default     | Meaning                          |
| -------- | ----------- | -------------------------------- |
| `--port` | `7982`      | TCP port for the control panel   |
| `--host` | `127.0.0.1` | Bind address (local-only default)|
| `--out`  | `data`      | Directory for runs and archives  |

## API

| Endpoint        | Method | Purpose                                   |
| --------------- | ------ | ----------------------------------------- |
| `/api/health`   | GET    | Liveness + version                        |
| `/api/state`    | GET    | Full run state (also pushed over `/ws`)   |
| `/api/start`    | POST   | `{ url, maxPages?, maxDepth?, maxAssets?, delayMs?, maxTotalMiB?, includeCrossOriginAssets? }` — caps omitted/0 = unlimited; `includeCrossOriginAssets` defaults to `true` |
| `/api/stop`     | POST   | Gracefully stop the active run            |
| `/api/download` | GET    | Latest sealed ZIP                         |
| `/ws`           | WS     | Live `{type:"state"|"log"}` messages      |

## Layout

```
server.js          HTTP + WebSocket server, run lifecycle
lib/crawler.js     archiving engine (fetching, discovery, spill-to-disk streaming)
lib/robots.js      robots.txt fetch/parse/gate (RFC 9309 flavoured)
lib/zipper.js      streaming ZIP writer (STORE + DEFLATE, CRC32, UTF-8 names)
lib/ws.js          minimal RFC 6455 WebSocket server
public/            control panel (single page, no build step)
data/runs/<id>/    per-run output: site/, manifest.json, poc404-archive.zip
```

## Notes on responsibility

Unlimited mode puts the full burden of restraint on the operator: crawling at
maximum speed against a site you do not control can load its server heavily
and get your address blocked, and mirroring a website can be subject to
copyright, terms of service, and local law. Use POC404 on sites you own, have
permission to archive, or whose terms permit it. The tool still gives sites
the strongest possible "no" channel — robots.txt Disallow rules, 401/403
status codes, and honest identification — and relies on you for the rest.

## License

MIT
