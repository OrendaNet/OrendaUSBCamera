// Bounded multipart decoder: viewers joining mid-stream receive complete JPEGs.
class JpegParts {
  constructor(contentType) {
    const match = /^multipart\/x-mixed-replace\s*;\s*boundary=(?:"([A-Za-z0-9_-]{1,70})"|([A-Za-z0-9_-]{1,70}))\s*$/i.exec(contentType || '');
    if (!match) throw new Error('Unsupported camera stream');
    this.boundary = Buffer.from(`--${match[1] || match[2]}\r\n`);
    this.buffer = Buffer.alloc(0);
  }
  *push(chunk) {
    if (chunk.length > 2 * 1024 * 1024) throw new Error('Camera chunk is too large');
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length) {
      if (this.buffer.subarray(0, 2).equals(Buffer.from('\r\n'))) this.buffer = this.buffer.subarray(2);
      if (this.buffer.length < this.boundary.length) break;
      if (!this.buffer.subarray(0, this.boundary.length).equals(this.boundary)) throw new Error('Invalid camera boundary');
      const end = this.buffer.indexOf('\r\n\r\n');
      if (end < 0) { if (this.buffer.length > 4096) throw new Error('Camera headers are too large'); break; }
      if (end > 4096) throw new Error('Camera headers are too large');
      const headers = this.buffer.subarray(this.boundary.length, end).toString('ascii');
      const lengths = [...headers.matchAll(/^Content-Length:\s*(\d+)\s*$/gim)];
      if (lengths.length !== 1 || !/^Content-Type:\s*image\/jpeg\s*$/im.test(headers)) throw new Error('Invalid camera frame headers');
      const length = Number(lengths[0][1]);
      if (!Number.isSafeInteger(length) || length < 4 || length > 1024 * 1024) throw new Error('Invalid camera frame size');
      const bodyAt = end + 4;
      if (this.buffer.length < bodyAt + length + 2) break;
      if (this.buffer.readUInt16BE(bodyAt) !== 0xffd8 || this.buffer.readUInt16BE(bodyAt + length - 2) !== 0xffd9 || this.buffer.toString('ascii', bodyAt + length, bodyAt + length + 2) !== '\r\n') throw new Error('Invalid JPEG frame');
      const jpeg = Buffer.from(this.buffer.subarray(bodyAt, bodyAt + length));
      this.buffer = this.buffer.subarray(bodyAt + length + 2);
      yield jpeg;
    }
    if (this.buffer.length > 1024 * 1024 + 4096) throw new Error('Camera frame is too large');
  }
}
module.exports = { JpegParts };
