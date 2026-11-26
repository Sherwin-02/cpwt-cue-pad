# CPWT Cue Pad

An iPad app for Citipointe West Tamil church events that plays dance audio, drama background music and sound cues the instant a tile is touched. It works with no internet once installed.

## Using it on the iPad

1. Open the app's address in **Safari** while online.
2. Tap **Share → Add to Home Screen**. Cue Pad is laid out for landscape. Lock rotation in Control Center with the iPad sideways. Always open Cue Pad from this icon. iOS keeps home-screen apps' saved data, but can clear data for sites only visited in Safari.
3. Tap **Edit → + Add tracks** and choose MP3s from Files or iCloud Drive. They're copied onto the iPad.
4. Tap **Done**. Each tile turns gold-edged when its audio is loaded and ready.

On the day:

- Plug the iPad into power and the sound desk (USB-C or Lightning to 3.5 mm, or a USB audio interface). Set the iPad volume to maximum and control the level at the desk.
- Turn on airplane mode (wifi back on if you're using a remote), Do Not Disturb, and set Auto-Lock to Never.
- Use **Guided Access** (Settings → Accessibility) so nobody can leave the app by accident.
- Open the show, tap once to start audio, and wait until the top bar says **All N ready**.

## Controls

| Action | What happens |
| --- | --- |
| Tap a tile | Plays it immediately. Whatever was playing stops instantly, unless the tile is set to **Play over other cues**. Turn the **Fade** switch on (bottom bar) to fade between cues instead |
| Tap a playing tile | Stops it immediately (fades out with its fade-out time when **Fade** is on) |
| Volume rail (right edge) | Master volume for everything. Drag the handle up or down. A tap alone won't change it, so a brush can't jump the level mid-show. It works the same on the remote and stays in sync on both |
| ⏸ Pause / ▶ Resume | Pauses everything playing and keeps its place. Tap again (or tap the paused tile) to carry on from the same spot. Starting another cue clears paused ones |
| Position slider | Shows and moves the place in the current cue (the one most recently started). All the buttons sit under it |
| ⏮ From start | Plays the current cue again from its start point |
| ⟲10 / ⟳10 | Jump back or forward 10 seconds in the current cue |
| ◢ Fade in | Starts the Next cue fading in (whatever was playing fades out over the same time). On a paused cue, it carries on fading in |
| ◣ Fade out | Fades everything playing out, then stops |
| ⏹ Stop all | Stops everything immediately |
| ⚙︎ Settings | Fade in / Fade out time (default 5 seconds) |
| Edit | Add, rename, recolour, reorder or delete cues and change their settings. Taps don't play in Edit mode (use Preview) |
| Show name | Switch shows, create, rename, duplicate, delete, export or import a backup |

## GO: running the show in order

The **Next** box beside **GO** shows the cue that GO will play, and that tile has a green **NEXT** badge. Tap **GO** to play it, and Next moves to the cue after it. So for a programme laid out in order, the operator only needs GO.

- **◀ / ▶** beside Next move it back or skip a cue without playing anything.
- Tapping a tile yourself plays it and moves Next to the cue after it, so GO always carries on from wherever you are. Cues set to **Play over other cues** (stings) don't move Next.
- A second GO within 0.4 s is ignored, so a double tap can't skip a cue.
- After the last cue, Next says **End of show**. **Shows → Start again from cue 1** resets it, and **Edit → (a cue) → Make this the next cue for GO** jumps to any cue.
- Next is remembered per show, even if the app is closed.
- A remote gets the same GO, ◀ and ▶ buttons.
- A Bluetooth keyboard or page-turner pedal works too: **Space, Enter, Page Down, → or ↓** is GO, **Page Up, ← or ↑** moves Next back, and **Esc** fades out.

Per-cue settings: name, colour, volume (0 to 150%), start point, fade in, fade out, loop, and play over other cues.

## Remote (phone or second iPad)

The main iPad plays all the audio. A remote shows the same tiles and sends taps to it directly over the local wifi, with no internet and no server.

1. **Once, beforehand, while online:** open the app's address in Safari on the remote device, so it's saved for offline use.
2. On the main iPad, tap **Remote**. A QR code and the front-camera view appear.
3. Scan the QR code with the remote's Camera app and tap the link.
4. The remote shows its own QR code. Hold it up to the main iPad's front camera. Both say **Connected** within a few seconds.

**Front or back camera:** if the main device has more than one camera, tap **Switch camera** under the camera view. It remembers your choice.

**No camera on the main device (for example a laptop):** step 1 still works, because the laptop shows its code and the phone scans it. For step 2, tap **No camera there? Send code instead** on the remote and send the code to the laptop (AirDrop, Messages, WhatsApp or email to yourself). On the laptop, open **No camera? Paste the code instead**, paste it and tap **Connect**. The code only works with the laptop's current pairing screen, so keep that screen open while you send it.

You only scan once. After that the remote reconnects by itself whenever the link drops, for example when the phone's screen locks, you switch apps, or the wifi blips, with no walking back to the main iPad. Its screen says **Reconnecting…** and then **Connected** again within a few seconds of the phone being back on and unlocked. The main iPad keeps playing the whole time and can still be tapped directly. The Remote button shows how many remotes are connected, and how many are away and expected back.

There's no idle timeout: while both screens are on and on the same wifi, the link stays up for the whole event.

The main iPad holds the pairing for as long as Cue Pad stays open on it. If Cue Pad is closed or reloaded on the main iPad, each remote has to scan once more (the remote says so after a few tries). **Remote → Disconnect and forget all remotes** ends every pairing.

You can connect several remotes. Phones work upright or sideways.

**Adding tracks from a remote:** tap **+ Add tracks** (**+ Tracks** on a phone) and pick audio files from the phone's Files app. They're sent straight to the main iPad over the same wifi link, saved there, and added as new cues at the end of the show. The remote shows progress; keep its screen on until it says **Added**. The main iPad shows a small progress note at the top and nothing pops up over the show. Files that aren't audio are refused.

Some church or guest wifi networks stop devices from talking to each other. If pairing never connects, put both devices on a phone hotspot or a small travel router.

## Audio files

MP3 at 320 kbps, 44.1 kHz is recommended. AAC (.m4a) and WAV also work. Trim silence at the start, or set a start point on the cue.

## How instant start works

When a show opens, each cue's audio is decoded once and its first 15 seconds is kept in memory. Tapping a tile plays that straight away. Meanwhile, the full track is decoded in the background and scheduled to take over exactly where the first 15 seconds end, down to the sample, so the join is inaudible. The full track is released when the cue stops. This keeps about 40 cues ready in roughly 230 MB, rather than the ~3 GB needed to hold every song fully decoded.

## Backups

**Shows → Export backup** saves one `.cuepad` file containing the show and all its audio. Keep a copy in iCloud Drive. **Import backup** restores it, on this iPad or another one.

## Development

Plain HTML, CSS and JavaScript with no build step. Any static host works. It is served from GitHub Pages.

- `js/engine.js`: audio engine (preloading, instant start, seamless join, fades)
- `js/app.js`: UI, shows and editing
- `js/db.js`: on-device storage (IndexedDB)
- `js/backup.js`: `.cuepad` backup files
- `js/pairing.js`: direct device-to-device link (WebRTC data channel), QR helpers, and reconnecting without codes. It's the only file that knows about the transport. While a remote is connected, the main iPad keeps a standby connection waiting for it. The remote answers that standby with a fixed identity (a saved certificate and fixed ICE credentials), so after a drop it can rebuild the same answer and connect again with nothing to scan
- `js/remote-host.js` / `js/remote-client.js`: remote on the main iPad / on the remote device
- `js/upload.js`: sends audio files from a remote to the main iPad in 16 KB pieces over the same link, with flow control, and checks every byte arrived before saving
- `sw.js`: offline cache. **Bump `VERSION` whenever app files change**, so devices get the update (Shows → Update).

Smoke test (needs Playwright and ffmpeg):

```
node tests/smoke.mjs
node tests/remote.mjs
node tests/go.mjs
```
