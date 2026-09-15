const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { randomBytes } = require('node:crypto');
const { createApp, PROFILE } = require('../server');

const id = 'usb-' + '1'.repeat(32);
const otherId = 'usb-' + '2'.repeat(32);
const thirdId = 'usb-' + '3'.repeat(32);
const secret = 'camera-test-proxy-secret';
const headers = { 'x-orenda-edge-proxy-secret': secret, 'x-orenda-username': 'operator', 'x-orenda-auth-source': 'fixture', 'x-orenda-user-name': 'Box operator' };
const jpeg = Buffer.from([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
const part = Buffer.concat([Buffer.from(`--fixture-camera\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`), jpeg, Buffer.from('\r\n')]);

async function fixture(t, options = {}) {
  const streams = [];
  const requests = [];
  const viewers = [];
  const runtime = { context: options.context || (async () => ({ services: { usb: { maxConcurrentCameraStreams: 2 } } })), usb: {
    devices: options.devices || (async () => ({ devices: [{ id, name: 'Logitech C270', type: 'camera', read: true }] })),
    cameraStream: options.cameraStream || (async (camera, settings) => {
      const stream = { camera, settings, aborted: false, canceled: false };
      stream.body = new ReadableStream({ start(controller) { stream.controller = controller; }, cancel() { stream.canceled = true; } });
      settings.signal.addEventListener('abort', () => {
        stream.aborted = true;
        try { stream.controller.error(new DOMException('Capture stopped', 'AbortError')); } catch (_) { /* Already closed. */ }
      }, { once: true });
      streams.push(stream);
      return { body: stream.body, contentType: 'multipart/x-mixed-replace; boundary=fixture-camera' };
    })
  } };
  const original = runtime.usb.cameraStream;
  runtime.usb.cameraStream = (...args) => { requests.push(args); return original(...args); };
  const server = createApp({ runtime, secret, viewerLeaseMs: options.viewerLeaseMs });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    viewers.forEach((controller) => controller.abort());
    server.stopCameras();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const request = (route, { raw = false, ...init } = {}) => {
    if (!raw && route.startsWith('/api/stream?') && !route.includes('viewer=')) route += '&viewer=' + randomBytes(16).toString('hex');
    return fetch(base + route, { headers, ...init });
  };
  const view = async (camera = id, fps = 10) => {
    const controller = new AbortController();
    const viewer = randomBytes(16).toString('hex');
    viewers.push(controller);
    const response = await request(`/api/stream?camera=${camera}&viewer=${viewer}&fps=${fps}`, { signal: controller.signal });
    return { response, controller, viewer };
  };
  return { request, view, streams, requests, server };
}

async function until(predicate) {
  for (let attempt = 0; attempt < 250; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('Expected camera state did not settle');
}

test('health is public and all app assets and APIs require the Edge proxy identity', async (t) => {
  const app = await fixture(t);
  const health = await app.request('/health', { headers: {} });
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true });
  for (const route of ['/', '/app.js', '/style.css', '/icon.svg', '/api/session', '/api/cameras', `/api/stream?camera=${id}`, `/api/status?camera=${id}`]) {
    const response = await app.request(route, { headers: { 'x-orenda-username': 'forged' } });
    assert.equal(response.status, 401, route);
    assert.match((await response.json()).error, /Edge Console/);
  }
  const wrongSecret = await app.request('/api/cameras', { headers: { ...headers, 'x-orenda-edge-proxy-secret': 'wrong' } });
  assert.equal(wrongSecret.status, 401);
  const session = await app.request('/api/session');
  assert.equal((await session.json()).user.name, 'Box operator');
  assert.equal(app.requests.length, 0);
});

test('camera discovery returns only readable cameras and no host paths or unrelated devices', async (t) => {
  const app = await fixture(t, { devices: async () => ({ devices: [
    { id, name: 'Logitech C270', type: 'camera', read: true, devicePath: '/dev/video0', serialNumber: 'private-hardware-id' },
    { id: otherId, name: 'Printer', type: 'printer', read: true },
    { id: thirdId, name: 'Unapproved camera', type: 'camera', read: false }
  ] }) });
  const response = await app.request('/api/cameras');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { cameras: [{ id, name: 'Logitech C270' }], profile: { width: 640, height: 480, fps: 10 },
    limits: { maxConcurrentCameras: 2, maxViewersPerCamera: 8 }, modes: [{ id: 'standard', label: 'Standard', fps: 10 }, { id: 'data-saver', label: 'Data saver', fps: 5 }] });
  assert.deepEqual(PROFILE, { width: 640, height: 480, fps: 10 });
});

