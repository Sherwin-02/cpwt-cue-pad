// Show backup files (.cuepad): one file holding a show and all of its audio.
// Layout: "CUEPAD1\n" | uint32 LE header length | header JSON | audio blobs in header order.

import * as db from './db.js';

const MAGIC = 'CUEPAD1\n';

export async function exportShow(show) {
  const ids = [...new Set(show.tiles.map((t) => t.trackId))];
  const tracks = [];
  const blobs = [];
  for (const id of ids) {
    const row = await db.get('tracks', id);
    if (!row) continue;
    tracks.push({ id: row.id, name: row.name, type: row.type, size: row.blob.size });
    blobs.push(row.blob);
  }
  const header = new TextEncoder().encode(JSON.stringify({ version: 1, show, tracks }));
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, header.length, true);
  return new Blob([MAGIC, len, header, ...blobs], { type: 'application/octet-stream' });
}

export async function importShow(file, newId) {
  const magic = await file.slice(0, MAGIC.length).text();
  if (magic !== MAGIC) throw new Error('This is not a Cue Pad backup file');
  const lenBytes = new Uint8Array(await file.slice(MAGIC.length, MAGIC.length + 4).arrayBuffer());
  const headerLen = new DataView(lenBytes.buffer).getUint32(0, true);
  let offset = MAGIC.length + 4;
  const header = JSON.parse(await file.slice(offset, offset + headerLen).text());
  offset += headerLen;
  for (const t of header.tracks) {
    const blob = file.slice(offset, offset + t.size, t.type || 'audio/mpeg');
    offset += t.size;
    const existing = await db.get('tracks', t.id);
    if (!existing) {
      // Copy into memory-backed blob so it survives after the file handle goes away.
      const copy = new Blob([await blob.arrayBuffer()], { type: t.type || 'audio/mpeg' });
      await db.put('tracks', { id: t.id, name: t.name, type: t.type, size: t.size, blob: copy, addedAt: Date.now() });
    }
  }
  const show = { ...header.show, id: newId, updatedAt: Date.now() };
  await db.put('shows', show);
  return show;
}

export async function saveFile(blob, filename) {
  const file = new File([blob], filename, { type: blob.type });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: filename });
      return;
    }
  } catch (err) {
    if (err && err.name === 'AbortError') return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
