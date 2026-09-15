const test = require('node:test');
const assert = require('node:assert/strict');
const { JpegParts } = require('../stream');

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
