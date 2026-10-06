import {
  AudioEngine,
  AnalyserBridge,
  makeNodeId,
  makeRealmId,
  makePortalId,
  type AnalyserFrame,
  type MicVoiceStatus,
  type NodeId,
  type SpatialNodeDescriptor,
  type SynthParams,
  type SynthType,
  type Vec3,
  type Realm,
  type RealmId,
  type RealmType,
  type EnvironmentType,
  type Portal,
  type PortalId,
  type PortalType,
} from '@spatial-soundscape/engine';
import { CYBERPUNK_PALETTE } from '@spatial-soundscape/common';
import { Renderer } from './Renderer.ts';
import { Multiplayer } from './Multiplayer.ts';
import { MoodDriver } from './MoodDriver.ts';
import { ResonanceDetector } from './ResonanceDetector.ts';
import { KeyboardPiano } from './KeyboardPiano.ts';
import { LoopRecorder } from './LoopRecorder.ts';
import { Recorder, fmtElapsed, fmtBytes, webmToWav } from './Recorder.ts';
import { constellationLayout } from './constellation.ts';
import { STARTER_PRESETS } from './presets.ts';
import { TUNES } from './tunes.ts';

const nodes = new Map<NodeId, SpatialNodeDescriptor>();
const frames = new Map<NodeId, AnalyserFrame>();
const peers = new Map<string, { position: Vec3; color: string }>();
const peerChats = new Map<string, { text: string; at: number }>();
const peerTrails = new Map<string, Vec3[]>();
const trails = new Map<NodeId, Vec3[]>();
const realms = new Map<RealmId, Realm>();
const portals = new Map<PortalId, Portal>();
const listener: Vec3 = { x: 0, y: 0, z: 0 };

// Feature state
import type { NodeLink } from './Renderer.ts';
const links = new Map<NodeId, NodeLink>();
let linkMode = false;
let linkSource: NodeId | null = null;
const LINK_INTERVALS = [
  { semitones: 7,   name: '5th'  },
  { semitones: 12,  name: '8va'  },
  { semitones: 5,   name: '4th'  },
  { semitones: -12, name: '8vb'  },
] as const;
let linkIntervalIdx = 0;

let gravityOn = false;
const GRAVITY = 22; // world-units/sec pull at 100 units away
// Per-node velocities for the per-type physics gravity — kept outside the
// nodes map so multiplayer sync doesn't churn on every micro-nudge.
const nodeVel = new Map<NodeId, { vx: number; vz: number }>();
// Ambient drift phase per node (for sinusoidal random-curves motion)
const nodePhase = new Map<NodeId, { a: number; b: number }>();
const MAX_VEL = 30; // world-units/second cap (equiv. ~0.5 px/frame at 60fps)

let globalBpm = 120;
const forward: Vec3 = { x: 0, y: 0, z: -1 };
const up: Vec3 = { x: 0, y: 1, z: 0 };

let activeSynthType: SynthType = 'ambient';
let totalEnergy = 0;

const canvas = document.getElementById('stage') as HTMLCanvasElement;
const renderer = new Renderer(canvas);

const engine = new AudioEngine({ maxNodes: 64, defaultReverbLength: 2.5 });
const bridge = new AnalyserBridge(engine);

bridge.onFrame = (newFrames) => {
  let energy = 0;
  for (const f of newFrames) {
    frames.set(f.nodeId, f);
    energy += f.rmsEnergy;
  }
  totalEnergy = Math.min(1, energy / Math.max(1, newFrames.length) * 1.5);
};

const resonance = new ResonanceDetector();
const piano = new KeyboardPiano(engine, () => listener);
const loopRecorder = new LoopRecorder((midi) => piano.playNote(midi));
piano.loopRecorder = loopRecorder;
const recorder = new Recorder(engine);
const mood = new MoodDriver();

let multiplayer: Multiplayer | null = null;
let currentRoom = 'lobby';

const splash = document.getElementById('splash')!;
const splashBtn = document.getElementById('splash-start')!;
splashBtn.addEventListener('click', async () => {
  await engine.start();
  bridge.start();
  updateLegend();

  try {
    multiplayer = new Multiplayer(engine, { nodes, realms, portals, peers, peerChats });
    multiplayer.onRealmChange = () => renderer.setRealms(realms);
    multiplayer.onPortalChange = () => renderer.setPortals(portals);
    multiplayer.onEnvironmentChange = (env) => applyEnvironment(env, false);
    await multiplayer.connect(currentRoom);
    setConnStatus('online', 'connected');
  } catch (err) {
    console.warn('multiplayer unavailable — running solo:', err);
    setConnStatus('offline', 'solo mode');
  }

  splash.classList.add('hidden');
  setTimeout(() => splash.remove(), 700);
});

const roomBtn      = document.getElementById('room-switch')!;
const roomNameEl   = document.getElementById('room-name')!;
const roomModal    = document.getElementById('room-modal')!;
const roomInput    = document.getElementById('room-input') as HTMLInputElement;
const roomCancel   = document.getElementById('room-cancel')!;
const roomConfirm  = document.getElementById('room-confirm')!;

function openRoomModal(): void {
  roomInput.value = currentRoom;
  roomModal.removeAttribute('hidden');
  setTimeout(() => { roomInput.focus(); roomInput.select(); }, 50);
}
function closeRoomModal(): void {
  roomModal.setAttribute('hidden', '');
}

roomBtn.addEventListener('click', openRoomModal);
roomCancel.addEventListener('click', closeRoomModal);
roomModal.addEventListener('click', (ev) => {
  if (ev.target === roomModal) closeRoomModal();
});
roomInput.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') roomConfirm.dispatchEvent(new Event('click'));
  if (ev.key === 'Escape') closeRoomModal();
});

function djb2(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (h * 33) ^ s.charCodeAt(i);
  return h >>> 0;
}

roomConfirm.addEventListener('click', async () => {
  const name = roomInput.value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(name)) {
    roomInput.style.borderColor = 'var(--neon-magenta)';
    setTimeout(() => { roomInput.style.borderColor = ''; }, 800);
    return;
  }
  const passcode = (document.getElementById('room-passcode') as HTMLInputElement).value.trim();
  const roomKey = passcode ? `${name}-${djb2(passcode).toString(36)}` : name;
  closeRoomModal();
  if (roomKey === currentRoom) return;

  // Reset local world so old-room state doesn't bleed into the new one.
  for (const id of [...nodes.keys()]) {
    engine.removeNode(id);
    nodes.delete(id);
    trails.delete(id);
  }
  realms.clear();
  renderer.setRealms(realms);
  portals.clear();
  renderer.setPortals(portals);
  peers.clear();

  currentRoom = roomKey;
  roomNameEl.textContent = name;
  setConnStatus('connecting', 'switching rooms…');

  // Tear down the previous connection first so its awareness doesn't leak
  // into the peer count of the new room.
  multiplayer?.disconnect();

  try {
    multiplayer = new Multiplayer(engine, { nodes, realms, portals, peers, peerChats });
    multiplayer.onRealmChange = () => renderer.setRealms(realms);
    multiplayer.onPortalChange = () => renderer.setPortals(portals);
    multiplayer.onEnvironmentChange = (env) => applyEnvironment(env, false);
    await multiplayer.connect(name);
    setConnStatus('online', 'connected');
  } catch (err) {
    console.warn('reconnect failed:', err);
    setConnStatus('offline', 'solo mode');
  }
  updateLegend();
});

const legendEl = document.getElementById('legend')!;
function updateLegend(): void {
  const n = nodes.size;
  if (!engine.isRunning) {
    legendEl.textContent = '▷ press ENTER to start audio';
    return;
  }
  if (n === 0) {
    legendEl.textContent = '◇ click canvas to drop a node · WASD to move';
  } else if (n === 1) {
    legendEl.textContent = `◉ ${n} node live · walk past it to hear the panning`;
  } else {
    legendEl.textContent = `◉ ${n} nodes live · ${piano.enabled ? '🎹 piano A–K · ' : ''}headphones recommended`;
  }
}

function setConnStatus(cls: 'online' | 'offline' | 'connecting', label: string): void {
  const dot = document.getElementById('conn-dot')!;
  dot.classList.remove('connected', 'connecting');
  if (cls === 'online') dot.classList.add('connected');
  if (cls === 'connecting') dot.classList.add('connecting');
  document.getElementById('conn-status')!.textContent = label;
}
setConnStatus('connecting', 'press ENTER to start');

// Theme dropdown — 4 palettes selectable from a floating menu.
try {
  const THEME_KEY = 'spatial-soundscape.theme';
  const TINT_HUE_KEY = 'spatial-soundscape.tint-hue';
  type Theme = 'dark' | 'dark-mellow' | 'light' | 'tint';
  const VALID: Theme[] = ['dark', 'dark-mellow', 'light', 'tint'];
  const ICONS: Record<Theme, string> = {
    'dark': '☾', 'dark-mellow': '◑', 'light': '♡', 'tint': '◌',
  };

  const TINT_PROPS = [
    '--bg-0','--bg-1','--bg-grid','--bg-aurora-1','--bg-aurora-2',
    '--neon-cyan','--neon-magenta','--neon-violet','--neon-amber',
    '--text','--text-dim','--border','--modal-bg','--input-bg','--mood-bg',
    '--canvas-text','--shadow-cyan','--shadow-magenta','--shadow-violet','--shadow-amber',
    '--canvas-glow-mul',
  ] as const;

  const clearTintStyles = (): void => {
    TINT_PROPS.forEach(p => document.documentElement.style.removeProperty(p));
  };

  const applyTintHue = (hue: number): void => {
    const h2 = (hue + 35) % 360;
    const h3 = (hue + 270) % 360;
    const h4 = (hue + 55) % 360;
    const h5 = (hue + 40) % 360;
    const r = document.documentElement;
    r.style.setProperty('--bg-0',          `hsl(${hue}, 35%, 98.5%)`);
    r.style.setProperty('--bg-1',          `hsl(${hue}, 40%, 96.5%)`);
    r.style.setProperty('--bg-grid',       `hsla(${hue}, 40%, 50%, 0.07)`);
    r.style.setProperty('--bg-aurora-1',   `hsla(${hue}, 50%, 60%, 0.07)`);
    r.style.setProperty('--bg-aurora-2',   `hsla(${h5}, 45%, 60%, 0.04)`);
    r.style.setProperty('--neon-cyan',     `hsl(${hue}, 52%, 45%)`);
    r.style.setProperty('--neon-magenta',  `hsl(${h2}, 55%, 42%)`);
    r.style.setProperty('--neon-violet',   `hsl(${h3}, 42%, 52%)`);
    r.style.setProperty('--neon-amber',    `hsl(${h4}, 60%, 44%)`);
    r.style.setProperty('--text',          `hsl(${hue}, 28%, 20%)`);
    r.style.setProperty('--text-dim',      `hsl(${hue}, 18%, 58%)`);
    r.style.setProperty('--border',        `hsla(${hue}, 30%, 50%, 0.20)`);
    r.style.setProperty('--modal-bg',      `hsla(${hue}, 35%, 99%, 0.97)`);
    r.style.setProperty('--input-bg',      `hsla(${hue}, 30%, 50%, 0.06)`);
    r.style.setProperty('--mood-bg',       `hsla(${hue}, 30%, 50%, 0.04)`);
    r.style.setProperty('--canvas-text',   `hsl(${hue}, 28%, 20%)`);
    r.style.setProperty('--shadow-cyan',    `hsla(${hue}, 52%, 45%, 0.18)`);
    r.style.setProperty('--shadow-magenta', `hsla(${h2}, 55%, 42%, 0.15)`);
    r.style.setProperty('--shadow-violet',  `hsla(${h3}, 42%, 52%, 0.14)`);
    r.style.setProperty('--shadow-amber',   `hsla(${h4}, 60%, 44%, 0.12)`);
    r.style.setProperty('--canvas-glow-mul', '0.14');
    renderer.invalidateThemeCache?.();
    const preview = document.getElementById('tint-preview') as HTMLElement | null;
    if (preview) preview.style.background = `hsl(${hue}, 65%, 65%)`;
  };

  const applyTheme = (theme: Theme): void => {
    if (theme !== 'tint') clearTintStyles();
    document.documentElement.setAttribute('data-theme', theme);
    const btn = document.getElementById('theme-btn');
    if (btn) btn.textContent = ICONS[theme];
    try { localStorage.setItem(THEME_KEY, theme); } catch { /* private mode */ }
    if (theme !== 'tint') renderer.invalidateThemeCache?.();
    document.querySelectorAll<HTMLElement>('.theme-opt').forEach(opt => {
      opt.classList.toggle('active', opt.dataset['theme'] === theme);
    });
    const tintRow = document.getElementById('tint-hue-row');
    if (theme === 'tint') {
      tintRow?.classList.add('open');
      const savedHue = parseInt((() => { try { return localStorage.getItem(TINT_HUE_KEY) ?? '340'; } catch { return '340'; } })());
      const slider = document.getElementById('tint-hue-slider') as HTMLInputElement | null;
      if (slider) slider.value = String(savedHue);
      applyTintHue(savedHue);
    } else {
      tintRow?.classList.remove('open');
    }
  };

  const stored = (() => { try { return localStorage.getItem(THEME_KEY); } catch { return null; } })();
  applyTheme((VALID.includes(stored as Theme) ? stored : 'dark') as Theme);

  const themeBtn = document.getElementById('theme-btn');
  const themeDropdown = document.getElementById('theme-dropdown');
  if (themeBtn && themeDropdown) {
    themeBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      themeDropdown.classList.toggle('open');
    });
    document.addEventListener('click', () => themeDropdown.classList.remove('open'));
    themeDropdown.addEventListener('click', (ev) => ev.stopPropagation());
    document.querySelectorAll<HTMLElement>('.theme-opt').forEach(opt => {
      opt.addEventListener('click', () => {
        const t = opt.dataset['theme'] as Theme;
        if (!VALID.includes(t)) return;
        applyTheme(t);
        if (t !== 'tint') themeDropdown.classList.remove('open');
      });
    });
    const tintSlider = document.getElementById('tint-hue-slider') as HTMLInputElement | null;
    tintSlider?.addEventListener('input', () => {
      const hue = parseInt(tintSlider.value);
      applyTintHue(hue);
      try { localStorage.setItem(TINT_HUE_KEY, String(hue)); } catch {}
    });
  } else {
    console.warn('theme elements not found — hard-refresh (Cmd+Shift+R) should fix.');
  }
} catch (err) {
  console.warn('theme init failed (non-fatal):', err);
}

