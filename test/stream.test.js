const test = require('node:test');
const assert = require('node:assert/strict');
const { Writable } = require('node:stream');
const { JpegParts, writeJpegFrame } = require('../stream');

const jpeg = Buffer.from([0xff, 0xd8, 10, 20, 30, 0xff, 0xd9]);
const part = (headers = `Content-Type: image/jpeg\r\nContent-Length: ${jpeg.length}`, body = jpeg) => Buffer.concat([
  Buffer.from(`--camera\r\n${headers}\r\n\r\n`), body, Buffer.from('\r\n')
]);
const parser = () => new JpegParts('multipart/x-mixed-replace; boundary="camera"');

test('multipart JPEG decoding preserves complete frames at every transport split', () => {
  const input = Buffer.concat([part(), part()]);
  for (let split = 0; split <= input.length; split++) {
    const decoder = parser();
    const result = [...decoder.push(input.subarray(0, split)), ...decoder.push(input.subarray(split))];
    assert.deepEqual(result, [jpeg, jpeg], `transport split ${split}`);
  }
  const decoder = parser();
  assert.deepEqual([...input].flatMap((byte) => [...decoder.push(Buffer.from([byte]))]), [jpeg, jpeg]);
});

test('stream types and multipart headers cannot smuggle an unbounded or non-JPEG body', () => {
  for (const type of ['text/html', 'multipart/x-mixed-replace', 'multipart/x-mixed-replace; boundary=bad\r\nInjected: true']) {
    assert.throws(() => new JpegParts(type));
  }
  for (const headers of [
    'Content-Type: image/jpeg',
    'Content-Type: text/html\r\nContent-Length: 7',
    'Content-Type: image/jpeg\r\nContent-Length: -1',
    'Content-Type: image/jpeg\r\nContent-Length: 7\r\nContent-Length: 7',
    'Content-Type: image/jpeg\r\nContent-Length: 1048577',
    'Content-Type: image/jpeg\r\nContent-Length: 9007199254740993'
  ]) assert.throws(() => [...parser().push(part(headers))]);
});

test('invalid JPEG markers and mismatched boundaries are rejected before sending a frame', () => {
  for (const invalid of [Buffer.from('notjpeg'), Buffer.from([0xff, 0xd8, 1, 2, 3, 4, 5]), Buffer.from([1, 2, 3, 4, 5, 0xff, 0xd9])]) {
    assert.throws(() => [...parser().push(part(undefined, invalid))]);
  }
  assert.throws(() => [...parser().push(Buffer.from('--different\r\nContent-Length: 7\r\n\r\n'))]);
  assert.throws(() => [...parser().push(Buffer.concat([part().subarray(0, part().length - 2), Buffer.from('xx')]))]);
});

test('unfinished frame headers and oversized incoming chunks have bounded buffering', () => {
  const decoder = parser();
  assert.deepEqual([...decoder.push(Buffer.from('--camera\r\n'))], []);
  assert.throws(() => [...decoder.push(Buffer.alloc(4096, 97))]);
  assert.throws(() => [...parser().push(Buffer.alloc(2 * 1024 * 1024 + 1))]);
});

test('a fragmented large frame is independent of transport buffers and keeps bounded storage', () => {
  const large = Buffer.alloc(256 * 1024, 25);
  large.writeUInt16BE(0xffd8, 0); large.writeUInt16BE(0xffd9, large.length - 2);
  const input = part(`Content-Type: image/jpeg\r\nContent-Length: ${large.length}`, large);
  const decoder = parser();
  const frames = [];
  for (let offset = 0; offset < input.length; offset += 997) frames.push(...decoder.push(input.subarray(offset, offset + 997)));
  input.fill(0);
  assert.deepEqual(frames, [large]);
  assert.deepEqual([...decoder.push(part())], [jpeg]);
});

class ViewerConnection extends Writable {
  constructor(stalled) {
    super({ highWaterMark: 32 });
    this.headersSent = true;
    this.frames = [];
    this.stalled = stalled;
  }
  _writev(chunks, callback) {
    this.frames.push(chunks.map(({ chunk }) => chunk));
    if (this.stalled) this.complete = callback;
    else callback();
  }
  _write(chunk, _encoding, callback) { this._writev([{ chunk }], callback); }
}
const state = res => ({ res, targetFps: 10, lastSentAt: 0, blockedAt: 0, rateStartedAt: 1000, sentFrames: 0, fps: 0 });
const encoded = value => ({ header: Buffer.from(`--camera\r\nContent-Type: image/jpeg\r\nContent-Length: ${value.length}\r\n\r\n`), jpeg: value });

test('a slow connection queues one complete frame while fast viewers continue and resume at the newest frame', async () => {
  const slow = state(new ViewerConnection(true));
  const fast = state(new ViewerConnection(false));
  const close = () => assert.fail('Healthy or briefly stalled viewers must not close');
  const frame = encoded(jpeg);
  for (let index = 0; index < 90; index++) {
    writeJpegFrame(slow, frame, close, 1000 + index * 100);
    writeJpegFrame(fast, frame, close, 1000 + index * 100);
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(slow.res.frames.length, 1);
  assert.equal(fast.res.frames.length, 90);
  assert.equal(slow.res.writableLength, frame.header.length + jpeg.length + 2);
  assert.equal(slow.res.frames[0][1], jpeg, 'delivery must share the immutable frame bytes');
  slow.res.stalled = false;
  slow.res.complete();
  await new Promise(resolve => setImmediate(resolve));
  const newest = Buffer.from([0xff, 0xd8, 99, 0xff, 0xd9]);
  writeJpegFrame(slow, encoded(newest), close, 10100);
  assert.equal(slow.res.frames.length, 2);
  assert.equal(slow.res.frames[1][1], newest);
  assert.equal(slow.res.writableLength, 0);
  slow.res.destroy(); fast.res.destroy();
});

test('a permanently stalled connection closes after its bounded wait without queuing more frames', () => {
  const viewer = state(new ViewerConnection(true));
  let closes = 0;
  const close = current => { closes++; current.closed = true; current.res.destroy(); };
  writeJpegFrame(viewer, encoded(jpeg), close, 1000);
  writeJpegFrame(viewer, encoded(jpeg), close, 1100);
  writeJpegFrame(viewer, encoded(jpeg), close, 11200);
  writeJpegFrame(viewer, encoded(jpeg), close, 11300);
  assert.equal(closes, 1);
  assert.equal(viewer.res.frames.length, 1);
});
