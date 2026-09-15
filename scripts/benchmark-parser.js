// Optional development benchmark. It does not open cameras or change application state.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const { execFileSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');

const ROOT = path.resolve(__dirname, '..');
const BASELINE = '5eafcb66c066fb8c2344c5b3a13b12fca1ddfdc5'; // Released camera 0.1.2.
const ITERATIONS = 100;
const FRAME_BYTES = [64 * 1024, 256 * 1024];
const CHUNK_BYTES = [1024, 16 * 1024, 64 * 1024];

function parserFrom(source) {
  // Compile each trusted repository version separately without replacing files.
  const filename = path.join(ROOT, 'stream.js');
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(ROOT);
  loaded._compile(source, filename);
  return loaded.exports.JpegParts;
}

function exercise(Parser, input, chunkBytes, expectedFrameBytes, iterations) {
  let count = 0;
  for (let iteration = 0; iteration < iterations; iteration++) {
    const parser = new Parser('multipart/x-mixed-replace; boundary=camera');
    for (let offset = 0; offset < input.length; offset += chunkBytes) {
      for (const frame of parser.push(input.subarray(offset, offset + chunkBytes))) {
        if (frame.length !== expectedFrameBytes) throw new Error('Unexpected decoded frame size');
        count++;
      }
    }
  }
  if (count !== iterations) throw new Error('Unexpected decoded frame count');
  return count;
}

function measure(Parser, jpegBytes, chunkBytes) {
  // These bytes exercise framing, not JPEG decoding or camera hardware.
  const jpeg = Buffer.alloc(jpegBytes, 1);
  jpeg.writeUInt16BE(0xffd8, 0);
  jpeg.writeUInt16BE(0xffd9, jpeg.length - 2);
  const input = Buffer.concat([
    Buffer.from(`--camera\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`),
    jpeg, Buffer.from('\r\n')
  ]);
  exercise(Parser, input, chunkBytes, jpegBytes, 5);
  let concatCalls = 0;
  let concatBytes = 0;
  let explicitCopyBytes = 0;
  const originalConcat = Buffer.concat;
  const originalCopy = Buffer.prototype.copy;
  Buffer.concat = (parts, length) => {
    concatCalls++;
    concatBytes += length ?? parts.reduce((sum, part) => sum + part.length, 0);
    return originalConcat(parts, length);
  };
  Buffer.prototype.copy = function (...args) {
    const count = originalCopy.apply(this, args);
    explicitCopyBytes += count;
    return count;
  };
  const started = performance.now();
  let frames;
  try {
    frames = exercise(Parser, input, chunkBytes, jpegBytes, ITERATIONS);
  } finally {
    Buffer.concat = originalConcat;
    Buffer.prototype.copy = originalCopy;
  }
  return {
    jpegBytes, chunkBytes, frames,
    milliseconds: Math.round((performance.now() - started) * 100) / 100,
    inputBytes: input.length * ITERATIONS,
    concatCalls, concatBytes, explicitCopyBytes
  };
}

function main() {
  let baselineSource;
  try {
    baselineSource = execFileSync('git', ['show', `${BASELINE}:stream.js`], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    throw new Error(`The 0.1.2 baseline is unavailable. From a Git checkout, run git fetch origin ${BASELINE}, then retry.`);
  }
  const sources = [
    { name: '0.1.2', commit: BASELINE, source: baselineSource },
    { name: 'working-tree', source: fs.readFileSync(path.join(ROOT, 'stream.js'), 'utf8') }
  ];
  const results = sources.map(({ source, ...identity }) => {
    const Parser = parserFrom(source);
    return {
      ...identity,
      sourceSha256: crypto.createHash('sha256').update(source).digest('hex'),
      cases: FRAME_BYTES.flatMap((frameBytes) => CHUNK_BYTES.map((chunkBytes) => measure(Parser, frameBytes, chunkBytes)))
    };
  });
  console.log(JSON.stringify({
    environment: { node: process.version, platform: process.platform, architecture: process.arch, osRelease: os.release() },
    workload: { framesPerCase: ITERATIONS, warmupFramesPerCase: 5, frameBytes: FRAME_BYTES, chunkBytes: CHUNK_BYTES },
    caveat: 'Synthetic multipart framing only. Counts cover Buffer.concat and explicit Buffer.copy, not all allocations, peak memory, JPEG decoding, network throughput or device FPS.',
    results
  }, null, 2));
}

try { main(); }
catch (error) { console.error(error.message); process.exitCode = 1; }