// Dynamic-imported so a stale Vite bundle can never break the whole module load.
(async () => {
  try {
    const micStatusEl = document.getElementById('mic-status');
    const micStatusLabelEl = document.getElementById('mic-status-label');
    if (!micStatusEl || !micStatusLabelEl) return;

    const MIC_LABELS: Record<MicVoiceStatus, string> = {
      pending: 'requesting…',
      live: 'live',
      blocked: 'BLOCKED — click address-bar mic icon',
      unavailable: 'no device',
    };

    const engineMod = await import('@spatial-soundscape/engine') as { MicVoice?: { onStatus: ((s: MicVoiceStatus) => void) | null } };
    if (!engineMod.MicVoice) {
      console.warn('MicVoice not exported by the loaded engine module — voice nodes still work, status indicator will not light up. Try restarting `npm run dev`.');
      return;
    }
    engineMod.MicVoice.onStatus = (s: MicVoiceStatus) => {
      micStatusEl.removeAttribute('hidden');
      micStatusEl.className = `mic-status ${s}`;
      micStatusLabelEl.textContent = MIC_LABELS[s];
    };
  } catch (err) {
    console.warn('mic status indicator init failed (non-fatal):', err);
  }
})();

const zoomIndicator = document.getElementById('zoom-indicator')!;

function updateZoomIndicator(): void {
  zoomIndicator.textContent = `${renderer.zoom.toFixed(2)}×`;
}

/** Zoom by a multiplicative factor, keeping the world point under (sx, sy) anchored. */
function zoomAt(factor: number, screenX: number, screenY: number): void {
  const worldBefore = renderer.screenToWorld(screenX, screenY, listener);
  renderer.setZoom(renderer.zoom * factor);
  const worldAfter  = renderer.screenToWorld(screenX, screenY, listener);
  // Anchor the zoom around the cursor by compensating listener position.
  listener.x += worldBefore.x - worldAfter.x;
  listener.z += worldBefore.z - worldAfter.z;
  updateZoomIndicator();
}

canvas.addEventListener('wheel', (ev) => {
  ev.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const factor = Math.exp(-ev.deltaY * 0.0015);
  zoomAt(factor, ev.clientX - rect.left, ev.clientY - rect.top);
}, { passive: false });

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return;
  if (e.key === '+' || e.key === '=') {
    zoomAt(1.15, window.innerWidth / 2, window.innerHeight / 2);
  } else if (e.key === '-' || e.key === '_') {
    zoomAt(1 / 1.15, window.innerWidth / 2, window.innerHeight / 2);
  } else if (e.key === '0') {
    renderer.setZoom(1);
    updateZoomIndicator();
  }
});

/** Animate zoom + listener toward target values over `durationMs`. */
function tweenCamera(targetZoom: number, targetX: number, targetZ: number, durationMs = 600): void {
  const startZoom = renderer.zoom;
  const startX = listener.x, startZ = listener.z;
  const startMs = performance.now();
  const step = (now: number) => {
    const t = Math.min(1, (now - startMs) / durationMs);
    const eased = t * t * (3 - 2 * t); // smoothstep
    renderer.setZoom(startZoom + (targetZoom - startZoom) * eased);
    listener.x = startX + (targetX - startX) * eased;
    listener.z = startZ + (targetZ - startZ) * eased;
    updateZoomIndicator();
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function fitAllInView(): void {
  let minX = listener.x, maxX = listener.x, minZ = listener.z, maxZ = listener.z;
  let count = 0;
  for (const n of nodes.values()) {
    if (n.position.x < minX) minX = n.position.x;
    if (n.position.x > maxX) maxX = n.position.x;
    if (n.position.z < minZ) minZ = n.position.z;
    if (n.position.z > maxZ) maxZ = n.position.z;
    count++;
  }
  for (const p of peers.values()) {
    if (p.position.x < minX) minX = p.position.x;
    if (p.position.x > maxX) maxX = p.position.x;
    if (p.position.z < minZ) minZ = p.position.z;
    if (p.position.z > maxZ) maxZ = p.position.z;
    count++;
  }
  if (count === 0) {
    tweenCamera(1, 0, 0);
    return;
  }
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;
  const rangeX = Math.max(400, maxX - minX);
  const rangeZ = Math.max(400, maxZ - minZ);
  const zoomX = (window.innerWidth  * 0.85) / rangeX;
  const zoomZ = (window.innerHeight * 0.85) / rangeZ;
  const targetZoom = Math.max(Renderer.MIN_ZOOM, Math.min(Renderer.MAX_ZOOM, Math.min(zoomX, zoomZ)));
  tweenCamera(targetZoom, cx, cz);
}

updateZoomIndicator();

const mod = { shift: false, alt: false, space: false };
window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return;
  if (e.key === 'Shift') mod.shift = true;
  if (e.key === 'Alt')   mod.alt   = true;
  if (e.code === 'Space') { mod.space = true; canvas.style.cursor = 'grab'; e.preventDefault(); }
});
window.addEventListener('keyup', (e) => {
  if (e.key === 'Shift') mod.shift = false;
  if (e.key === 'Alt')   mod.alt   = false;
  if (e.code === 'Space') { mod.space = false; canvas.style.cursor = 'crosshair'; }
});
window.addEventListener('blur', () => { mod.shift = mod.alt = mod.space = false; });

const GRID_SNAP = 32;
function snap(p: Vec3): Vec3 {
  return mod.shift
    ? { x: Math.round(p.x / GRID_SNAP) * GRID_SNAP, y: 0, z: Math.round(p.z / GRID_SNAP) * GRID_SNAP }
    : p;
}

// Command pattern: each mutation broadcasts and stays multiplayer-safe on undo.
interface Command { do(): void; undo(): void; label: string }
const undoStack: Command[] = [];
const redoStack: Command[] = [];
const UNDO_LIMIT = 200;

function execute(cmd: Command, skipDo = false): void {
  if (!skipDo) cmd.do();
  undoStack.push(cmd);
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  redoStack.length = 0;
}
function undo(): void {
  const cmd = undoStack.pop();
  if (!cmd) { flashLegend('nothing to undo'); return; }
  cmd.undo();
  redoStack.push(cmd);
  flashLegend(`undo: ${cmd.label}`);
}
function redo(): void {
  const cmd = redoStack.pop();
  if (!cmd) { flashLegend('nothing to redo'); return; }
  cmd.do();
  undoStack.push(cmd);
  flashLegend(`redo: ${cmd.label}`);
}

const legendEl2 = document.getElementById('legend')!;
let legendFlashTimer: ReturnType<typeof setTimeout> | null = null;
function flashLegend(msg: string): void {
  legendEl2.textContent = msg;
  if (legendFlashTimer) clearTimeout(legendFlashTimer);
  legendFlashTimer = setTimeout(() => updateLegend(), 1500);
}

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return;
  const cmdOrCtrl = e.metaKey || e.ctrlKey;
  if (cmdOrCtrl && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    if (e.shiftKey) redo(); else undo();
  } else if (cmdOrCtrl && e.key.toLowerCase() === 'y') {
    e.preventDefault();
    redo();
  }
});

const helpModal = document.getElementById('help-modal')!;
const helpBtn   = document.getElementById('help-btn')!;
const helpClose = document.getElementById('help-close')!;
function openHelp(): void  { helpModal.removeAttribute('hidden'); }
function closeHelp(): void { helpModal.setAttribute('hidden', ''); }
helpBtn.addEventListener('click', openHelp);
helpClose.addEventListener('click', closeHelp);

// Help modal tabs — click a tab to show its page
document.querySelectorAll<HTMLButtonElement>('.help-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    const target = tab.dataset['helpTab'];
    document.querySelectorAll('.help-tab').forEach(t => t.classList.toggle('active', t === tab));
    document.querySelectorAll<HTMLElement>('.help-page').forEach(p => {
      p.classList.toggle('active', p.dataset['helpPage'] === target);
    });
    // Reset scroll so switching to a new tab always starts at the top
    document.querySelector('.help-scroll')?.scrollTo({ top: 0 });
  });
});
helpModal.addEventListener('click', (ev) => { if (ev.target === helpModal) closeHelp(); });
window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return;
  if (e.key === '?' || (e.shiftKey && e.key === '/')) { e.preventDefault(); openHelp(); }
  if (e.key === 'Escape') { closeHelp(); closeRoomModal(); }
});

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return;
  if (e.key === 'Home') { e.preventDefault(); tweenCamera(1, 0, 0); }
  if (e.key.toLowerCase() === 'f' && !mod.shift && !e.metaKey && !e.ctrlKey && !piano.enabled) {
    e.preventDefault();
    if (!document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => {});
    else document.exitFullscreen?.().catch(() => {});
  }
});

let hoveredNodeId: NodeId | null = null;
window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return;
  if (e.key.toLowerCase() === 'm' && hoveredNodeId && !piano.enabled) {
    toggleMute(hoveredNodeId);
  }
});

function toggleMute(id: NodeId): void {
  const n = nodes.get(id);
  if (!n) return;
  const wasMuted = n.muted;
  execute({
    label: wasMuted ? 'unmute' : 'mute',
    do: () => {
      const cur = nodes.get(id); if (!cur) return;
      const updated = { ...cur, muted: !wasMuted };
      nodes.set(id, updated);
      engine.getNode(id)?.setMuted(!wasMuted);
      if (multiplayer) multiplayer.broadcastNodeAdd(updated);
    },
    undo: () => {
      const cur = nodes.get(id); if (!cur) return;
      const updated = { ...cur, muted: wasMuted };
      nodes.set(id, updated);
      engine.getNode(id)?.setMuted(wasMuted);
      if (multiplayer) multiplayer.broadcastNodeAdd(updated);
    },
  });
}

const keys = new Set<string>();
const listenerVelocity: Vec3 = { x: 0, y: 0, z: 0 };
window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return;
  keys.add(e.key.toLowerCase());
});
window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));

const MAX_SPEED = 360;        // world units / sec
const ACCEL     = 1800;       // world units / sec²
const DAMPING   = 6.5;        // exponential decay rate when no key pressed
const BROADCAST_INTERVAL = 0.08; // throttle peer position updates to ~12 Hz
let broadcastTimer = 0;

function tickMovement(dt: number): void {
  let dx = 0, dz = 0;
  // WASD disabled while piano is on — those keys play notes instead.
  const wasd = !piano.enabled;
  if ((wasd && keys.has('w')) || keys.has('arrowup'))    dz -= 1;
  if ((wasd && keys.has('s')) || keys.has('arrowdown'))  dz += 1;
  if ((wasd && keys.has('a')) || keys.has('arrowleft'))  dx -= 1;
  if ((wasd && keys.has('d')) || keys.has('arrowright')) dx += 1;
  const len = Math.hypot(dx, dz);

  if (len > 0) {
    listenerVelocity.x += (dx / len) * ACCEL * dt;
    listenerVelocity.z += (dz / len) * ACCEL * dt;
  } else {
    const decay = Math.exp(-DAMPING * dt);
    listenerVelocity.x *= decay;
    listenerVelocity.z *= decay;
  }

  const speed = Math.hypot(listenerVelocity.x, listenerVelocity.z);
  if (speed > MAX_SPEED) {
    const k = MAX_SPEED / speed;
    listenerVelocity.x *= k;
    listenerVelocity.z *= k;
  }

  listener.x += listenerVelocity.x * dt;
  listener.z += listenerVelocity.z * dt;

  broadcastTimer += dt;
  if (broadcastTimer >= BROADCAST_INTERVAL && multiplayer && (Math.abs(listenerVelocity.x) + Math.abs(listenerVelocity.z) > 1)) {
    multiplayer.broadcastPosition(listener);
    broadcastTimer = 0;
  }
  if (engine.isRunning) {
    engine.updateListenerPosition({ position: listener, forward, up });
  }
}

const NODE_HIT_RADIUS = 40;

interface DragState {
  id: NodeId;
  startMs: number;
  startPos: Vec3;        // world pos at mousedown
  pointerStart: Vec3;    // pointer world pos at mousedown
  moved: boolean;        // crosses threshold → we're really dragging, not just clicking
}
let drag: DragState | null = null;

function hitTestNode(worldX: number, worldZ: number): NodeId | null {
  // Reverse order so the topmost (most recently added) node wins.
  const arr = Array.from(nodes.entries());
  for (let i = arr.length - 1; i >= 0; i--) {
    const [id, n] = arr[i]!;
    const d = Math.hypot(n.position.x - worldX, n.position.z - worldZ);
    if (d < NODE_HIT_RADIUS) return id;
  }
  return null;
}

canvas.addEventListener('contextmenu', (ev) => {
  ev.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const wp = renderer.screenToWorld(ev.clientX - rect.left, ev.clientY - rect.top, listener);
  // Nodes take priority — right-click on a node deletes the node
  const hit = hitTestNode(wp.x, wp.z);
  if (hit) { removeNode(hit); return; }
  // Portal on top of the click? Delete it.
  for (const p of portals.values()) {
    const dx = wp.x - p.center.x;
    const dz = wp.z - p.center.z;
    if (dx * dx + dz * dz <= p.radius * p.radius) {
      // Delete both members of a local pair for symmetry
      if (p.type === 'local' && p.pairId) {
        portals.delete(p.pairId);
        multiplayer?.broadcastPortalRemove(p.pairId);
      }
      portals.delete(p.id);
      renderer.setPortals(portals);
      multiplayer?.broadcastPortalRemove(p.id);
      flashLegend('portal removed');
      return;
    }
  }
  // Right-click inside a realm deletes the realm
  const realm = findRealmAt(wp);
  if (realm) {
    realms.delete(realm.id);
    renderer.setRealms(realms);
    multiplayer?.broadcastRealmRemove(realm.id);
    flashLegend(`removed ${realm.name}`);
    return;
  }
});

interface PanState { startListenerX: number; startListenerZ: number; startScreenX: number; startScreenY: number }
let pan: PanState | null = null;

canvas.addEventListener('mousedown', async (ev) => {
  if (ev.button !== 0) return; // only left
  if (!engine.isRunning) {
    try { await engine.start(); bridge.start(); }
    catch (err) { console.error('audio start failed', err); return; }
  }

  if (mod.space) {
    pan = {
      startListenerX: listener.x,
      startListenerZ: listener.z,
      startScreenX: ev.clientX,
      startScreenY: ev.clientY,
    };
    canvas.style.cursor = 'grabbing';
    return;
  }

  const rect = canvas.getBoundingClientRect();
  const wp = renderer.screenToWorld(ev.clientX - rect.left, ev.clientY - rect.top, listener);
  const hit = hitTestNode(wp.x, wp.z);
  if (hit) {
    const n = nodes.get(hit)!;
    // Alt+drag clones the node and drags the clone instead.
    let dragId = hit;
    let dragStartPos = { ...n.position };
    if (mod.alt) {
      const cloneId = makeNodeId();
      const clone: SpatialNodeDescriptor = {
        ...n,
        id: cloneId,
        label: `${n.params.type}-${nodes.size + 1}`,
        position: { ...n.position },
      };
      execute({
        label: 'duplicate',
        do:   () => addNodeRaw({ ...clone }),
        undo: () => removeNodeRaw(cloneId),
      });
      dragId = cloneId;
      dragStartPos = { ...clone.position };
    }
    drag = { id: dragId, startMs: performance.now(), startPos: dragStartPos, pointerStart: wp, moved: false };
    // Reset physics velocity so the manual drag isn't fighting inertia.
    nodeVel.set(dragId, { vx: 0, vz: 0 });
    canvas.style.cursor = 'grabbing';
  }
});

