// Direct device-to-device link over local wifi (WebRTC data channel).
// No internet and no server: the two devices swap connection details by
// scanning QR codes. The transport is isolated here so a church PC server can
// replace it later without touching the rest of the app.

const ICE_TIMEOUT_MS = 2500;

export const PAIR_PREFIX = '#pair=';
export const ANSWER_PREFIX = 'CPA1:';

// ---------------------------------------------------------------- encoding

function b64url(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unb64url(str) {
  const s = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

async function pipe(bytes, stream) {
  const res = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await res.arrayBuffer());
}

// Keep only what a data-channel connection needs, to keep QR codes small.
function trimSdp(sdp) {
  return sdp
    .split(/\r?\n/)
    .filter((l) => l && !/^a=(extmap|rtcp-fb|ssrc|msid|group:LS)/.test(l))
    .join('\r\n') + '\r\n';
}

export async function encodeDesc(desc) {
  const json = JSON.stringify({ t: desc.type === 'offer' ? 'o' : 'a', s: trimSdp(desc.sdp) });
  const raw = new TextEncoder().encode(json);
  if (typeof CompressionStream !== 'undefined') {
    try {
      return 'z' + b64url(await pipe(raw, new CompressionStream('deflate-raw')));
    } catch {}
  }
  return 'j' + b64url(raw);
}

export async function decodeDesc(text) {
  const kind = text[0];
  let bytes = unb64url(text.slice(1));
  if (kind === 'z') bytes = await pipe(bytes, new DecompressionStream('deflate-raw'));
  const { t, s } = JSON.parse(new TextDecoder().decode(bytes));
  return { type: t === 'o' ? 'offer' : 'answer', sdp: s };
}

function waitForIce(pc) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { pc.removeEventListener('icegatheringstatechange', check); resolve(); };
    const check = () => { if (pc.iceGatheringState === 'complete') done(); };
    pc.addEventListener('icegatheringstatechange', check);
    setTimeout(done, ICE_TIMEOUT_MS);
  });
}

// ---------------------------------------------------------------- link

// A small wrapper with a uniform API: send(obj), onmessage(obj), onstate(state).
// A standby link is one the main iPad keeps waiting for a remote to come back
// on; it ignores ICE failures until it has opened, because a half-finished
// reconnect attempt shouldn't use it up.
class Link extends EventTarget {
  constructor(pc, { standby = false } = {}) {
    super();
    this.pc = pc;
    this.channel = null;
    this.standby = standby;
    this.opened = false;
    this.state = 'connecting';
    pc.addEventListener('connectionstatechange', () => {
      const s = pc.connectionState;
      if (s === 'connected' && this.channel && this.channel.readyState === 'open') this.setState('open');
      else if (s === 'disconnected' && this.opened) this.setState('reconnecting');
      else if (s === 'closed') this.setState('closed');
      else if (s === 'failed' && (this.opened || !this.standby)) this.setState('closed');
    });
  }
  attach(channel) {
    this.channel = channel;
    channel.addEventListener('open', () => this.setState('open'));
    channel.addEventListener('close', () => this.setState('closed'));
    channel.addEventListener('message', (e) => {
      try { this.dispatchEvent(new CustomEvent('message', { detail: JSON.parse(e.data) })); } catch {}
    });
  }
  setState(s) {
    if (this.state === s || this.state === 'closed') return;
    if (s === 'open') this.opened = true;
    this.state = s;
    this.dispatchEvent(new CustomEvent('state', { detail: s }));
  }
  send(obj) {
    if (this.channel && this.channel.readyState === 'open') {
      try { this.channel.send(JSON.stringify(obj)); return true; } catch {}
    }
    return false;
  }
  close() {
    try { this.channel && this.channel.close(); } catch {}
    try { this.pc.close(); } catch {}
    this.setState('closed');
  }
}

const RTC_CONFIG = { iceServers: [] }; // local network only

function rtcConfig(identity) {
  return identity && identity.cert ? { ...RTC_CONFIG, certificates: [identity.cert] } : RTC_CONFIG;
}

// Main iPad: returns { link, offerText, accept(answerText) }.
export async function createHostOffer() {
  const pc = new RTCPeerConnection(RTC_CONFIG);
  const link = new Link(pc);
  link.attach(pc.createDataChannel('cue', { ordered: true }));
  await pc.setLocalDescription(await pc.createOffer());
  await waitForIce(pc);
  const offerText = await encodeDesc(pc.localDescription);
  return {
    link,
    offerText,
    async accept(answerText) {
      const desc = await decodeDesc(answerText);
      if (desc.type !== 'answer') throw new Error('Not a remote code');
      await pc.setRemoteDescription(desc);
    },
  };
}

// Remote: given the main iPad's offer, returns { link, answerText }.
export async function createRemoteAnswer(offerText, identity = null) {
  const desc = await decodeDesc(offerText);
  if (desc.type !== 'offer') throw new Error('Not a pairing code');
  const pc = new RTCPeerConnection(rtcConfig(identity));
  const link = new Link(pc);
  pc.addEventListener('datachannel', (e) => link.attach(e.channel));
  await pc.setRemoteDescription(desc);
  await pc.setLocalDescription(await pc.createAnswer());
  await waitForIce(pc);
  return { link, answerText: ANSWER_PREFIX + (await encodeDesc(pc.localDescription)) };
}

// ---------------------------------------------------------------- reconnect

// Only the first connection needs the QR codes. While a remote is connected,
// the main iPad prepares a standby connection and sends its details over the
// live link. The remote answers with a fixed identity: a saved certificate and
// fixed ICE credentials. The main iPad applies that answer straight away and
// leaves the standby waiting. If the link drops, the remote rebuilds exactly
// the same answer on its own and connects to the waiting standby, with no
// codes to scan. Only the main iPad has to stay awake and keep the app open.