test('no camera is a successful empty discovery state', async (t) => {
  const app = await fixture(t, { devices: async () => ({ devices: [] }) });
  assert.deepEqual((await (await app.request('/api/cameras')).json()).cameras, []);
  assert.equal((await (await app.request(`/api/status?camera=${id}`)).json()).state, 'idle');
});

test('declined and unavailable runtime errors are sanitized into useful setup states', async (t) => {
  for (const status of [403, 404, 409, 429, 501, 503, 504, 500]) {
    await t.test(String(status), async (t) => {
      const app = await fixture(t, { devices: async () => { throw Object.assign(new Error('secret host path /dev/video99'), { status }); } });
      const response = await app.request('/api/cameras');
      assert.equal(response.status, status === 500 ? 503 : status);
      const body = await response.text();
      assert.doesNotMatch(body, /secret|\/dev\//);
      assert.match(body, /camera|Camera/);
    });
  }
});

test('invalid camera identifiers, unsupported methods and unknown recording routes never start capture', async (t) => {
  const app = await fixture(t);
  for (const camera of ['', '/dev/video0', '../video0', 'usb-' + 'g'.repeat(32)]) {
    for (const route of ['stream', 'status']) {
      const response = await app.request(`/api/${route}?camera=${encodeURIComponent(camera)}`);
      assert.equal(response.status, 400);
      await response.arrayBuffer();
    }
  }
  assert.equal((await app.request('/api/cameras', { method: 'POST' })).status, 405);
  for (const route of ['/api/record', '/api/audio', '/api/snapshot']) assert.equal((await app.request(route)).status, 404);
  assert.equal(app.requests.length, 0);
});

test('two viewers share one capture and late viewers receive a complete latest JPEG', async (t) => {
  const app = await fixture(t);
  const first = await app.view();
  assert.equal(first.response.status, 200);
  assert.match(first.response.headers.get('content-type'), /^multipart\/x-mixed-replace; boundary=orenda-camera$/);
  assert.match(first.response.headers.get('cache-control'), /no-store/);
  assert.equal(app.requests.length, 1);
  assert.deepEqual({ ...app.requests[0][1], signal: undefined }, { ...PROFILE, signal: undefined });
  const reader = first.response.body.getReader();
  app.streams[0].controller.enqueue(part.subarray(0, 17));
  app.streams[0].controller.enqueue(part.subarray(17));
  const initial = Buffer.from((await reader.read()).value);
  assert.ok(initial.includes(jpeg));
  assert.match(initial.toString('latin1'), /^--orenda-camera\r\n/);
  const second = await app.view();
  const secondReader = second.response.body.getReader();
  assert.deepEqual(Buffer.from((await secondReader.read()).value), initial);
  assert.equal(app.requests.length, 1);
  assert.equal((await (await app.request(`/api/status?camera=${id}`)).json()).state, 'live');
  first.controller.abort();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(app.streams[0].aborted, false);
  second.controller.abort();
  await until(() => app.streams[0].aborted);
  assert.equal((await (await app.request(`/api/status?camera=${id}`)).json()).state, 'idle');
});

test('simultaneous joins enforce eight viewers and two active cameras', async (t) => {
  const app = await fixture(t);
  const viewers = await Promise.all(Array.from({ length: 8 }, () => app.view()));
  assert.ok(viewers.every(({ response }) => response.status === 200));
  assert.equal(app.requests.length, 1);
  const excess = await app.view();
  assert.equal(excess.response.status, 429);
  await excess.response.arrayBuffer();
  assert.equal((await app.view(otherId)).response.status, 200);
  const third = await app.view(thirdId);
  assert.equal(third.response.status, 429);
  await third.response.arrayBuffer();
  assert.equal(app.requests.length, 2);
});

test('capture setup failure returns a sanitized error and leaves no capture running', async (t) => {
  const app = await fixture(t, { cameraStream: async () => { throw Object.assign(new Error('internal token fixture'), { status: 403 }); } });
  const { response } = await app.view();
  assert.equal(response.status, 403);
  assert.doesNotMatch(await response.text(), /token|fixture/);
  const status = await (await app.request(`/api/status?camera=${id}`)).json();
  assert.equal(status.state, 'error');
  assert.match(status.error, /approved/);
});

test('an upstream stream error terminates viewers and can be retried without stale capture state', async (t) => {
  const app = await fixture(t);
  const first = await app.view();
  const reader = first.response.body.getReader();
  app.streams[0].controller.enqueue(part);
  await reader.read();
  const terminated = assert.rejects(reader.read());
  app.streams[0].controller.error(new Error('camera disconnected'));
  await terminated;
  await until(() => app.streams[0].aborted);
  assert.equal((await (await app.request(`/api/status?camera=${id}`)).json()).state, 'error');
  assert.equal((await app.view()).response.status, 200);
  assert.equal(app.requests.length, 2);
});

test('app shutdown aborts every active upstream capture', async (t) => {
  const app = await fixture(t);
  await app.view();
  await app.view(otherId);
  app.server.stopCameras();
  assert.ok(app.streams.every((stream) => stream.aborted));
});

test('closing a viewer during camera startup cancels the eventual upstream body', async (t) => {
  let complete;
  let settings;
  let canceled = false;
  const app = await fixture(t, { cameraStream: (_id, options) => {
    settings = options;
    return new Promise((resolve) => { complete = resolve; });
  } });
  const controller = new AbortController();
  const opening = app.request(`/api/stream?camera=${id}`, { signal: controller.signal });
  const aborted = assert.rejects(opening, { name: 'AbortError' });
  await until(() => complete);
  controller.abort();
  await aborted;
  await until(() => settings.signal.aborted);
  complete({ body: new ReadableStream({ cancel() { canceled = true; } }), contentType: 'multipart/x-mixed-replace; boundary=camera' });
  await until(() => canceled);
});

test('a nonmultipart camera response is rejected and its upstream is aborted', async (t) => {
  let settings;
  const app = await fixture(t, { cameraStream: async (_id, options) => {
    settings = options;
    return { body: new ReadableStream(), contentType: 'text/html' };
  } });
  const { response } = await app.view();
  assert.equal(response.status, 503);
  assert.equal(settings.signal.aborted, true);
  assert.match((await response.json()).error, /camera is unavailable/);
});

test('a stream requires an unpredictable viewer id', async (t) => {
  const app = await fixture(t);
  for (const viewer of ['', 'short', 'f'.repeat(31), 'F'.repeat(32), '../stop']) {
    const response = await app.request(`/api/stream?camera=${id}&viewer=${encodeURIComponent(viewer)}`, { raw: true });
    assert.equal(response.status, 400);
    await response.arrayBuffer();
  }
  assert.equal(app.requests.length, 0);
});

test('only the viewer owner can stop that viewer and other viewers keep their capture', async (t) => {
  const app = await fixture(t);
  const first = await app.view();
  const second = await app.view();
  for (const intruder of [{ ...headers, 'x-orenda-username': 'intruder' }, { ...headers, 'x-orenda-auth-source': 'different-source' }]) {
    const denied = await app.request(`/api/viewers/${first.viewer}/stop`, { method: 'POST', headers: intruder });
    assert.equal(denied.status, 404);
    await denied.arrayBuffer();
  }
  assert.equal(app.streams[0].aborted, false);
  const disconnected = assert.rejects(first.response.body.getReader().read());
  assert.equal((await app.request(`/api/viewers/${first.viewer}/stop`, { method: 'POST' })).status, 204);
  await disconnected;
  assert.equal(app.streams[0].aborted, false);
  assert.equal((await app.request(`/api/viewers/${first.viewer}/stop`, { method: 'POST' })).status, 204);
  assert.equal((await app.request(`/api/viewers/${second.viewer}/stop`, { method: 'POST' })).status, 204);
  await until(() => app.streams[0].aborted);
});

test('stopping before a delayed stream request prevents late capture and a fresh viewer can retry', async (t) => {
  const app = await fixture(t);
  const viewer = randomBytes(16).toString('hex');
  assert.equal((await app.request(`/api/viewers/${viewer}/stop`, { method: 'POST' })).status, 204);
  const late = await app.request(`/api/stream?camera=${id}&viewer=${viewer}`);
  assert.ok([409, 410].includes(late.status));
  await late.arrayBuffer();
  assert.equal(app.requests.length, 0);
  assert.equal((await app.view()).response.status, 200);
  assert.equal(app.requests.length, 1);
});

test('an owner can stop a viewer while its camera is still starting', async (t) => {
  let complete;
  let settings;
  let canceled = false;
  const app = await fixture(t, { cameraStream: (_id, options) => {
    settings = options;
    return new Promise((resolve) => { complete = resolve; });
  } });
  const viewer = randomBytes(16).toString('hex');
  const opening = app.request(`/api/stream?camera=${id}&viewer=${viewer}`);
  const closed = assert.rejects(opening);
  await until(() => complete);
  assert.equal((await app.request(`/api/viewers/${viewer}/stop`, { method: 'POST' })).status, 204);
  await closed;
  assert.equal(settings.signal.aborted, true);
  complete({ body: new ReadableStream({ cancel() { canceled = true; } }), contentType: 'multipart/x-mixed-replace; boundary=camera' });
  await until(() => canceled);
});

test('expired viewers close even if the browser retains their HTTP stream', async (t) => {
  const app = await fixture(t, { viewerLeaseMs: 100 });
  const { response } = await app.view();
  await assert.rejects(response.body.getReader().read());
  await until(() => app.streams[0].aborted);
});

test('owned status heartbeats renew only their viewer and global status cannot retain abandoned viewers', async (t) => {
  const app = await fixture(t, { viewerLeaseMs: 200 });
  const abandoned = await app.view();
  const active = await app.view();
  const timer = setInterval(() => {
    for (const suffix of ['', `&viewer=${active.viewer}`]) {
      app.request(`/api/status?camera=${id}${suffix}`).then((response) => response.arrayBuffer()).catch(() => {});
    }
  }, 50);
  t.after(() => clearInterval(timer));
  await assert.rejects(abandoned.response.body.getReader().read());
  assert.equal(app.streams[0].aborted, false);
  clearInterval(timer);
  assert.equal((await app.request(`/api/viewers/${active.viewer}/stop`, { method: 'POST' })).status, 204);
  await until(() => app.streams[0].aborted);
});

test('older or unavailable runtime context safely limits the monitoring layout to one camera', async (t) => {
  for (const context of [async () => ({ services: { usb: { camera: true } } }), async () => { throw new Error('private runtime detail'); }]) {
    const app = await fixture(t, { context });
    const response = await app.request('/api/cameras');
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.limits.maxConcurrentCameras, 1);
    assert.equal(body.cameras.length, 1);
    assert.doesNotMatch(JSON.stringify(body), /private runtime/);
  }
});