window.addEventListener('mousemove', (ev) => {
  if (pan) {
    const dx = (ev.clientX - pan.startScreenX) / renderer.zoom;
    const dy = (ev.clientY - pan.startScreenY) / renderer.zoom;
    listener.x = pan.startListenerX - dx;
    listener.z = pan.startListenerZ - dy;
    return;
  }

  if (!drag) {
    const rect = canvas.getBoundingClientRect();
    if (ev.clientX < rect.left || ev.clientY < rect.top) return;
    const wp = renderer.screenToWorld(ev.clientX - rect.left, ev.clientY - rect.top, listener);
    hoveredNodeId = hitTestNode(wp.x, wp.z);
    canvas.style.cursor = mod.space ? 'grab' : hoveredNodeId ? 'grab' : 'crosshair';
    return;
  }
  const rect = canvas.getBoundingClientRect();
  const wp = renderer.screenToWorld(ev.clientX - rect.left, ev.clientY - rect.top, listener);
  const dx = wp.x - drag.pointerStart.x;
  const dz = wp.z - drag.pointerStart.z;
  if (Math.hypot(dx, dz) > 4) drag.moved = true;
  const newPos: Vec3 = snap({ x: drag.startPos.x + dx, y: 0, z: drag.startPos.z + dz });
  const n = nodes.get(drag.id);
  if (!n) { drag = null; return; }
  nodes.set(drag.id, { ...n, position: newPos });
  engine.getNode(drag.id)?.setPosition(newPos, 30);
});

window.addEventListener('mouseup', async (ev) => {
  if (pan) {
    pan = null;
    canvas.style.cursor = mod.space ? 'grab' : 'crosshair';
    return;
  }
  if (!drag) return;
  const wasDrag = drag.moved;
  const id = drag.id;
  const finalPos = nodes.get(id)?.position;
  const startPos = drag.startPos;
  drag = null;
  canvas.style.cursor = 'crosshair';

  lastMouseUpWasDrag = wasDrag;

  if (wasDrag && finalPos) {
    if (multiplayer) multiplayer.broadcastNodeMove(id, finalPos);
    // Skip do() — the drag already moved the node; we only need undo info.
    const oldP = startPos;
    const newP = { ...finalPos };
    execute({
      label: 'move node',
      do: () => {
        const cur = nodes.get(id); if (!cur) return;
        nodes.set(id, { ...cur, position: newP });
        engine.getNode(id)?.setPosition(newP, 80);
        if (multiplayer) multiplayer.broadcastNodeMove(id, newP);
      },
      undo: () => {
        const cur = nodes.get(id); if (!cur) return;
        nodes.set(id, { ...cur, position: oldP });
        engine.getNode(id)?.setPosition(oldP, 80);
        if (multiplayer) multiplayer.broadcastNodeMove(id, oldP);
      },
    }, /* skipDo */ true);
  }
});

// ── Node volume + sound design popup ─────────────────────────────────────
let activePopupId: NodeId | null = null;
let lastMouseUpWasDrag = false;

const nodePopup   = document.getElementById('node-popup')!;
const npLabelEl   = document.getElementById('np-label')!;
const npVolEl     = document.getElementById('np-vol') as HTMLInputElement;
const npValEl     = document.getElementById('np-val')!;
const npIconEl    = nodePopup.querySelector('.np-icon')!;

function npIcon(pct: number): string {
  if (pct === 0) return '🔇';
  if (pct < 35)  return '🔈';
  if (pct < 70)  return '🔉';
  return '🔊';
}

// Helper: apply a design param to the active node and update local state
function applyDesignParam(patch: Partial<import('@spatial-soundscape/engine').SynthParams>): void {
  if (!activePopupId) return;
  const n = nodes.get(activePopupId);
  if (!n) return;
  nodes.set(activePopupId, { ...n, params: { ...n.params, ...patch } });
  engine.getNode(activePopupId)?.updateParams(patch);
}

// ── Design section DOM refs ───────────────────────────────────────────────
const ALL_SECTIONS = ['ambient','bass','perc','generative','bells','strings','pad','pluck','voice'] as const;
type DesignType = typeof ALL_SECTIONS[number];

function showDesignSection(type: DesignType): void {
  for (const t of ALL_SECTIONS) {
    const el = document.getElementById(`npd-${t}`);
    if (el) el.hidden = t !== type;
  }
}

// Sliders: [elementId, valueDisplayId, param key, parse fn]
type SliderDef = [string, string, string, (v: string) => number | string];

function wireSlider(id: string, valId: string, paramKey: string, parse: (v: string) => number, fmt?: (n: number) => string): void {
  const el = document.getElementById(id) as HTMLInputElement | null;
  const vEl = document.getElementById(valId);
  if (!el || !vEl) return;
  el.addEventListener('input', () => {
    const n = parse(el.value);
    vEl.textContent = fmt ? fmt(n) : String(n);
    applyDesignParam({ [paramKey]: n });
  });
}

function wireSelect(id: string, paramKey: string): void {
  const el = document.getElementById(id) as HTMLSelectElement | null;
  if (!el) return;
  el.addEventListener('change', () => applyDesignParam({ [paramKey]: el.value }));
}

// Wire all sliders once at startup
wireSlider('npa-cutoff',  'npa-cutoff-v',  'filterCutoff',   Number, n => Math.round(n).toString());
wireSlider('npa-lfo',     'npa-lfo-v',     'lfoRate',        Number, n => n.toFixed(2));
wireSlider('npa-spread',  'npa-spread-v',  'detuneSpread',   Number, n => Math.round(n).toString());

wireSlider('npb-cutoff',  'npb-cutoff-v',  'filterCutoff',   Number, n => Math.round(n).toString());
wireSlider('npb-drive',   'npb-drive-v',   'drive',          v => Number(v) / 100, n => Math.round(n * 100).toString());
wireSlider('npb-sub',     'npb-sub-v',     'subMix',         v => Number(v) / 100, n => Math.round(n * 100).toString());

wireSlider('npp-freq',    'npp-freq-v',    'frequency',      Number, n => Math.round(n).toString());
wireSlider('npp-decay',   'npp-decay-v',   'decay',          Number, n => n.toFixed(2));
wireSlider('npp-noise',   'npp-noise-v',   'noiseMix',       v => Number(v) / 100, n => Math.round(n * 100).toString());

wireSlider('npg-speed',   'npg-speed-v',   'arpSpeed',       Number, n => n.toFixed(1));
wireSelect('npg-pattern', 'arpPattern');

wireSlider('npk-ratio',   'npk-ratio-v',   'fmRatio',        Number, n => n.toFixed(1));
wireSlider('npk-depth',   'npk-depth-v',   'fmDepth',        Number, n => Math.round(n).toString());
wireSlider('npk-decay',   'npk-decay-v',   'decay',          Number, n => n.toFixed(1));

wireSlider('nps-spread',  'nps-spread-v',  'detuneSpread',   Number, n => Math.round(n).toString());
wireSlider('nps-attack',  'nps-attack-v',  'attack',         Number, n => n.toFixed(2));
wireSlider('nps-cutoff',  'nps-cutoff-v',  'filterCutoff',   Number, n => Math.round(n).toString());

wireSlider('npd-cutoff',  'npd-cutoff-v',  'filterCutoff',   Number, n => Math.round(n).toString());
wireSlider('npd-sweep',   'npd-sweep-v',   'lfoRate',        Number, n => n.toFixed(2));
wireSelect('npd-chord',   'chordVoicing');

wireSlider('nppl-decay',  'nppl-decay-v',  'decay',          Number, n => n.toFixed(2));
wireSlider('nppl-harm',   'nppl-harm-v',   'harmonicMix',    v => Number(v) / 100, n => Math.round(n * 100).toString());
wireSlider('nppl-cutoff', 'nppl-cutoff-v', 'filterCutoff',   Number, n => Math.round(n).toString());

wireSlider('npv-gate',    'npv-gate-v',    'gateThreshold',  Number, n => Math.round(n).toString());

// ── Populate design section with node's current params ───────────────────
function populateDesign(type: string, p: Record<string, unknown>): void {
  function set(id: string, valId: string, value: number, fmt?: (n: number) => string): void {
    const el = document.getElementById(id) as HTMLInputElement | null;
    const vEl = document.getElementById(valId);
    if (!el || !vEl) return;
    el.value = String(value);
    vEl.textContent = fmt ? fmt(value) : String(value);
  }

  if (type === 'ambient') {
    set('npa-cutoff', 'npa-cutoff-v', (p['filterCutoff'] as number) ?? 800, n => Math.round(n).toString());
    set('npa-lfo',    'npa-lfo-v',    (p['lfoRate'] as number) ?? 0.15, n => n.toFixed(2));
    set('npa-spread', 'npa-spread-v', (p['detuneSpread'] as number) ?? 8, n => Math.round(n).toString());
  } else if (type === 'bass') {
    set('npb-cutoff', 'npb-cutoff-v', (p['filterCutoff'] as number) ?? 300, n => Math.round(n).toString());
    set('npb-drive',  'npb-drive-v',  Math.round(((p['drive'] as number) ?? 0.5) * 100), n => Math.round(n).toString());
    set('npb-sub',    'npb-sub-v',    Math.round(((p['subMix'] as number) ?? 0) * 100), n => Math.round(n).toString());
  } else if (type === 'percussion') {
    set('npp-freq',  'npp-freq-v',  (p['frequency'] as number) ?? 1000, n => Math.round(n).toString());
    set('npp-decay', 'npp-decay-v', (p['decay'] as number) ?? 0.2, n => n.toFixed(2));
    set('npp-noise', 'npp-noise-v', Math.round(((p['noiseMix'] as number) ?? 1) * 100), n => Math.round(n).toString());
  } else if (type === 'generative') {
    set('npg-speed', 'npg-speed-v', (p['arpSpeed'] as number) ?? 1, n => n.toFixed(1));
    const patEl = document.getElementById('npg-pattern') as HTMLSelectElement | null;
    if (patEl) patEl.value = (p['arpPattern'] as string) ?? 'pentatonic';
  } else if (type === 'bells') {
    set('npk-ratio', 'npk-ratio-v', (p['fmRatio'] as number) ?? 3.5, n => n.toFixed(1));
    set('npk-depth', 'npk-depth-v', (p['fmDepth'] as number) ?? 0, n => Math.round(n).toString());
    set('npk-decay', 'npk-decay-v', (p['decay'] as number) ?? 3.5, n => n.toFixed(1));
  } else if (type === 'strings') {
    set('nps-spread', 'nps-spread-v', (p['detuneSpread'] as number) ?? 14, n => Math.round(n).toString());
    set('nps-attack', 'nps-attack-v', (p['attack'] as number) ?? 1.2, n => n.toFixed(2));
    set('nps-cutoff', 'nps-cutoff-v', (p['filterCutoff'] as number) ?? 1800, n => Math.round(n).toString());
  } else if (type === 'pad') {
    set('npd-cutoff', 'npd-cutoff-v', (p['filterCutoff'] as number) ?? 700, n => Math.round(n).toString());
    set('npd-sweep',  'npd-sweep-v',  (p['lfoRate'] as number) ?? 0.07, n => n.toFixed(2));
    const chordEl = document.getElementById('npd-chord') as HTMLSelectElement | null;
    if (chordEl) chordEl.value = (p['chordVoicing'] as string) ?? 'maj';
  } else if (type === 'pluck') {
    set('nppl-decay',  'nppl-decay-v',  (p['decay'] as number) ?? 0.45, n => n.toFixed(2));
    set('nppl-harm',   'nppl-harm-v',   Math.round(((p['harmonicMix'] as number) ?? 0.3) * 100), n => Math.round(n).toString());
    set('nppl-cutoff', 'nppl-cutoff-v', (p['filterCutoff'] as number) ?? 0, n => n > 0 ? Math.round(n).toString() : '—');
    if ((p['filterCutoff'] as number) > 0) {
      const el = document.getElementById('nppl-cutoff') as HTMLInputElement | null;
      if (el) el.value = String(p['filterCutoff']);
    }
  } else if (type === 'voice') {
    set('npv-gate', 'npv-gate-v', (p['gateThreshold'] as number) ?? -40, n => Math.round(n).toString());
  }
}

// Map SynthType → section id suffix
const TYPE_TO_SECTION: Record<string, DesignType> = {
  ambient:    'ambient',
  bass:       'bass',
  percussion: 'perc',
  generative: 'generative',
  bells:      'bells',
  strings:    'strings',
  pad:        'pad',
  pluck:      'pluck',
  voice:      'voice',
};

function openNodePopup(id: NodeId, sx: number, sy: number): void {
  const n = nodes.get(id);
  if (!n) return;
  activePopupId = id;
  npLabelEl.textContent = n.label ?? n.params.type.toUpperCase();
  const pct = Math.round(n.params.gain * 100);
  npVolEl.value = String(pct);
  npValEl.textContent = `${pct}%`;
  npIconEl.textContent = npIcon(pct);

  // Show and populate type-specific section
  const section = TYPE_TO_SECTION[n.params.type];
  if (section) {
    showDesignSection(section);
    populateDesign(n.params.type, n.params as unknown as Record<string, unknown>);
    (document.getElementById('np-design') as HTMLElement).hidden = false;
  } else {
    (document.getElementById('np-design') as HTMLElement).hidden = true;
  }

  const PW = 260;
  let x = sx + 14;
  if (x + PW > window.innerWidth - 16) x = sx - PW - 14;
  nodePopup.style.left = `${x}px`;
  nodePopup.style.top  = `${Math.max(8, sy - 30)}px`;
  nodePopup.classList.add('open');
}

function closeNodePopup(): void {
  activePopupId = null;
  nodePopup.classList.remove('open');
}

npVolEl.addEventListener('input', () => {
  if (!activePopupId) return;
  const gain = parseInt(npVolEl.value) / 100;
  npValEl.textContent = `${npVolEl.value}%`;
  npIconEl.textContent = npIcon(parseInt(npVolEl.value));
  const n = nodes.get(activePopupId);
  if (n) nodes.set(activePopupId, { ...n, params: { ...n.params, gain } });
  engine.getNode(activePopupId)?.updateParams({ gain });
});

const npSetDefaultBtn = document.getElementById('np-set-default')!;
npSetDefaultBtn.addEventListener('click', () => {
  if (!activePopupId) return;
  const n = nodes.get(activePopupId);
  if (!n) return;
  saveDesignDefault(n.params.type, n.params);
  npSetDefaultBtn.textContent = 'SAVED';
  npSetDefaultBtn.classList.add('saved');
  setTimeout(() => {
    npSetDefaultBtn.textContent = 'SET AS DEFAULT';
    npSetDefaultBtn.classList.remove('saved');
  }, 1800);
});

