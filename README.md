# Spatial Soundscape

A multiplayer, in-browser, HRTF-binaural audio sandbox. Drop sounds onto a
shared canvas, walk between them, and hear them pan around you in 3D.

[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white)](#)
[![Web Audio API](https://img.shields.io/badge/Web%20Audio-HRTF-555)](#)
[![Yjs](https://img.shields.io/badge/Multiplayer-Yjs%20CRDT-555)](#)
[![License](https://img.shields.io/badge/license-MIT-555)](LICENSE)

<p align="center">
  <img src="packages/frontend/public/screenshots/splash-neon.png" width="49%" alt="Splash — NEON dark" />
  <img src="packages/frontend/public/screenshots/splash-rose.png" width="49%" alt="Splash — Rosé Dawn" />
</p>

---
## What it does

- Drop **ten sound nodes** — ambient pads, bass drones, percussion, generative
  arpeggios, bells, strings, pads, plucked strings, a melody composer, or
  your microphone.
- Walk with `WASD`; every node pans through the browser's **HRTF binaural** model.
  Headphones give the full 3D effect.
- **Realms** — draw circular musical zones. Nodes dropped inside inherit the
  realm's key + BPM; walking into a realm applies its audio treatment
  (bass = lowpass + boost, percussive = highpass, chaos = tremolo, melodic
  = clean) with a 0.5 s crossfade at the borders.
- **Portals** — local pairs teleport you across the canvas; room portals
  jump you to a different room with a warm warp transition.
- **Acoustic environments** — one global space per room: `NONE`, `CAVE`
  (dark 2.5 s tail), `FOREST` (pre-delay + HF damping), `CATHEDRAL` (4 s
  wide reverb), `TUNNEL` (comb resonance). Syncs across peers.
- **Echo ghosts** — record your last 30 s of movement as a fading aurora
  trail with a delayed reverbed audio echo. Toggle in the sidebar.
- **Sound gravity** — per-type physics: bass attracts, bells push, pad orbits
  bass, gen-AI rhythm-orbits others, perc bounces off boundaries.
- **Melody composer** — piano-roll grid: draw your own tune step-by-step,
  preview, then drop it as a node. Load templates from famous riffs
  (Billie Jean, Come As You Are, Still D.R.E., Beethoven's 5th, Take Five).
- **Multiplayer** — open the same room in two tabs or share with a friend.
  Nodes, realms, portals, and environment sync live via Yjs over WebSocket.
  Add an optional **passcode** for private rooms.
- **Mood Engine** — type anything; on-device AI re-tunes every node to a
  matching key, color, and reverb. No API keys, works offline.
- **Creative tools** — harmonically link nodes, set a global BPM, save/restore
  scenes, record loops, cursor chat with `T`, and more.
- **Four themes** — NEON, Tokyo Night, Rosé Dawn, and Pastel Tint (drag a live
  hue strip to pick any pastel color).

<p align="center">
  <img src="packages/frontend/public/screenshots/canvas-neon.png" width="99%" alt="Canvas — NEON dark with nodes" />
</p>
<p align="center">
  <img src="packages/frontend/public/screenshots/splash-tokyo.png" width="32%" alt="Tokyo Night" />
  <img src="packages/frontend/public/screenshots/theme-picker.png" width="32%" alt="Theme picker" />
  <img src="packages/frontend/public/screenshots/canvas-rose.png"  width="32%" alt="Rosé Dawn canvas" />
</p>

---

## Quick start

> Requires Node.js 18+, npm 9+, and a modern browser. Headphones are strongly
> recommended — HRTF spatial audio collapses to flat stereo without them.


```bash
git clone https://github.com/Indira-06-Projects/Spatial-Soundscape.git
cd Spatial-Soundscape

npm install
npm run build --workspace=@spatial-soundscape/engine
npm run dev
```

Open <http://localhost:5173> in your browser. Open a second tab on the same
URL to test multiplayer.

To run pieces individually:

```bash
npm run dev:backend    # Fastify + y-websocket relay on :3001
npm run dev:frontend   # Vite dev server on :5173
npm run typecheck      # strict TypeScript check across all workspaces
npm run build          # production builds across the monorepo
```

---

## Controls

Press `?` in the app for the full overlay (shown below). A few non-obvious ones:
`Alt`+drag duplicates a node, `Shift`+drag snaps to grid, hover a node then press `M` to mute,
and `T` opens a cursor chat bubble visible to all peers.

<p align="center">
  <img src="packages/frontend/public/screenshots/help-modal-rose.png" width="80%" alt="Help overlay — Rosé Dawn theme" />
</p>

---

## Node types

| Glyph | Name | Sound |
|---|---|---|
| ◉ | AMBIENT | 3 detuned oscillators + LFO filter sweep |
| ▼ | BASS | Sub sine through a waveshaper — weight and low end |
| ▦ | PERC | Filtered noise burst — snare/hat/click; BPM-synced |
| ✺ | GEN AI | Pentatonic arpeggio on AudioWorklet clock — BPM-synced |
| ✦ | BELLS | FM synthesis — bright metallic ring, auto-retriggered |
| ≋ | STRINGS | 4 detuned saws with slow bow-like attack |
| ⬡ | PAD | Major triad through a slow filter sweep — wide, warm |
| ⌇ | PLUCK | Triangle + harmonic, fast exponential decay |
| ♫ | MELODY | Opens the piano-roll composer — draw your own tune, preview, drop as a node |
| ◎ | VOICE | Your mic through the full HRTF spatial chain |

---

## Spatial systems

Beyond individual nodes, four systems shape how sound behaves across the canvas. Each is synced via Yjs (except Echo Ghosts, which is deliberately local).

### Realms

Circular musical zones with a name, key, BPM, colour, and radius.

- **Node inheritance.** Any node dropped inside a realm inherits its key
  (frequency shifted to the nearest octave of that pitch class) and BPM
  (tempo for percussion / pluck / generative). Manual sound-design tweaks
  after drop always win.
- **Audio treatment.** Walking into a realm applies its filter with a 0.5 s
  crossfade. Types are `MELODIC` (no filter), `BASS` (lowpass 400 Hz + 3 dB
  boost), `PERCUSSIVE` (highpass 200 Hz), `CHAOS` (7 Hz tremolo). Overlapping
  realms sum weights per-type at the master bus.
- **Editing.** Click the label pill at the top of any realm (or shift-click
  anywhere inside) to reopen the editor. A live `SIZE` slider resizes on the
  canvas as you drag. Right-click on empty realm space deletes it.

### Portals

Gateways for teleporting across (or between) rooms.

- **Local pair.** Two linked portals — walking into one exits from the twin.
  Placed by clicking the sidebar `◈ NEW PORTAL` button, then clicking the
  canvas twice. A 1.2 s cooldown prevents bounce-back.
- **Room portal.** Links to another room by name. Walking through cleanly
  disconnects the current room's multiplayer session, tears down local
  state, and reconnects to the destination — no wanderer-count leak.
- **Colour picker.** Each portal has its own accent colour, drawn as a
  swirling three-arm radial gradient with the destination label centred.
- **Deleting.** Right-click a portal removes it (both halves of a local pair).

### Acoustic environments

One global environment per room; a sidebar icon strip toggles between five presets.

| Preset | Character |
|---|---|
| `◌` NONE | No colouring |
| `⏜` CAVE | 2.5 s dark tail · high-shelf cut above 4 kHz · narrow stereo |
| `✽` FOREST | 30 ms pre-delay · mild HF damping · shorter 1.2 s tail |
| `✚` CATHEDRAL | 4 s tail · wide stereo · subtle low-cut on direct signal |
| `⇌` TUNNEL | Comb resonance (~55 Hz spacing) · narrow stereo · mid-length reverb |

Filter/reverb parameters ramp with a ~0.5 s exponential time constant so
the environment change feels like walking into a new space rather than a
sudden cut.

### Echo Ghosts

Toggled from the sidebar. When active:

- The last 30 s of your movement is rendered as a fading aurora trail
  (opacity fades linearly from 60 % → 0 % across the window).
- The audio engine opens a delay+feedback+reverb bus tapping the master —
  the sonic effect is "3.5 s ago, on repeat, drenched in reverb."

Ghost state is local only — peers won't see or hear yours.

### Sound Gravity — per-type physics

Toggle `⊕ GRAVITY` in the sidebar to activate a physics loop that treats each node type differently:

| Type | Behaviour |
|---|---|
| BASS | Attracts nearby nodes within 220 world-units |
| BELLS | Repels nearby nodes within 220 world-units |
| PAD | Orbits the nearest BASS node within 300 world-units |
| AMBIENT | Drifts along a slow two-frequency lissajous curve |
| GEN AI | Rhythm-orbits other GEN AI nodes within 150 world-units around their centroid |
| PERC | Bounces off canvas boundaries and other nodes |

All velocities are damped and capped at ~0.5 px/frame. Manual drag zeroes the physics velocity so it feels responsive.

### Melody composer

Click the `♫ MELODY` sidebar button to open a 13 × 16 piano-roll grid.

- Click cells to place notes (monophonic — one note per column). Rows are `+6` to `-6` semitones from the root, or actual note names via the `LABELS` toggle.
- Pick root note, octave, wave shape (triangle / sine / square), and BPM.
- Load a famous-tune template as a starting point (Billie Jean · Come As
  You Are · Still D.R.E. · Beethoven's 5th "fate motif" · Take Five in 5/4)
  then edit freely.
- `PREVIEW` plays your composition through a hidden audio-only node (no
  multiplayer broadcast). `DROP AS NODE` primes your next canvas click to
  plant it — and the drop respects realm inheritance (key + BPM).

---

## How it works

**Audio** — Web Audio API with an HRTF `PannerNode` per node for
headphone-accurate 3D placement. Convolver reverb is synthesised at runtime
(no IR file) with pre-delay and stereo-width parameters so the same IR
generator produces every acoustic environment. An AudioWorklet beat clock
keeps PERC, PLUCK, and GEN AI in sample-accurate sync at any BPM. Every
node routes through a chain of treatment buses:

```
node → compressor → realm bus → environment bus → destination
                     ↓ ↑
                master → ghost delay + reverb → destination
```

The **realm bus** applies filter/tremolo/boost based on which realm(s) the
listener is inside. The **environment bus** applies the global acoustic
space (env-specific highshelf, low-cut, comb delay). The **ghost bus** is a
long delay + wet reverb that toggles on with Echo Ghosts. All parameter
changes use `setTargetAtTime` so per-frame updates crossfade smoothly.

**Multiplayer** — Yjs CRDT syncs four Y.Maps per room: `nodes`, `realms`,
`portals`, and `env`. Peer awareness (position, cursor chat) rides on the
same WebSocket. Rooms auto-reconnect with a 2-second backoff; private
rooms use client-side djb2 passcode hashing so the server never sees the
actual passcode. Switching rooms (via the room modal or a room portal)
calls `Multiplayer.disconnect()` to tear down the previous connection
cleanly — no phantom wanderers.

**Mood Engine** — Two-tier classifier: a fast offline lexicon (VADER-inspired,
~250 words) with a Transformers.js distilbert upgrade that silently loads in
the background. Either tier drives key, tempo, node color, and reverb depth.

**Renderer** — Canvas2D at 60 fps. Layers: theme-aware aurora background →
warping grid → peer/node trails → harmonic link wires → resonance bridges →
FFT analyser rings → node orbs → peer avatars with chat bubbles → minimap.
All colors are CSS custom properties so switching themes updates canvas and
HUD simultaneously.

**Themes** — four options, all persisted to `localStorage`:

| | Theme | Character |
|---|---|---|
| ☾ | NEON | Cyberpunk dark — electric cyan + magenta, full glow |
| ◑ | TOKYO NIGHT | Soft dark — pastel blue + rose, reduced glow |
| ♡ | ROSÉ DAWN | Warm peach pastel — near-white bg, minimal glow |
| ◌ | PASTEL TINT | Fully custom — drag the hue strip to any pastel color |

---

## Architecture

```
spatial-soundscape/
├── packages/
│   ├── engine/     Web Audio core (no DOM)
│   ├── common/     Shared constants (WS_PATH, palette)
│   ├── backend/    Fastify 5 + y-websocket relay
│   └── frontend/   Vite + TypeScript + Canvas2D
│       ├── main.ts           Scene loop + all UI wiring
│       ├── Renderer.ts       Canvas2D scene
│       ├── Multiplayer.ts    Yjs client
│       ├── MoodDriver.ts     Lexicon + ML sentiment
│       ├── KeyboardPiano.ts  Computer-keyboard piano
│       └── style.css         Four-theme CSS custom-property system
├── package.json    Workspace root + dev scripts
└── LICENSE         MIT
```

Key choices: vanilla TypeScript over a framework (Canvas2D and Web Audio need
no virtual DOM), Canvas2D over WebGL (soft glows and polylines are one-liners),
Yjs for multiplayer (CRDT merges give free offline resilience), AudioWorklet
for the beat clock (main-thread `setInterval` jitters 5–15 ms under GC load).

---

## Deployment

```bash
npm run build
PORT=3001 node packages/backend/dist/server.js &
npx serve packages/frontend/dist
```

Reverse-proxy setup (Caddy example):

```caddy
your-domain.example {
    handle /ws/*    { reverse_proxy 127.0.0.1:3001 }
    handle /health  { reverse_proxy 127.0.0.1:3001 }
    handle          { root * packages/frontend/dist; file_server; try_files {path} /index.html }
}
```

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3001` | Backend listen port |
| `HOST` | `0.0.0.0` | Backend bind host |

---

## Tech stack

| | Technology |
|---|---|
| Audio | Web Audio API — HRTF panner, convolver, compressor, AudioWorklet, MediaRecorder |
| AI | Transformers.js + ONNX Runtime Web (in-browser distilbert) |
| Multiplayer | Yjs CRDT + y-protocols over WebSocket |
| Backend | Fastify 5, `@fastify/websocket` |
| Frontend | Vite 5, TypeScript 5.5, Canvas 2D |

---

## Troubleshooting

| Symptom                                                | Likely cause and fix                                                                                                                              |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| ENTER button doesn't respond after pulling new changes | Vite's pre-bundled dependency cache is stale. Stop `npm run dev`, run `rm -rf node_modules/.vite packages/frontend/node_modules/.vite`, restart.  |
| Voice node is silent                                   | Browser blocked the microphone. Check the address-bar mic icon and the mic-status indicator in the bottom HUD, then re-grant permission.          |
| No sound at all                                        | The browser is waiting for a user gesture. Click anywhere on the canvas — the lazy-start path will resume the AudioContext.                       |
| Audio feedback squeal with VOICE nodes                 | You're using speakers. Voice nodes loop the mic through the spatial audio bus — headphones are required.                                          |
| Mood engine result tagged `lex` instead of `ML`        | The Transformers.js CDN is unreachable on your network. The lexicon fallback is in use and works fine.                                            |
| `code 130` after pressing Ctrl+C                       | Not an error. `128 + 2` is the Unix convention for "process killed by SIGINT" — the normal response to your interrupt.                            |
| Multiplayer says "solo mode"                           | The backend isn't reachable. Confirm it booted with `curl http://localhost:3001/health`; expected response is `{"ok":true}`.                      |
| Two-finger pinch doesn't zoom on a Mac trackpad        | Make sure the browser tab is focused. Some trackpads also need three-finger drag disabled in System Settings.                                     |

---

## Verifying a clean state

```bash
npm run typecheck                                     # all workspaces
npm run build --workspace=@spatial-soundscape/engine  # engine -> dist/
```

Both should exit 0.

---

## Tech stack

| Layer       | Technology                                                                                                  |
| ----------- | ----------------------------------------------------------------------------------------------------------- |
| Audio       | Web Audio API (HRTF panner, convolver reverb, dynamics compressor, AudioWorklet, MediaRecorder, getUserMedia) |
| AI          | Transformers.js + ONNX Runtime Web (in-browser distilbert sentiment)                                        |
| Multiplayer | Yjs CRDT + y-protocols sync/awareness over WebSocket                                                        |
| Backend     | Fastify 5, `@fastify/websocket`, pino logging                                                               |
| Frontend    | Vite 5, TypeScript 5.5, Canvas 2D (no framework)                                                            |
| Tooling     | npm workspaces, strict TypeScript (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), `tsx`         |

---

## Contributing

Pull requests that fix bugs or add focused features are welcome.

1. Fork and branch from `main`.
2. Ensure `npm run typecheck` exits 0 across all workspaces.
3. Open a PR with a clear description. Small focused PRs are preferred over
   large sweeping ones.