test('two cameras stream independently and stopping one leaves the other live', async (t) => {
  const app = await fixture(t);
  const first = await app.view(id);
  const second = await app.view(otherId);
  const firstReader = first.response.body.getReader();
  const secondReader = second.response.body.getReader();
  app.streams[0].controller.enqueue(part);
  app.streams[1].controller.enqueue(part);
  assert.ok(Buffer.from((await firstReader.read()).value).includes(jpeg));
  assert.ok(Buffer.from((await secondReader.read()).value).includes(jpeg));
  assert.deepEqual(app.streams.map(stream => stream.camera), [id, otherId]);
  await app.request(`/api/viewers/${first.viewer}/stop`, { method: 'POST' });
  await until(() => app.streams[0].aborted);
  assert.equal(app.streams[1].aborted, false);
  assert.equal((await (await app.request(`/api/status?camera=${otherId}&viewer=${second.viewer}`)).json()).state, 'live');
});

test('one batched status request renews only its owned viewers across both cameras', async (t) => {
  const app = await fixture(t, { viewerLeaseMs: 250 });
  const abandoned = await app.view();
  const first = await app.view();
  const second = await app.view(otherId);
  const body = JSON.stringify({ viewers: [{ camera: id, viewer: first.viewer }, { camera: otherId, viewer: second.viewer }] });
  const pulse = () => app.request('/api/status', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body });
  const result = await (await pulse()).json();
  assert.deepEqual(result.viewers.map(row => [row.camera, row.viewer, row.state]), [[id, first.viewer, 'connecting'], [otherId, second.viewer, 'connecting']]);
  const timer = setInterval(() => pulse().then(response => response.arrayBuffer()).catch(() => {}), 50);
  t.after(() => clearInterval(timer));
  await assert.rejects(abandoned.response.body.getReader().read());
  assert.equal(app.streams[0].aborted, false);
  assert.equal(app.streams[1].aborted, false);
  assert.equal((await (await pulse()).json()).viewers.length, 2);
  assert.equal(app.requests.length, 2);
});