nodePopup.addEventListener('click', (ev) => ev.stopPropagation());
document.addEventListener('click', () => closeNodePopup());

canvas.addEventListener('click', async (ev) => {
  if (!engine.isRunning) {
    try { await engine.start(); bridge.start(); }
    catch { return; }
  }
  const rect = canvas.getBoundingClientRect();
  const wp = renderer.screenToWorld(ev.clientX - rect.left, ev.clientY - rect.top, listener);

  // Portal placement short-circuits everything.
  if (portalDraft) {
    placePortalAt(wp);
    flashClick(ev.clientX, ev.clientY);
    return;
  }
  // Realm placement short-circuits everything (node hit, drop, popup).
  if (realmPlacementDraft) {
    createRealmFromDraft(realmPlacementDraft, wp);
    armRealmPlacement(null);
    flashClick(ev.clientX, ev.clientY);
    return;
  }

  // Click on a realm's label ribbon (the text banner at the top of the
  // circle) or shift-click anywhere inside the realm → open its editor.
  const labelHit = findRealmLabelAt(ev.clientX - rect.left, ev.clientY - rect.top);
  if (labelHit) { openRealmEditor(labelHit); return; }
  if (ev.shiftKey) {
    const r = findRealmAt(wp);
    if (r) { openRealmEditor(r); return; }
  }

  const hit = hitTestNode(wp.x, wp.z);
  if (hit) {
    ev.stopPropagation();
    if (linkMode) {
      if (!linkSource) {
        linkSource = hit;
        flashLegend(`link source: ${nodes.get(hit)?.label} — now click target`);
      } else if (linkSource !== hit) {
        const iv = LINK_INTERVALS[linkIntervalIdx]!;
        links.set(linkSource, { target: hit, interval: iv.semitones });
        flashLegend(`linked ${nodes.get(linkSource)?.label} → ${nodes.get(hit)?.label} (${iv.name})`);
        linkSource = null;
      }
      return;
    }
    if (!lastMouseUpWasDrag) openNodePopup(hit, ev.clientX, ev.clientY);
    return;
  }
  if (linkMode) { linkSource = null; return; }
  closeNodePopup();
  flashClick(ev.clientX, ev.clientY);
  dropNode(activeSynthType, wp);
});


interface TouchState {
  identifier: number;
  startMs: number;
  startClientX: number;
  startClientY: number;
  longPressTimer: ReturnType<typeof setTimeout> | null;
  isDragging: boolean;
  hitNodeId: NodeId | null;
}
let touch: TouchState | null = null;

interface PinchState {
  startDist: number;
  startZoom: number;
  anchorScreenX: number;
  anchorScreenY: number;
}
let pinch: PinchState | null = null;

function touchDist(a: Touch, b: Touch): number {
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}

canvas.addEventListener('touchstart', async (ev) => {
  ev.preventDefault();

  if (ev.touches.length === 2) {
    const a = ev.touches[0]!, b = ev.touches[1]!;
    pinch = {
      startDist: touchDist(a, b),
      startZoom: renderer.zoom,
      anchorScreenX: (a.clientX + b.clientX) / 2,
      anchorScreenY: (a.clientY + b.clientY) / 2,
    };
    if (touch?.longPressTimer) clearTimeout(touch.longPressTimer);
    drag = null;
    touch = null;
    return;
  }

  if (touch) return;
  const t = ev.changedTouches[0];
  if (!t) return;

  if (!engine.isRunning) {
    try { await engine.start(); bridge.start(); }
    catch { return; }
  }

  const rect = canvas.getBoundingClientRect();
  const wp = renderer.screenToWorld(t.clientX - rect.left, t.clientY - rect.top, listener);
  const hit = hitTestNode(wp.x, wp.z);

  touch = {
    identifier: t.identifier,
    startMs: performance.now(),
    startClientX: t.clientX,
    startClientY: t.clientY,
    longPressTimer: null,
    isDragging: false,
    hitNodeId: hit,
  };

  if (hit) {
    const n = nodes.get(hit)!;
    drag = { id: hit, startMs: performance.now(), startPos: { ...n.position }, pointerStart: wp, moved: false };
    // Long-press = mobile equivalent of right-click delete.
    touch.longPressTimer = setTimeout(() => {
      if (touch && !touch.isDragging && touch.hitNodeId) {
        if ('vibrate' in navigator) navigator.vibrate(50);
        removeNode(touch.hitNodeId);
        drag = null;
        touch = null;
      }
    }, 500);
  }
}, { passive: false });

canvas.addEventListener('touchmove', (ev) => {
  ev.preventDefault();

  if (pinch && ev.touches.length === 2) {
    const a = ev.touches[0]!, b = ev.touches[1]!;
    const dist = touchDist(a, b);
    const targetZoom = pinch.startZoom * (dist / pinch.startDist);
    const rect = canvas.getBoundingClientRect();
    const sx = pinch.anchorScreenX - rect.left;
    const sy = pinch.anchorScreenY - rect.top;
    const worldBefore = renderer.screenToWorld(sx, sy, listener);
    renderer.setZoom(targetZoom);
    const worldAfter  = renderer.screenToWorld(sx, sy, listener);
    listener.x += worldBefore.x - worldAfter.x;
    listener.z += worldBefore.z - worldAfter.z;
    updateZoomIndicator();
    return;
  }

  if (!touch) return;
  const t = Array.from(ev.changedTouches).find(c => c.identifier === touch!.identifier);
  if (!t) return;

  const dx = t.clientX - touch.startClientX;
  const dy = t.clientY - touch.startClientY;
  if (Math.hypot(dx, dy) > 6) {
    touch.isDragging = true;
    if (touch.longPressTimer) { clearTimeout(touch.longPressTimer); touch.longPressTimer = null; }
  }

  if (drag) {
    const rect = canvas.getBoundingClientRect();
    const wp = renderer.screenToWorld(t.clientX - rect.left, t.clientY - rect.top, listener);
    const ddx = wp.x - drag.pointerStart.x;
    const ddz = wp.z - drag.pointerStart.z;
    if (Math.hypot(ddx, ddz) > 4) drag.moved = true;
    const newPos: Vec3 = { x: drag.startPos.x + ddx, y: 0, z: drag.startPos.z + ddz };
    const n = nodes.get(drag.id);
    if (!n) { drag = null; return; }
    nodes.set(drag.id, { ...n, position: newPos });
    engine.getNode(drag.id)?.setPosition(newPos, 30);
  }
}, { passive: false });

canvas.addEventListener('touchend', (ev) => {
  ev.preventDefault();

  if (pinch && ev.touches.length < 2) {
    pinch = null;
    return;
  }

  if (!touch) return;
  const t = Array.from(ev.changedTouches).find(c => c.identifier === touch!.identifier);
  if (!t) return;

  if (touch.longPressTimer) { clearTimeout(touch.longPressTimer); touch.longPressTimer = null; }

  const wasDrag = drag?.moved ?? false;
  const id = drag?.id;
  const finalPos = id ? nodes.get(id)?.position : null;

  if (!touch.hitNodeId && !touch.isDragging) {
    const rect = canvas.getBoundingClientRect();
    const wp = renderer.screenToWorld(t.clientX - rect.left, t.clientY - rect.top, listener);
    flashClick(t.clientX, t.clientY);
    if (realmPlacementDraft) {
      createRealmFromDraft(realmPlacementDraft, wp);
      armRealmPlacement(null);
    } else {
      dropNode(activeSynthType, wp);
    }
  } else if (wasDrag && id && finalPos && multiplayer) {
    multiplayer.broadcastNodeMove(id, finalPos);
  }

  drag = null;
  touch = null;
}, { passive: false });

canvas.addEventListener('touchcancel', () => {
  if (touch?.longPressTimer) clearTimeout(touch.longPressTimer);
  drag = null;
  touch = null;
  pinch = null;
});

/** Brief ring flash at the cursor so every click is visually confirmed. */
function flashClick(x: number, y: number): void {
  const dot = document.createElement('div');
  dot.style.cssText = `
    position: fixed; left: ${x}px; top: ${y}px;
    width: 8px; height: 8px; margin: -4px 0 0 -4px;
    border-radius: 50%;
    background: var(--neon-cyan);
    box-shadow: 0 0 24px var(--neon-cyan);
    pointer-events: none; z-index: 50;
    animation: clickFlash 500ms ease-out forwards;
  `;
  document.body.appendChild(dot);
  setTimeout(() => dot.remove(), 600);
}

function removeNode(id: NodeId, recordUndo = true): void {
  const descriptor = nodes.get(id);
  if (!descriptor) return;
  if (recordUndo) {
    execute({
      label: 'delete node',
      do:   () => removeNodeRaw(id),
      undo: () => addNodeRaw({ ...descriptor }),
    });
  } else {
    removeNodeRaw(id);
  }
}

function removeNodeRaw(id: NodeId): void {
  engine.removeNode(id);
  nodes.delete(id);
  trails.delete(id);
  links.delete(id);
  nodeVel.delete(id);
  nodePhase.delete(id);
  renderer.cleanupNode(id);
  for (const [srcId, lnk] of links) { if (lnk.target === id) links.delete(srcId); }
  if (multiplayer) multiplayer.broadcastNodeRemove(id);
  updateLegend();
}

function addNodeRaw(descriptor: SpatialNodeDescriptor): void {
  nodes.set(descriptor.id, descriptor);
  engine.addNode(descriptor);
  trails.set(descriptor.id, [descriptor.position]);
  if (multiplayer) multiplayer.broadcastNodeAdd(descriptor);
  updateLegend();
}

function dropNode(type: SynthType, position: Vec3): NodeId {
  const id = makeNodeId();
  const color = CYBERPUNK_PALETTE[nodes.size % CYBERPUNK_PALETTE.length] ?? '#00f5d4';

  const baseParams = defaultParamsFor(type);
  let params: SynthParams = ['percussion', 'pluck', 'generative'].includes(type)
    ? { ...baseParams, tempo: globalBpm }
    : baseParams;

  // Composed-melody drop: overlay a user-authored melody onto a generative voice.
  let label = `${type}-${nodes.size + 1}`;
  if (pendingComposedMelody && type === 'generative') {
    const m = pendingComposedMelody;
    params = {
      ...params,
      frequency: m.freq,
      wave: m.wave,
      arpSpeed: m.arpSpeed,
      melodyScale: m.melodyScale,
    };
    label = m.label;
    // Melody is consumed on drop — next generative drop is a fresh arp again
    pendingComposedMelody = null;
  }

  // Realm inheritance: if this drop falls inside a Realm, shift the node's
  // frequency to the realm's key (at the type's natural octave) and set its
  // tempo to the realm's BPM. Manual per-node overrides (via sound-design
  // panel) still win because they mutate the node after drop.
  const realm = findRealmAt(position);
  let realmId: RealmId | undefined = undefined;
  if (realm) {
    realmId = realm.id;
    if (['percussion', 'pluck', 'generative'].includes(type)) {
      params = { ...params, tempo: realm.bpm };
    }
    if (type !== 'percussion' && type !== 'voice') {
      params = { ...params, frequency: shiftToKey(params.frequency, realm.key) };
    }
    // Composed melodies additionally have an arpSpeed that must sync to
    // the realm's BPM (otherwise a 100 BPM composed tune would keep playing
    // at 100 even inside a 140 BPM realm). Formula: 16ths @ bpm ↔ bpm/50.
    if (type === 'generative' && params.melodyScale) {
      params = { ...params, arpSpeed: realm.bpm / 50 };
    }
    label = `${label} · ${realm.name}`;
    flashLegend(`inherited ${realm.key} · ${realm.bpm} BPM from ${realm.name}`);
  }

  const descriptor: SpatialNodeDescriptor = {
    id,
    position: snap(position),
    params,
    label,
    color,
    innerRadius: 120,
    outerRadius: 800,
    muted: false,
    ...(realmId ? { realmId } : {}),
  };
  execute({
    label: `drop ${type}`,
    do:   () => addNodeRaw({ ...descriptor }),
    undo: () => removeNodeRaw(descriptor.id),
  });
  return id;
}

// Design params that can be saved as per-type defaults
const DESIGN_KEYS: (keyof SynthParams)[] = [
  'filterCutoff', 'lfoRate', 'detuneSpread', 'drive', 'subMix',
  'noiseMix', 'arpSpeed', 'arpPattern', 'fmRatio', 'fmDepth',
  'harmonicMix', 'chordVoicing', 'gateThreshold', 'decay', 'attack',
];

function loadDesignDefaults(type: SynthType): Partial<SynthParams> {
  try {
    const raw = localStorage.getItem(`ss:design:${type}`);
    return raw ? (JSON.parse(raw) as Partial<SynthParams>) : {};
  } catch { return {}; }
}

function saveDesignDefault(type: SynthType, params: SynthParams): void {
  const patch: Partial<SynthParams> = {};
  for (const k of DESIGN_KEYS) {
    if (params[k] !== undefined) (patch as Record<string, unknown>)[k] = params[k];
  }
  localStorage.setItem(`ss:design:${type}`, JSON.stringify(patch));
}

function defaultParamsFor(type: SynthType): SynthParams {
  const base: Omit<SynthParams, 'type'> = {
    wave: 'sine',
    frequency: 220,
    gain: 0.35,
    attack: 0.05,
    decay: 0.2,
    sustain: 0.5,
    release: 0.4,
    reverbWet: 0.4,
    chorusDepth: 0.2,
  };
  const hardcoded = ((): SynthParams => { switch (type) {
    case 'ambient':    return { ...base, type, wave: 'sawtooth', frequency: 196, gain: 0.18 };
    case 'bass':       return { ...base, type, frequency: 55,  gain: 0.42 };
    case 'percussion': return { ...base, type, frequency: 880, gain: 0.25, attack: 0.001, release: 0.05 };
    case 'generative': return { ...base, type, wave: 'triangle', frequency: 261.63, gain: 0.22 };
    case 'voice':      return { ...base, type, frequency: 440, gain: 0.85, reverbWet: 0.25 };
    case 'bells':      return { ...base, type, wave: 'sine', frequency: 440, gain: 0.35, reverbWet: 0.65 };
    case 'strings':    return { ...base, type, wave: 'sawtooth', frequency: 196, gain: 0.22, reverbWet: 0.45 };
    case 'pad':        return { ...base, type, wave: 'sine', frequency: 130.81, gain: 0.20, reverbWet: 0.55 };
    case 'pluck':      return { ...base, type, wave: 'triangle', frequency: 261.63, gain: 0.42, reverbWet: 0.30 };
    case 'piano':      return { ...base, type, wave: 'sine', frequency: 261.63, gain: 0.55, reverbWet: 0.35, attack: 0.003, decay: 2.8, sustain: 0, release: 0.05 };
  }})();
  return { ...hardcoded, ...loadDesignDefaults(type) };
}

// When set, the next canvas drop spawns a generative node with THIS melody.
// The composer modal populates this before closing so the drop feels "primed."
let pendingComposedMelody: {
  freq: number;
  wave: OscillatorType;
  arpSpeed: number;
  melodyScale: (number | null)[];
  label: string;
} | null = null;

