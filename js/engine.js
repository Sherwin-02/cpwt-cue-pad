// Audio engine for Cue Pad.
//
// Instant start without holding every song in memory:
//   * When a show opens, each tile's track is decoded once and only the first
//     HEAD_SECONDS (from the tile's start point) is kept in memory as a small
//     AudioBuffer. That is what plays the instant a tile is tapped.
//   * On tap, the whole track is decoded again in the background and scheduled
//     to start exactly where the head ends (sample-accurate, same decoder, so
//     the join is seamless). The full buffer is released when the tile stops.
//
// 40 heads of 15 s stereo at 48 kHz is about 230 MB, versus roughly 3 GB if
// every track were fully decoded.

export const HEAD_SECONDS = 15;

export class Engine extends EventTarget {
  constructor(loadBytes) {
    super();
    this.loadBytes = loadBytes; // async (trackId) => ArrayBuffer
    this.ctx = null;
    this.master = null;
    this.masterGain = 1;
    this.preps = new Map(); // tileId -> { status, head, playDuration, trackDuration, sig, error }
    this.players = new Map(); // tileId -> player
    this.queue = Promise.resolve();
    this.loadGeneration = 0;
  }

  ensureContext() {
    if (this.ctx) return this.ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC({ latencyHint: 'interactive' });
    this.master = this.ctx.createGain();
    this.master.gain.value = this.masterGain;
    this.master.connect(this.ctx.destination);
    this.ctx.addEventListener('statechange', () => this.emit('contextstate'));
    return this.ctx;
  }

  get running() {
    return !!this.ctx && this.ctx.state === 'running';
  }

