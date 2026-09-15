const byId = (id) => document.getElementById(id);
const grid = byId('camera-grid');
const records = new Map();
const blankFrame = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const preferenceKey = 'orenda-camera-monitor-v1';
let preferences = { quality: 'standard', paused: false, cameras: {} };
let storageAvailable = true;
let maxConcurrent = 1;
let ready = false;
let loading = false;
let suspended = document.hidden;
let focused = '';
let pollTimer;
let countdownTimer;
let statusController;
let polling = false;

try {
  const saved = JSON.parse(localStorage.getItem(preferenceKey) || 'null');
  if (saved && typeof saved === 'object') {
    preferences.quality = saved.quality === 'data-saver' ? 'data-saver' : 'standard';
    preferences.paused = saved.paused === true;
    for (const [id, value] of Object.entries(saved.cameras || {}).slice(0, 128)) {
      if (!/^usb-[a-f0-9]{32}$/.test(id) || !value || typeof value !== 'object') continue;
      const until = Number(value.until);
      preferences.cameras[id] = { paused: value.paused === true, until: Number.isFinite(until) && until > Date.now() && until < Date.now() + 900000 ? until : 0 };
    }
  }
} catch { storageAvailable = false; }
byId('quality').value = preferences.quality;

function text(node, value) {
  if (node.textContent !== value) node.textContent = value;
}
function savePreferences() {
  preferences.cameras = {};
  for (const record of records.values()) preferences.cameras[record.id] = { paused: record.manualPaused, until: record.pauseUntil };
  if (storageAvailable) {
    try { localStorage.setItem(preferenceKey, JSON.stringify(preferences)); }
    catch { storageAvailable = false; }
  }
}
function notice(message = '') {
  text(byId('notice'), message);
  byId('notice').hidden = !message;
}
async function api(route, options = {}) {
  const response = await fetch(route, { cache: 'no-store', signal: AbortSignal.timeout(12000), ...options });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Your Box could not be reached. Try again in a moment.');
  return result;
}
const activeCount = () => [...records.values()].filter((record) => record.viewer).length;
const frameRate = () => preferences.quality === 'data-saver' ? 5 : 10;
function remaining(until) {
  const seconds = Math.max(1, Math.ceil((until - Date.now()) / 1000));
  return seconds >= 60 ? `${Math.ceil(seconds / 60)} min` : `${seconds}s`;
}
function updateCard(record) {
  const active = Boolean(record.viewer);
  const timed = record.pauseUntil > Date.now();
  const full = !active && activeCount() >= maxConcurrent;
  let state = record.state;
  let label = { live: 'Live', connecting: 'Connecting', stalled: 'Reconnecting', busy: 'Busy', offline: 'Offline', error: 'Unavailable', paused: 'Paused' }[state];
  let heading = { live: '', connecting: 'Opening your live view', stalled: 'Waiting for video', busy: 'Camera is busy', offline: 'Camera is offline', error: 'No video right now', paused: 'Ready when you are' }[state];
  let message = record.message;
  if (!active && state === 'paused') {
    if (suspended && record.wanted) { heading = 'Paused in the background'; message = 'Your view resumes when you return.'; }
    else if (timed) { heading = `Back in ${remaining(record.pauseUntil)}`; message = 'Your view resumes automatically when a live slot is available.'; }
    else if (full) { heading = 'Ready when you are'; message = 'Pause another camera to start this view.'; }
    else message = 'Start a live view when you are ready.';
  }
  record.node.dataset.state = state;
  text(record.badge, label);
  text(record.heading, heading);
  text(record.detail, message);
  record.messageNode.setAttribute('aria-live', state === 'live' ? 'off' : 'polite');
  text(record.messageNode, state === 'live' ? `Live video · ${record.fps ?? 0} fps` : message);
  const showVideo = state === 'live' && active && !record.imageFailed;
  record.video.hidden = !showVideo;
  record.placeholder.hidden = showVideo;
  text(record.toggle, active ? 'Pause view' : timed ? 'Resume now' : ['error', 'offline', 'busy'].includes(state) ? 'Try again' : 'Start view');
  record.toggle.disabled = !ready || (!active && full);
  record.toggle.setAttribute('aria-label', `${active ? 'Pause' : 'Start'} camera ${record.ordinal}: ${record.name}`);
  record.duration.disabled = !ready;
}
function updateOverview() {
  const live = [...records.values()].filter((record) => record.viewer && record.state === 'live').length;
  const active = activeCount();
  text(byId('live-count'), `${live} live`);
  text(byId('camera-count'), `${records.size} camera${records.size === 1 ? '' : 's'} available`);
  text(byId('capacity-note'), `View up to ${maxConcurrent} camera${maxConcurrent === 1 ? '' : 's'} at once · ${active} of ${maxConcurrent} in use`);
  text(byId('mode-note'), `640 × 480 · ${frameRate()} fps · no audio`);
  byId('pause-all').disabled = !ready || ![...records.values()].some((record) => record.viewer || record.pauseUntil);
  byId('resume-all').disabled = !ready || !records.size || active >= Math.min(maxConcurrent, records.size);
  for (const record of records.values()) updateCard(record);
}
function closeViewer(record) {
  const closing = record.viewer;
  record.viewer = '';
  record.imageFailed = false;
  record.generation += 1;
  record.video.src = blankFrame;
  record.video.hidden = true;
  record.placeholder.hidden = false;
  if (closing) {
    // WebKit can retain an MJPEG image request after its source changes.
    // An owned stop closes only this viewer; the server lease covers lost exits.
    fetch(`api/viewers/${closing}/stop`, { method: 'POST', keepalive: true, cache: 'no-store' }).catch(() => {});
  }
}
function pause(record, minutes = 0) {
  closeViewer(record);
  if (minutes) preferences.paused = false;
  record.pauseUntil = minutes ? Date.now() + minutes * 60000 : 0;
  record.manualPaused = !minutes;
  record.wanted = Boolean(minutes);
  record.state = 'paused';
  savePreferences();
  reconcile();
}
function fail(record, message, code) {
  closeViewer(record);
  record.wanted = false;
  record.state = code === 409 || code === 429 ? 'busy' : code === 503 || code === 504 ? 'offline' : 'error';
  record.message = message || 'Video could not be displayed. Try again to reconnect.';
}
function start(record) {
  if (suspended || document.hidden || record.viewer || activeCount() >= maxConcurrent) return;
  record.viewer = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('');
  record.generation += 1;
  record.startedAt = Date.now();
  record.state = 'connecting';
  record.message = 'Waiting for the first camera frame…';
  record.imageFailed = false;
  record.fps = frameRate();
  record.video.src = `api/stream?camera=${encodeURIComponent(record.id)}&viewer=${record.viewer}&fps=${frameRate()}`;
  scheduleStatus(1000);
}
function reconcile() {
  if (!suspended && ready) {
    for (const record of records.values()) {
      if (record.pauseUntil && record.pauseUntil <= Date.now()) record.pauseUntil = 0;
      if (record.wanted && !record.manualPaused && !record.pauseUntil && !record.viewer && activeCount() < maxConcurrent) start(record);
    }
  }
  updateOverview();
  clearTimeout(countdownTimer);
  if (!suspended && [...records.values()].some((record) => record.pauseUntil)) countdownTimer = setTimeout(reconcile, 1000);
  if (!activeCount()) { clearTimeout(pollTimer); pollTimer = undefined; }
}
function resume(record) {
  if (activeCount() >= maxConcurrent) return;
  preferences.paused = false;
  record.manualPaused = false;
  record.pauseUntil = 0;
  record.wanted = true;
  record.state = 'paused';
  savePreferences();
  reconcile();
}
function scheduleStatus(delay = 3000) {
  if (suspended || !activeCount() || polling || pollTimer) return;
  pollTimer = setTimeout(checkStatus, delay);
}
async function checkStatus() {
  pollTimer = undefined;
  if (suspended || polling) return;
  const snapshot = [...records.values()].filter((record) => record.viewer).map((record) => ({ camera: record.id, viewer: record.viewer, fps: frameRate() }));
  if (!snapshot.length) return;
  polling = true;
  const controller = new AbortController();
  statusController = controller;
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const result = await api('api/status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ viewers: snapshot }), signal: controller.signal });
    for (const item of result.viewers || []) {
      const record = records.get(item.camera);
      if (!record || record.viewer !== item.viewer || suspended) continue;
      if (record.imageFailed) { fail(record, item.error || 'Video could not be displayed. Close another viewer or try again.', item.errorCode); continue; }
      if (item.state === 'error' || (item.state === 'idle' && Date.now() - record.startedAt > 2000)) {
        fail(record, item.error || 'The stream stopped. Try again to reconnect.', item.errorCode);
      } else if (item.state === 'live') {
        record.state = item.lastFrameAgeMs > 3000 ? 'stalled' : 'live';
        record.message = record.state === 'stalled' ? 'The camera has stopped sending fresh frames. Waiting to reconnect…' : '';
        record.fps = item.fps;
      }
    }
  } catch (error) {
    if (!suspended && !controller.signal.aborted) {
      for (const item of snapshot) {
        const record = records.get(item.camera);
        if (record?.viewer === item.viewer) fail(record, error.message);
      }
    } else if (!suspended) {
      for (const item of snapshot) {
        const record = records.get(item.camera);
        if (record?.viewer === item.viewer) fail(record, 'Your Box is taking too long to respond. Try again.');
      }
    }
  } finally {
    clearTimeout(timeout);
    if (statusController === controller) statusController = undefined;
    polling = false;
    reconcile();
    scheduleStatus();
  }
}
function addCamera(camera, index) {
  const node = byId('camera-template').content.firstElementChild.cloneNode(true);
  const saved = preferences.cameras[camera.id] || {};
  const record = {
    id: camera.id, name: camera.name, ordinal: index + 1, node, viewer: '', generation: 0, state: 'paused', message: '',
    wanted: !preferences.paused && saved.paused !== true, manualPaused: preferences.paused || saved.paused === true,
    pauseUntil: saved.until || 0, imageFailed: false,
    video: node.querySelector('.camera-video'), placeholder: node.querySelector('.camera-placeholder'),
    heading: node.querySelector('.camera-placeholder h3'), detail: node.querySelector('.camera-placeholder p'),
    badge: node.querySelector('.state-badge'), toggle: node.querySelector('.camera-toggle'),
    duration: node.querySelector('.timed-pause select'), messageNode: node.querySelector('.camera-message')
  };
  // Additional cameras stay paused until selected; they do not unexpectedly
  // take a slot when another manually selected view closes.
  if (!record.pauseUntil && [...records.values()].filter((item) => item.wanted && !item.pauseUntil).length >= maxConcurrent) record.wanted = false;
  node.dataset.camera = camera.id;
  node.querySelector('.camera-number').textContent = String(index + 1).padStart(2, '0');
  record.toggle.addEventListener('click', () => record.viewer ? pause(record) : resume(record));
  record.duration.setAttribute('aria-label', `Pause camera ${index + 1}: ${camera.name} for`);
  record.duration.addEventListener('change', () => {
    const minutes = Number(record.duration.value);
    record.duration.value = '';
    if ([1, 5, 15].includes(minutes)) pause(record, minutes);
  });
  node.querySelector('.focus-button').addEventListener('click', () => focusCamera(record.id));
  record.video.addEventListener('error', () => {
    if (!record.viewer || record.video.getAttribute('src') === blankFrame) return;
    record.imageFailed = true;
    record.state = 'error';
    record.message = 'Video could not be displayed. Checking the camera connection…';
    updateCard(record);
    scheduleStatus(1000);
  });
  records.set(camera.id, record);
  grid.append(node);
  return record;
}
function focusCamera(id) {
  focused = records.has(id) ? id : '';
  document.body.classList.toggle('focused', Boolean(focused));
  byId('focus-toolbar').hidden = !focused;
  byId('focus-picker').value = focused;
  for (const record of records.values()) record.node.classList.toggle('focused-card', record.id === focused);
  if (focused) {
    byId('back-to-grid').focus({ preventScroll: true });
    byId('focus-toolbar').scrollIntoView({ block: 'nearest' });
  }
}
async function loadCameras() {
  if (loading) return;
  loading = true;
  byId('refresh').disabled = true;
  byId('empty-refresh').disabled = true;
  grid.setAttribute('aria-busy', 'true');
  try {
    const result = await api('api/cameras');
    maxConcurrent = result.limits?.maxConcurrentCameras === 2 ? 2 : 1;
    const cameras = result.cameras || [];
    const ids = new Set(cameras.map((camera) => camera.id));
    for (const record of records.values()) {
      if (!ids.has(record.id)) { closeViewer(record); record.node.remove(); records.delete(record.id); }
    }
    cameras.forEach((camera, index) => {
      const record = records.get(camera.id) || addCamera(camera, index);
      record.name = camera.name;
      text(record.node.querySelector('h2'), camera.name);
      record.video.alt = `Live view from ${camera.name}`;
      record.node.querySelector('.focus-button').setAttribute('aria-label', `Focus camera ${record.ordinal}: ${camera.name}`);
    });
    let allowed = 0;
    for (const record of records.values()) {
      if (record.viewer && ++allowed > maxConcurrent) pause(record);
    }
    const picker = byId('focus-picker');
    picker.replaceChildren();
    for (const record of records.values()) { const option = document.createElement('option'); option.value = record.id; option.textContent = record.name; picker.append(option); }
    if (focused) focusCamera(focused);
    byId('empty-state').hidden = Boolean(records.size);
    byId('empty-refresh').hidden = Boolean(records.size);
    text(byId('empty-title'), 'Bring your cameras into view');
    text(byId('empty-description'), 'Connect a USB camera to your OrendaBox, then select it in this app’s USB permissions in Edge Console. Refresh when you are ready.');
    ready = true;
    notice();
    reconcile();
  } catch (error) {
    notice(error.message);
    if (!records.size) {
      text(byId('empty-title'), 'Your cameras are unavailable');
      text(byId('empty-description'), 'Check your Box connection, then try again.');
      byId('empty-refresh').hidden = false;
    }
  } finally {
    loading = false;
    byId('refresh').disabled = false;
    byId('empty-refresh').disabled = false;
    grid.setAttribute('aria-busy', 'false');
  }
}
byId('pause-all').addEventListener('click', () => {
  preferences.paused = true;
  for (const record of records.values()) {
    closeViewer(record); record.wanted = false; record.manualPaused = true; record.pauseUntil = 0; record.state = 'paused';
  }
  savePreferences();
  reconcile();
});
byId('resume-all').addEventListener('click', () => {
  preferences.paused = false;
  let slots = maxConcurrent - activeCount();
  for (const record of records.values()) {
    if (!record.viewer && slots > 0) { record.wanted = true; record.manualPaused = false; record.pauseUntil = 0; record.state = 'paused'; slots -= 1; }
  }
  savePreferences();
  reconcile();
});
byId('quality').addEventListener('change', () => {
  preferences.quality = byId('quality').value === 'data-saver' ? 'data-saver' : 'standard';
  savePreferences();
  updateOverview();
  clearTimeout(pollTimer); pollTimer = undefined;
  scheduleStatus(0);
});
byId('refresh').addEventListener('click', loadCameras);
byId('empty-refresh').addEventListener('click', loadCameras);
byId('back-to-grid').addEventListener('click', () => {
  const previous = records.get(focused);
  focusCamera('');
  previous?.node.querySelector('.focus-button').focus({ preventScroll: true });
});
byId('focus-picker').addEventListener('change', () => focusCamera(byId('focus-picker').value));
byId('fullscreen').hidden = !document.fullscreenEnabled;
byId('fullscreen').addEventListener('click', () => {
  const result = records.get(focused)?.node.requestFullscreen?.();
  result?.catch(() => { text(byId('announcement'), 'Focused view is ready. Full screen is unavailable in this browser.'); });
});
document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && focused && !document.fullscreenElement) byId('back-to-grid').click(); });
function suspend() {
  suspended = true;
  clearTimeout(pollTimer); pollTimer = undefined;
  clearTimeout(countdownTimer);
  statusController?.abort();
  for (const record of records.values()) if (record.viewer) { closeViewer(record); record.state = 'paused'; }
  updateOverview();
}
function returnToPage() {
  if (document.hidden) return;
  suspended = false;
  reconcile();
  scheduleStatus(1000);
}
document.addEventListener('visibilitychange', () => document.hidden ? suspend() : returnToPage());
window.addEventListener('pagehide', suspend);
window.addEventListener('pageshow', returnToPage);
api('api/session').then(loadCameras).catch((error) => {
  notice(error.message);
  text(byId('empty-title'), 'Open Camera Monitor from Edge Console');
  text(byId('empty-description'), 'Your Box session is needed to view its cameras.');
  grid.setAttribute('aria-busy', 'false');
});
