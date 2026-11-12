// TCP is a byte STREAM, not a message protocol: one write() may arrive split across several
// 'data' events, and several writes may arrive glued together in one 'data' event.
// We therefore frame every message as: [4-byte big-endian length][UTF-8 JSON].
const { MAX_TCP_FRAME, safeParse } = require('./protocol');

function encodeFrame(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const out = Buffer.allocUnsafe(4 + body.length);
  out.writeUInt32BE(body.length, 0);
  body.copy(out, 4);
  return out;
}

class FrameReader {
  constructor(maxFrame = MAX_TCP_FRAME) {
    this.buf = Buffer.alloc(0);
    this.max = maxFrame;
    this.partialChunks = 0;   // metrics: how often a chunk ended mid-frame
    this.coalesced = 0;       // metrics: how often one chunk carried >1 frame
  }
  // Returns { msgs:[...], bad:n }. Throws Error('frameTooLarge') on protocol violation.
  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const msgs = [];
    let bad = 0, frames = 0;
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32BE(0);
      if (len > this.max) throw new Error('frameTooLarge');
      if (this.buf.length < 4 + len) break;
      const body = this.buf.subarray(4, 4 + len).toString('utf8');
      this.buf = this.buf.subarray(4 + len);
      frames++;
      const m = safeParse(body);
      if (m === null) bad++; else msgs.push(m);
    }
    if (frames > 1) this.coalesced++;
    if (this.buf.length) this.partialChunks++;
    return { msgs, bad };
  }
}

module.exports = { encodeFrame, FrameReader };
