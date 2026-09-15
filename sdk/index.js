const crypto = require('node:crypto');

function header(headers, name) {
  const value = typeof headers.get === 'function' ? headers.get(name) : headers[name];
  return Array.isArray(value) ? '' : String(value || '').trim();
}

function authenticateEdgeRequest(headers, secret = process.env.ORENDA_EDGE_APP_PROXY_SECRET) {
  const provided = Buffer.from(header(headers, 'x-orenda-edge-proxy-secret'));
  const expected = Buffer.from(String(secret || ''));
  if (!expected.length || expected.length !== provided.length || !crypto.timingSafeEqual(expected, provided)) return null;
  const username = header(headers, 'x-orenda-username');
  const source = header(headers, 'x-orenda-auth-source');
  if (!username || !source) return null;
  return {
    id: header(headers, 'x-orenda-user-id') || username,
    username,
    name: header(headers, 'x-orenda-user-name') || username,
    roles: header(headers, 'x-orenda-user-roles').split(',').map((role) => role.trim()).filter(Boolean),
    source
  };
}

function requireEdgeUser(req, res, next) {
  req.user = authenticateEdgeRequest(req.headers);
  if (req.user) return next();
  res.writeHead(401, { 'Content-Type': 'application/json' });
  return res.end(JSON.stringify({ error: 'Open this app from Edge Console to continue' }));
}

function usbDeviceRoute(id) {
  if (typeof id !== 'string' || !/^usb-[a-f0-9]{32}$/.test(id)) throw new Error('Choose a USB device id returned by usb.devices()');
  return `/usb/devices/${id}`;
}

function createRuntimeClient({ baseUrl = process.env.ORENDA_EDGE_API_URL, token = process.env.ORENDA_APP_TOKEN, fetchImpl = fetch } = {}) {
  const request = async (route, body, method = body ? 'POST' : 'GET', streamOptions) => {
    if (!baseUrl || !token) throw new Error('OrendaBox runtime credentials are unavailable; install through Edge Console');
    const controller = new AbortController();
    const signal = streamOptions?.signal ? AbortSignal.any([controller.signal, streamOptions.signal]) : controller.signal;
    const timeout = setTimeout(() => controller.abort(new Error('OrendaBox API did not respond')), 10000);
    timeout.unref?.();
    let response;
    try { response = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}${route}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'error', signal
    }); } catch (error) { clearTimeout(timeout); throw error; }
    if (!response.ok) {
      let details;
      try { details = await response.json?.().catch(() => null); } finally { clearTimeout(timeout); }
      const error = new Error(details?.error || `OrendaBox API ${route} returned ${response.status}`);
      error.status = response.status;
      throw error;
    }
    if (streamOptions) {
      clearTimeout(timeout);
      const contentType = response.headers.get('content-type') || '';
      if (!/^multipart\/x-mixed-replace\s*;\s*boundary=orenda-camera$/i.test(contentType) || !response.body) {
        controller.abort(); throw new Error('OrendaBox returned an invalid camera stream');
      }
      return { body: response.body, contentType };
    }
    try { return await response.json(); } finally { clearTimeout(timeout); }
  };
  return {
    context: () => request('/context'),
    config: () => request('/config'),
    listPlcTags: () => request('/plc/tags'),
    readPlcTags: (tags) => request('/plc/read', { tags }),
    usb: {
      devices: () => request('/usb/devices'),
      cameraStream: (id, options = {}) => {
        const route = usbDeviceRoute(id);
        const { width = 640, height = 480, fps = 10, signal } = options;
        if (Object.keys(options).some((key) => !['width', 'height', 'fps', 'signal'].includes(key)) || ![[320, 240], [640, 480], [1280, 720]].some(([w, h]) => w === width && h === height) || !Number.isInteger(fps) || fps < 1 || fps > 15) throw new Error('Camera streams require a supported resolution and 1–15 fps');
        return request(`${route}/camera/stream?width=${width}&height=${height}&fps=${fps}`, undefined, 'GET', { signal });
      },
      read: (id, { maxBytes = 4096, timeoutMs = 5000 } = {}) => {
        const route = usbDeviceRoute(id);
        if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 4096 || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000) throw new Error('USB reads require maxBytes 1–4096 and timeoutMs 1–5000');
        return request(`${route}/read`, { maxBytes, timeoutMs });
      },
      write: (id, bytes) => {
        const route = usbDeviceRoute(id);
        if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > 65536) throw new Error('USB writes require a Buffer or Uint8Array containing 1–65536 bytes');
        const dataBase64 = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
        return request(`${route}/write`, { dataBase64 });
      }
    },
    metrics: {
      query: (query, options = {}) => request('/prometheus/query', { query, ...options }),
      queryRange: (query, { start, end, step }) => request('/prometheus/query-range', { query, start, end, step }),
      metricNames: (prefix = '') => request(`/prometheus/metrics?prefix=${encodeURIComponent(prefix)}`)
    },
    mongo: {
      collections: () => request('/mongodb/collections'),
      collection: (name) => {
        if (typeof name !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(name) || /^system/i.test(name)) throw new Error('Invalid MongoDB collection name');
        const base = `/mongodb/collections/${encodeURIComponent(name)}`;
        return {
          find: (filter = {}, options = {}) => request(`${base}/find`, { filter, ...options }),
          get: (id) => request(`${base}/documents/${encodeURIComponent(id)}`),
          insertOne: (document) => request(`${base}/documents`, { document }),
          replaceOne: (id, document) => request(`${base}/documents/${encodeURIComponent(id)}`, { document }, 'PUT'),
          deleteOne: (id) => request(`${base}/documents/${encodeURIComponent(id)}`, undefined, 'DELETE')
        };
      }
    }
  };
}

module.exports = { authenticateEdgeRequest, requireEdgeUser, createRuntimeClient };
