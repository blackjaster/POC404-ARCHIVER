// lib/ws.js — minimal RFC 6455 WebSocket server. Zero dependencies.
//
// Correct frame parsing (masking, extended lengths, fragmentation),
// close handshake, ping/pong heartbeat. Server frames are never masked,
// as required by the spec.
"use strict";

const crypto = require("crypto");

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_INBOUND = 1 << 20; // 1 MiB — messages are tiny JSON, anything else is abuse

class WSConnection {
  constructor(socket) {
    this.socket = socket;
    this.onmessage = null;
    this.onclose = null;

    this._buf = Buffer.alloc(0);
    this._fragments = [];
    this._fragOp = 0;
    this._closed = false;

    this._pingTimer = setInterval(() => this.ping(), 25_000);
    this._pingTimer.unref();

    socket.setNoDelay(true);
    socket.on("data", (d) => this._onData(d));
    socket.on("close", () => this._dead());
    socket.on("error", () => this._dead());
  }

  _dead() {
    if (this._closed) return;
    this._closed = true;
    clearInterval(this._pingTimer);
    if (this.onclose) this.onclose();
    try { this.socket.destroy(); } catch { /* already gone */ }
  }

  _onData(d) {
    if (this._closed) return;
    this._buf = this._buf.length ? Buffer.concat([this._buf, d]) : d;
    while (!this._closed) {
      const frame = this._readFrame();
      if (!frame) break;
      this._handleFrame(frame);
    }
  }

  _readFrame() {
    const buf = this._buf;
    if (buf.length < 2) return null;

    const b0 = buf[0];
    const b1 = buf[1];
    const fin = (b0 & 0x80) !== 0;
    const op = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let off = 2;

    if (len === 126) {
      if (buf.length < off + 2) return null;
      len = buf.readUInt16BE(off);
      off += 2;
    } else if (len === 127) {
      if (buf.length < off + 8) return null;
      const big = buf.readBigUInt64BE(off);
      off += 8;
      if (big > BigInt(MAX_INBOUND)) { this.close(1009); return null; }
      len = Number(big);
    }
    if (len > MAX_INBOUND) { this.close(1009); return null; }

    let mask = null;
    if (masked) {
      if (buf.length < off + 4) return null;
      mask = buf.subarray(off, off + 4);
      off += 4;
    }
    if (buf.length < off + len) return null;

    let payload = buf.subarray(off, off + len);
    if (mask) {
      payload = Buffer.from(payload); // copy before unmasking in place
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    }
    this._buf = buf.subarray(off + len);
    return { fin, op, payload };
  }

  _handleFrame({ fin, op, payload }) {
    if (op === 0x8) {          // close — echo the code back, then go away
      this._sendFrame(0x8, payload.length >= 2 ? payload.subarray(0, 2) : Buffer.alloc(0));
      this._dead();
      return;
    }
    if (op === 0x9) { this._sendFrame(0xa, payload); return; } // ping -> pong
    if (op === 0xa) return;                                    // pong

    if (op === 0x1 || op === 0x2 || op === 0x0) {
      const isFragment = !fin || this._fragments.length > 0;
      if (isFragment) {
        if (op !== 0x0 && this._fragments.length > 0) { this.close(1002); return; }
        if (op !== 0x0) this._fragOp = op;
        this._fragments.push(payload);
        if (!fin) return;
        const full = Buffer.concat(this._fragments);
        const kind = this._fragOp;
        this._fragments = [];
        this._fragOp = 0;
        this._emit(kind, full);
        return;
      }
      this._emit(op, payload);
      return;
    }
    this.close(1002); // unknown opcode — protocol error
  }

  _emit(op, payload) {
    if (!this.onmessage) return;
    if (op === 0x1) this.onmessage(payload.toString("utf8"), "text");
    else this.onmessage(payload, "binary");
  }

  _sendFrame(op, payload) {
    if (this._closed || this.socket.destroyed) return;
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x80 | op; // FIN set — we never fragment outbound frames
    try {
      this.socket.write(Buffer.concat([header, payload]));
    } catch { this._dead(); }
  }

  send(obj) {
    this._sendFrame(0x1, Buffer.from(JSON.stringify(obj)));
  }

  ping() {
    this._sendFrame(0x9, Buffer.alloc(0));
  }

  close(code = 1000) {
    if (this._closed) return;
    const b = Buffer.alloc(2);
    b.writeUInt16BE(code, 0);
    this._sendFrame(0x8, b);
    const s = this.socket;
    setTimeout(() => { try { s.destroy(); } catch { /* noop */ } }, 1000).unref();
    this._dead();
  }
}

/** Perform the upgrade handshake on an already captured upgrade request. */
function accept(req, socket, head) {
  const key = req.headers["sec-websocket-key"];
  const version = req.headers["sec-websocket-version"];
  if (!key || version !== "13") {
    socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return null;
  }
  const acceptKey = crypto.createHash("sha1").update(key + GUID).digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
    "Upgrade: websocket\r\n" +
    "Connection: Upgrade\r\n" +
    `Sec-WebSocket-Accept: ${acceptKey}\r\n\r\n`
  );
  const conn = new WSConnection(socket);
  if (head && head.length) conn._onData(head);
  return conn;
}

module.exports = { accept, WSConnection };
