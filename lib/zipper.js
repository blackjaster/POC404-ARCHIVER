// lib/zipper.js — dependency-free ZIP writer (STORE + DEFLATE, UTF-8 names).
//
// Streams entries straight to a file handle instead of buffering the whole
// archive in memory. Textual assets are DEFLATE-compressed when that is
// actually smaller. Enforces ZIP32 limits explicitly rather than producing
// a corrupt archive.
"use strict";

const fs = require("fs/promises");
const zlib = require("zlib");

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(d = new Date()) {
  const time =
    ((d.getHours() & 0x1f) << 11) |
    ((d.getMinutes() & 0x3f) << 5) |
    (Math.floor(d.getSeconds() / 2) & 0x1f);
  const date =
    (((d.getFullYear() - 1980) & 0x7f) << 9) |
    (((d.getMonth() + 1) & 0x0f) << 5) |
    (d.getDate() & 0x1f);
  return { time, date };
}

const TEXTUAL = /\.(?:html?|xhtml|css|js|mjs|cjs|json|txt|xml|svg|md|csv|log)$/i;

class ZipWriter {
  /**
   * @param {string} outPath absolute path of the archive to write
   * @param {Date} [when] timestamp applied to every entry
   */
  constructor(outPath, when = new Date()) {
    this.outPath = outPath;
    this.when = when;
    this._fh = null;
    this._offset = 0;
    this._entries = 0;
    this._central = [];
    this._finished = false;
  }

  async _handle() {
    if (!this._fh) this._fh = await fs.open(this.outPath, "w");
    return this._fh;
  }

  async _write(buf) {
    const fh = await this._handle();
    await fh.write(buf);
    this._offset += buf.length;
  }

  /**
   * Add one entry.
   * @param {object} e { name: string, data: Buffer }
   */
  async add(e) {
    if (this._finished) throw new Error("zip already finalized");
    const nameB = Buffer.from(String(e.name), "utf8");
    if (nameB.length > 0xffff) throw new Error(`entry name too long: ${e.name}`);
    if (!Buffer.isBuffer(e.data)) throw new Error(`entry data must be a Buffer: ${e.name}`);

    const data = e.data;
    const { time, date } = dosDateTime(this.when);
    let method = 0; // STORED
    let payload = data;
    if (TEXTUAL.test(e.name) && data.length > 64) {
      try {
        const def = zlib.deflateRawSync(data, { level: 6 });
        if (def.length < data.length) { method = 8; payload = def; }
      } catch { /* keep stored */ }
    }

    const crc = crc32(data);
    const startOffset = this._offset;

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);   // local file header signature
    lh.writeUInt16LE(20, 4);           // version needed
    lh.writeUInt16LE(0x0800, 6);       // flags: UTF-8 filenames
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(time, 10);
    lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(payload.length, 18); // compressed size
    lh.writeUInt32LE(data.length, 22);    // uncompressed size
    lh.writeUInt16LE(nameB.length, 26);
    lh.writeUInt16LE(0, 28);              // extra field length

    await this._write(lh);
    await this._write(nameB);
    await this._write(payload);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);   // central directory signature
    ch.writeUInt16LE(20, 4);           // version made by
    ch.writeUInt16LE(20, 6);           // version needed
    ch.writeUInt16LE(0x0800, 8);       // flags
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(time, 12);
    ch.writeUInt16LE(date, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(payload.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameB.length, 28);
    ch.writeUInt16LE(0, 30);           // extra
    ch.writeUInt16LE(0, 32);           // comment
    ch.writeUInt16LE(0, 34);           // disk number
    ch.writeUInt16LE(0, 36);           // internal attrs
    ch.writeUInt32LE(0, 38);           // external attrs
    ch.writeUInt32LE(startOffset, 42); // local header offset

    this._central.push(ch, nameB);
    this._entries += 1;

    if (this._offset > 0xffffffff - 65536)
      throw new Error("archive exceeds ZIP32 size limit (4 GiB)");
    if (this._entries > 0xffff)
      throw new Error("archive exceeds ZIP32 entry-count limit (65535)");
  }

  async finalize() {
    if (this._finished) return;
    this._finished = true;

    const centralBuf = Buffer.concat(this._central);
    await this._write(centralBuf);

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(this._entries, 8);
    eocd.writeUInt16LE(this._entries, 10);
    eocd.writeUInt32LE(centralBuf.length, 12);
    eocd.writeUInt32LE(this._offset, 16); // size of whole archive minus EOCD
    await this._write(eocd);

    if (this._fh) { await this._fh.close(); this._fh = null; }
    return { entries: this._entries, bytes: this._offset + 22 };
  }

  async abort() {
    if (this._fh) { try { await this._fh.close(); } catch { /* noop */ } this._fh = null; }
    try { await fs.unlink(this.outPath); } catch { /* noop */ }
  }
}

module.exports = { ZipWriter, crc32 };
