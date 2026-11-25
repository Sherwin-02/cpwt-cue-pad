// Main iPad side of the remote: pairing sheet, state broadcast, commands.
import { createHostOffer, qrSvg, startScanner, PAIR_PREFIX, ANSWER_PREFIX } from './pairing.js';

const links = new Set();
let api = null; // { toggle, stopAll, fadeAll, snapshot, bus, openSheet, closeSheet, el, onCount }
let broadcastTimer = null;
let lastSent = '';

export function remoteCount() {
  let n = 0;
  for (const l of links) if (l.state === 'open' || l.state === 'reconnecting') n++;
  return n;
}

function send(link, snap) {
  link.send({ t: 'state', ...snap });
}

function broadcast(force = false) {
  if (!links.size) return;
  const snap = api.snapshot();
  const json = JSON.stringify(snap);
  if (!force && json === lastSent) return;
  lastSent = json;
  for (const l of links) if (l.state === 'open') send(l, snap);
}

function ensureTimer() {
  if (broadcastTimer) return;
  // 4 updates a second keeps progress bars smooth; remotes interpolate between.
  broadcastTimer = setInterval(() => {
    if (!links.size) { clearInterval(broadcastTimer); broadcastTimer = null; return; }
    broadcast();
    for (const l of links) if (l.state === 'open') l.send({ t: 'ping' });
  }, 250);
}

function addLink(link) {
  links.add(link);
  link.addEventListener('message', (e) => {
    const m = e.detail;
    if (m.t === 'toggle') api.toggle(m.id);
    else if (m.t === 'stopAll') api.stopAll();
    else if (m.t === 'fadeAll') api.fadeAll();
    else if (m.t === 'volume') api.setVolume(m.v);
    else if (m.t === 'hello') send(link, api.snapshot());
    setTimeout(() => broadcast(true), 30);
  });
  link.addEventListener('state', (e) => {
    if (e.detail === 'open') send(link, api.snapshot());
    if (e.detail === 'closed') links.delete(link);
    api.onCount(remoteCount());
  });
  ensureTimer();
}

export function setupRemoteHost(options) {
  api = options;
  api.bus.addEventListener('change', () => broadcast());
}

export function disconnectAll() {
  for (const l of [...links]) l.close();
  links.clear();
  api.onCount(0);
}

export async function openPairingSheet() {
  const { el } = api;
  const qrBox = el('div', { class: 'qr-box' }, el('div', { class: 'muted' }, 'Preparing…'));
  const video = el('video', { class: 'scan-video', playsinline: true, muted: true, autoplay: true });
  const step = el('div', { class: 'pair-step' });
  const msg = el('div', { class: 'pair-msg', role: 'status' }, '');
  const body = el('div', { class: 'pair' },
    el('div', { class: 'pair-cols' },
      el('div', {},
        el('div', { class: 'pair-num' }, '1'),
        el('p', {}, 'On the phone or second iPad, open the Camera app and scan this code. Tap the link that appears.'),
        qrBox),
      el('div', {},
        el('div', { class: 'pair-num' }, '2'),
        el('p', {}, 'The remote then shows its own code. Hold it up to this iPad\'s front camera.'),
        video, step)),
    msg,
    el('div', { class: 'btn-row' },
      el('button', { class: 'btn', type: 'button', onclick: () => { disconnectAll(); msg.textContent = 'All remotes disconnected.'; } }, 'Disconnect all remotes')));

  let stopScan = null;
  let pending = null;
  let done = false;
  api.openSheet('Connect a remote', body, {
    onClose: () => {
      if (stopScan) stopScan();
      if (pending && pending.link.state !== 'open') pending.link.close();
    },
  });

  const onCode = async (text) => {
    if (done || !text.startsWith(ANSWER_PREFIX) || !pending) return false;
    done = true;
    step.textContent = 'Code read. Connecting…';
    try {
      await pending.accept(text.slice(ANSWER_PREFIX.length));
    } catch (err) {
      done = false;
      step.textContent = 'That code didn\'t work. Scan the remote again.';
      return false;
    }
    return true;
  };
  // Used by automated tests (no camera there).
  if (window.cuepad) window.cuepad.pairWithCode = onCode;

  try {
    // Camera first: once camera access is granted, Safari shares real local
    // network addresses, which makes the direct link more reliable.
    step.textContent = 'Starting camera…';
    let cameraOk = true;
    try {
      stopScan = await startScanner(video, onCode);
      step.textContent = 'Looking for the remote\'s code…';
    } catch (err) {
      cameraOk = false;
      step.textContent = 'Camera unavailable. Allow camera access for Cue Pad in Settings, then try again.';
    }

    pending = await createHostOffer();
    const url = location.href.split('#')[0] + PAIR_PREFIX + pending.offerText;
    qrBox.innerHTML = await qrSvg(url);
    addLink(pending.link);
    pending.link.addEventListener('state', (e) => {
      if (e.detail === 'open') {
        msg.textContent = 'Remote connected.';
        step.textContent = 'Connected ✓';
        setTimeout(() => api.closeSheet(), 900);
      } else if (e.detail === 'closed' && !done) {
        msg.textContent = '';
      } else if (e.detail === 'closed') {
        msg.textContent = 'Could not connect. Check both devices are on the same wifi, then try again.';
      }
    });
    if (!cameraOk) msg.textContent = '';
  } catch (err) {
    console.error(err);
    msg.textContent = 'Could not start pairing: ' + (err.message || err);
  }
}
