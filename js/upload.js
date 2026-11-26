// Sending audio files from a remote to the main iPad over the same direct
// wifi link the remote already uses. Files go in small pieces, one file at a
// time; the main iPad saves each one and adds it as a new cue at the end.

export const CHUNK = 16 * 1024; // raw bytes per message (about 22 KB as text)
export const MAX_FILE = 200 * 1024 * 1024;
const AUDIO_EXT = /\.(mp3|m4a|aac|wav|aif|aiff|caf|flac|ogg)$/i;

export const isAudio = (name, type) => (type || '').startsWith('audio/') || AUDIO_EXT.test(name || '');

function toB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromB64(text) {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

// Remote side. getLink() returns the current link (it can change after a
// reconnect, which ends the transfer). onProgress({ index, count, name, sent, size }).
// Resolves with the main iPad's reply for each file.
export async function sendFiles(getLink, files, { onProgress, waitReply }) {
  const results = [];
  for (let index = 0; index < files.length; index++) {
    const f = files[index];
    const id = uid();
    const link = getLink();
    if (!link || link.state !== 'open') throw new Error('Not connected to the main iPad');
    const bytes = new Uint8Array(await f.arrayBuffer());
    const total = Math.ceil(bytes.length / CHUNK);
    const reply = waitReply(id);
    if (!link.send({ t: 'upStart', id, name: f.name, type: f.type || '', size: bytes.length, chunks: total })) throw new Error('Not connected to the main iPad');
    for (let i = 0; i < total; i++) {
      if (getLink() !== link || link.state !== 'open') throw new Error('The connection dropped while sending');
      await link.drain();
      const part = bytes.subarray(i * CHUNK, (i + 1) * CHUNK);
      if (!link.send({ t: 'upChunk', id, i, d: toB64(part) })) throw new Error('The connection dropped while sending');
      if (onProgress && (i % 8 === 0 || i === total - 1)) onProgress({ index, count: files.length, name: f.name, sent: Math.min(bytes.length, (i + 1) * CHUNK), size: bytes.length });
    }
    link.send({ t: 'upEnd', id });
    results.push(await reply);
  }
  return results;
}

// Main iPad side: collects pieces and hands each finished file to save(file).
export function createReceiver({ save, onActivity }) {
  const incoming = new Map(); // id -> { name, type, size, chunks, parts, got, link, at }
  // Drop transfers that stopped half-way (the remote's link dropped).
  setInterval(() => {
    const now = Date.now();
    for (const [id, u] of incoming) if (now - u.at > 60000) { incoming.delete(id); onActivity && onActivity(null); }
  }, 15000);

  return function handle(link, m) {
    if (m.t === 'upStart') {
      const reply = (ok, msg) => link.send({ t: 'upDone', id: m.id, ok, msg });
      const name = String(m.name || 'Track').slice(0, 200);
      const size = Number(m.size) || 0;
      const chunks = Number(m.chunks) || 0;
      if (!isAudio(name, m.type)) return reply(false, `${name} isn't an audio file`), true;
      if (size <= 0 || size > MAX_FILE || chunks !== Math.ceil(size / CHUNK)) return reply(false, `${name} is too big or empty`), true;
      incoming.set(m.id, { name, type: String(m.type || ''), size, chunks, parts: new Array(chunks), got: 0, link, at: Date.now() });
      onActivity && onActivity({ name, got: 0, size });
      return true;
    }
    if (m.t === 'upChunk') {
      const u = incoming.get(m.id);
      if (!u || u.link !== link) return true;
      const i = Number(m.i);
      if (!(i >= 0 && i < u.chunks) || u.parts[i]) return true;
      try { u.parts[i] = fromB64(String(m.d || '')); } catch { return true; }
      u.got++;
      u.at = Date.now();
      if (u.got % 32 === 0) onActivity && onActivity({ name: u.name, got: u.got * CHUNK, size: u.size });
      return true;
    }
    if (m.t === 'upEnd') {
      const u = incoming.get(m.id);
      incoming.delete(m.id);
      const reply = (ok, msg) => link.send({ t: 'upDone', id: m.id, ok, msg });
      if (!u) { reply(false, 'The main iPad lost part of the file. Try again.'); return true; }
      const len = u.parts.reduce((n, p) => n + (p ? p.length : 0), 0);
      if (u.got !== u.chunks || len !== u.size) { reply(false, `Part of ${u.name} went missing. Try again.`); onActivity && onActivity(null); return true; }
      const file = new File(u.parts, u.name, { type: u.type || 'audio/mpeg' });
      Promise.resolve(save(file)).then(
        () => { reply(true); onActivity && onActivity(null); },
        (err) => { reply(false, `Could not save ${u.name}: ${err && err.message || err}`); onActivity && onActivity(null); });
      return true;
    }
    return false;
  };
}
