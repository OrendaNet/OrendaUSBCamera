# Camera stream performance

The app shares one camera capture between viewers. Each received JPEG is assembled
in a bounded buffer, then its multipart header, JPEG and trailer are sent together
without copying the image into another full multipart buffer. Slow viewers skip
frames while their previous frame is pending; they do not slow other viewers or
accumulate a queue of old images. Standard and Data saver send at most 10 and 5
frames per second respectively. Both modes share the same camera capture.

## Reproduce the parser comparison

From a Git checkout with Node.js installed, run:

```sh
node scripts/benchmark-parser.js
```

The optional benchmark takes a few seconds and is not a CI test. It adds no
dependencies, opens no cameras, makes no network requests and changes no source
files. It loads the original parser from camera **0.1.2**, commit
`5eafcb66c066fb8c2344c5b3a13b12fca1ddfdc5`, and compares it with the current
`stream.js`. In a shallow checkout, fetch that exact commit first:

```sh
git fetch origin 5eafcb66c066fb8c2344c5b3a13b12fca1ddfdc5
```

Each case parses 100 synthetic multipart frames after five warmup frames. Frame
payloads are 64 or 256 KiB, split into 1, 16 or 64 KiB transport chunks. The payload
has valid JPEG start/end markers for the framing parser but is not a decodable
camera image. JSON output includes the Node/OS version, source hashes, elapsed
time and byte counts for instrumented `Buffer.concat` and `Buffer.copy` calls.

## What changed

The 0.1.2 parser repeatedly concatenates the entire partially received frame each
time another chunk arrives. For 100 frames split into 1 KiB chunks, its
concatenations alone copy **219,551,900 bytes** for 64 KiB frames and
**3,394,771,200 bytes** for 256 KiB frames. Smaller transport chunks increase that
repeated work.

The current parser reads the small bounded header once and copies the JPEG bytes
directly into their final buffer. The same workloads use **zero concatenations**
and explicitly copy **6,553,600** and **26,214,400 bytes** respectively: one copy of
each JPEG byte. It still allocates a frame buffer; this is not a zero-copy pipeline.
Headers remain bounded to approximately 4 KiB and individual JPEGs to 1 MiB.

A local run on **Node.js v22.19.0, Windows x64 10.0.26200** produced the following
elapsed times. Each cell covers 100 frames, not one frame:

| JPEG size | Transport chunk | 0.1.2 parser | Current parser |
| --- | --- | ---: | ---: |
| 64 KiB | 1 KiB | 94.92 ms | 3.93 ms |
| 64 KiB | 16 KiB | 11.62 ms | 0.72 ms |
| 64 KiB | 64 KiB | 8.72 ms | 0.82 ms |
| 256 KiB | 1 KiB | 707.98 ms | 4.96 ms |
| 256 KiB | 16 KiB | 37.96 ms | 4.48 ms |
| 256 KiB | 64 KiB | 17.54 ms | 3.84 ms |

The copy counts describe parser work, not peak process memory or total system
copies. In particular, the original parser's final `Buffer.from` copy is not
included in its concatenation count. Kernel buffers, the Edge proxy, browser image
decoding and capture work are outside this benchmark. Elapsed time varies with
Node version, CPU load, warmup and garbage collection, and includes the byte-count
instrumentation and parser construction. These measurements are not
ARM64 throughput, physical-camera validation or achievable video frame rates.

No physical Logitech C270 was available for this measurement. Check live video,
multiple cameras, disconnect/reconnect and pause behaviour on the intended Box
before drawing conclusions about hardware performance.