document.querySelectorAll<HTMLButtonElement>('.node-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const t = btn.dataset['type']!;
    if (t === 'melody') {
      // Open composer instead of setting active type. Composer's DROP will
      // handle placement; user keeps their previous active type otherwise.
      openMelodyComposer();
      return;
    }
    pendingComposedMelody = null;
    activeSynthType = t as SynthType;
    document.querySelectorAll('.node-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  });
});
document.querySelector<HTMLButtonElement>('.node-btn[data-type="ambient"]')!.classList.add('active');

// ── Echo Ghosts ────────────────────────────────────────────────────────
// Records the local listener position over the last GHOST_WINDOW seconds.
// Rendered as a fading trail; audio ghost is a wet-only long-delay bus in
// the engine that echoes back what you played N seconds ago.
const GHOST_WINDOW_MS = 30_000;
const GHOST_SAMPLE_MS = 200;             // record ~5 points/sec
let ghostsOn = false;
let ghostLastSampleT = 0;
const ghostPath: { x: number; z: number; t: number }[] = [];

function tickGhosts(nowMs: number): void {
  if (!ghostsOn) { renderer.setGhostPoints([]); return; }
  if (nowMs - ghostLastSampleT > GHOST_SAMPLE_MS) {
    ghostPath.push({ x: listener.x, z: listener.z, t: nowMs });
    ghostLastSampleT = nowMs;
  }
  // Drop expired points
  while (ghostPath.length > 0 && nowMs - ghostPath[0]!.t > GHOST_WINDOW_MS) {
    ghostPath.shift();
  }
  // Map to renderer points with age-based alpha
  const pts = ghostPath.map(p => {
    const age = nowMs - p.t;
    const alpha = Math.max(0, 1 - age / GHOST_WINDOW_MS);
    return { x: p.x, z: p.z, alpha };
  });
  renderer.setGhostPoints(pts);
}

document.getElementById('btn-ghosts')!.addEventListener('click', () => {
  ghostsOn = !ghostsOn;
  document.getElementById('btn-ghosts')!.classList.toggle('active', ghostsOn);
  engine.setGhostsEnabled(ghostsOn);
  if (!ghostsOn) ghostPath.length = 0;
  flashLegend(ghostsOn ? 'echo ghosts ON · your last 30s replays' : 'echo ghosts OFF');
});

// ── Global acoustic environment ────────────────────────────────────────
// One environment is active per room. Selected via the sidebar strip.
// Synced through yjs so all peers hear the same acoustic space.
let currentEnv: EnvironmentType = 'none';

function applyEnvironment(env: EnvironmentType, broadcast: boolean): void {
  currentEnv = env;
  engine.setEnvironment(env);
  document.querySelectorAll<HTMLButtonElement>('.env-btn').forEach(b => {
    b.classList.toggle('active', b.dataset['env'] === env);
  });
  if (broadcast && multiplayer) multiplayer.broadcastEnvironment(env);
  flashLegend(env === 'none' ? 'environment: none' : `environment: ${env.toUpperCase()}`);
}

document.querySelectorAll<HTMLButtonElement>('.env-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    applyEnvironment(btn.dataset['env'] as EnvironmentType, true);
  });
});

// ── Portals ────────────────────────────────────────────────────────────
// Click the sidebar NEW PORTAL button → modal opens (kind + destination +
// color). Confirm arms placement — next canvas click plants a portal there.
// For LOCAL kind, a second click plants the twin. Right-click a portal to
// delete it (removes both halves of a local pair).

interface LocalPortalPlacement { pairId: PortalId; firstPos: Vec3 | null; color: string }
type PortalDraft =
  | { kind: 'local'; state: LocalPortalPlacement }
  | { kind: 'room'; destRoom: string; color: string }
  | null;

let portalDraft: PortalDraft = null;
const PORTAL_RADIUS = 60;
const PORTAL_COOLDOWN_MS = 1200;      // prevent instant re-teleport
let lastTeleportAt = 0;

const portalModal      = document.getElementById('portal-modal')!;
const portalBtn        = document.getElementById('btn-portal') as HTMLButtonElement;
const portalKindSel    = document.getElementById('portal-kind') as HTMLSelectElement;
const portalRoomInput  = document.getElementById('portal-room-name') as HTMLInputElement;
const portalRoomRow    = document.getElementById('portal-room-row')!;
const portalColorPills = document.getElementById('portal-color-pills')!;

function setPortalColor(color: string): void {
  portalColorPills.querySelectorAll('.realm-color-pill').forEach(el => {
    el.classList.toggle('selected', (el as HTMLElement).dataset['color'] === color);
  });
}
function currentPortalColor(): string {
  return portalColorPills.querySelector<HTMLElement>('.realm-color-pill.selected')?.dataset['color']
    ?? '#4cc9f0';
}
portalColorPills.querySelectorAll('.realm-color-pill').forEach(el => {
  el.addEventListener('click', (ev) => {
    ev.preventDefault();
    setPortalColor((el as HTMLElement).dataset['color']!);
  });
});
setPortalColor('#4cc9f0');   // default

// Toggle destination-room field visibility when the kind changes
portalKindSel.addEventListener('change', () => {
  portalRoomRow.toggleAttribute('hidden', portalKindSel.value !== 'room');
});

function openPortalEditor(): void {
  // Reset defaults for a fresh new portal
  portalKindSel.value = 'local';
  portalRoomRow.setAttribute('hidden', '');
  portalRoomInput.value = '';
  setPortalColor('#4cc9f0');
  portalModal.removeAttribute('hidden');
}
function closePortalEditor(): void { portalModal.setAttribute('hidden', ''); }

portalBtn.addEventListener('click', () => {
  // Second click cancels an in-progress placement
  if (portalDraft) { endPortalPlacement(); return; }
  openPortalEditor();
});
document.getElementById('portal-cancel-modal')!.addEventListener('click', closePortalEditor);
portalModal.addEventListener('click', (ev) => { if (ev.target === portalModal) closePortalEditor(); });

document.getElementById('portal-confirm')!.addEventListener('click', () => {
  const color = currentPortalColor();
  if (portalKindSel.value === 'room') {
    const name = portalRoomInput.value.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(name)) {
      portalRoomInput.style.borderColor = 'var(--neon-magenta)';
      setTimeout(() => { portalRoomInput.style.borderColor = ''; }, 800);
      return;
    }
    portalDraft = { kind: 'room', destRoom: name, color };
    flashLegend(`click canvas to place ROOM portal → ${name}`);
  } else {
    portalDraft = { kind: 'local', state: { pairId: makePortalId(), firstPos: null, color } };
    flashLegend('click canvas to place FIRST local portal · then click again for the twin');
  }
  document.body.classList.add('portal-placing');
  portalBtn.classList.add('armed');
  closePortalEditor();
});

function placePortalAt(world: Vec3): void {
  if (!portalDraft) return;

  if (portalDraft.kind === 'local') {
    const state = portalDraft.state;
    if (!state.firstPos) {
      // First half of a local pair placed — wait for the twin
      state.firstPos = { ...world };
      flashLegend('first portal placed · click again for the twin');
      return;
    }
    // Second half — create both portals, linked by pairId
    const idA = makePortalId();
    const idB = state.pairId;
    const a: Portal = {
      id: idA, type: 'local', center: state.firstPos, radius: PORTAL_RADIUS,
      color: state.color, pairId: idB, label: 'A → B',
    };
    const b: Portal = {
      id: idB, type: 'local', center: { ...world }, radius: PORTAL_RADIUS,
      color: state.color, pairId: idA, label: 'B → A',
    };
    portals.set(a.id, a); portals.set(b.id, b);
    renderer.setPortals(portals);
    multiplayer?.broadcastPortalAdd(a);
    multiplayer?.broadcastPortalAdd(b);
    endPortalPlacement();
    flashLegend('local portal pair placed');
  } else {
    // Room portal — single placement
    const p: Portal = {
      id: makePortalId(), type: 'room', center: { ...world }, radius: PORTAL_RADIUS,
      color: portalDraft.color, destRoom: portalDraft.destRoom, label: portalDraft.destRoom.toUpperCase(),
    };
    portals.set(p.id, p);
    renderer.setPortals(portals);
    multiplayer?.broadcastPortalAdd(p);
    endPortalPlacement();
    flashLegend(`room portal → ${portalDraft.destRoom}`);
  }
}

function endPortalPlacement(): void {
  portalDraft = null;
  document.body.classList.remove('portal-placing');
  portalBtn.classList.remove('armed');
}

/** Walking-into-portal check. Runs every frame after tickMovement. */
function tickPortals(): void {
  if (portals.size === 0) return;
  const now = performance.now();
  if (now - lastTeleportAt < PORTAL_COOLDOWN_MS) return;
  for (const p of portals.values()) {
    const dx = listener.x - p.center.x;
    const dz = listener.z - p.center.z;
    if (dx * dx + dz * dz > p.radius * p.radius) continue;
    // Listener is inside a portal
    if (p.type === 'local' && p.pairId) {
      const twin = portals.get(p.pairId);
      if (!twin) continue;
      // Teleport to twin's position — offset slightly outside so we don't
      // immediately re-enter and bounce back.
      const offset = twin.radius + 20;
      const angle = Math.atan2(listener.z - p.center.z, listener.x - p.center.x);
      listener.x = twin.center.x + Math.cos(angle) * offset;
      listener.z = twin.center.z + Math.sin(angle) * offset;
      lastTeleportAt = now;
      flashWarp();
      return;
    }
    if (p.type === 'room' && p.destRoom) {
      lastTeleportAt = now;
      flashWarp();
      switchRoom(p.destRoom);
      return;
    }
  }
}

function flashWarp(): void {
  const overlay = document.getElementById('warp-overlay')!;
  overlay.classList.add('active');
  setTimeout(() => overlay.classList.remove('active'), 500);
}

async function switchRoom(name: string): Promise<void> {
  // Reuse the same teardown as the room switcher
  for (const id of [...nodes.keys()]) {
    engine.removeNode(id);
    nodes.delete(id);
    trails.delete(id);
  }
  realms.clear();   renderer.setRealms(realms);
  portals.clear();  renderer.setPortals(portals);
  peers.clear();
  currentRoom = name;
  const roomNameEl2 = document.getElementById('room-name');
  if (roomNameEl2) roomNameEl2.textContent = name;
  // Same as manual room switch — tear down the old connection so peer
  // awareness (wanderer count) doesn't accumulate on repeat teleports.
  multiplayer?.disconnect();
  try {
    multiplayer = new Multiplayer(engine, { nodes, realms, portals, peers, peerChats });
    multiplayer.onRealmChange = () => renderer.setRealms(realms);
    multiplayer.onPortalChange = () => renderer.setPortals(portals);
    multiplayer.onEnvironmentChange = (env) => applyEnvironment(env, false);
    await multiplayer.connect(name);
  } catch (err) {
    console.warn('portal room switch failed:', err);
  }
}

// ── Realm placement & editing ──────────────────────────────────────────
// Click NEW REALM → editor modal opens. Configure name/type/key/BPM/color,
// hit PLACE → next canvas click plants the realm there. Shift-click an
// existing realm to reopen the editor pre-filled (save or delete from there).

const REALM_DEFAULTS: Record<RealmType, { color: string; key: string; bpm: number; namePrefix: string }> = {
  bass:       { color: '#ff4d40', key: 'C',  bpm: 100, namePrefix: 'BASS' },      // deep red-orange
  melodic:    { color: '#00f5d4', key: 'C',  bpm: 100, namePrefix: 'MELODIC' },   // cyan
  percussive: { color: '#ffd60a', key: 'C',  bpm: 120, namePrefix: 'PERC' },      // amber
  chaos:      { color: '#9b5de5', key: 'C',  bpm: 140, namePrefix: 'CHAOS' },     // purple
  // 'custom' is kept in the type union for backward compat with existing yjs
  // docs, but no longer surfaced in the UI — every realm can already be
  // freely customized regardless of type.
  custom:     { color: '#4cc9f0', key: 'C',  bpm: 100, namePrefix: 'REALM' },
};

interface RealmDraft {
  name: string;
  type: RealmType;
  key: string;
  bpm: number;
  color: string;
  radius: number;
}

// When set, the next canvas click plants this pending draft as a new realm.
let realmPlacementDraft: RealmDraft | null = null;
// When set, the editor is editing this existing realm (save vs place).
let editingRealmId: RealmId | null = null;

const realmBtn         = document.getElementById('btn-realm') as HTMLButtonElement;
const realmModal       = document.getElementById('realm-modal')!;
const realmNameInput   = document.getElementById('realm-name') as HTMLInputElement;
const realmEditorType  = document.getElementById('realm-editor-type') as HTMLSelectElement;
const realmKeySel      = document.getElementById('realm-key') as HTMLSelectElement;
const realmBpmSlider   = document.getElementById('realm-bpm') as HTMLInputElement;
const realmBpmVal      = document.getElementById('realm-bpm-val')!;
const realmRadiusSlider = document.getElementById('realm-radius') as HTMLInputElement;
const realmRadiusVal    = document.getElementById('realm-radius-val')!;
const realmColorPills  = document.getElementById('realm-color-pills')!;
const realmDeleteBtn   = document.getElementById('realm-delete') as HTMLButtonElement;
const realmCancelBtn   = document.getElementById('realm-cancel')!;
const realmConfirmBtn  = document.getElementById('realm-confirm')!;
const realmModalTitle  = document.getElementById('realm-modal-title')!;

function setRealmColor(color: string): void {
  realmColorPills.querySelectorAll('.realm-color-pill').forEach(el => {
    el.classList.toggle('selected', (el as HTMLElement).dataset['color'] === color);
  });
}
function currentRealmColor(): string {
  return realmColorPills.querySelector<HTMLElement>('.realm-color-pill.selected')?.dataset['color']
    ?? '#00f5d4';
}
realmColorPills.querySelectorAll('.realm-color-pill').forEach(el => {
  el.addEventListener('click', (ev) => {
    ev.preventDefault();
    setRealmColor((el as HTMLElement).dataset['color']!);
  });
});
realmBpmSlider.addEventListener('input', () => { realmBpmVal.textContent = realmBpmSlider.value; });
realmRadiusSlider.addEventListener('input', () => {
  realmRadiusVal.textContent = realmRadiusSlider.value;
  // Live-preview: if we're editing an existing realm, mutate it in the local
  // map so the canvas updates as the user drags. Broadcast happens on SAVE.
  if (editingRealmId) {
    const r = realms.get(editingRealmId);
    if (r) {
      const updated: Realm = { ...r, radius: Number(realmRadiusSlider.value) };
      realms.set(updated.id, updated);
      renderer.setRealms(realms);
    }
  }
});
// Changing type auto-fills defaults for name-prefix + color unless user has already typed a name.
realmEditorType.addEventListener('change', () => {
  const d = REALM_DEFAULTS[realmEditorType.value as RealmType];
  setRealmColor(d.color);
  // Only overwrite the name if it still matches an auto-generated prefix or is blank.
  const isAutoName = !realmNameInput.value.trim() ||
    /^(BASS|MELODIC|PERC|CHAOS|REALM)\s\d+$/.test(realmNameInput.value.trim());
  if (isAutoName) realmNameInput.value = `${d.namePrefix} ${nextRealmIndex(realmEditorType.value as RealmType)}`;
});