const ID_KEY = 'cuepad.remote.identity';
const CERT_DB = 'cuepad-remote';

function randomToken(len) {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let out = '';
  for (const b of bytes) out += chars[b % chars.length];
  return out;
}

function certStore(mode, fn) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(CERT_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('kv', mode);
      const r = fn(tx.objectStore('kv'));
      tx.oncomplete = () => { db.close(); resolve(r && r.result); };
      tx.onerror = tx.onabort = () => { db.close(); reject(tx.error); };
    };
  });
}

async function loadCert() {
  try {
    const cert = await certStore('readonly', (s) => s.get('cert'));
    if (cert && (!cert.expires || cert.expires > Date.now() + 86400000)) return cert;
  } catch {}
  return null;
}

let identityPromise = null;

// The remote's long-lived identity. The certificate is kept in IndexedDB so the
// remote can reconnect even after the browser reloads the page; if this
// browser can't store it, it lives for as long as the page stays open.
export function remoteIdentity() {
  if (identityPromise) return identityPromise;
  identityPromise = (async () => {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(ID_KEY) || 'null'); } catch {}
    if (!saved || !saved.id) {
      saved = { id: randomToken(12), ufrag: randomToken(8), pwd: randomToken(24) };
      try { localStorage.setItem(ID_KEY, JSON.stringify(saved)); } catch {}
    }
    let cert = await loadCert();
    if (!cert) {
      try {
        cert = await RTCPeerConnection.generateCertificate({ name: 'ECDSA', namedCurve: 'P-256', expires: 180 * 86400000 });
        try { await certStore('readwrite', (s) => s.put(cert, 'cert')); } catch {}
      } catch { cert = null; }
    }
    return { ...saved, cert };
  })();
  return identityPromise;
}

function withIce(sdp, ufrag, pwd) {
  return sdp
    .replace(/a=ice-ufrag:[^\r\n]*/g, `a=ice-ufrag:${ufrag}`)
    .replace(/a=ice-pwd:[^\r\n]*/g, `a=ice-pwd:${pwd}`);
}

// Main iPad: a connection that waits for one particular remote to come back.
// Returns { link, offer, arm(answerSdp) }.
export async function createStandby() {
  const pc = new RTCPeerConnection(RTC_CONFIG);
  const link = new Link(pc, { standby: true });
  link.attach(pc.createDataChannel('cue', { ordered: true }));
  await pc.setLocalDescription(await pc.createOffer());
  await waitForIce(pc);
  return {
    link,
    offer: pc.localDescription.sdp,
    async arm(answerSdp) {
      await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
    },
  };
}

// Remote: the answer it will reproduce later for this standby offer. Nothing
// connects yet.
export async function standbyAnswer(offerSdp, identity) {
  if (!identity || !identity.cert) throw new Error('No saved identity');
  const pc = new RTCPeerConnection(rtcConfig(identity));
  try {
    await pc.setRemoteDescription({ type: 'offer', sdp: offerSdp });
    const answer = await pc.createAnswer();
    return withIce(answer.sdp, identity.ufrag, identity.pwd);
  } finally {
    pc.close();
  }
}

// Remote: connect to a waiting standby without any new codes.
export async function reconnectToStandby(offerSdp, identity) {
  const pc = new RTCPeerConnection(rtcConfig(identity));
  const link = new Link(pc);
  pc.addEventListener('datachannel', (e) => link.attach(e.channel));
  await pc.setRemoteDescription({ type: 'offer', sdp: offerSdp });
  const answer = await pc.createAnswer();
  await pc.setLocalDescription({ type: 'answer', sdp: withIce(answer.sdp, identity.ufrag, identity.pwd) });
  return link;
}

// ---------------------------------------------------------------- QR helpers

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Could not load ' + src));
    document.head.appendChild(s);
  });
}

let qrLib = null;
let scanLib = null;

export async function qrSvg(text) {
  if (!qrLib) { await loadScript('vendor/qrcode.js'); qrLib = window.qrcode; }
  const qr = qrLib(0, 'L');
  qr.addData(text, 'Byte');
  qr.make();
  const n = qr.getModuleCount();
  const m = 4; // quiet zone
  let path = '';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) if (qr.isDark(r, c)) path += `M${c + m} ${r + m}h1v1h-1z`;
  }
  const size = n + m * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="Pairing code"><rect width="${size}" height="${size}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
}

// Scans the camera feed until onCode returns true, or stop() is called.
export async function startScanner(video, onCode, { facingMode = 'user' } = {}) {
  if (!scanLib) { await loadScript('vendor/jsQR.js'); scanLib = window.jsQR; }
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
  video.setAttribute('playsinline', '');
  video.muted = true;
  video.srcObject = stream;
  await video.play().catch(() => {});
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  let stopped = false;
  let timer = null;
  const stop = () => {
    stopped = true;
    clearTimeout(timer);
    stream.getTracks().forEach((t) => t.stop());
    video.srcObject = null;
  };
  const tick = async () => {
    if (stopped) return;
    if (video.readyState >= 2 && video.videoWidth) {
      const scale = Math.min(1, 800 / video.videoWidth);
      canvas.width = Math.round(video.videoWidth * scale);
      canvas.height = Math.round(video.videoHeight * scale);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const code = scanLib(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
      if (code && code.data) {
        try {
          if (await onCode(code.data)) { stop(); return; }
        } catch (err) { console.warn(err); }
      }
    }
    timer = setTimeout(tick, 120);
  };
  tick();
  return stop;
}
