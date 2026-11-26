// Audio editing helpers: waveform peaks for the trim editor, and joining
// several cues into one new audio file.
//
// Nothing here changes an existing audio file. Trims are stored on the cue
// (startAt / endAt in seconds) and applied at playback. A join renders a NEW
// file (16-bit WAV) and leaves every original file on the device untouched.

import { Engine } from './engine.js';

// Peak level (0..1) of `buffer` between `from` and `to` seconds, in `buckets`
// columns. Uses the loudest channel so a hard-panned part still shows.
export function computePeaks(buffer, buckets, from = 0, to = buffer.duration) {
  const sr = buffer.sampleRate;
  const a = Math.max(0, Math.floor(from * sr));
  const b = Math.min(buffer.length, Math.ceil(to * sr));
  const out = new Float32Array(Math.max(1, buckets));
  const span = Math.max(1, b - a);
  const chans = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) chans.push(buffer.getChannelData(c));
  for (let i = 0; i < out.length; i++) {
    const s0 = a + Math.floor((i * span) / out.length);
    const s1 = Math.max(s0 + 1, a + Math.floor(((i + 1) * span) / out.length));
    // Very long buckets: sampling every few frames is plenty for a picture.
    const step = Math.max(1, Math.floor((s1 - s0) / 2000));
    let m = 0;
    for (const d of chans) {
      for (let s = s0; s < s1 && s < d.length; s += step) {
        const v = d[s] < 0 ? -d[s] : d[s];
        if (v > m) m = v;
      }
    }
    out[i] = Math.min(1, m);
  }
  return out;
}

const EDGE = 0.005; // 5 ms ramp at cut points so a trim never clicks

// parts: [{ load: async () => ArrayBuffer, startAt, endAt, volume, label }]
// opts.mode: 'straight' | 'gap' | 'crossfade', opts.seconds for gap/crossfade.
// decode: (ArrayBuffer) => Promise<AudioBuffer>, all at `sampleRate`.
// Works one part at a time so only one decoded song is in memory at once.
// Returns { blob, duration } with blob an audio/wav file.
export async function joinParts(parts, { decode, sampleRate, mode = 'straight', seconds = 0, onProgress } = {}) {
  if (parts.length < 2) throw new Error('Choose at least two cues to join');
  const sr = sampleRate;
  const xfWanted = mode === 'crossfade' ? Math.round(Math.max(0, seconds) * sr) : 0;
  const gapFrames = mode === 'gap' ? Math.round(Math.max(0, seconds) * sr) : 0;
  const chunks = [];
  let total = 0;
  let carry = null; // last few seconds of the previous part, waiting to crossfade

  const emit = (L, R, from = 0, to = L.length) => {
    const n = Math.max(0, to - from);
    if (!n) return;
    const pcm = new Int16Array(n * 2);
    for (let i = 0; i < n; i++) {
      pcm[2 * i] = toInt16(L[from + i]);
      pcm[2 * i + 1] = toInt16(R[from + i]);
    }
    chunks.push(pcm);
    total += n;
  };

  for (let p = 0; p < parts.length; p++) {
    const part = parts[p];
    if (onProgress) onProgress(p, parts.length);
    const buf = await decode(await part.load());
    if (buf.sampleRate !== sr) throw new Error('Unexpected sample rate while joining');
    const { startFrame, endFrame } = Engine.trimFrames(part, buf.length, sr);
    const len = endFrame - startFrame;
    const vol = part.volume ?? 1;
    const src0 = buf.getChannelData(0);
    const src1 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : src0;
    const L = new Float32Array(len);
    const R = new Float32Array(len);
    const edge = Math.min(Math.round(EDGE * sr), Math.floor(len / 2));
    for (let i = 0; i < len; i++) {
      let g = vol;
      if (i < edge) g *= i / edge;
      else if (i >= len - edge) g *= (len - 1 - i) / edge;
      L[i] = src0[startFrame + i] * g;
      R[i] = src1[startFrame + i] * g;
    }

    let begin = 0;
    if (carry) {
      // Equal-power crossfade of the end of the last part into this one.
      const xf = Math.min(carry.L.length, Math.floor(len / 2));
      emit(carry.L, carry.R, 0, carry.L.length - xf);
      const off = carry.L.length - xf;
      for (let i = 0; i < xf; i++) {
        const t = (i + 0.5) / xf;
        const a = Math.cos((t * Math.PI) / 2);
        const b = Math.sin((t * Math.PI) / 2);
        L[i] = carry.L[off + i] * a + L[i] * b;
        R[i] = carry.R[off + i] * a + R[i] * b;
      }
      carry = null;
    }
    const last = p === parts.length - 1;
    let end = len;
    if (!last && xfWanted > 0) {
      const xf = Math.min(xfWanted, Math.floor(len / 2));
      end = len - xf;
      carry = { L: L.slice(end), R: R.slice(end) };
    }
    emit(L, R, begin, end);
    if (!last && gapFrames > 0) emit(new Float32Array(gapFrames), new Float32Array(gapFrames));
  }
  if (onProgress) onProgress(parts.length, parts.length);
  return { blob: wavBlob(chunks, total, sr), duration: total / sr };
}

function toInt16(v) {
  if (v >= 1) return 32767;
  if (v <= -1) return -32768;
  return Math.round(v * 32767);
}

function wavBlob(chunks, frames, sr) {
  const channels = 2;
  const bytes = frames * channels * 2;
  const h = new DataView(new ArrayBuffer(44));
  const str = (o, s) => { for (let i = 0; i < s.length; i++) h.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); h.setUint32(4, 36 + bytes, true); str(8, 'WAVE');
  str(12, 'fmt '); h.setUint32(16, 16, true); h.setUint16(20, 1, true); h.setUint16(22, channels, true);
  h.setUint32(24, sr, true); h.setUint32(28, sr * channels * 2, true); h.setUint16(32, channels * 2, true); h.setUint16(34, 16, true);
  str(36, 'data'); h.setUint32(40, bytes, true);
  return new Blob([h.buffer, ...chunks], { type: 'audio/wav' });
}

// Rough length of a join, from the cues' trimmed lengths (seconds).
export function joinedLength(durations, mode, seconds) {
  const sum = durations.reduce((a, b) => a + b, 0);
  const joints = Math.max(0, durations.length - 1);
  if (mode === 'gap') return sum + joints * seconds;
  if (mode === 'crossfade') {
    let total = durations[0] || 0;
    for (let i = 1; i < durations.length; i++) total += durations[i] - Math.min(seconds, durations[i - 1] / 2, durations[i] / 2);
    return total;
  }
  return sum;
}