function nextRealmIndex(type: RealmType): number {
  return 1 + [...realms.values()].filter(r => r.type === type).length;
}

function openRealmEditor(existing?: Realm): void {
  editingRealmId = existing?.id ?? null;
  if (existing) {
    realmModalTitle.textContent = 'EDIT REALM';
    realmNameInput.value = existing.name;
    // If the existing realm is 'custom' (from an old client), fall back to
    // melodic so the dropdown has a valid selection.
    realmEditorType.value = existing.type === 'custom' ? 'melodic' : existing.type;
    realmKeySel.value = existing.key;
    realmBpmSlider.value = String(existing.bpm);
    realmBpmVal.textContent = String(existing.bpm);
    realmRadiusSlider.value = String(existing.radius);
    realmRadiusVal.textContent = String(existing.radius);
    setRealmColor(existing.color);
    realmDeleteBtn.hidden = false;
    realmConfirmBtn.textContent = '✓ SAVE';
  } else {
    realmModalTitle.textContent = 'NEW REALM';
    const defaultType: RealmType = 'melodic';
    realmEditorType.value = defaultType;
    const d = REALM_DEFAULTS[defaultType];
    realmNameInput.value = `${d.namePrefix} ${nextRealmIndex(defaultType)}`;
    realmKeySel.value = d.key;
    realmBpmSlider.value = String(d.bpm);
    realmBpmVal.textContent = String(d.bpm);
    realmRadiusSlider.value = '260';
    realmRadiusVal.textContent = '260';
    setRealmColor(d.color);
    realmDeleteBtn.hidden = true;
    realmConfirmBtn.textContent = '✚ PLACE ON CANVAS';
  }
  realmModal.removeAttribute('hidden');
  renderer.setSelectedRealm(editingRealmId);   // highlight while editing
  setTimeout(() => realmNameInput.focus(), 40);
}
function closeRealmEditor(): void {
  realmModal.setAttribute('hidden', '');
  editingRealmId = null;
  renderer.setSelectedRealm(null);
}
function readDraftFromEditor(): RealmDraft {
  return {
    name: realmNameInput.value.trim() || 'REALM',
    type: realmEditorType.value as RealmType,
    key: realmKeySel.value,
    bpm: Number(realmBpmSlider.value),
    color: currentRealmColor(),
    radius: Number(realmRadiusSlider.value),
  };
}

realmBtn.addEventListener('click', () => {
  // If we're already armed for placement (button glows cyan), a second click cancels it.
  if (realmPlacementDraft) { armRealmPlacement(null); return; }
  openRealmEditor();
});
realmCancelBtn.addEventListener('click', closeRealmEditor);
realmModal.addEventListener('click', (ev) => { if (ev.target === realmModal) closeRealmEditor(); });
realmConfirmBtn.addEventListener('click', () => {
  const draft = readDraftFromEditor();
  if (editingRealmId) {
    const existing = realms.get(editingRealmId);
    if (!existing) { closeRealmEditor(); return; }
    const updated: Realm = { ...existing, ...draft };
    realms.set(updated.id, updated);
    renderer.setRealms(realms);
    multiplayer?.broadcastRealmUpdate(updated);
    flashLegend(`${updated.name} updated · ${updated.key} · ${updated.bpm} BPM`);
    closeRealmEditor();
  } else {
    armRealmPlacement(draft);
    closeRealmEditor();
  }
});
realmDeleteBtn.addEventListener('click', () => {
  if (!editingRealmId) return;
  const r = realms.get(editingRealmId);
  realms.delete(editingRealmId);
  renderer.setRealms(realms);
  if (r) multiplayer?.broadcastRealmRemove(r.id);
  flashLegend(r ? `removed ${r.name}` : 'realm removed');
  closeRealmEditor();
});

function armRealmPlacement(draft: RealmDraft | null): void {
  realmPlacementDraft = draft;
  document.body.classList.toggle('realm-placing', draft !== null);
  realmBtn.classList.toggle('armed', draft !== null);
  if (draft) flashLegend(`click canvas to place «${draft.name}» · NEW REALM again to cancel`);
}

function createRealmFromDraft(draft: RealmDraft, position: Vec3): void {
  const realm: Realm = {
    id: makeRealmId(),
    name: draft.name,
    color: draft.color,
    center: { x: position.x, y: 0, z: position.z },
    radius: draft.radius,
    type: draft.type,
    key: draft.key,
    bpm: draft.bpm,
  };
  realms.set(realm.id, realm);
  renderer.setRealms(realms);
  multiplayer?.broadcastRealmAdd(realm);
  flashLegend(`${realm.name} placed · ${realm.key} · ${realm.bpm} BPM`);
}

const REALM_NOTE_MIDI: Record<string, number> = {
  C: 0, 'C#': 1, D: 2, Eb: 3, E: 4, F: 5, 'F#': 6, G: 7, Ab: 8, A: 9, Bb: 10, B: 11,
};

/**
 * Shift a note's frequency so it lands on `key` at the octave closest to the
 * original. Preserves the node type's natural register (bass stays bass,
 * bells stay bells) while re-rooting the pitch to the realm's key.
 */
function shiftToKey(currentHz: number, key: string): number {
  const targetPc = REALM_NOTE_MIDI[key] ?? 0;
  const currentMidi = 69 + 12 * Math.log2(currentHz / 440);
  const currentPc = ((Math.round(currentMidi) % 12) + 12) % 12;
  // semitones we need to move to reach targetPc, wrapping to the shortest path
  let diff = targetPc - currentPc;
  if (diff > 6)  diff -= 12;
  if (diff < -6) diff += 12;
  return currentHz * Math.pow(2, diff / 12);
}

/**
 * Return a realm whose label ribbon was clicked at these screen coords, or
 * null. The label sits ~15px above the realm's top edge in a text-width band.
 * Wider than the actual text so shorter labels aren't a hard-to-hit target.
 */
function findRealmLabelAt(screenX: number, screenY: number): Realm | null {
  for (const r of realms.values()) {
    const screen = renderer.worldToScreen(r.center, listener);
    const rPx = r.radius * renderer.zoom;
    const labelTop = screen.y - rPx - 22;
    const labelBot = screen.y - rPx - 2;
    if (screenY < labelTop || screenY > labelBot) continue;
    // Half-width of the label ribbon (approx). Padding on each side of center.
    const halfW = Math.max(90, 5.5 * r.name.length + 40);
    if (Math.abs(screenX - screen.x) <= halfW) return r;
  }
  return null;
}

/** Return the smallest realm (by radius) containing this world position, or null. */
function findRealmAt(pos: Vec3): Realm | null {
  let best: Realm | null = null;
  for (const r of realms.values()) {
    const dx = pos.x - r.center.x;
    const dz = pos.z - r.center.z;
    if (dx * dx + dz * dz <= r.radius * r.radius) {
      if (!best || r.radius < best.radius) best = r;
    }
  }
  return best;
}
// ────────────────────────────────────────────────────────────────────────

const moodInput = document.getElementById('mood-input') as HTMLInputElement;
const moodBtn = document.getElementById('mood-btn')!;
const moodOutput = document.getElementById('mood-output')!;

moodBtn.addEventListener('click', async () => {
  const text = moodInput.value.trim();
  if (!text) return;
  moodOutput.textContent = 'analysing…';
  moodOutput.className = 'mood-output';
  // The lexicon path can't throw — but wrap defensively so any future change
  // (ML path failing mid-call etc.) can't surface a raw exception in the UI.
  try {
    const result = await mood.analyse(text);
    const modeLabel = mood.lastMode === 'ml' ? '🧠 ML' : '⚡ lex';
    const matchInfo = mood.lastMode === 'lexicon' && mood.lastMatchedWords.length > 0
      ? ` · matched: ${mood.lastMatchedWords.slice(0, 5).map(w => `«${w}»`).join(' ')}`
      : mood.lastMode === 'lexicon'
        ? ' · no known words → defaulting neutral'
        : '';
    moodOutput.textContent = `${result.mood.toUpperCase()} · ${(result.score * 100).toFixed(0)}% · key ${result.suggestedKey} · ${result.suggestedTempo}bpm · ${modeLabel}${matchInfo}`;
    moodOutput.className = `mood-output ${result.mood}`;
    mood.applyToScene(result, nodes, engine);
  } catch (err) {
    console.warn('mood analysis failed silently, defaulting to neutral:', err);
    moodOutput.textContent = 'NEUTRAL · 50% · key 60 · 90bpm · ⚡ lex';
    moodOutput.className = 'mood-output';
  }
});

document.getElementById('btn-fit')!.addEventListener('click', fitAllInView);

document.getElementById('btn-constellation')!.addEventListener('click', () => {
  const positions = constellationLayout(nodes.size, 320);
  let i = 0;
  for (const [id, n] of nodes) {
    const target = positions[i++] ?? n.position;
    nodes.set(id, { ...n, position: target });
    engine.getNode(id)?.setPosition(target, 1000);
    if (multiplayer) multiplayer.broadcastNodeMove(id, target);
  }
});

document.getElementById('btn-piano')!.addEventListener('click', () => {
  piano.toggle();
  const btn = document.getElementById('btn-piano')!;
  btn.classList.toggle('active');
  btn.textContent = piano.enabled ? '♪ PIANO ON' : '♪ KEYBOARD PIANO';
  updateLegend();
});

const pianoVolPopup = document.getElementById('piano-vol-popup')!;
const pvpVolEl      = document.getElementById('pvp-vol') as HTMLInputElement;
const pvpValEl      = document.getElementById('pvp-val')!;
const pvpIconEl     = document.getElementById('pvp-icon')!;

const pianoVolBtn = document.getElementById('btn-piano-vol')!;
pianoVolBtn.addEventListener('click', (ev) => {
  ev.stopPropagation();
  const rect = pianoVolBtn.getBoundingClientRect();
  pianoVolPopup.style.right = `${window.innerWidth - rect.right}px`;
  pianoVolPopup.style.top   = `${rect.top - 70}px`;
  pianoVolPopup.style.left  = '';
  pianoVolPopup.classList.toggle('open');
});

pvpVolEl.addEventListener('input', () => {
  const pct = parseInt(pvpVolEl.value);
  piano.gain = (pct / 100) * 0.55;
  pvpValEl.textContent = `${pct}%`;
  // Update popup icon opacity to indicate level (SVG stays, just dim it at low volumes)
  pvpIconEl.style.opacity = pct === 0 ? '0.25' : pct < 40 ? '0.55' : '1';
});

pianoVolPopup.addEventListener('click', (ev) => ev.stopPropagation());
document.addEventListener('click', () => pianoVolPopup.classList.remove('open'));

document.getElementById('btn-loop')!.addEventListener('click', () => {
  const btn = document.getElementById('btn-loop')!;
  if (loopRecorder.isPlaying) {
    loopRecorder.stop();
    document.body.classList.remove('loop-recording', 'loop-playing');
    btn.textContent = '↺ LOOP REC';
  } else if (loopRecorder.isRecording) {
    loopRecorder.stopRecord();
    document.body.classList.remove('loop-recording');
    document.body.classList.add('loop-playing');
    btn.textContent = '↺ LOOPING';
  } else {
    if (!piano.enabled) {
      piano.toggle();
      const pianoBtn = document.getElementById('btn-piano')!;
      pianoBtn.classList.add('active');
      pianoBtn.textContent = '♪ PIANO ON';
      updateLegend();
    }
    loopRecorder.startRecord();
    document.body.classList.add('loop-recording');
    btn.textContent = '● REC LOOP';
  }
});

// ── Master REC (top HUD) ────────────────────────────────────────────────────
const masterRecBtn   = document.getElementById('btn-master-rec')!;
const recElapsedEl   = document.getElementById('rec-elapsed')!;
const recSizeEl      = document.getElementById('rec-size')!;
const exportModal    = document.getElementById('export-modal')!;
const exportFilename = document.getElementById('export-filename') as HTMLInputElement;
const exportSizeHint = document.getElementById('export-size-hint')!;
const exportCancel   = document.getElementById('export-cancel')!;
const exportDownload = document.getElementById('export-download')!;
const fmtWebm        = document.getElementById('fmt-webm')!;
const fmtWav         = document.getElementById('fmt-wav')!;
const exportFmtHint  = document.getElementById('export-format-hint')!;

let exportBlob: Blob | null = null;
let exportFormat: 'webm' | 'wav' = 'webm';

function defaultFilename(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `soundscape-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}-${pad(d.getMinutes())}`;
}

function openExportModal(blob: Blob): void {
  exportBlob = blob;
  exportFormat = 'webm';
  fmtWebm.classList.add('active');
  fmtWav.classList.remove('active');
  exportFmtHint.textContent = 'smaller file, browser-native';
  exportFilename.value = defaultFilename();
  exportSizeHint.textContent = `Recorded ${fmtBytes(blob.size)} · choose format and download`;
  exportModal.removeAttribute('hidden');
  setTimeout(() => { exportFilename.focus(); exportFilename.select(); }, 50);
}

function closeExportModal(): void {
  exportModal.setAttribute('hidden', '');
  exportBlob = null;
}

fmtWebm.addEventListener('click', () => {
  exportFormat = 'webm';
  fmtWebm.classList.add('active');
  fmtWav.classList.remove('active');
  exportFmtHint.textContent = 'smaller file, browser-native';
});
fmtWav.addEventListener('click', () => {
  exportFormat = 'wav';
  fmtWav.classList.add('active');
  fmtWebm.classList.remove('active');
  exportFmtHint.textContent = 'lossless PCM — larger file, converting after click';
});

exportCancel.addEventListener('click', closeExportModal);
exportModal.addEventListener('click', (ev) => { if (ev.target === exportModal) closeExportModal(); });

exportDownload.addEventListener('click', async () => {
  if (!exportBlob) return;
  exportDownload.textContent = exportFormat === 'wav' ? 'CONVERTING…' : 'DOWNLOADING…';
  (exportDownload as HTMLButtonElement).disabled = true;

  let blob = exportBlob;
  let ext  = 'webm';
  if (exportFormat === 'wav') {
    blob = await webmToWav(exportBlob);
    ext  = 'wav';
  }

  const name = (exportFilename.value.trim() || defaultFilename()) + '.' + ext;
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);

  exportDownload.textContent = '⬇ DOWNLOAD';
  (exportDownload as HTMLButtonElement).disabled = false;
  closeExportModal();
});