test('batched status validates the entire request and cannot retain or inspect another owner', async (t) => {
  const app = await fixture(t, { viewerLeaseMs: 200 });
  const first = await app.view();
  const owned = { camera: id, viewer: first.viewer };
  const post = (body, auth = headers) => app.request('/api/status', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  for (const body of ['{', {}, { viewers: null }, { viewers: [owned, owned] }, { viewers: [null] }, { viewers: [{ ...owned, fps: '5' }] }, { viewers: [{ ...owned, fps: 30 }] }, { viewers: [{ camera: '/dev/video0', viewer: first.viewer }] }, { viewers: Array.from({ length: 17 }, () => owned) }]) {
    assert.equal((await post(body)).status, 400);
  }
  assert.equal((await app.request('/api/status', { method: 'POST', body: '{}' })).status, 415);
  assert.equal((await post({ viewers: [] }, { 'x-orenda-username': 'forged' })).status, 401);
  assert.equal((await post('x'.repeat(8193))).status, 413);
  assert.equal((await post({ viewers: [owned] }, { ...headers, 'x-orenda-auth-source': 'another-source' })).status, 404);
  assert.equal((await post({ viewers: [{ camera: otherId, viewer: first.viewer }] })).status, 404);
  const timer = setInterval(() => post({ viewers: [owned] }, { ...headers, 'x-orenda-username': 'another-user' }).then(response => response.arrayBuffer()).catch(() => {}), 50);
  t.after(() => clearInterval(timer));
  await assert.rejects(first.response.body.getReader().read());
  assert.equal(app.streams[0].aborted, true);
});

test('data saver changes an existing viewer rate without reconnecting or changing other viewers', async (t) => {
  const app = await fixture(t);
  const full = await app.view(id, 10);
  const saver = await app.view(id, 10);
  const changed = await app.request('/api/status', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ viewers: [{ camera: id, viewer: saver.viewer, fps: 5 }] }) });
  assert.equal(changed.status, 200);
  assert.equal((await changed.json()).viewers[0].viewer, saver.viewer);
  const count = async response => {
    let frames = 0;
    const { JpegParts } = require('../stream');
    const parser = new JpegParts(response.headers.get('content-type'));
    try { for await (const chunk of response.body) for (const frame of parser.push(chunk)) { assert.deepEqual(frame, jpeg); frames++; } } catch (_) { /* Test ends the response. */ }
    return frames;
  };
  const fullCount = count(full.response);
  const saverCount = count(saver.response);
  for (let frame = 0; frame < 12; frame++) {
    app.streams[0].controller.enqueue(part);
    await new Promise(resolve => setTimeout(resolve, 105));
  }
  full.controller.abort(); saver.controller.abort();
  const [standardFrames, savedFrames] = await Promise.all([fullCount, saverCount]);
  assert.ok(standardFrames >= 10, String(standardFrames));
  assert.ok(savedFrames >= 5 && savedFrames <= 7, String(savedFrames));
  assert.ok(savedFrames < standardFrames);
  assert.equal(app.requests.length, 1);
  for (const fps of ['0', '30', '5.0', '-1', 'abc']) assert.equal((await app.request(`/api/stream?camera=${id}&fps=${fps}`)).status, 400);
});

test('a maximum-size valid JPEG reaches a viewer without the multipart overhead exceeding its bound', async (t) => {
  const app = await fixture(t);
  const { response } = await app.view();
  const { JpegParts } = require('../stream');
  const parser = new JpegParts(response.headers.get('content-type'));
  const large = Buffer.alloc(1024 * 1024, 23);
  large.writeUInt16BE(0xffd8, 0); large.writeUInt16BE(0xffd9, large.length - 2);
  app.streams[0].controller.enqueue(Buffer.concat([Buffer.from(`--fixture-camera\r\nContent-Type: image/jpeg\r\nContent-Length: ${large.length}\r\n\r\n`), large, Buffer.from('\r\n')]));
  for await (const chunk of response.body) {
    const frames = [...parser.push(chunk)];
    if (frames.length) { assert.deepEqual(frames[0], large); break; }
  }
});
