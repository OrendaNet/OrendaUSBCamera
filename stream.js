// Bounded multipart decoder: viewers joining mid-stream receive complete JPEGs.
class JpegParts {
  constructor(contentType) {
    const match = /^multipart\/x-mixed-replace\s*;\s*boundary=(?:"([A-Za-z0-9_-]{1,70})"|([A-Za-z0-9_-]{1,70}))\s*$/i.exec(contentType || '');
    if (!match) throw new Error('Unsupported camera stream');
    this.boundary = Buffer.from(`--${match[1] || match[2]}\r\n`);
    this.headers = Buffer.allocUnsafe(4100);
    this.headerLength = 0;
    this.frame = null;
    this.frameLength = 0;
    this.trailerLength = 0;
  }
  *push(chunk) {
    if (chunk.length > 2 * 1024 * 1024) throw new Error('Camera chunk is too large');
    const input = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    let offset = 0;
    while (offset < input.length) {
      if (!this.frame) {
        // Only the small header is scanned byte by byte. JPEG bytes are copied
        // once into their final buffer, even on heavily fragmented connections.
        if (this.headerLength >= this.headers.length) throw new Error('Camera headers are too large');
        this.headers[this.headerLength++] = input[offset++];
        if (this.headerLength < 4 || this.headers.readUInt32BE(this.headerLength - 4) !== 0x0d0a0d0a) continue;
        const start = this.headers.readUInt16BE(0) === 0x0d0a ? 2 : 0;
        if (!this.headers.subarray(start, start + this.boundary.length).equals(this.boundary)) throw new Error('Invalid camera boundary');
        const headers = this.headers.toString('ascii', start + this.boundary.length, this.headerLength - 4);
        const lengths = [...headers.matchAll(/^Content-Length:\s*(\d+)\s*$/gim)];
        if (lengths.length !== 1 || !/^Content-Type:\s*image\/jpeg\s*$/im.test(headers)) throw new Error('Invalid camera frame headers');
        const length = Number(lengths[0][1]);
        if (!Number.isSafeInteger(length) || length < 4 || length > 1024 * 1024) throw new Error('Invalid camera frame size');
        this.frame = Buffer.allocUnsafe(length);
        this.frameLength = 0;
        this.trailerLength = 0;
        this.headerLength = 0;
      } else if (this.frameLength < this.frame.length) {
        const length = Math.min(input.length - offset, this.frame.length - this.frameLength);
        input.copy(this.frame, this.frameLength, offset, offset + length);
        this.frameLength += length;
        offset += length;
      } else {
        if (input[offset++] !== (this.trailerLength === 0 ? 13 : 10)) throw new Error('Invalid JPEG frame');
        if (++this.trailerLength !== 2) continue;
        const jpeg = this.frame;
        this.frame = null;
        if (jpeg.readUInt16BE(0) !== 0xffd8 || jpeg.readUInt16BE(jpeg.length - 2) !== 0xffd9) throw new Error('Invalid JPEG frame');
        yield jpeg;
      }
    }
    if (!this.frame && this.headerLength > 4096) throw new Error('Camera headers are too large');
  }
}
const FRAME_END = Buffer.from('\r\n');
const MAX_QUEUED_BYTES = 2 * 1024 * 1024;

function writeJpegFrame(viewer, frame, close, now = Date.now()) {
  const res = viewer.res;
  if (viewer.closed || res.destroyed || !res.headersSent) return;
  if (res.writableLength > MAX_QUEUED_BYTES) return close(viewer);
  // One unfinished frame per connection; other viewers continue independently.
  if (res.writableNeedDrain || res.writableLength > 0) {
    viewer.blockedAt ||= now;
    if (now - viewer.blockedAt > 10000) close(viewer);
    return;
  }
  viewer.blockedAt = 0;
  if (viewer.lastSentAt && now - viewer.lastSentAt < 1000 / viewer.targetFps - 5) return;
  viewer.lastSentAt = now;
  viewer.sentFrames++;
  const elapsed = now - viewer.rateStartedAt;
  if (elapsed >= 1000) {
    viewer.fps = Math.round(viewer.sentFrames * 10000 / elapsed) / 10;
    viewer.sentFrames = 0;
    viewer.rateStartedAt = now;
  }
  // writev batches the header/body/trailer without another full JPEG copy.
  res.cork();
  res.write(frame.header);
  res.write(frame.jpeg);
  res.write(FRAME_END);
  res.uncork();
}

module.exports = { JpegParts, writeJpegFrame };
