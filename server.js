const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { authenticateEdgeRequest, createRuntimeClient } = require('./sdk');
const { JpegParts, writeJpegFrame } = require('./stream');

const PROFILE = Object.freeze({ width: 640, height: 480, fps: 10 });
const CAMERA_ID = /^usb-[a-f0-9]{32}$/;
const VIEWER_ID = /^[a-f0-9]{32}$/;
const BOUNDARY = 'orenda-camera';
const MAX_VIEWERS = 8;
const MODES = Object.freeze([{ id: 'standard', label: 'Standard', fps: 10 }, { id: 'data-saver', label: 'Data saver', fps: 5 }]);
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
    404: 'Camera support is unavailable. Update Edge Manager to 0.2.41 or later.',
    409: 'The camera is busy or has reconnected. Close other camera apps and try again.',
    422: 'This camera does not support 640×480 MJPEG video. Select a compatible USB camera.',
    429: 'The camera or viewer limit is reached. Pause another camera or close another viewer and try again.',
    501: 'Camera support is unavailable. Update Edge Manager to 0.2.41 or later.',
    503: 'The camera is unavailable. Check its USB connection and access in Edge Console.',
    504: 'The camera did not send video. Check its USB connection and try again.'
  };
  return { status, message: messages[status] };
}

function createApp({ runtime = createRuntimeClient(), secret = process.env.ORENDA_EDGE_APP_PROXY_SECRET, viewerLeaseMs = 15000 } = {}) {
  if (!Number.isInteger(viewerLeaseMs) || viewerLeaseMs < 1 || viewerLeaseMs > 15000) throw new Error('Invalid viewer lease');
  const hubs = new Map();
  const failures = new Map();
  const viewers = new Map();
  const responseViewers = new WeakMap();
  const closedViewers = new Map();
  const ownerOf = (user) => JSON.stringify([user.source, user.id]);
  function batchBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      const finish = (error, value) => {
        clearTimeout(timer);
        req.removeListener('data', data);
        req.removeListener('end', end);
        req.removeListener('error', aborted);
        req.removeListener('aborted', aborted);
        if (error) { req.resume(); reject(error); } else resolve(value);
      };
      const data = (chunk) => {
        size += chunk.length;
        if (size > 8192) return finish(Object.assign(new Error('Status request is too large.'), { status: 413 }));
        chunks.push(chunk);
      };
      const end = () => {
        try { finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (_) { finish(Object.assign(new Error('Invalid status request.'), { status: 400 })); }
      };
      const aborted = () => finish(Object.assign(new Error('Status request interrupted.'), { status: 400 }));
      const timer = setTimeout(() => finish(Object.assign(new Error('Status request timed out.'), { status: 408 })), 5000);
      req.on('data', data).once('end', end).once('error', aborted).once('aborted', aborted);
    });
  }
  function rememberClosed(id) {
    const now = Date.now();
    for (const [key, until] of closedViewers) if (until <= now) closedViewers.delete(key);
    if (closedViewers.size >= 128) closedViewers.delete(closedViewers.keys().next().value);
    closedViewers.set(id, now + 15000);
  }
  function releaseViewer(viewer) {
    if (viewer.closed) return;
    viewer.closed = true;
    if (viewers.get(viewer.id) === viewer) viewers.delete(viewer.id);
    rememberClosed(viewer.id);
    viewer.hub.clients.delete(viewer.res);
    viewer.res.destroy();
    if (!viewer.hub.clients.size) stopHub(viewer.hub);
  }
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
      const viewer = responseViewers.get(res);
      if (viewer) { if (viewers.get(viewer.id) === viewer) viewers.delete(viewer.id); rememberClosed(viewer.id); }
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
    const header = Buffer.from(`--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`);
    const frame = { header, jpeg };
    const now = Date.now();
    hub.lastFrameAt = now;
    hub.latest = frame;
    for (const res of hub.clients) {
      const viewer = responseViewers.get(res);
      if (viewer) writeJpegFrame(viewer, frame, releaseViewer, now);
    }
  }
  function viewerStatus(id, viewerId, user, renew = true) {
    const viewer = viewerId ? viewers.get(viewerId) : null;
    if (viewer && (viewer.owner !== ownerOf(user) || viewer.hub.id !== id)) throw Object.assign(new Error('Viewer not found.'), { status: 404 });
    const failure = failures.get(id);
    if (viewerId && (!viewer || viewer.expiresAt <= Date.now())) {
      if (viewer) releaseViewer(viewer);
      return { state: 'idle', error: failure?.message || null, errorCode: failure?.status || null, fps: 0, lastFrameAgeMs: null };
    }
    if (viewer && renew) viewer.expiresAt = Date.now() + viewerLeaseMs;
    const hub = hubs.get(id);
    const capturedAt = hub?.lastFrameAt || 0;
    const frameAt = viewer ? Math.min(capturedAt, viewer.lastSentAt) : capturedAt;
    const lastFrameAgeMs = frameAt ? Math.max(0, Date.now() - frameAt) : null;
    return { state: failure ? 'error' : frameAt ? 'live' : hub ? 'connecting' : 'idle', error: failure?.message || null,
      errorCode: failure?.status || null, fps: lastFrameAgeMs !== null && lastFrameAgeMs < 2000 ? viewer?.fps || 0 : 0, lastFrameAgeMs };
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
            for (const frame of parser.push(chunk)) sendFrame(hub, frame);
          }
          if (!hub.stopped) recordFailure(hub, { status: 503 });
        } catch (error) { recordFailure(hub, error); }
      });
    }).catch((error) => { recordFailure(hub, error); throw error; });
    hub.watchdog = setInterval(() => {
      for (const res of hub.clients) {
        const viewer = responseViewers.get(res);
        if (viewer && viewer.expiresAt <= Date.now()) releaseViewer(viewer);
      }
      if (hub.stopped) return;
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
      const stopRoute = /^\/api\/viewers\/([^/]+)\/stop$/.exec(url.pathname);
      if (req.method === 'POST' && stopRoute) {
        const viewerId = stopRoute[1];
        if (!VIEWER_ID.test(viewerId)) return json(res, 400, { error: 'Invalid viewer.' });
        const viewer = viewers.get(viewerId);
        if (viewer && viewer.owner !== ownerOf(user)) return json(res, 404, { error: 'Viewer not found.' });
        if (viewer) releaseViewer(viewer);
        else rememberClosed(viewerId);
        req.resume();
        res.writeHead(204, { 'Cache-Control': 'no-store' });
        return res.end();
      }
      if (req.method === 'POST' && url.pathname === '/api/status') {
        if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) return json(res, 415, { error: 'Send a JSON status request.' });
        try {
          const body = await batchBody(req);
          if (!body || !Array.isArray(body.viewers) || body.viewers.length > 16 || Object.keys(body).some(key => key !== 'viewers')) throw Object.assign(new Error('Invalid status request.'), { status: 400 });
          const seen = new Set();
          for (const item of body.viewers) {
            if (!item || !CAMERA_ID.test(item.camera || '') || !VIEWER_ID.test(item.viewer || '') || seen.has(item.viewer) || Object.keys(item).some(key => !['camera', 'viewer', 'fps'].includes(key)) || (item.fps !== undefined && ![5, 10].includes(item.fps))) throw Object.assign(new Error('Invalid viewer.'), { status: 400 });
            seen.add(item.viewer);
            // Check the entire batch before renewing any leases.
            const viewer = viewers.get(item.viewer);
            if (viewer && (viewer.owner !== ownerOf(user) || viewer.hub.id !== item.camera)) throw Object.assign(new Error('Viewer not found.'), { status: 404 });
          }
          return json(res, 200, { viewers: body.viewers.map(({ camera, viewer, fps }) => {
            const current = viewers.get(viewer);
            if (current && fps !== undefined && current.targetFps !== fps) {
              current.targetFps = fps;
              current.sentFrames = 0;
              current.fps = 0;
              current.rateStartedAt = Date.now();
            }
            return { camera, viewer, ...viewerStatus(camera, viewer, user) };
          }) });
        } catch (error) {
          if ([408, 413].includes(error.status)) res.setHeader('Connection', 'close');
          return json(res, error.status || 400, { error: error.message });
        }
      }
      if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed.' });
      if (url.pathname === '/api/session') return json(res, 200, { user });
      if (url.pathname === '/api/cameras') {
        try {
          const [result, context] = await Promise.all([runtime.usb.devices(), Promise.resolve().then(() => runtime.context?.()).catch(() => null)]);
          const cameras = (result.devices || []).filter((device) => device.type === 'camera' && device.read).map(({ id, name }) => ({ id, name }));
          const maxConcurrentCameras = context?.services?.usb?.maxConcurrentCameraStreams >= 2 ? 2 : 1;
          return json(res, 200, { cameras, profile: PROFILE, limits: { maxConcurrentCameras, maxViewersPerCamera: MAX_VIEWERS }, modes: MODES });
        } catch (error) { const failure = cameraError(error); return json(res, failure.status, { error: failure.message }); }
      }
      if (url.pathname === '/api/stream' || url.pathname === '/api/status') {
        const id = url.searchParams.get('camera');
        if (!CAMERA_ID.test(id || '')) return json(res, 400, { error: 'Choose an approved camera.' });
        if (url.pathname === '/api/status') {
          const viewerId = url.searchParams.get('viewer');
          if (viewerId !== null && !VIEWER_ID.test(viewerId)) return json(res, 400, { error: 'Invalid viewer.' });
          try { return json(res, 200, viewerStatus(id, viewerId, user)); }
          catch (error) { return json(res, error.status, { error: error.message }); }
        }
        try {
          const viewerId = url.searchParams.get('viewer');
          if (!VIEWER_ID.test(viewerId || '')) return json(res, 400, { error: 'Invalid viewer.' });
          const fps = url.searchParams.get('fps') || '10';
          if (!['5', '10'].includes(fps)) return json(res, 400, { error: 'Choose Standard or Data saver video.' });
          if (viewers.has(viewerId) || (closedViewers.get(viewerId) || 0) > Date.now()) return json(res, 409, { error: 'This viewer has closed or is already open. Start video again.' });
          const hub = getHub(id);
          if (hub.clients.size >= MAX_VIEWERS) return json(res, 429, { error: cameraError({ status: 429 }).message });
          // Reserve before awaiting the camera so simultaneous joins remain bounded.
          const viewer = { id: viewerId, owner: ownerOf(user), hub, res, expiresAt: Date.now() + viewerLeaseMs,
            targetFps: Number(fps), lastSentAt: 0, blockedAt: 0, rateStartedAt: Date.now(), sentFrames: 0, fps: 0 };
          viewers.set(viewerId, viewer);
          responseViewers.set(res, viewer);
          hub.clients.add(res);
          res.once('close', () => releaseViewer(viewer));
          await hub.ready;
          if (res.destroyed || hub.stopped) return;
          res.writeHead(200, { 'Content-Type': `multipart/x-mixed-replace; boundary=${BOUNDARY}`, 'Cache-Control': 'no-store, no-cache, must-revalidate', 'X-Accel-Buffering': 'no', 'X-Content-Type-Options': 'nosniff' });
          res.flushHeaders();
          if (hub.latest) writeJpegFrame(viewer, hub.latest, releaseViewer);
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
