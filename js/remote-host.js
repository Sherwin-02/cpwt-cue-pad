// Main iPad side of the remote: pairing sheet, state broadcast, commands.
import { createHostOffer, createStandby, qrSvg, startScanner, PAIR_PREFIX, ANSWER_PREFIX } from './pairing.js';

const links = new Set();
// Paired remotes by their id: { link (the live one), standby } so a remote that
// drops can reconnect on its own. Kept for as long as this page stays open.
const paired = new Map();
let api = null; // { toggle, stopAll, fadeAll, go, stepNext, snapshot, bus, openSheet, closeSheet, el, onCount }
let broadcastTimer = null;
let lastSent = '';

export function remoteCount() {
  let n = 0;
  for (const l of links) if (l.state === 'open' || l.state === 'reconnecting') n++;
  return n;
}

// Paired remotes that aren't connected right now (they reconnect by themselves).
function awayCount() {
  let n = 0;
  for (const e of paired.values()) if (!e.link || e.link.state !== 'open') n++;
  return n;
}

function updateCount() {
  api.onCount(remoteCount(), awayCount());
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
    else if (m.t === 'pauseAll') api.pauseAll();
    else if (m.t === 'go') api.go();
    else if (m.t === 'step') api.stepNext(m.delta < 0 ? -1 : 1);
    else if (m.t === 'volume') api.setVolume(m.v);
    else if (m.t === 'seek') api.seekBy(Number(m.delta) || 0);
    else if (m.t === 'seekTo') api.seekTo(Number(m.pos) || 0);
    else if (m.t === 'fadeMode') api.setFadeMode(!!m.on);
    else if (m.t === 'hello') {
      send(link, api.snapshot());
      if (typeof m.rid === 'string' && m.rid) adopt(m.rid, link, m.reconnect !== false);
      return;
    } else if (m.t === 'standbyAnswer') {
      armStandby(link, m);
      return;
    } else return;
    setTimeout(() => broadcast(true), 30);
  });
  link.addEventListener('state', (e) => {
    if (e.detail === 'open') send(link, api.snapshot());
    if (e.detail === 'closed') links.delete(link);
    updateCount();
  });
  ensureTimer();
}

// A remote said who it is. This link becomes its live link (closing any older
// one that hasn't noticed it's dead yet), and a fresh standby is prepared.
async function adopt(rid, link, canReconnect) {
  let entry = paired.get(rid);
  if (!entry) { entry = { link: null, standby: null }; paired.set(rid, entry); }
  if (entry.link && entry.link !== link) entry.link.close();
  entry.link = link;
  link.rid = rid;
  if (!canReconnect) return;
  try {
    const sb = await createStandby();
    if (entry.link !== link || link.state === 'closed') { sb.link.close(); return; }
    if (entry.standby) entry.standby.link.close();
    entry.standby = sb;
    sb.link.addEventListener('state', (e) => {
      if (e.detail !== 'open') return;
      if (entry.standby === sb) entry.standby = null;
      addLink(sb.link);
      updateCount();
    });
    link.send({ t: 'standby', sdp: sb.offer });
  } catch (err) {
    console.warn('Could not prepare a standby link', err);
  }
}

async function armStandby(link, m) {
  const entry = link.rid && paired.get(link.rid);
  if (!entry || !entry.standby || entry.standby.offer !== m.offer) return;
  try {
    await entry.standby.arm(m.sdp);
    link.send({ t: 'armed', offer: m.offer });
  } catch (err) {
    console.warn('Standby answer rejected', err);
    link.send({ t: 'armFailed' });
  }
}

export function setupRemoteHost(options) {
  api = options;
  api.bus.addEventListener('change', () => broadcast());
}

export function disconnectAll() {
  for (const l of [...links]) { l.send({ t: 'forget' }); }
  // Give the goodbye a moment to go out before closing.
  setTimeout(() => {
    for (const l of [...links]) l.close();
    links.clear();
  }, 150);
  for (const entry of paired.values()) if (entry.standby) entry.standby.link.close();
  paired.clear();
  api.onCount(0);
}

export function pairedCount() {
  return paired.size;
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
    el('p', { class: 'muted' }, 'Each remote only needs this once. If its wifi drops or its screen locks, it reconnects by itself as long as Cue Pad stays open on this iPad.'),
    el('div', { class: 'btn-row' },
      el('button', { class: 'btn', type: 'button', onclick: () => { disconnectAll(); msg.textContent = 'All remotes disconnected.'; } }, 'Disconnect and forget all remotes')));

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