recorder.onTick = (elapsed, bytes) => {
  recElapsedEl.textContent = fmtElapsed(elapsed);
  recSizeEl.textContent    = fmtBytes(bytes);
};
recorder.onWarn = () => {
  recElapsedEl.style.color = 'var(--neon-amber)';
  // brief flash to alert user
  masterRecBtn.textContent = '⏺ 55 MIN';
  setTimeout(() => { masterRecBtn.textContent = '⏹ STOP'; }, 3000);
};
recorder.onStopped = (blob) => {
  document.body.classList.remove('master-recording');
  masterRecBtn.textContent = '⏺ REC';
  recElapsedEl.setAttribute('hidden', '');
  recSizeEl.setAttribute('hidden', '');
  recElapsedEl.style.color = '';
  openExportModal(blob);
};

masterRecBtn.addEventListener('click', async () => {
  if (recorder.isRecording) {
    await recorder.stop();
  } else {
    recorder.start();
    document.body.classList.add('master-recording');
    masterRecBtn.textContent = '⏹ STOP';
    recElapsedEl.removeAttribute('hidden');
    recSizeEl.removeAttribute('hidden');
    recElapsedEl.textContent = '00:00';
    recSizeEl.textContent    = '0 KB';
  }
});

document.getElementById('btn-clear')!.addEventListener('click', () => {
  for (const id of [...nodes.keys()]) {
    engine.removeNode(id);
    nodes.delete(id);
    trails.delete(id);
    if (multiplayer) multiplayer.broadcastNodeRemove(id);
  }
  for (const id of [...realms.keys()]) {
    realms.delete(id);
    if (multiplayer) multiplayer.broadcastRealmRemove(id);
  }
  renderer.setRealms(realms);
  updateLegend();
});

(document.getElementById('vol-master') as HTMLInputElement).addEventListener('input', (e) => {
  engine.setMasterVolume(Number((e.target as HTMLInputElement).value) / 100);
});
(document.getElementById('vol-reverb') as HTMLInputElement).addEventListener('input', (e) => {
  engine.setReverbWet(Number((e.target as HTMLInputElement).value) / 100);
});
(document.getElementById('vol-visuals') as HTMLInputElement).addEventListener('input', (e) => {
  renderer.visualIntensity = Number((e.target as HTMLInputElement).value) / 100;
});

// ── Sidebar collapse / width toggle ─────────────────────────────────────────
const sidebar       = document.querySelector('.hud-side') as HTMLElement;
const sidebarToggle = document.getElementById('sidebar-toggle')!;
const sidebarWideBtn = document.getElementById('sidebar-wide-btn')!;

sidebarToggle.addEventListener('click', () => {
  const isCollapsed = sidebar.classList.toggle('collapsed');
  sidebarToggle.textContent = isCollapsed ? '‹' : '›';
  sidebarToggle.title = isCollapsed ? 'Open sidebar' : 'Close sidebar';
});

sidebarWideBtn.addEventListener('click', () => {
  const isWide = sidebar.classList.toggle('wide');
  sidebarWideBtn.textContent = isWide ? '⟵' : '⟺';
  // Nudge the toggle tab — CSS sibling selector handles it but update title too
  sidebarToggle.title = sidebar.classList.contains('collapsed')
    ? 'Open sidebar' : 'Close sidebar';
});

let trailTimer = 0;
function tickTrails(dt: number): void {
  trailTimer += dt;
  if (trailTimer < 0.1) return;
  trailTimer = 0;
  for (const [id, n] of nodes) {
    const t = trails.get(id) ?? [];
    t.push({ ...n.position });
    if (t.length > 40) t.shift();
    trails.set(id, t);
  }
  for (const [id, peer] of peers) {
    const t = peerTrails.get(id) ?? [];
    t.push({ ...peer.position });
    if (t.length > 20) t.shift();
    peerTrails.set(id, t);
  }
  for (const id of peerTrails.keys()) {
    if (!peers.has(id)) peerTrails.delete(id);
  }
}

// ── Sound Gravity: per-type physics ────────────────────────────────────
// Each node type contributes a different force to itself + neighbors:
//   bass       — attracts nearby nodes toward it
//   bells      — repels nearby nodes outward
//   pad        — orbits the nearest bass node within 300px
//   ambient    — drifts along a slow random curve (two-frequency sine)
//   generative — locks nearby generatives (≤ 150px) into a shared rhythm orbit
//   percussion — bounces off world boundaries and other nodes
//   others     — no rule; just decelerate to rest
// Velocity is capped at MAX_VEL (world-units/second) and manually dragging a
// node zeroes its velocity so the drag feels responsive.
const GRAV_PULL   = 40;   // bass attraction strength
const GRAV_PUSH   = 55;   // bells repulsion strength
const GRAV_INFL   = 220;  // interaction radius for pull/push
const ORBIT_RANGE = 300;  // pad orbit radius from nearest bass
const RHYTHM_RANGE = 150; // gen-ai rhythm orbit radius
const BOUND_XZ    = 1200; // perc bounce boundary
const DRAG        = 0.85; // per-second velocity damping (multiplied per frame)
const AMBIENT_DRIFT_AMP = 18;

function tickGravity(dt: number): void {
  if (!gravityOn || nodes.size === 0) return;

  // Snapshot of type-indexed neighbors we need each frame.
  const bassNodes: SpatialNodeDescriptor[] = [];
  for (const n of nodes.values()) if (n.params.type === 'bass') bassNodes.push(n);

  for (const [id, n] of nodes) {
    let v = nodeVel.get(id);
    if (!v) { v = { vx: 0, vz: 0 }; nodeVel.set(id, v); }

    // Force accumulators for this frame (in world-units per second^2)
    let ax = 0, az = 0;

    // (1) Bass attraction — every non-bass node pulled toward every bass
    for (const b of bassNodes) {
      if (b.id === id) continue;
      const dx = b.position.x - n.position.x;
      const dz = b.position.z - n.position.z;
      const d = Math.hypot(dx, dz);
      if (d < 20 || d > GRAV_INFL * 2) continue;
      const f = GRAV_PULL * (1 - Math.min(1, d / (GRAV_INFL * 2)));
      ax += (dx / d) * f;
      az += (dz / d) * f;
    }

    // (2) Bells repulsion — anyone near a bells node gets pushed away
    for (const [otherId, o] of nodes) {
      if (otherId === id || o.params.type !== 'bells') continue;
      const dx = n.position.x - o.position.x;
      const dz = n.position.z - o.position.z;
      const d = Math.hypot(dx, dz);
      if (d < 5 || d > GRAV_INFL) continue;
      const f = GRAV_PUSH * (1 - d / GRAV_INFL);
      ax += (dx / d) * f;
      az += (dz / d) * f;
    }

    // Type-specific behaviors ────────────────────────────────────────────
    switch (n.params.type) {
      case 'pad': {
        // Orbit the nearest bass within ORBIT_RANGE
        let nearest: SpatialNodeDescriptor | null = null;
        let bestD = Infinity;
        for (const b of bassNodes) {
          const d = Math.hypot(b.position.x - n.position.x, b.position.z - n.position.z);
          if (d < bestD && d < ORBIT_RANGE) { bestD = d; nearest = b; }
        }
        if (nearest) {
          const dx = n.position.x - nearest.position.x;
          const dz = n.position.z - nearest.position.z;
          const d = Math.hypot(dx, dz);
          if (d > 5) {
            // Tangential thrust = perpendicular to the radius vector
            const tangentX = -dz / d;
            const tangentZ =  dx / d;
            ax += tangentX * 60;
            az += tangentZ * 60;
            // Weak centripetal pull to keep orbit tight
            ax += (nearest.position.x - n.position.x) / d * 6;
            az += (nearest.position.z - n.position.z) / d * 6;
          }
        }
        break;
      }
      case 'ambient': {
        // Slow random-curve drift via two-frequency lissajous
        let ph = nodePhase.get(id);
        if (!ph) { ph = { a: Math.random() * Math.PI * 2, b: Math.random() * Math.PI * 2 }; nodePhase.set(id, ph); }
        ph.a += 0.6 * dt;
        ph.b += 0.4 * dt;
        ax += Math.cos(ph.a) * AMBIENT_DRIFT_AMP;
        az += Math.sin(ph.b * 1.3) * AMBIENT_DRIFT_AMP;
        break;
      }
      case 'generative': {
        // Cluster with other generatives within 150 px into a shared orbit
        let cx = 0, cz = 0, count = 0;
        for (const [otherId, o] of nodes) {
          if (otherId === id || o.params.type !== 'generative') continue;
          const d = Math.hypot(o.position.x - n.position.x, o.position.z - n.position.z);
          if (d < RHYTHM_RANGE) { cx += o.position.x; cz += o.position.z; count++; }
        }
        if (count > 0) {
          const meanX = cx / count;
          const meanZ = cz / count;
          const dx = n.position.x - meanX;
          const dz = n.position.z - meanZ;
          const d = Math.hypot(dx, dz);
          if (d > 5) {
            // Tangential orbit around the centroid
            ax += (-dz / d) * 45;
            az += ( dx / d) * 45;
            // Pull toward centroid to keep the group cohesive
            ax += (meanX - n.position.x) * 0.4;
            az += (meanZ - n.position.z) * 0.4;
          }
        }
        break;
      }
      // bass, bells, percussion, others: base rules only
    }

    // Integrate velocity
    const damp = Math.pow(DRAG, dt);
    v.vx = (v.vx + ax * dt) * damp;
    v.vz = (v.vz + az * dt) * damp;

    // Speed cap
    const speed = Math.hypot(v.vx, v.vz);
    if (speed > MAX_VEL) {
      v.vx = (v.vx / speed) * MAX_VEL;
      v.vz = (v.vz / speed) * MAX_VEL;
    }

    let nx = n.position.x + v.vx * dt;
    let nz = n.position.z + v.vz * dt;

    // (3) Percussion bounce off world boundary + other nodes
    if (n.params.type === 'percussion') {
      if (nx >  BOUND_XZ) { nx =  BOUND_XZ; v.vx = -Math.abs(v.vx); }
      if (nx < -BOUND_XZ) { nx = -BOUND_XZ; v.vx =  Math.abs(v.vx); }
      if (nz >  BOUND_XZ) { nz =  BOUND_XZ; v.vz = -Math.abs(v.vz); }
      if (nz < -BOUND_XZ) { nz = -BOUND_XZ; v.vz =  Math.abs(v.vz); }
      // Simple node-node bounce: if we're overlapping (< 40 world units),
      // reflect our velocity vector away.
      for (const [otherId, o] of nodes) {
        if (otherId === id) continue;
        const dx = nx - o.position.x;
        const dz = nz - o.position.z;
        const d = Math.hypot(dx, dz);
        if (d < 40 && d > 0) {
          v.vx += (dx / d) * 20;
          v.vz += (dz / d) * 20;
        }
      }
    }

    // Only broadcast if the node actually moved appreciably
    if (Math.abs(nx - n.position.x) > 0.05 || Math.abs(nz - n.position.z) > 0.05) {
      const newPos: Vec3 = { x: nx, y: 0, z: nz };
      nodes.set(id, { ...n, position: newPos });
      engine.getNode(id)?.setPosition(newPos, 0);
    }
  }
}

function tickLinks(): void {
  for (const [srcId, lnk] of links) {
    const src = nodes.get(srcId);
    const tgt = nodes.get(lnk.target);
    if (!src || !tgt) { links.delete(srcId); continue; }
    const targetFreq = src.params.frequency * Math.pow(2, lnk.interval / 12);
    if (Math.abs(tgt.params.frequency - targetFreq) > 0.5) {
      nodes.set(lnk.target, { ...tgt, params: { ...tgt.params, frequency: targetFreq } });
      engine.getNode(lnk.target)?.updateParams({ frequency: targetFreq });
    }
  }
}

// ── BPM sync ─────────────────────────────────────────────────────────────
function applyBpm(bpm: number): void {
  globalBpm = bpm;
  for (const [id, n] of nodes) {
    if (['percussion', 'pluck', 'generative'].includes(n.params.type)) {
      engine.getNode(id)?.updateParams({ tempo: bpm });
      nodes.set(id, { ...n, params: { ...n.params, tempo: bpm } });
    }
  }
}

const bpmSlider = document.getElementById('bpm-slider') as HTMLInputElement;
const bpmVal    = document.getElementById('bpm-val')!;
bpmSlider.addEventListener('input', () => {
  const bpm = parseInt(bpmSlider.value);
  bpmVal.textContent = String(bpm);
  applyBpm(bpm);
});

// ── Gravity toggle ────────────────────────────────────────────────────────
document.getElementById('btn-gravity')!.addEventListener('click', () => {
  gravityOn = !gravityOn;
  document.getElementById('btn-gravity')!.classList.toggle('active', gravityOn);
});

// ── Link mode ────────────────────────────────────────────────────────────
document.getElementById('btn-link')!.addEventListener('click', () => {
  linkIntervalIdx = (linkIntervalIdx + 1) % LINK_INTERVALS.length;
  const iv = LINK_INTERVALS[linkIntervalIdx]!;
  if (!linkMode) {
    linkMode = true;
    linkSource = null;
    document.getElementById('btn-link')!.classList.add('active');
    flashLegend(`link mode: ${iv.name} — click source node`);
  } else {
    // Cycle interval
    document.getElementById('btn-link')!.textContent = `⤢ LINK (${iv.name})`;
    flashLegend(`link interval → ${iv.name}`);
  }
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && linkMode) {
    linkMode = false; linkSource = null;
    document.getElementById('btn-link')!.classList.remove('active');
    document.getElementById('btn-link')!.textContent = '⤢ LINK';
  }
});

// ── Snapshots ────────────────────────────────────────────────────────────
const SNAP_KEY = 'spatial-soundscape.snapshots';
interface Snapshot { name: string; at: number; nodeList: SpatialNodeDescriptor[] }

