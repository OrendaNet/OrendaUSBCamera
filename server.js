const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { authenticateEdgeRequest, createRuntimeClient } = require('./sdk');
const { JpegParts } = require('./stream');

const PROFILE = Object.freeze({ width: 640, height: 480, fps: 10 });
const CAMERA_ID = /^usb-[a-f0-9]{32}$/;
const BOUNDARY = 'orenda-camera';
const MAX_VIEWERS = 8;
const MAX_QUEUED_BYTES = 1024 * 1024;
const assets = new Map([
  ['/', ['text/html; charset=utf-8', 'index.html']],
  ['/app.js', ['text/javascript; charset=utf-8', 'app.js']],
  ['/style.css', ['text/css; charset=utf-8', 'style.css']],
  ['/icon.svg', ['image/svg+xml', 'icon.svg']]
].map(([route, [type, file]]) => [route, { type, body: fs.readFileSync(path.join(__dirname, 'public', file)) }]));

function cameraError(error) {
  const status = [400, 401, 403, 404, 409, 422, 429, 501, 503, 504].includes(error.status) ? error.status : 503;
  const messages = {
    400: 'This camera does not support the requested video format.',
    401: 'The app connection has expired. Reopen the app from Edge Console.',
    403: 'Camera access is not approved. Ask a Box administrator to allow USB read access for this camera.',
    404: 'Camera support is unavailable. Update Edge Manager to 0.2.39 or later.',
    409: 'The camera is busy or has reconnected. Close other camera apps and try again.',
    422: 'This camera does not support 640×480 MJPEG video. Select a compatible USB camera.',
    429: 'Too many camera viewers are open. Close another viewer and try again.',
    501: 'Camera support is unavailable. Update Edge Manager to 0.2.39 or later.',
    503: 'The camera is unavailable. Check its USB connection and access in Edge Console.',
    504: 'The camera did not send video. Check its USB connection and try again.'
  };
  return { status, message: messages[status] };
}

function createApp({ runtime = createRuntimeClient(), secret = process.env.ORENDA_EDGE_APP_PROXY_SECRET } = {}) {
  const hubs = new Map();
  const failures = new Map();
  const json = (res, status, body) => {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(JSON.stringify(body));
  };
  function stopHub(hub) {
    if (hub.stopped) return;
    hub.stopped = true;
    hub.controller.abort();
    clearInterval(hub.watchdog);
    if (hubs.get(hub.id) === hub) hubs.delete(hub.id);
    for (const res of hub.clients) {
      if (hub.failure && !res.headersSent) json(res, hub.failure.status, { error: hub.failure.message });
      else res.destroy();
    }
    hub.clients.clear();
    hub.latest = null;
  }
  function recordFailure(hub, error) {
    if (hub.stopped) return;
    if (failures.size >= 32) failures.delete(failures.keys().next().value);
    hub.failure = cameraError(error);
    failures.set(hub.id, hub.failure);
    stopHub(hub);
  }
  function sendFrame(hub, jpeg) {
    const part = Buffer.concat([
      Buffer.from(`--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`), jpeg, Buffer.from('\r\n')
    ]);
    hub.lastFrameAt = Date.now();
    hub.latest = part;
    for (const res of hub.clients) {
      if (res.destroyed || res.writableLength + part.length > MAX_QUEUED_BYTES) { res.destroy(); continue; }
      res.write(part);
    }
  }
  function getHub(id) {
    let hub = hubs.get(id);
    if (hub) return hub;
    if (hubs.size >= 2) throw Object.assign(new Error('Camera limit'), { status: 429 });
    failures.delete(id);
    hub = { id, clients: new Set(), controller: new AbortController(), latest: null, lastFrameAt: 0, startedAt: Date.now(), stopped: false };
    hubs.set(id, hub);
    hub.ready = Promise.resolve().then(async () => {
      const response = await runtime.usb.cameraStream(id, { ...PROFILE, signal: hub.controller.signal });
      if (hub.stopped) { await response.body.cancel().catch(() => {}); return; }
      const parser = new JpegParts(response.contentType);
      // Let the awaiting HTTP handlers write their response headers first.
      setImmediate(async () => {
        try {
          for await (const chunk of response.body) {
            if (hub.stopped) break;
            for (const frame of parser.push(Buffer.from(chunk))) sendFrame(hub, frame);
          }
          if (!hub.stopped) recordFailure(hub, { status: 503 });
        } catch (error) { recordFailure(hub, error); }
      });
    }).catch((error) => { recordFailure(hub, error); throw error; });
    hub.watchdog = setInterval(() => {
      if (Date.now() - (hub.lastFrameAt || hub.startedAt) > 15000) recordFailure(hub, { status: 504 });
    }, 1000);
    hub.watchdog.unref();
    return hub;
  }
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true });
      const user = authenticateEdgeRequest(req.headers, secret);
      if (!user) return json(res, 401, { error: 'Open this app from Edge Console to continue.' });
      if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed.' });
      if (url.pathname === '/api/session') return json(res, 200, { user });
      if (url.pathname === '/api/cameras') {
        try {
          const result = await runtime.usb.devices();
          const cameras = (result.devices || []).filter((device) => device.type === 'camera' && device.read).map(({ id, name }) => ({ id, name }));
          return json(res, 200, { cameras, profile: PROFILE });
        } catch (error) { const failure = cameraError(error); return json(res, failure.status, { error: failure.message }); }
      }
      if (url.pathname === '/api/stream' || url.pathname === '/api/status') {
        const id = url.searchParams.get('camera');
        if (!CAMERA_ID.test(id || '')) return json(res, 400, { error: 'Choose an approved camera.' });
        if (url.pathname === '/api/status') {
          const hub = hubs.get(id);
          const failure = failures.get(id);
          return json(res, 200, { state: failure ? 'error' : hub?.lastFrameAt ? 'live' : hub ? 'connecting' : 'idle', error: failure?.message || null });
        }
        try {
          const hub = getHub(id);
          if (hub.clients.size >= MAX_VIEWERS) return json(res, 429, { error: cameraError({ status: 429 }).message });
          // Reserve before awaiting the camera so simultaneous joins remain bounded.
          hub.clients.add(res);
          res.once('close', () => { hub.clients.delete(res); if (!hub.clients.size) stopHub(hub); });
          await hub.ready;
          if (res.destroyed || hub.stopped) return;
          res.writeHead(200, { 'Content-Type': `multipart/x-mixed-replace; boundary=${BOUNDARY}`, 'Cache-Control': 'no-store, no-cache, must-revalidate', 'X-Accel-Buffering': 'no', 'X-Content-Type-Options': 'nosniff' });
          res.flushHeaders();
          if (hub.latest) res.write(hub.latest);
          return;
        } catch (error) {
          const failure = cameraError(error);
          if (!res.headersSent) return json(res, failure.status, { error: failure.message });
          return res.destroy();
        }
      }
      const asset = assets.get(url.pathname);
      if (!asset) return json(res, 404, { error: 'Not found.' });
      res.writeHead(200, { 'Content-Type': asset.type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
      res.end(asset.body);
    } catch (_) { if (res.headersSent) res.destroy(); else json(res, 500, { error: 'The viewer could not complete this request.' }); }
  });
  server.stopCameras = () => { for (const hub of hubs.values()) stopHub(hub); };
  server.on('close', server.stopCameras);
  return server;
}

if (require.main === module) {
  const server = createApp();
  server.listen(Number(process.env.PORT || 3101), process.env.HOST || '127.0.0.1');
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
    server.stopCameras(); server.close(); server.closeIdleConnections();
  });
}
module.exports = { createApp, PROFILE };
