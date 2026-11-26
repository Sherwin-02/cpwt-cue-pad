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
    if (m.t && m.t.startsWith('up') && api.upload) { api.upload(link, m); return; }
    if (m.t === 'toggle') api.toggle(m.id);
    else if (m.t === 'stopAll') api.stopAll();
    else if (m.t === 'fadeAll') api.fadeAll();
    else if (m.t === 'fadeIn') api.fadeIn();
    else if (m.t === 'fromStart') api.fromStart();
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
  const switchBtn = el('button', { class: 'btn', type: 'button', hidden: true }, 'Switch camera');
  const pasteBox = el('textarea', { class: 'pair-paste', rows: 3, placeholder: 'Paste the code here (it starts with CPA1:)', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
  const pasteBtn = el('button', { class: 'btn primary', type: 'button' }, 'Connect');
  const pasteMsg = el('div', { class: 'muted' }, '');
  const msg = el('div', { class: 'pair-msg', role: 'status' }, '');
  const body = el('div', { class: 'pair' },
    el('div', { class: 'pair-cols' },
      el('div', {},
        el('div', { class: 'pair-num' }, '1'),
        el('p', {}, 'On the phone or second iPad, open the Camera app and scan this code. Tap the link that appears.'),
        qrBox),
      el('div', {},
        el('div', { class: 'pair-num' }, '2'),
        el('p', {}, 'The remote then shows its own code. Hold it up to this device\'s camera.'),
        video, step,
        el('div', { class: 'btn-row' }, switchBtn),
        el('details', { class: 'pair-nocam' },
          el('summary', {}, 'No camera? Paste the code instead'),
          el('p', {}, 'On the remote, tap Send code instead and send it to this device (AirDrop, Messages, WhatsApp or email to yourself). Then paste it here.'),
          pasteBox,
          el('div', { class: 'btn-row' }, pasteBtn),
          pasteMsg))),
    msg,
    el('p', { class: 'muted' }, 'Each remote only needs this once. If its wifi drops or its screen locks, it reconnects by itself as long as Cue Pad stays open on this iPad.'),
    el('div', { class: 'btn-row' },
      el('button', { class: 'btn', type: 'button', onclick: () => { disconnectAll(); msg.textContent = 'All remotes disconnected.'; } }, 'Disconnect and forget all remotes')));

  let stopScan = null;
  let facing = 'user';
  try { facing = localStorage.getItem('cuepad.scanFacing') || 'user'; } catch {}
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

  switchBtn.addEventListener('click', async () => {
    if (done) return;
    facing = facing === 'user' ? 'environment' : 'user';
    try { localStorage.setItem('cuepad.scanFacing', facing); } catch {}
    if (stopScan) stopScan();
    stopScan = null;
    step.textContent = 'Switching camera…';
    try {
      stopScan = await startScanner(video, onCode, { facingMode: facing });
      video.classList.toggle('rear', facing === 'environment');
      step.textContent = `Looking for the remote's code (${facing === 'user' ? 'front' : 'back'} camera)…`;
    } catch {
      step.textContent = 'That camera isn\'t available.';
    }
  });

  pasteBtn.addEventListener('click', async () => {
    const text = pasteBox.value.replace(/\s+/g, '');
    const at = text.indexOf(ANSWER_PREFIX);
    if (at < 0) { pasteMsg.textContent = 'That isn\'t a remote code. It should start with CPA1:'; return; }
    if (!pending) { pasteMsg.textContent = 'Still getting ready. Try again in a moment.'; return; }
    pasteMsg.textContent = 'Connecting…';
    const ok = await onCode(text.slice(at));
    pasteMsg.textContent = ok ? 'Code accepted. Connecting…' : 'That code didn\'t work. Make sure it\'s from the remote that scanned this iPad\'s current code.';
  });

  try {
    // Camera first: once camera access is granted, Safari shares real local
    // network addresses, which makes the direct link more reliable.
    step.textContent = 'Starting camera…';
    let cameraOk = true;
    try {
      stopScan = await startScanner(video, onCode, { facingMode: facing });
      video.classList.toggle('rear', facing === 'environment');
      step.textContent = 'Looking for the remote\'s code…';
      // Offer a front/back switch when the device has more than one camera.
      try {
        const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
        switchBtn.hidden = cams.length < 2;
      } catch {}
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
