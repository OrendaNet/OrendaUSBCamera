const camera = document.getElementById('camera');
const video = document.getElementById('video');
const toggle = document.getElementById('toggle');
const refresh = document.getElementById('refresh');
const badge = document.getElementById('badge');
const status = document.getElementById('status');
const placeholder = document.getElementById('placeholder');
const title = document.getElementById('screen-title');
const detail = document.getElementById('screen-detail');
let selected = '';
let playing = false;
let wanted = true;
let generation = 0;
let checking = false;
let poll;

function message(state, label, text, heading = label) {
  badge.dataset.state = state;
  badge.textContent = label;
  status.textContent = text;
  title.textContent = heading;
  detail.textContent = text;
}
function stop() {
  playing = false;
  clearTimeout(poll);
  video.removeAttribute('src');
  video.hidden = true;
  placeholder.hidden = false;
  toggle.textContent = 'Start video';
}
async function api(route) {
  const response = await fetch(route, { cache: 'no-store', signal: AbortSignal.timeout(12000) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'The camera connection is unavailable.');
  return result;
}
function fail(text) {
  stop();
  message('error', 'Unavailable', text, 'No video right now');
  toggle.textContent = 'Try again';
}
async function checkState(ticket) {
  if (!playing || ticket !== generation) return;
  try {
    const result = await api(`api/status?camera=${encodeURIComponent(selected)}`);
    if (!playing || ticket !== generation) return;
    if (result.state === 'error' || result.state === 'idle') return fail(result.error || 'The stream stopped. Try again to reconnect.');
    if (result.state === 'live') {
      video.hidden = false;
      placeholder.hidden = true;
      message('live', 'Live', 'Connected to your OrendaBox camera.');
    }
  } catch (error) { if (ticket === generation && playing) return fail(error.message); }
  if (playing && ticket === generation) poll = setTimeout(() => checkState(ticket), 2000);
}
function start() {
  stop();
  if (!selected || document.hidden) return;
  const ticket = ++generation;
  playing = true;
  toggle.textContent = 'Pause video';
  message('connecting', 'Connecting', 'Waiting for the first camera frame…', 'Starting your camera');
  video.src = `api/stream?camera=${encodeURIComponent(selected)}&view=${ticket}`;
  poll = setTimeout(() => checkState(ticket), 1000);
}
async function loadCameras() {
  if (checking) return;
  checking = true;
  refresh.disabled = true;
  toggle.disabled = true;
  stop();
  const ticket = ++generation;
  message('connecting', 'Connecting', 'Looking for an approved USB camera…', 'Finding your camera');
  try {
    const result = await api('api/cameras');
    if (ticket !== generation) return;
    camera.replaceChildren();
    for (const device of result.cameras) {
      const option = document.createElement('option');
      option.value = device.id;
      option.textContent = device.name;
      camera.append(option);
    }
    const previous = result.cameras.find((device) => device.id === selected);
    selected = (previous || result.cameras.find((device) => /c270/i.test(device.name)) || result.cameras[0])?.id || '';
    camera.disabled = !selected;
    toggle.disabled = !selected;
    if (!selected) {
      const option = document.createElement('option'); option.textContent = 'No approved camera'; camera.append(option);
      return message('idle', 'No camera', 'Connect the camera to your OrendaBox, then select it under this app’s USB permissions in Edge Console.', 'Connect your USB camera');
    }
    camera.value = selected;
    if (wanted) start();
    else message('idle', 'Paused', 'Select Start video when you are ready.');
  } catch (error) { fail(error.message); }
  finally { checking = false; refresh.disabled = false; }
}
toggle.addEventListener('click', () => {
  if (playing) { wanted = false; ++generation; stop(); message('idle', 'Paused', 'Video is paused in this viewer. Other open viewers may still use the camera.'); }
  else { wanted = true; start(); }
});
camera.addEventListener('change', () => { selected = camera.value; wanted = true; start(); });
refresh.addEventListener('click', loadCameras);
video.addEventListener('error', () => { if (playing) checkState(generation); });
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { ++generation; stop(); message('idle', 'Paused', 'Video pauses while this page is in the background.'); }
  else if (wanted && selected) start();
});
window.addEventListener('pagehide', () => { ++generation; stop(); });
api('api/session').then(loadCameras).catch((error) => { fail(error.message); toggle.disabled = true; refresh.disabled = true; });