function loadSnaps(): Snapshot[] {
  try { return JSON.parse(localStorage.getItem(SNAP_KEY) ?? '[]') as Snapshot[]; } catch { return []; }
}
function saveSnaps(snaps: Snapshot[]): void {
  try { localStorage.setItem(SNAP_KEY, JSON.stringify(snaps)); } catch {}
}
function renderSnapList(): void {
  const list = document.getElementById('snap-list')!;
  const snaps = loadSnaps();
  if (snaps.length === 0) {
    list.innerHTML = '<div class="snap-empty">no snapshots yet</div>';
    return;
  }
  list.innerHTML = '';
  for (let i = 0; i < snaps.length; i++) {
    const s = snaps[i]!;
    const row = document.createElement('div');
    row.className = 'snap-item';
    const age = new Date(s.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    row.innerHTML = `
      <span class="snap-item-name" title="${s.name}">${s.name}</span>
      <span class="snap-item-time">${age} · ${s.nodeList.length}n</span>
      <button data-restore="${i}">▶</button>
      <button data-del="${i}">✕</button>
    `;
    list.appendChild(row);
  }
  list.querySelectorAll<HTMLButtonElement>('[data-restore]').forEach(btn => {
    btn.addEventListener('click', () => {
      const snap = loadSnaps()[parseInt(btn.dataset['restore']!)]!;
      for (const id of [...nodes.keys()]) removeNodeRaw(id);
      for (const d of snap.nodeList) addNodeRaw(d);
      document.getElementById('snapshot-modal')!.setAttribute('hidden', '');
    });
  });
  list.querySelectorAll<HTMLButtonElement>('[data-del]').forEach(btn => {
    btn.addEventListener('click', () => {
      const snaps2 = loadSnaps();
      snaps2.splice(parseInt(btn.dataset['del']!), 1);
      saveSnaps(snaps2);
      renderSnapList();
    });
  });
}

function loadPreset(idx: number): void {
  const preset = STARTER_PRESETS[idx];
  if (!preset) return;
  for (const id of [...nodes.keys()]) removeNodeRaw(id);
  for (const node of preset.nodes) {
    const base = defaultParamsFor(node.params.type);
    const params: SynthParams = { ...base, ...node.params } as SynthParams;
    if (preset.bpm && ['percussion', 'pluck', 'generative'].includes(params.type)) {
      params.tempo = preset.bpm;
    }
    addNodeRaw({ ...node, id: makeNodeId(), params });
  }
  if (preset.bpm) {
    globalBpm = preset.bpm;
    bpmSlider.value = String(preset.bpm);
    bpmVal.textContent = String(preset.bpm);
    applyBpm(preset.bpm);
  }
  document.getElementById('snapshot-modal')!.setAttribute('hidden', '');
}

function renderStarterScenes(): void {
  const grid = document.getElementById('starter-scenes')!;
  grid.innerHTML = '';
  STARTER_PRESETS.forEach((preset, idx) => {
    const card = document.createElement('div');
    card.className = 'starter-card';
    card.innerHTML = `
      <div class="starter-card-name">${preset.name}</div>
      <div class="starter-card-tag">${preset.tag}</div>
      <div class="starter-card-desc">${preset.description}</div>
      <button class="starter-card-load">LOAD</button>
    `;
    card.querySelector('.starter-card-load')!.addEventListener('click', (e) => {
      e.stopPropagation();
      loadPreset(idx);
    });
    grid.appendChild(card);
  });
}

// ── Melody Composer ────────────────────────────────────────────────────
// A piano-roll modal for authoring monophonic melodies. Grid is 16 steps ×
// 13 semitone rows (from +6 down to -6 relative to the root). Clicking a
// cell sets that step to that pitch; clicking again clears the step.
// PREVIEW spawns an audio-only generative node (no multiplayer broadcast).
// DROP AS NODE places it on the canvas at the listener position.

const COMPOSER_STEPS = 16;
const COMPOSER_ROWS  = 13;         // -6 through +6 semitones
const COMPOSER_ROW_OFFSETS = Array.from({ length: COMPOSER_ROWS }, (_, i) => 6 - i);
const NOTE_MIDI: Record<string, number> = {
  C: 0, 'C#': 1, D: 2, Eb: 3, E: 4, F: 5, 'F#': 6, G: 7, Ab: 8, A: 9, Bb: 10, B: 11,
};
const MIDI_TO_NAME = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

function composerRowLabel(semi: number): string {
  const mode = (document.getElementById('composer-labels') as HTMLSelectElement | null)?.value ?? 'semi';
  if (mode === 'notes') {
    const rootNote = (document.getElementById('composer-root') as HTMLSelectElement).value;
    const rootIdx = NOTE_MIDI[rootNote] ?? 0;
    const noteIdx = ((rootIdx + semi) % 12 + 12) % 12;
    return MIDI_TO_NAME[noteIdx]!;
  }
  return semi === 0 ? '0' : (semi > 0 ? '+' + semi : String(semi));
}

let composerSteps: (number | null)[] = new Array(COMPOSER_STEPS).fill(null);
let composerPreviewId: NodeId | null = null;
let composerPlayheadIdx = 0;
let composerPlayheadTimer: ReturnType<typeof setInterval> | null = null;

function composerRootFreq(): number {
  const note = (document.getElementById('composer-root') as HTMLSelectElement).value;
  const oct  = Number((document.getElementById('composer-octave') as HTMLSelectElement).value);
  const midi = 12 * (oct + 1) + (NOTE_MIDI[note] ?? 0);
  return 440 * Math.pow(2, (midi - 69) / 12);
}
function composerWave(): OscillatorType {
  return (document.getElementById('composer-wave') as HTMLSelectElement).value as OscillatorType;
}
function composerBpm(): number {
  return Number((document.getElementById('composer-bpm') as HTMLInputElement).value);
}
function composerArpSpeed(): number { return composerBpm() / 50; }

function renderComposerGrid(): void {
  const grid = document.getElementById('composer-grid')!;
  grid.innerHTML = '';
  // Header row (empty label + 16 step columns)
  for (let r = 0; r < COMPOSER_ROWS; r++) {
    const semi = COMPOSER_ROW_OFFSETS[r]!;
    const label = document.createElement('div');
    label.className = 'composer-row-label' + (semi === 0 ? ' root' : '');
    label.textContent = composerRowLabel(semi);
    grid.appendChild(label);
    for (let s = 0; s < COMPOSER_STEPS; s++) {
      const cell = document.createElement('div');
      cell.className = 'composer-cell';
      if (semi === 0) cell.classList.add('root-row');
      if (s % 4 === 0) cell.classList.add('beat-mark');
      if (composerSteps[s] === semi) {
        cell.classList.add('on');
        if (semi === 0) cell.classList.add('root');
      }
      cell.dataset['step'] = String(s);
      cell.dataset['semi'] = String(semi);
      cell.addEventListener('click', () => {
        // Monophonic: clicking places this pitch at this step, or clears if same
        composerSteps[s] = (composerSteps[s] === semi) ? null : semi;
        renderComposerGrid();
      });
      grid.appendChild(cell);
    }
  }
  // Overlay playhead if playing
  if (composerPreviewId) markComposerPlayhead(composerPlayheadIdx);
}

function markComposerPlayhead(idx: number): void {
  document.querySelectorAll('#composer-grid .composer-cell.playhead').forEach(c => c.classList.remove('playhead'));
  document.querySelectorAll(`#composer-grid .composer-cell[data-step="${idx}"]`).forEach(c => c.classList.add('playhead'));
}

function stopComposerPreview(): void {
  if (composerPlayheadTimer) { clearInterval(composerPlayheadTimer); composerPlayheadTimer = null; }
  if (composerPreviewId) {
    engine.removeNode(composerPreviewId);
    composerPreviewId = null;
  }
  document.querySelectorAll('#composer-grid .composer-cell.playhead').forEach(c => c.classList.remove('playhead'));
}

function startComposerPreview(): void {
  stopComposerPreview();
  if (composerSteps.every(s => s === null)) return;   // nothing to play
  const id = makeNodeId();
  composerPreviewId = id;
  const params: SynthParams = {
    type: 'generative',
    wave: composerWave(),
    frequency: composerRootFreq(),
    gain: 0.24,
    attack: 0.02, decay: 0.2, sustain: 0.6, release: 0.4,
    reverbWet: 0.35, chorusDepth: 0.12,
    arpSpeed: composerArpSpeed(),
    melodyScale: composerSteps,
    filterCutoff: 2400,
  };
  engine.addNode({
    id, position: { x: listener.x, y: 0, z: listener.z },
    params, label: 'preview', color: '#ffd60a',
    innerRadius: 200, outerRadius: 4000, muted: false,
  });
  // Animate playhead in sync with 16th-note steps
  const stepMs = (60000 / composerBpm()) / 4;
  composerPlayheadIdx = 0;
  markComposerPlayhead(0);
  composerPlayheadTimer = setInterval(() => {
    composerPlayheadIdx = (composerPlayheadIdx + 1) % COMPOSER_STEPS;
    markComposerPlayhead(composerPlayheadIdx);
  }, stepMs);
}

function openMelodyComposer(): void {
  document.getElementById('melody-modal')!.removeAttribute('hidden');
  renderComposerGrid();
}
function closeMelodyComposer(): void {
  stopComposerPreview();
  document.getElementById('melody-modal')!.setAttribute('hidden', '');
}

document.getElementById('composer-bpm')!.addEventListener('input', (e) => {
  document.getElementById('composer-bpm-val')!.textContent = (e.target as HTMLInputElement).value;
});
// Re-render row labels when the label mode or the root changes so note names track.
document.getElementById('composer-labels')!.addEventListener('change', renderComposerGrid);
document.getElementById('composer-root')!.addEventListener('change', renderComposerGrid);
document.getElementById('composer-template')!.addEventListener('change', (e) => {
  const v = (e.target as HTMLSelectElement).value;
  stopComposerPreview();
  if (v === 'empty') {
    composerSteps = new Array(COMPOSER_STEPS).fill(null);
  } else {
    const tune = TUNES[Number(v)];
    if (tune) {
      // Only take the first 16 steps of longer tunes (Seven Nation Army is 32).
      // Clamp offsets to the -6..+6 grid range; anything outside becomes a rest.
      composerSteps = tune.melodyScale.slice(0, COMPOSER_STEPS).map(s =>
        (s === null || s > 6 || s < -6) ? null : s,
      );
      while (composerSteps.length < COMPOSER_STEPS) composerSteps.push(null);
    }
  }
  renderComposerGrid();
});
document.getElementById('composer-preview')!.addEventListener('click', startComposerPreview);
document.getElementById('composer-stop')!.addEventListener('click', stopComposerPreview);
document.getElementById('composer-clear')!.addEventListener('click', () => {
  stopComposerPreview();
  composerSteps = new Array(COMPOSER_STEPS).fill(null);
  renderComposerGrid();
});
document.getElementById('composer-drop')!.addEventListener('click', () => {
  if (composerSteps.every(s => s === null)) return;
  const noteName = (document.getElementById('composer-root') as HTMLSelectElement).value;
  const oct = (document.getElementById('composer-octave') as HTMLSelectElement).value;
  pendingComposedMelody = {
    freq: composerRootFreq(),
    wave: composerWave(),
    arpSpeed: composerArpSpeed(),
    melodyScale: [...composerSteps],
    label: `melody · ${noteName}${oct}`,
  };
  activeSynthType = 'generative';
  document.querySelectorAll('.node-btn').forEach(b => b.classList.remove('active'));
  document.querySelector<HTMLButtonElement>('.node-btn[data-type="melody"]')!.classList.add('active');
  closeMelodyComposer();
});
document.getElementById('composer-close')!.addEventListener('click', closeMelodyComposer);
document.getElementById('melody-modal')!.addEventListener('click', (ev) => {
  if (ev.target === document.getElementById('melody-modal')) closeMelodyComposer();
});
// ────────────────────────────────────────────────────────────────────────

document.getElementById('btn-snapshot')!.addEventListener('click', () => {
  renderStarterScenes();
  renderSnapList();
  document.getElementById('snapshot-modal')!.removeAttribute('hidden');
});
document.getElementById('snap-close')!.addEventListener('click', () => {
  document.getElementById('snapshot-modal')!.setAttribute('hidden', '');
});
document.getElementById('snapshot-modal')!.addEventListener('click', (ev) => {
  if (ev.target === document.getElementById('snapshot-modal')) {
    document.getElementById('snapshot-modal')!.setAttribute('hidden', '');
  }
});
document.getElementById('snap-save-btn')!.addEventListener('click', () => {
  const name = (document.getElementById('snap-name-input') as HTMLInputElement).value.trim() || `scene-${Date.now()}`;
  const snaps = loadSnaps();
  snaps.unshift({ name, at: Date.now(), nodeList: Array.from(nodes.values()) });
  if (snaps.length > 12) snaps.pop();
  saveSnaps(snaps);
  (document.getElementById('snap-name-input') as HTMLInputElement).value = '';
  renderSnapList();
});
(document.getElementById('snap-name-input') as HTMLInputElement).addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('snap-save-btn')!.click();
});

// ── Cursor chat ───────────────────────────────────────────────────────────
const chatWrap = document.getElementById('chat-input-wrap')!;
const chatText = document.getElementById('chat-text') as HTMLInputElement;

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return;
  if (e.key.toLowerCase() === 't' && !piano.enabled) {
    e.preventDefault();
    chatWrap.classList.toggle('open');
    if (chatWrap.classList.contains('open')) chatText.focus();
  }
});
chatText.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const text = chatText.value.trim();
    if (text && multiplayer) multiplayer.broadcastChat(text);
    chatText.value = '';
    chatWrap.classList.remove('open');
  }
  if (e.key === 'Escape') { chatWrap.classList.remove('open'); }
  e.stopPropagation(); // prevent piano keys firing
});

let lastT = performance.now();
let frameCount = 0;
let fpsT = lastT;
const fpsEl = document.getElementById('fps')!;
const peerCountEl = document.getElementById('peer-count')!;

/**
 * Recompute realm audio treatment weights based on the listener's position
 * relative to each realm. Weights are membership indicators (1 inside center,
 * fading to 0 at the edge with a small overshoot for smoothness), summed by
 * realm type and clamped. Cross-fade to the engine happens over 0.5s so the
 * transition feels like walking through a doorway.
 */
function tickRealmAudio(): void {
  if (!engine.isRunning) return;
  let bassW = 0, melW = 0, percW = 0, chaosW = 0;
  for (const realm of realms.values()) {
    const dx = listener.x - realm.center.x;
    const dz = listener.z - realm.center.z;
    const d  = Math.sqrt(dx * dx + dz * dz);
    // Membership: 1 at center, linearly fades to 0 at edge (no bleed outside).
    const m = Math.max(0, 1 - d / realm.radius);
    if (m <= 0) continue;
    switch (realm.type) {
      case 'bass':       bassW  = Math.max(bassW,  m); break;
      case 'melodic':    melW   = Math.max(melW,   m); break;
      case 'percussive': percW  = Math.max(percW,  m); break;
      case 'chaos':      chaosW = Math.max(chaosW, m); break;
      case 'custom':     break;                           // legacy no-op
    }
  }
  engine.setRealmTreatment({ bassW, melodicW: melW, percussiveW: percW, chaosW }, 0.5);
}

function loop(now: number): void {
  const dt = Math.min(0.05, (now - lastT) / 1000);
  lastT = now;

  tickMovement(dt);
  tickTrails(dt);
  tickGravity(dt);
  tickLinks();
  tickRealmAudio();
  tickGhosts(now);
  tickPortals();

  const pairs = resonance.detect(nodes);

  renderer.render({
    nodes,
    frames,
    listener,
    peers,
    trails,
    peerTrails,
    peerChats,
    links,
    resonancePairs: pairs,
  }, totalEnergy);

  frameCount++;
  if (now - fpsT > 500) {
    fpsEl.textContent = `${((frameCount * 1000) / (now - fpsT)).toFixed(0)} fps`;
    frameCount = 0;
    fpsT = now;
  }
  peerCountEl.textContent = String(peers.size + 1);

  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
