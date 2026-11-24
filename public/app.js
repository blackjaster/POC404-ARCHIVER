/* POC404 control panel client.
   Talks to the local server over /api/* and a /ws WebSocket. */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);

  const els = {
    form: $("runForm"),
    target: $("target"),
    start: $("startBtn"),
    stop: $("stopBtn"),
    hint: $("formHint"),
    crossOrigin: $("crossOrigin"),
    phase: $("phase"),
    current: $("current"),
    barWrap: $("barWrap"),
    barFill: $("barFill"),
    stPages: $("stPages"),
    stAssets: $("stAssets"),
    stBytes: $("stBytes"),
    stSpeed: $("stSpeed"),
    stFail: $("stFail"),
    stElapsed: $("stElapsed"),
    robotsNote: $("robotsNote"),
    console: $("console"),
    download: $("downloadBtn"),
    zipInfo: $("zipInfo"),
    statusDot: $("statusDot"),
    statusText: $("statusText"),
    footNote: $("footNote"),
  };

  const MAX_LINES = 400;
  let running = false;

  /* ------------------------------------------------------------ helpers */

  function fmtBytes(n) {
    if (!Number.isFinite(n) || n <= 0) return "0 B";
    if (n < 1024) return n + " B";
    if (n < 1048576) return (n / 1024).toFixed(1) + " KiB";
    if (n < 1073741824) return (n / 1048576).toFixed(1) + " MiB";
    return (n / 1073741824).toFixed(2) + " GiB";
  }

  function logLine(text, cls) {
    const el = document.createElement("div");
    el.textContent = text;
    if (cls) el.className = cls;
    const nearBottom =
      els.console.scrollHeight - els.console.scrollTop - els.console.clientHeight < 48;
    els.console.appendChild(el);
    while (els.console.childElementCount > MAX_LINES) els.console.removeChild(els.console.firstChild);
    if (nearBottom) els.console.scrollTop = els.console.scrollHeight;
  }

  function setRunning(on) {
    running = on;
    els.start.disabled = on;
    els.stop.disabled = !on;
    for (const el of [els.target, els.crossOrigin])
      el.disabled = on;
    if (on) {
      els.download.disabled = true;
      els.zipInfo.textContent = "";
    }
  }

  function renderState(s) {
    if (!s) return;

    if (s.server) {
      els.footNote.textContent =
        `v${s.server.version} · :${s.server.port} · up ${Math.floor(s.server.uptimeSec / 60)}m`;
    }

    const run = s.run;
    const last = s.last;
    // While running, live counters live on `run`; once finished, they live
    // in `last.summary` (the final snapshot of the crawler).
    const view = run || last?.summary || null;
    const isFinished = !run && !!last;

    if (!view) {
      els.phase.textContent = "idle";
      els.phase.classList.remove("busy");
      els.barFill.style.width = "0%";
      els.barWrap.setAttribute("aria-valuenow", "0");
      return;
    }

    els.phase.textContent = (isFinished ? last.phase : view.phase) || "—";
    els.phase.classList.toggle("busy", run && !["done", "failed", "stopped"].includes(view.phase));

    els.current.textContent = run?.current ? String(run.current) : "";

    const pct = Math.max(0, Math.min(100, Number(view.percent) || 0));
    els.barFill.style.width = pct + "%";
    els.barWrap.setAttribute("aria-valuenow", String(pct));

    els.stPages.textContent = `${view.pagesDone ?? 0} / ${view.pagesPlanned ?? 0}`;
    els.stAssets.textContent = `${view.assetsDone ?? 0} / ${view.assetsPlanned ?? 0}`;
    els.stBytes.textContent = fmtBytes(view.bytes);
    els.stSpeed.textContent = fmtBytes(view.speedBps) + "/s";
    els.stFail.textContent = String(view.failures ?? 0);
    els.stElapsed.textContent = (view.elapsedSec ?? 0) + " s";

    if (run?.robotsNote || last?.summary?.robotsNote)
      els.robotsNote.textContent = run?.robotsNote || last.summary.robotsNote;

    if (!run && last) {
      setRunning(false);
      const ready = last.zipReady && last.zipBytes > 0;
      els.download.disabled = !ready;
      if (ready) {
        els.zipInfo.textContent = `archive ready — ${fmtBytes(last.zipBytes)}`;
      } else if (last.phase === "failed") {
        els.zipInfo.textContent = `run failed: ${last.error || "unknown error"}`;
      } else {
        els.zipInfo.textContent = "";
      }
      if (last.phase === "failed") els.zipInfo.classList.add("line-fail");
    }
  }

  /* ------------------------------------------------------------ websocket */

  let ws = null;
  let reconnectDelay = 500;

  function connectWs() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    try {
      ws = new WebSocket(`${proto}://${location.host}/ws`);
    } catch {
      scheduleReconnect();
      return;
    }

    ws.onopen = () => {
      reconnectDelay = 500;
      els.statusDot.className = "dot on";
      els.statusText.textContent = "connected";
    };

    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === "log") {
        const fail = /\[fail\]|\[fatal\]/.test(msg.line);
        const end = /\[end\]|\[zip\]/.test(msg.line);
        logLine(msg.line, fail ? "line-fail" : end ? "line-end" : "");
      } else if (msg.type === "state") {
        renderState(msg);
      }
    };

    ws.onclose = () => {
      els.statusDot.className = "dot err";
      els.statusText.textContent = "reconnecting…";
      scheduleReconnect();
    };

    ws.onerror = () => { try { ws.close(); } catch { /* noop */ } };
  }

  function scheduleReconnect() {
    setTimeout(connectWs, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 8000);
  }

  /* ------------------------------------------------------------ API calls */

  async function postJson(url, body) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  els.form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    if (running) return;

    const url = els.target.value.trim();
    if (!/^https?:\/\//i.test(url) && !/^[\w.-]+\.[a-z]{2,}/i.test(url)) {
      els.hint.textContent = "enter a valid http(s) URL, e.g. https://example.com";
      els.target.focus();
      return;
    }

    els.console.textContent = "";
    setRunning(true);
    els.hint.textContent = "Unlimited crawl — no page, depth, byte or rate caps. Honest UA; robots.txt Disallow rules respected.";

    try {
      // No caps are sent: the server runs unlimited unless the API is used
      // directly with explicit maxPages/maxDepth/delayMs/maxTotalMiB values.
      await postJson("/api/start", {
        url: /^https?:\/\//i.test(url) ? url : "https://" + url,
        includeCrossOriginAssets: els.crossOrigin.checked,
      });
    } catch (err) {
      setRunning(false);
      els.hint.textContent = "start failed — " + err.message;
    }
  });

  els.stop.addEventListener("click", async () => {
    if (!running) return;
    els.stop.disabled = true;
    try { await postJson("/api/stop"); }
    catch (err) { els.hint.textContent = "stop failed — " + err.message; }
  });

  els.download.addEventListener("click", () => {
    // navigates with Content-Disposition: attachment, page stays put
    const a = document.createElement("a");
    a.href = "/api/download";
    document.body.appendChild(a);
    a.click();
    a.remove();
  });

  /* ------------------------------------------------------ panel guards */

  // Operator request: the control panel disables the right-click context menu
  // and the Ctrl/Cmd+U view-source shortcut. Client-side deterrent only —
  // it does not change what the browser itself can do.
  document.addEventListener("contextmenu", (ev) => ev.preventDefault());
  document.addEventListener("keydown", (ev) => {
    const key = (ev.key || "").toLowerCase();
    if (key === "u" && (ev.ctrlKey || ev.metaKey)) ev.preventDefault();
  });

  /* ------------------------------------------------------------ boot */

  fetch("/api/state").then(r => r.json()).then(renderState).catch(() => {});
  connectWs();
})();
