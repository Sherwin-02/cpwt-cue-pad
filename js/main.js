// Entry point: the same page runs as the main cue pad, or as a remote when it
// was opened from a pairing QR code (#pair=...).
import { PAIR_PREFIX } from './pairing.js';

if (location.hash.startsWith(PAIR_PREFIX)) {
  import('./remote-client.js').then((m) => m.startRemote());
} else {
  import('./app.js');
}