  // Must be called from a user gesture (iOS requirement).
  async unlock() {
    const ctx = this.ensureContext();
    try {
      // Play through the ring/silent switch on iPhone/iPad.
      if (navigator.audioSession) navigator.audioSession.type = 'playback';
    } catch {}
    try { await ctx.resume(); } catch {}
    const b = ctx.createBuffer(1, 1, ctx.sampleRate);
    const s = ctx.createBufferSource();
    s.buffer = b;
    s.connect(ctx.destination);
    s.start();
    this.emit('contextstate');
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  static signature(tile) {
    return `${tile.trackId}|${tile.startAt || 0}`;
  }

  prepStatus(tileId) {
    const p = this.preps.get(tileId);
    return p ? p.status : 'none';
  }

  // Prepare (preload) every tile of a show, one track at a time to keep peak
  // memory low. Tiles already prepared with the same track/start are kept.
  loadShow(tiles) {
    const gen = ++this.loadGeneration;
    const ctx = this.ensureContext();
    const wanted = new Set(tiles.map((t) => t.id));
    for (const id of [...this.preps.keys()]) {
      if (!wanted.has(id) && !this.players.has(id)) this.preps.delete(id);
    }
    for (const tile of tiles) {
      const sig = Engine.signature(tile);
      const p = this.preps.get(tile.id);
      if (p && p.sig === sig && (p.status === 'ready' || p.status === 'loading')) continue;
      this.preps.set(tile.id, { status: 'queued', sig });
    }
    this.emit('prep');
    for (const tile of tiles) {
      const sig = Engine.signature(tile);
      this.queue = this.queue.then(async () => {
        if (gen !== this.loadGeneration) {
          // A newer load superseded this one; leave it queued for that load.
          return;
        }
        const p = this.preps.get(tile.id);
        if (!p || p.sig !== sig || p.status === 'ready') return;
        p.status = 'loading';
        this.emit('prep', { tileId: tile.id });
        try {
          const bytes = await this.loadBytes(tile.trackId);
          const full = await ctx.decodeAudioData(bytes);
          const startAt = Math.min(Math.max(0, tile.startAt || 0), Math.max(0, full.duration - 0.05));
          const startFrame = Math.floor(startAt * full.sampleRate);
          const headFrames = Math.min(
            Math.round(HEAD_SECONDS * full.sampleRate),
            full.length - startFrame
          );
          const head = ctx.createBuffer(full.numberOfChannels, Math.max(1, headFrames), full.sampleRate);
          for (let c = 0; c < full.numberOfChannels; c++) {
            head.copyToChannel(full.getChannelData(c).subarray(startFrame, startFrame + headFrames), c);
          }
          Object.assign(p, {
            status: 'ready',
            head,
            startFrame,
            headFrames,
            sampleRate: full.sampleRate,
            trackDuration: full.duration,
            playDuration: (full.length - startFrame) / full.sampleRate,
            needsTail: startFrame + headFrames < full.length,
          });
        } catch (err) {
          console.error('Could not load tile', tile, err);
          Object.assign(p, { status: 'error', error: String(err && err.message || err) });
        }
        this.emit('prep', { tileId: tile.id });
      });
    }
    return this.queue;
  }

  // Overall output level (0..1 gain), applied smoothly to everything playing.
  setMasterGain(g) {
    this.masterGain = Math.max(0, Math.min(1, g));
    if (this.master) {
      const now = this.ctx.currentTime;
      this.master.gain.cancelScheduledValues(now);
      this.master.gain.setTargetAtTime(this.masterGain, now, 0.03);
    }
  }

  isPlaying(tileId) {
    const pl = this.players.get(tileId);
    return !!pl && !pl.stopping && !pl.paused;
  }

  playingIds() {
    return [...this.players.values()].filter((p) => !p.stopping && !p.paused).map((p) => p.tileId);
  }

  // Returns true if playback started.
  play(tile, { otherFade = null } = {}) {
    const prep = this.preps.get(tile.id);
    if (!this.ctx || !prep || prep.status !== 'ready') return false;
    if (this.players.has(tile.id)) this.stop(tile.id, 0.02);

    const ctx = this.ctx;
    const now = ctx.currentTime;
    const t0 = now;
    const vol = tile.volume ?? 1;
    const gain = ctx.createGain();
    gain.connect(this.master);
    const fadeIn = Math.max(0, tile.fadeIn || 0);
    if (fadeIn > 0) {
      gain.gain.setValueAtTime(0, t0);
      gain.gain.linearRampToValueAtTime(vol, t0 + fadeIn);
    } else {
      gain.gain.setValueAtTime(vol, t0);
    }

    const head = ctx.createBufferSource();
    head.buffer = prep.head;
    head.connect(gain);
    const loop = !!tile.loop;
    if (loop && !prep.needsTail) {
      head.loop = true;
    }
    head.start(t0);

    const player = {
      tileId: tile.id,
      tile,
      prep,
      vol,
      t0,
      gain,
      sources: [head],
      loop,
      playDuration: prep.playDuration,
      stopping: false,
      paused: false,
      pausedPos: 0,
      full: null,
      tailState: prep.needsTail ? 'loading' : 'none',
    };
    this.players.set(tile.id, player);

    const finalize = () => {
      if (this.players.get(tile.id) === player) {
        this.players.delete(tile.id);
        try { gain.disconnect(); } catch {}
        this.emit('playback', { tileId: tile.id, state: 'ended' });
      }
    };

    player.finalize = finalize;
    if (!prep.needsTail) {
      if (!loop) head.onended = finalize;
    } else {
      this.attachTail(tile, prep, player, finalize);
    }

    this.emit('playback', { tileId: tile.id, state: 'playing' });
    return true;
  }

  async attachTail(tile, prep, player, finalize) {
    const ctx = this.ctx;
    try {
      const bytes = await this.loadBytes(tile.trackId);
      if (player.stopping || this.players.get(tile.id) !== player) return;
      const full = await ctx.decodeAudioData(bytes);
      if (player.stopping || this.players.get(tile.id) !== player) return;
      player.full = full;
      // Paused while decoding: resume() will play from the full buffer.
      if (player.paused) { player.tailState = 'ready'; return; }
      const src = ctx.createBufferSource();
      src.buffer = full;
      src.connect(player.gain);
      if (player.loop) {
        src.loop = true;
        src.loopStart = prep.startFrame / full.sampleRate;
        src.loopEnd = full.duration;
      }
      const headLen = prep.headFrames / prep.sampleRate;
      const when = player.t0 + headLen;
      const offset = (prep.startFrame + prep.headFrames) / full.sampleRate;
      if (when > ctx.currentTime + 0.01) {
        src.start(when, offset);
        player.tailState = 'scheduled';
      } else {
        // Decoding took longer than the head (should not happen in practice).
        const late = ctx.currentTime - when;
        src.start(ctx.currentTime, offset + late);
        player.tailState = 'late';
        console.warn('Tail started late by', late.toFixed(3), 's');
      }
      player.sources.push(src);
      if (!player.loop) src.onended = finalize;
    } catch (err) {
      console.error('Tail decode failed', err);
      player.tailState = 'error';
      // Let the head finish, then end.
      if (player.sources[0]) player.sources[0].onended = finalize;
    }
  }

  isPaused(tileId) {
    const pl = this.players.get(tileId);
    return !!pl && pl.paused && !pl.stopping;
  }

  pausedIds() {
    return [...this.players.values()].filter((p) => p.paused && !p.stopping).map((p) => p.tileId);
  }

  // Pause keeps the cue's place; resume carries on from exactly there.
  pause(tileId) {
    const pl = this.players.get(tileId);
    if (!pl || pl.stopping || pl.paused) return false;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    let pos = now - pl.t0;
    if (pl.loop && pl.playDuration > 0) pos %= pl.playDuration;
    pl.pausedPos = Math.max(0, Math.min(pos, pl.playDuration));
    pl.paused = true;
    const g = pl.gain.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(0, now + 0.04);
    for (const s of pl.sources) {
      s.onended = null;
      try { s.stop(now + 0.05); } catch {}
    }
    pl.sources = [];
    this.emit('playback', { tileId, state: 'paused' });
    return true;
  }

  resume(tileId) {
    const pl = this.players.get(tileId);
    if (!pl || pl.stopping || !pl.paused) return false;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const { prep } = pl;
    const pos = pl.pausedPos;
    pl.t0 = now - pos;
    pl.paused = false;
    const g = pl.gain.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(0, now);
    g.linearRampToValueAtTime(pl.vol, now + 0.04);
    const src = ctx.createBufferSource();
    src.connect(pl.gain);
    if (pl.full) {
      const startSec = prep.startFrame / pl.full.sampleRate;
      src.buffer = pl.full;
      if (pl.loop) { src.loop = true; src.loopStart = startSec; src.loopEnd = pl.full.duration; }
      src.start(now, startSec + pos);
      pl.tailState = 'scheduled';
    } else {
      src.buffer = prep.head;
      if (pl.loop && !prep.needsTail) src.loop = true;
      src.start(now, Math.min(pos, prep.head.duration));
      // A tail decode still in flight will schedule itself from the new t0.
    }
    if (!pl.loop && (pl.full || !prep.needsTail)) src.onended = pl.finalize;
    pl.sources = [src];
    this.emit('playback', { tileId, state: 'playing' });
    return true;
  }

  stop(tileId, fadeSeconds = 0) {
    const pl = this.players.get(tileId);
    if (!pl) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const fade = Math.max(0.015, fadeSeconds || 0); // tiny ramp avoids clicks
    pl.stopping = true;
    const g = pl.gain.gain;
    const current = g.value;
    g.cancelScheduledValues(now);
    g.setValueAtTime(current, now);
    g.linearRampToValueAtTime(0, now + fade);
    for (const s of pl.sources) {
      s.onended = null;
      try { s.stop(now + fade + 0.02); } catch {}
    }
    pl.stopAt = now + fade;
    this.emit('playback', { tileId, state: 'stopping' });
    setTimeout(() => {
      if (this.players.get(tileId) === pl) {
        this.players.delete(tileId);
        try { pl.gain.disconnect(); } catch {}
        pl.sources.length = 0;
        this.emit('playback', { tileId, state: 'ended' });
      }
    }, (fade + 0.1) * 1000);
  }

  stopAll(fadeSeconds = 0) {
    for (const id of [...this.players.keys()]) this.stop(id, fadeSeconds);
  }

  // Seconds since the tile started (wrapped for loops), or null.
  position(tileId) {
    const pl = this.players.get(tileId);
    if (!pl || !this.ctx) return null;
    if (pl.paused) return { pos: pl.pausedPos, duration: pl.playDuration, loop: pl.loop, stopping: pl.stopping, paused: true };
    let pos = this.ctx.currentTime - pl.t0;
    if (pl.loop && pl.playDuration > 0) pos = pos % pl.playDuration;
    return { pos: Math.max(0, pos), duration: pl.playDuration, loop: pl.loop, stopping: pl.stopping, paused: false };
  }
}
