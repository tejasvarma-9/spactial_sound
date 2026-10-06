import type { AnalyserFrame, NodeId, Portal, PortalId, Realm, RealmId, SpatialNodeDescriptor, Vec3 } from '@spatial-soundscape/engine';
import type { ResonancePair } from './ResonanceDetector.ts';

function scaleAlpha(css: string, factor: number): string {
  css = css.trim();
  let r = 0, g = 0, b = 0, a = 1;
  const rgbaMatch = /^rgba?\(([^)]+)\)$/i.exec(css);
  const hslaMatch = /^hsla?\(([^)]+)\)$/i.exec(css);
  if (rgbaMatch) {
    const parts = rgbaMatch[1]!.split(',').map(s => parseFloat(s.trim()));
    r = parts[0] ?? 0; g = parts[1] ?? 0; b = parts[2] ?? 0; a = parts[3] ?? 1;
  } else if (hslaMatch) {
    const parts = hslaMatch[1]!.split(',');
    const hh = parseFloat(parts[0] ?? '0');
    const s = parseFloat(parts[1] ?? '0') / 100;
    const l = parseFloat(parts[2] ?? '0') / 100;
    a = parseFloat(parts[3] ?? '1');
    const k = (n: number) => (n + hh / 30) % 12;
    const f = (n: number) => l - Math.min(l, 1 - l) * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    r = Math.round(f(0) * 255);
    g = Math.round(f(8) * 255);
    b = Math.round(f(4) * 255);
  } else if (css.startsWith('#')) {
    const hex = css.slice(1);
    const h = hex.length === 3 ? hex.split('').map(c => c + c).join('') : hex;
    r = parseInt(h.slice(0, 2), 16);
    g = parseInt(h.slice(2, 4), 16);
    b = parseInt(h.slice(4, 6), 16);
  }
  return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, a * factor))})`;
}

export interface NodeLink { target: NodeId; interval: number }

// ── Per-node animation state (sparks for BELLS, ripples for PLUCK) ────────────
interface ParticleSpark { x: number; y: number; vx: number; vy: number; born: number }
interface RippleRing    { born: number; duration: number }
interface NodeAnimState {
  sparks:     ParticleSpark[];
  ripples:    RippleRing[];
  shockwaves: RippleRing[];
  lastEnergy: number;
}

interface RenderState {
  nodes: ReadonlyMap<NodeId, SpatialNodeDescriptor>;
  frames: Map<NodeId, AnalyserFrame>;
  listener: Vec3;
  peers: Map<string, { position: Vec3; color: string }>;
  trails: Map<NodeId, Vec3[]>;
  peerTrails: Map<string, Vec3[]>;
  peerChats: Map<string, { text: string; at: number }>;
  links: Map<NodeId, NodeLink>;
  resonancePairs: ResonancePair[];
}

const TYPE_GLYPHS: Record<string, string> = {
  ambient:    '◉',
  bass:       '▼',
  percussion: '▦',
  generative: '✺',
  voice:      '◎',
  bells:      '✦',
  strings:    '≋',
  pad:        '⬡',
  pluck:      '⌇',
  piano:      '♪',
};

export class Renderer {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private dpr = 1;

  private auroraEnergy = 0;
  private _now = 0;
  private _bloomFlash = 0;
  private _peakEnergy = 0;
  private readonly _animStates = new Map<NodeId, NodeAnimState>();
  private _realms: Realm[] = [];
  private _selectedRealmId: RealmId | null = null;

  setRealms(realms: Map<RealmId, Realm>): void {
    // Snapshot into an array so each frame's iteration doesn't exhaust it.
    this._realms = Array.from(realms.values());
  }
  setSelectedRealm(id: RealmId | null): void {
    this._selectedRealmId = id;
  }

  private _ghostPoints: { x: number; z: number; alpha: number }[] = [];
  setGhostPoints(pts: { x: number; z: number; alpha: number }[]): void {
    this._ghostPoints = pts;
  }

  private _portals: Portal[] = [];
  setPortals(m: Map<PortalId, Portal>): void {
    this._portals = Array.from(m.values());
  }

  /** 0–1 global visual intensity, wired to the sidebar slider. */
  visualIntensity = 1.0;

  zoom = 1.0;
  static readonly MIN_ZOOM = 0.15;
  static readonly MAX_ZOOM = 3.0;

  private themeCache: {
    bg0: string;
    grid: string;
    aurora1: string;
    aurora2: string;
    text: string;
    textDim: string;
    avatarBg: string;
    neonCyan: string;
    glowMul: number;
  } | null = null;

  invalidateThemeCache(): void {
    this.themeCache = null;
  }

  private _theme(): NonNullable<Renderer['themeCache']> {
    if (this.themeCache) return this.themeCache;
    const cs = getComputedStyle(document.documentElement);
    const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
    this.themeCache = {
      bg0:      v('--bg-0',        '#07060e'),
      grid:     v('--bg-grid',     'rgba(155,93,229,0.12)'),
      aurora1:  v('--bg-aurora-1', 'rgba(155,93,229,0.18)'),
      aurora2:  v('--bg-aurora-2', 'rgba(0,245,212,0.08)'),
      text:     v('--canvas-text', '#d8d3ee'),
      textDim:  v('--text-dim',    '#6b6485'),
      avatarBg: v('--bg-0',        '#07060e'),
      neonCyan: v('--neon-cyan',   '#00f5d4'),
      glowMul:  parseFloat(v('--canvas-glow-mul', '1.0')) || 1.0,
    };
    return this.themeCache;
  }

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('2D canvas context unavailable');
    this.ctx = ctx;
    this._resize();
    window.addEventListener('resize', () => this._resize());
  }

  private _resize(): void {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = window.innerWidth * this.dpr;
    this.canvas.height = window.innerHeight * this.dpr;
    this.canvas.style.width = `${window.innerWidth}px`;
    this.canvas.style.height = `${window.innerHeight}px`;
  }

  worldToScreen(p: Vec3, listener: Vec3): { x: number; y: number } {
    return {
      x: (p.x - listener.x) * this.zoom + window.innerWidth / 2,
      y: (p.z - listener.z) * this.zoom + window.innerHeight / 2,
    };
  }

  screenToWorld(sx: number, sy: number, listener: Vec3): Vec3 {
    return {
      x: (sx - window.innerWidth / 2) / this.zoom + listener.x,
      y: 0,
      z: (sy - window.innerHeight / 2) / this.zoom + listener.z,
    };
  }

  setZoom(z: number): number {
    this.zoom = Math.max(Renderer.MIN_ZOOM, Math.min(Renderer.MAX_ZOOM, z));
    return this.zoom;
  }

  /** Call when a node is removed so its anim state is GC'd. */
  cleanupNode(id: NodeId): void {
    this._animStates.delete(id);
  }

  private _animState(id: NodeId): NodeAnimState {
    let s = this._animStates.get(id);
    if (!s) { s = { sparks: [], ripples: [], shockwaves: [], lastEnergy: 0 }; this._animStates.set(id, s); }
    return s;
  }

  render(state: RenderState, totalEnergy: number): void {
    this._now = performance.now();
    const { ctx, dpr } = this;
    const W = window.innerWidth;
    const H = window.innerHeight;

    ctx.save();
    ctx.scale(dpr, dpr);

    this.auroraEnergy += (totalEnergy - this.auroraEnergy) * 0.08;
    this._drawBackground(W, H);

    this._drawGrid(W, H, state);
    this._drawRealms(state);
    this._drawPortals(state);

    // Update bloom: find loudest node this frame, fire bloom on loud peak
    let frameMax = 0;
    for (const [, frame] of state.frames) frameMax = Math.max(frameMax, frame.rmsEnergy);
    if (frameMax > 0.55 && this._peakEnergy < 0.35) {
      this._bloomFlash = Math.min(1, this._bloomFlash + (frameMax - 0.35) * this.visualIntensity * 2.5);
    }
    this._peakEnergy += (frameMax - this._peakEnergy) * 0.1;

    this._drawPeerTrails(state);
    this._drawTrails(state);
    this._drawGhostTrail(state);
    this._drawShockwaves(state);
    this._drawLinks(state);
    this._drawResonanceBridges(state);

    for (const [id, descriptor] of state.nodes) {
      const frame = state.frames.get(id);
      const screen = this.worldToScreen(descriptor.position, state.listener);
      this._drawNode(descriptor, screen, frame);
    }

    for (const [peerId, peer] of state.peers) {
      const screen = this.worldToScreen(peer.position, state.listener);
      const chat = state.peerChats.get(peerId);
      const bubble = chat && chat.at + 5500 > performance.now() ? chat.text : undefined;
      this._drawAvatar(screen, peer.color, false, peerId.slice(0, 4), bubble);
    }

    this._drawAvatar({ x: W / 2, y: H / 2 }, this._theme().neonCyan, true, 'YOU');

    this._drawMinimap(state, W, H);

    ctx.restore();
  }

  private _drawMinimap(state: RenderState, W: number, H: number): void {
    const { ctx } = this;
    const size = 140;
    const pad = 16;
    const x = pad;
    const y = H - size - 44;

    // Compute world bounds from all nodes + listener so the map auto-zooms
    let minX = state.listener.x - 200, maxX = state.listener.x + 200;
    let minZ = state.listener.z - 200, maxZ = state.listener.z + 200;
    for (const n of state.nodes.values()) {
      if (n.position.x < minX) minX = n.position.x;
      if (n.position.x > maxX) maxX = n.position.x;
      if (n.position.z < minZ) minZ = n.position.z;
      if (n.position.z > maxZ) maxZ = n.position.z;
    }
    for (const p of state.peers.values()) {
      if (p.position.x < minX) minX = p.position.x;
      if (p.position.x > maxX) maxX = p.position.x;
      if (p.position.z < minZ) minZ = p.position.z;
      if (p.position.z > maxZ) maxZ = p.position.z;
    }
    const rangeX = Math.max(400, maxX - minX);
    const rangeZ = Math.max(400, maxZ - minZ);
    const range = Math.max(rangeX, rangeZ) * 1.15; // breathing room
    const cx = (minX + maxX) / 2;
    const cz = (minZ + maxZ) / 2;

    const worldToMap = (wx: number, wz: number) => ({
      x: x + size / 2 + ((wx - cx) / range) * size,
      y: y + size / 2 + ((wz - cz) / range) * size,
    });

    // Background
    const t2 = this._theme();
    ctx.fillStyle = scaleAlpha(t2.bg0, 1.4);
    ctx.strokeStyle = t2.grid;
    ctx.lineWidth = 1;
    ctx.fillRect(x, y, size, size);
    ctx.strokeRect(x, y, size, size);

    // Crosshair through centre
    ctx.strokeStyle = t2.grid;
    ctx.beginPath();
    ctx.moveTo(x, y + size / 2); ctx.lineTo(x + size, y + size / 2);
    ctx.moveTo(x + size / 2, y); ctx.lineTo(x + size / 2, y + size);
    ctx.stroke();

    // Nodes as colored dots
    for (const n of state.nodes.values()) {
      const p = worldToMap(n.position.x, n.position.z);
      ctx.fillStyle = n.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
      ctx.fill();
    }

    // Peers as small diamonds
    for (const peer of state.peers.values()) {
      const p = worldToMap(peer.position.x, peer.position.z);
      ctx.fillStyle = peer.color;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(Math.PI / 4);
      ctx.fillRect(-3, -3, 6, 6);
      ctx.restore();
    }

    // Local avatar (you)
    const me = worldToMap(state.listener.x, state.listener.z);
    ctx.fillStyle = '#00f5d4';
    ctx.shadowColor = '#00f5d4';
    ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.arc(me.x, me.y, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;

    // Label
    ctx.fillStyle = t2.textDim;
    ctx.font = '9px JetBrains Mono, monospace';
    ctx.textAlign = 'left';
    ctx.fillText('RADAR', x + 4, y - 4);
  }

  private _drawBackground(W: number, H: number): void {
    const { ctx } = this;
    const theme = this._theme();
    const vi = this.visualIntensity;

    // Decay bloom flash ~10 frames half-life
    this._bloomFlash *= 0.82;

    const intensity = this.auroraEnergy + this._bloomFlash * vi;

    ctx.fillStyle = theme.bg0;
    ctx.fillRect(0, 0, W, H);

    const grad = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.max(W, H) * 0.7);
    grad.addColorStop(0, scaleAlpha(theme.aurora1, 1 + intensity * 1.3));
    grad.addColorStop(0.5, scaleAlpha(theme.aurora2, 1 + intensity * 1.5));
    grad.addColorStop(1, scaleAlpha(theme.bg0, 0));
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);

    // Extra bloom flash ring at screen centre
    if (this._bloomFlash > 0.05 && vi > 0) {
      const flashR = Math.max(W, H) * 0.55 * (1 - this._bloomFlash * 0.3);
      const fg = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, flashR);
      fg.addColorStop(0, scaleAlpha(theme.aurora1, this._bloomFlash * 0.6 * vi));
      fg.addColorStop(1, scaleAlpha(theme.aurora1, 0));
      ctx.fillStyle = fg;
      ctx.fillRect(0, 0, W, H);
    }
  }

  private _drawPortals(state: RenderState): void {
    if (this._portals.length === 0) return;
    const { ctx } = this;
    const vi = this.visualIntensity;
    const swirl = (this._now / 1000) * 1.5;  // rotation for the swirling look

    for (const p of this._portals) {
      const center = this.worldToScreen(p.center, state.listener);
      const r = p.radius * this.zoom;
      ctx.save();
      ctx.translate(center.x, center.y);

      // Swirling gradient: three offset radial gradients rotating over time.
      // Achieved by rotating the ctx then stamping arcs at different radii.
      for (let i = 0; i < 3; i++) {
        const phase = swirl + (i * Math.PI * 2) / 3;
        const ox = Math.cos(phase) * r * 0.25;
        const oy = Math.sin(phase) * r * 0.25;
        const grad = ctx.createRadialGradient(ox, oy, 0, ox, oy, r);
        grad.addColorStop(0, scaleAlpha(p.color, 0.55 * vi));
        grad.addColorStop(1, scaleAlpha(p.color, 0.0));
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(0, 0, r, 0, Math.PI * 2);
        ctx.fill();
      }
      // Outer ring
      ctx.globalAlpha = 0.9 * vi;
      ctx.strokeStyle = p.color;
      ctx.lineWidth = 2.5;
      ctx.shadowColor = p.color;
      ctx.shadowBlur = 20;
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.shadowBlur = 0;

      // Destination label
      ctx.globalAlpha = 0.95 * vi;
      ctx.fillStyle = '#f8f6ff';
      ctx.font = `600 ${Math.max(10, r / 4)}px "IBM Plex Mono", monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(p.label, 0, 0);

      // Type badge (small icon at bottom)
      ctx.font = '8px "IBM Plex Mono", monospace';
      ctx.globalAlpha = 0.6 * vi;
      ctx.fillText(p.type === 'room' ? '➜ ROOM' : '↔ LOCAL', 0, r + 12);

      ctx.restore();
    }
  }

  private _drawGhostTrail(state: RenderState): void {
    if (this._ghostPoints.length < 2) return;
    const { ctx } = this;
    const vi = this.visualIntensity;
    const theme = this._theme();
    ctx.save();
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (let i = 1; i < this._ghostPoints.length; i++) {
      const a = this._ghostPoints[i - 1]!;
      const b = this._ghostPoints[i]!;
      const p1 = this.worldToScreen({ x: a.x, y: 0, z: a.z }, state.listener);
      const p2 = this.worldToScreen({ x: b.x, y: 0, z: b.z }, state.listener);
      // Segment alpha = min of the two endpoint alphas — trail fades away
      // smoothly at the tail end.
      const segAlpha = Math.min(a.alpha, b.alpha) * 0.6 * vi;
      if (segAlpha <= 0.001) continue;
      ctx.globalAlpha = segAlpha;
      ctx.strokeStyle = theme.aurora1;
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.stroke();
      // Small pulsing dot at the newer endpoint for texture
      ctx.globalAlpha = segAlpha * 1.4;
      ctx.fillStyle = theme.aurora2;
      ctx.beginPath();
      ctx.arc(p2.x, p2.y, 1.8, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  private _drawRealms(state: RenderState): void {
    const { ctx } = this;
    const vi = this.visualIntensity;
    for (const realm of this._realms) {
      const center = this.worldToScreen(realm.center, state.listener);
      const r = realm.radius * this.zoom;
      const isSelected = realm.id === this._selectedRealmId;

      // Translucent fill — brighter when selected. Default composite mode
      // (source-over with alpha) blends overlapping realm colors naturally.
      ctx.save();
      const grad = ctx.createRadialGradient(center.x, center.y, r * 0.2, center.x, center.y, r);
      const innerA = (isSelected ? 0.18 : 0.10) * vi;
      grad.addColorStop(0, scaleAlpha(realm.color, innerA));
      grad.addColorStop(1, scaleAlpha(realm.color, 0.0));
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(center.x, center.y, r, 0, Math.PI * 2);
      ctx.fill();

      // Border ring — brighter + thicker + glow when selected
      ctx.globalAlpha = (isSelected ? 0.9 : 0.55) * vi;
      ctx.strokeStyle = realm.color;
      ctx.lineWidth = isSelected ? 2.5 : 1.5;
      ctx.setLineDash(isSelected ? [] : [6, 6]);
      if (isSelected) {
        ctx.shadowColor = realm.color;
        ctx.shadowBlur = 16;
      }
      ctx.beginPath();
      ctx.arc(center.x, center.y, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.shadowBlur = 0;

      // Faint centered realm name — sized to the realm radius, always readable
      // but recedes so nodes stay the focus. Skips if the realm is very small.
      if (r > 60) {
        ctx.globalAlpha = 0.14 * vi;
        const size = Math.max(11, Math.min(28, r / 4));
        ctx.font = `700 ${size}px "IBM Plex Mono", monospace`;
        ctx.fillStyle = realm.color;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(realm.name, center.x, center.y);
      }

      // Label ribbon at top of the realm — hint that it's clickable
      ctx.globalAlpha = 0.95 * vi;
      ctx.font = '10px "IBM Plex Mono", monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      const text = `${realm.name} · ${realm.key} · ${realm.bpm} BPM`;
      const y = center.y - r - 8;
      const w = ctx.measureText(text).width + 20;
      // Rounded pill background so the label reads as a clickable button
      const bx = center.x - w / 2;
      const by = y - 13;
      ctx.fillStyle = 'rgba(7, 6, 14, 0.82)';
      ctx.strokeStyle = scaleAlpha(realm.color, 0.6);
      ctx.lineWidth = 1;
      const rr = 6;
      ctx.beginPath();
      ctx.moveTo(bx + rr, by);
      ctx.lineTo(bx + w - rr, by);
      ctx.arcTo(bx + w, by, bx + w, by + rr, rr);
      ctx.lineTo(bx + w, by + 15 - rr);
      ctx.arcTo(bx + w, by + 15, bx + w - rr, by + 15, rr);
      ctx.lineTo(bx + rr, by + 15);
      ctx.arcTo(bx, by + 15, bx, by + 15 - rr, rr);
      ctx.lineTo(bx, by + rr);
      ctx.arcTo(bx, by, bx + rr, by, rr);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = realm.color;
      ctx.fillText(text, center.x, y);
      ctx.restore();
    }
  }

  private _drawGrid(W: number, H: number, state: RenderState): void {
    const { ctx } = this;
    const spacing = 64;
    const offsetX = ((state.listener.x % spacing) + spacing) % spacing;
    const offsetY = ((state.listener.z % spacing) + spacing) % spacing;

    ctx.strokeStyle = this._theme().grid;
    ctx.lineWidth = 1;

    // Bass nodes distort nearby grid intersections
    const bassNodes: Array<{ pos: { x: number; y: number }; energy: number; radius: number }> = [];
    for (const [id, n] of state.nodes) {
      if (n.params.type !== 'bass') continue;
      const screen = this.worldToScreen(n.position, state.listener);
      const energy = state.frames.get(id)?.rmsEnergy ?? 0;
      bassNodes.push({ pos: screen, energy, radius: n.outerRadius });
    }

    const distort = (x: number, y: number): { x: number; y: number } => {
      let dx = 0, dy = 0;
      for (const b of bassNodes) {
        const ddx = x - b.pos.x, ddy = y - b.pos.y;
        const dist = Math.hypot(ddx, ddy);
        if (dist < b.radius && dist > 1) {
          const pull = (1 - dist / b.radius) * b.energy * 22;
          dx += (ddx / dist) * pull;
          dy += (ddy / dist) * pull;
        }
      }
      return { x: x + dx, y: y + dy };
    };

    // Vertical lines (distorted polyline so they ripple near bass)
    for (let x = -offsetX; x < W + spacing; x += spacing) {
      ctx.beginPath();
      for (let y = 0; y < H + spacing; y += spacing / 4) {
        const p = distort(x, y);
        if (y === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
    }
    // Horizontal lines
    for (let y = -offsetY; y < H + spacing; y += spacing) {
      ctx.beginPath();
      for (let x = 0; x < W + spacing; x += spacing / 4) {
        const p = distort(x, y);
        if (x === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
    }
  }

  private _drawPeerTrails(state: RenderState): void {
    const { ctx } = this;
    for (const [id, trail] of state.peerTrails) {
      const peer = state.peers.get(id);
      if (!peer || trail.length < 2) continue;
      ctx.strokeStyle = peer.color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 0; i < trail.length; i++) {
        const sp = this.worldToScreen(trail[i]!, state.listener);
        if (i === 0) ctx.moveTo(sp.x, sp.y);
        else ctx.lineTo(sp.x, sp.y);
      }
      ctx.globalAlpha = 0.22;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  private _drawTrails(state: RenderState): void {
    if (this.visualIntensity === 0) return;
    const { ctx } = this;
    for (const [id, trail] of state.trails) {
      const node = state.nodes.get(id);
      if (!node || trail.length < 2) continue;
      const frame  = state.frames.get(id);
      const energy = frame?.rmsEnergy ?? 0;
      const fftBands = frame?.frequencyData;

      // Convert trail world positions → screen
      const pts = trail.map(p => this.worldToScreen(p, state.listener));
      const n = pts.length;

      // Build ribbon polygon using perpendicular normals at each point
      const upper: Array<{ x: number; y: number }> = [];
      const lower: Array<{ x: number; y: number }> = [];

      for (let i = 0; i < n; i++) {
        const age = i / (n - 1);                     // 0=oldest, 1=newest
        // Width: taper from thin at tail → thick at head, modulated by FFT band
        const bandIdx = Math.floor((i / n) * (fftBands ? Math.floor(fftBands.length / 4) : 0));
        const bandAmp  = fftBands ? (fftBands[bandIdx] ?? 0) / 255 : energy;
        const halfW    = (1.5 + age * (4 + energy * 10) + bandAmp * 6) * this.visualIntensity;

        // Perpendicular: use segment direction
        const prev = pts[Math.max(0, i - 1)]!;
        const next = pts[Math.min(n - 1, i + 1)]!;
        let dx = next.x - prev.x, dy = next.y - prev.y;
        const len = Math.hypot(dx, dy) || 1;
        dx /= len; dy /= len;
        // Normal = (-dy, dx)
        const nx = -dy, ny = dx;

        const cur = pts[i]!;
        upper.push({ x: cur.x + nx * halfW, y: cur.y + ny * halfW });
        lower.push({ x: cur.x - nx * halfW, y: cur.y - ny * halfW });
      }

      // Draw ribbon as filled polygon (upper edge forward, lower edge backward)
      ctx.beginPath();
      ctx.moveTo(upper[0]!.x, upper[0]!.y);
      for (const p of upper) ctx.lineTo(p.x, p.y);
      for (let i = lower.length - 1; i >= 0; i--) ctx.lineTo(lower[i]!.x, lower[i]!.y);
      ctx.closePath();

      // Gradient along ribbon: transparent at tail, opaque at head
      const tail = pts[0]!, head = pts[n - 1]!;
      const grad = ctx.createLinearGradient(tail.x, tail.y, head.x, head.y);
      const baseAlpha = (0.12 + energy * 0.35) * this.visualIntensity;
      grad.addColorStop(0, node.color + '00');
      grad.addColorStop(0.5, node.color + Math.round(baseAlpha * 0.5 * 255).toString(16).padStart(2, '0'));
      grad.addColorStop(1, node.color + Math.round(baseAlpha * 255).toString(16).padStart(2, '0'));
      ctx.fillStyle = grad;
      ctx.fill();
    }
  }

  private _drawShockwaves(state: RenderState): void {
    if (this.visualIntensity === 0) return;
    const { ctx } = this;
    const now = this._now;
    for (const [id, animState] of this._animStates) {
      const node = state.nodes.get(id);
      if (!node) continue;
      const screen = this.worldToScreen(node.position, state.listener);
      const baseR  = 24 * this.zoom;

      for (const sw of animState.shockwaves) {
        const age  = (now - sw.born) / sw.duration;
        if (age >= 1) continue;
        const eased = 1 - (1 - age) * (1 - age);        // ease-out quad
        const r     = baseR + eased * 120 * this.zoom;
        const alpha = (1 - age) * 0.55 * this.visualIntensity;
        ctx.beginPath();
        ctx.arc(screen.x, screen.y, r, 0, Math.PI * 2);
        ctx.strokeStyle = node.color;
        ctx.lineWidth   = (1 - age) * 3 * this.visualIntensity;
        ctx.globalAlpha = alpha;
        ctx.stroke();
        ctx.globalAlpha = 1;
      }

      // Prune expired shockwaves
      animState.shockwaves = animState.shockwaves.filter(sw => (now - sw.born) < sw.duration);
    }
  }

  private _drawLinks(state: RenderState): void {
    const { ctx } = this;
    const t = performance.now() / 1000;
    const INTERVAL_NAMES: Record<number, string> = { 5: '4th', 7: '5th', 12: '8va', 24: '2oct', '-12': '8vb' };
    for (const [srcId, link] of state.links) {
      const src = state.nodes.get(srcId);
      const tgt = state.nodes.get(link.target);
      if (!src || !tgt) continue;
      const ss = this.worldToScreen(src.position, state.listener);
      const st = this.worldToScreen(tgt.position, state.listener);
      const grad = ctx.createLinearGradient(ss.x, ss.y, st.x, st.y);
      grad.addColorStop(0, src.color);
      grad.addColorStop(1, tgt.color);
      ctx.strokeStyle = grad;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 4]);
      ctx.lineDashOffset = -t * 30;
      ctx.globalAlpha = 0.55;
      ctx.beginPath();
      ctx.moveTo(ss.x, ss.y);
      ctx.lineTo(st.x, st.y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      const mx = (ss.x + st.x) / 2, my = (ss.y + st.y) / 2;
      const label = INTERVAL_NAMES[link.interval] ?? `+${link.interval}st`;
      ctx.fillStyle = src.color;
      ctx.font = '8px JetBrains Mono, monospace';
      ctx.textAlign = 'center';
      ctx.globalAlpha = 0.8;
      ctx.fillText(label, mx, my - 4);
      ctx.globalAlpha = 1;
    }
  }

  private _drawResonanceBridges(state: RenderState): void {
    const { ctx } = this;
    const t = performance.now() / 1000;
    for (const { a, b, strength, age } of state.resonancePairs) {
      const na = state.nodes.get(a);
      const nb = state.nodes.get(b);
      if (!na || !nb) continue;
      // Use an eased age curve so the fade-in feels organic, not linear
      const eased = age * age * (3 - 2 * age); // smoothstep
      const sa = this.worldToScreen(na.position, state.listener);
      const sb = this.worldToScreen(nb.position, state.listener);
      const grad = ctx.createLinearGradient(sa.x, sa.y, sb.x, sb.y);
      grad.addColorStop(0, na.color);
      grad.addColorStop(1, nb.color);
      ctx.strokeStyle = grad;
      ctx.lineWidth = (1 + strength * 3) * (0.4 + 0.6 * eased);
      ctx.globalAlpha = (0.3 + strength * 0.5) * eased;
      const wobble = Math.sin(t * 3) * 0.5 + 0.5;
      ctx.setLineDash([12, 6 + wobble * 8]);
      ctx.lineDashOffset = -t * 40;
      ctx.beginPath();
      ctx.moveTo(sa.x, sa.y);
      ctx.lineTo(sb.x, sb.y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }
  }

  private _drawNode(
    node: SpatialNodeDescriptor,
    screen: { x: number; y: number },
    frame: AnalyserFrame | undefined,
  ): void {
    const { ctx } = this;
    const energy = frame?.rmsEnergy ?? 0;
    const baseR = 22;
    const pulseR = baseR + energy * 60;

    const isMuted = node.muted;
    const glowMul = this._theme().glowMul;
    // Outer reactive rings — one per FFT band
    if (frame && !isMuted) {
      const bands = 6;
      const binsPerBand = Math.floor(frame.frequencyData.length / bands / 4);
      for (let i = 0; i < bands; i++) {
        let sum = 0;
        for (let j = 0; j < binsPerBand; j++) {
          sum += frame.frequencyData[i * binsPerBand + j] ?? 0;
        }
        const v = sum / (binsPerBand * 255);
        const r = pulseR + 18 + i * 12 + v * 32;
        ctx.strokeStyle = node.color;
        ctx.globalAlpha = (0.35 - i * 0.04) * (0.4 + v) * glowMul;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(screen.x, screen.y, r, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    // Muted nodes render as dim grey ghosts so it's instantly obvious which
    // are silenced.  The base color is preserved on the inner glyph so you
    // can still identify the synth type.
    const orbColor = isMuted ? '#3a3550' : node.color;
    const glyphColor = isMuted ? '#6b6485' : node.color;

    // Outer glow halo (only when not muted).  Both alpha and radius are
    // scaled by glowMul so light mode produces a tight crisp orb instead of
    // a watercolor bloom.
    if (!isMuted) {
      const haloR = pulseR + 40 * glowMul;
      const glow = ctx.createRadialGradient(screen.x, screen.y, 0, screen.x, screen.y, haloR);
      const a0 = Math.round(204 * glowMul).toString(16).padStart(2, '0'); // 0xcc * mul
      const a1 = Math.round(68  * glowMul).toString(16).padStart(2, '0'); // 0x44 * mul
      glow.addColorStop(0, node.color + a0);
      glow.addColorStop(0.4, node.color + a1);
      glow.addColorStop(1, node.color + '00');
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(screen.x, screen.y, haloR, 0, Math.PI * 2);
      ctx.fill();
    }

    // Core orb (always uses the theme background so the glyph reads clearly)
    ctx.fillStyle = this._theme().avatarBg;
    ctx.beginPath();
    ctx.arc(screen.x, screen.y, baseR, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = orbColor;
    ctx.lineWidth = 2;
    if (isMuted) ctx.setLineDash([4, 3]);
    ctx.stroke();
    ctx.setLineDash([]);

    // Glyph
    ctx.fillStyle = glyphColor;
    ctx.font = '18px JetBrains Mono, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(TYPE_GLYPHS[node.params.type] ?? '●', screen.x, screen.y);

    // Personality animation layer
    if (!isMuted) this._drawPersonality(node, screen, frame);
    ctx.globalAlpha = 1;

    // Label
    const theme = this._theme();
    ctx.fillStyle = isMuted ? theme.textDim : theme.text;
    ctx.font = '10px JetBrains Mono, monospace';
    ctx.globalAlpha = 0.75;
    const labelText = isMuted ? `${node.label.toUpperCase()} · muted` : node.label.toUpperCase();
    ctx.fillText(labelText, screen.x, screen.y + baseR + 14);
    ctx.globalAlpha = 1;
  }

  private _drawAvatar(
    screen: { x: number; y: number },
    color: string,
    isLocal: boolean,
    label: string,
    chatBubble?: string,
  ): void {
    const { ctx } = this;
    const glowMul = this._theme().glowMul;
    const r = isLocal ? 14 : 10;
    // Glow — also scaled by theme glowMul
    const haloR = r + 30 * glowMul;
    const a0 = Math.round(255 * glowMul).toString(16).padStart(2, '0');
    const a1 = Math.round(85  * glowMul).toString(16).padStart(2, '0');
    const g = ctx.createRadialGradient(screen.x, screen.y, 0, screen.x, screen.y, haloR);
    g.addColorStop(0, color + a0);
    g.addColorStop(0.5, color + a1);
    g.addColorStop(1, color + '00');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(screen.x, screen.y, haloR, 0, Math.PI * 2);
    ctx.fill();

    // Diamond
    ctx.save();
    ctx.translate(screen.x, screen.y);
    ctx.rotate(Math.PI / 4);
    ctx.fillStyle = this._theme().avatarBg;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.fillRect(-r, -r, r * 2, r * 2);
    ctx.strokeRect(-r, -r, r * 2, r * 2);
    ctx.restore();

    ctx.fillStyle = color;
    ctx.font = isLocal ? 'bold 9px JetBrains Mono' : '9px JetBrains Mono';
    ctx.textAlign = 'center';
    ctx.fillText(label, screen.x, screen.y + r + 18);

    if (chatBubble) {
      const pad = 6, bh = 20;
      ctx.font = '10px JetBrains Mono, monospace';
      const bw = ctx.measureText(chatBubble).width + pad * 2;
      const bx = screen.x - bw / 2, by = screen.y - r - 32;
      ctx.fillStyle = this._theme().avatarBg;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.globalAlpha = 0.9;
      ctx.beginPath();
      ctx.roundRect(bx, by, bw, bh, 4);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = color;
      ctx.globalAlpha = 1;
      ctx.fillText(chatBubble, screen.x, by + bh / 2 + 3);
    }
  }

  // ── Node personality animations ─────────────────────────────────────────────

  private _drawPersonality(
    node: SpatialNodeDescriptor,
    screen: { x: number; y: number },
    frame: AnalyserFrame | undefined,
  ): void {
    const { ctx } = this;
    const now = this._now;
    const cx = screen.x;
    const cy = screen.y;
    const color = node.color;
    const energy = frame?.rmsEnergy ?? 0;
    const type = node.params.type;

    if (this.visualIntensity === 0) return;
    const vi = this.visualIntensity;
    ctx.save();
    ctx.lineCap = 'round';

    const animSt = this._animState(node.id);

    // Emit shockwave on energy spike (energy jumps above threshold from below)
    const prevEnergy = animSt.lastEnergy;
    if (energy > 0.45 && prevEnergy < 0.35) {
      animSt.shockwaves.push({ born: now, duration: 600 });
    }
    animSt.lastEnergy = energy;

    switch (type) {
      case 'ambient':    this._pAmbient(cx, cy, color, now, energy, vi); break;
      case 'bass':       this._pBass(cx, cy, color, now, node.params.tempo ?? 120, energy, vi); break;
      case 'bells':      this._pBells(cx, cy, color, now, energy, animSt, vi); break;
      case 'percussion': this._pPerc(cx, cy, color, now, node.params.tempo ?? 120, vi); break;
      case 'generative': this._pGenAI(cx, cy, color, now, node.params.arpSpeed ?? 1, vi); break;
      case 'strings':    this._pStrings(cx, cy, color, now, vi); break;
      case 'pad':        this._pPad(cx, cy, color, now, node.params.lfoRate ?? 0.07, vi); break;
      case 'pluck':      this._pPluck(cx, cy, color, now, energy, animSt, vi); break;
      case 'voice':      this._pVoice(cx, cy, color, energy, frame?.timeDomainData, vi); break;
    }

    ctx.restore();
  }

  private _pAmbient(cx: number, cy: number, color: string, now: number, energy: number, vi: number): void {
    const { ctx } = this;
    const breath = 0.5 + 0.5 * Math.sin(now * 0.001 * 0.2 * Math.PI * 2);
    const r = 22 + breath * 14 + energy * 30;
    ctx.strokeStyle = color;
    ctx.globalAlpha = (0.15 + breath * 0.25) * vi;
    ctx.lineWidth = 1.5 + breath;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = (0.08 + breath * 0.12) * vi;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, r + 10 + breath * 6, 0, Math.PI * 2);
    ctx.stroke();
  }

  private _pBass(cx: number, cy: number, color: string, now: number, bpm: number, energy: number, vi: number): void {
    const { ctx } = this;
    const beatMs = 60000 / bpm;
    // Three rings staggered by 1/3 beat — expand outward and fade
    for (let i = 0; i < 3; i++) {
      const phase = ((now / beatMs) + i / 3) % 1;
      const r     = 20 + phase * 65;
      const alpha = (1 - phase) * (0.55 + energy * 0.3) * vi;
      if (alpha < 0.01) continue;
      ctx.strokeStyle = color;
      ctx.globalAlpha = alpha;
      ctx.lineWidth   = (1 - phase) * 3.5 + 0.5;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();
    }
    // Subtle core dot that throbs with the beat
    const beatPhase  = (now / beatMs) % 1;
    const corePulse  = Math.pow(Math.max(0, 1 - beatPhase * 4), 2);
    ctx.fillStyle    = color;
    ctx.globalAlpha  = (0.18 + corePulse * 0.45) * vi;
    ctx.beginPath();
    ctx.arc(cx, cy, 5 + corePulse * 5, 0, Math.PI * 2);
    ctx.fill();
  }

  private _pBells(
    cx: number, cy: number, color: string, now: number,
    energy: number, state: NodeAnimState, vi: number,
  ): void {
    const { ctx } = this;
    if (energy > 0.04 && state.lastEnergy < 0.015) {
      for (let i = 0; i < 10; i++) {
        const angle = Math.random() * Math.PI * 2;
        const speed = 50 + Math.random() * 70;
        state.sparks.push({ x: cx, y: cy, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed - 20, born: now });
      }
    }
    state.lastEnergy = energy;

    state.sparks = state.sparks.filter(s => now - s.born < 400);
    for (const s of state.sparks) {
      const t   = (now - s.born) / 1000;
      const age = t / 0.4;
      const px  = s.x + s.vx * t;
      const py  = s.y + s.vy * t + 60 * t * t;
      ctx.fillStyle = color;
      ctx.globalAlpha = (1 - age) * 0.85 * vi;
      const r = 2.5 * (1 - age * 0.5);
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private _pPerc(cx: number, cy: number, color: string, now: number, bpm: number, vi: number): void {
    const { ctx } = this;
    const beatMs    = 60000 / bpm;
    const beatPhase = (now / beatMs) % 1;

    // Center impact flash — very fast, like the strike point
    const flash = Math.pow(Math.max(0, 1 - beatPhase * 14), 2);
    if (flash > 0.005) {
      ctx.fillStyle   = color;
      ctx.globalAlpha = flash * 0.85 * vi;
      ctx.beginPath();
      ctx.arc(cx, cy, 6 + flash * 8, 0, Math.PI * 2);
      ctx.fill();
    }

    // Single sharp ring that bursts outward and fades in ~200ms
    const ring = Math.pow(Math.max(0, 1 - beatPhase * 9), 2);
    if (ring > 0.005) {
      const r = 18 + (1 - ring) * 44;
      ctx.strokeStyle = color;
      ctx.globalAlpha = ring * 0.8 * vi;
      ctx.lineWidth   = ring * 3.5 + 0.5;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  private _pGenAI(cx: number, cy: number, color: string, now: number, arpSpeed: number, vi: number): void {
    const { ctx } = this;
    const angle = (now * 0.001 * arpSpeed * 1.5) % (Math.PI * 2);
    ctx.translate(cx, cy);
    ctx.rotate(angle);
    for (let i = 0; i < 3; i++) {
      const offset  = (i / 3) * Math.PI * 2;
      const r       = 14 + i * 4;
      const arcLen  = Math.PI * 0.9;
      ctx.strokeStyle = color;
      ctx.globalAlpha = (0.55 - i * 0.1) * vi;
      ctx.lineWidth   = 2 - i * 0.4;
      ctx.beginPath();
      ctx.arc(0, 0, r, offset, offset + arcLen);
      ctx.stroke();
    }
  }

  private _pStrings(cx: number, cy: number, color: string, now: number, vi: number): void {
    const { ctx } = this;
    const lfoHz  = 5.2;
    const amp    = 4;
    const steps  = 64;
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.35 * vi;
    ctx.lineWidth   = 1.5;
    ctx.beginPath();
    for (let i = 0; i <= steps; i++) {
      const theta = (i / steps) * Math.PI * 2;
      const phase = now * 0.001 * lfoHz * Math.PI * 2 + theta * 2.5;
      const r     = 22 + amp * Math.sin(phase);
      const px    = cx + r * Math.cos(theta);
      const py    = cy + r * Math.sin(theta);
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.stroke();
  }

  private _pPad(cx: number, cy: number, color: string, now: number, sweepHz: number, vi: number): void {
    const { ctx } = this;
    const t = now * 0.001;
    // Four rotating arcs at different radii and speeds — dreamy aurora feel
    const arcDefs = [
      { r: 26, speed: 0.07, arcFrac: 0.55, lw: 3.5 },
      { r: 35, speed: 0.05, arcFrac: 0.4,  lw: 2.5 },
      { r: 44, speed: 0.09, arcFrac: 0.3,  lw: 2.0 },
      { r: 52, speed: 0.04, arcFrac: 0.5,  lw: 1.5 },
    ];
    for (let i = 0; i < arcDefs.length; i++) {
      const { r, speed, arcFrac, lw } = arcDefs[i]!;
      const startAngle = (t * speed * Math.PI * 2 + i * (Math.PI / 2.2)) % (Math.PI * 2);
      const arcLen     = Math.PI * 2 * arcFrac * (0.85 + 0.15 * Math.sin(t * sweepHz + i * 1.3));
      const breath     = 0.5 + 0.5 * Math.sin(t * sweepHz * 0.7 + i * 0.9);
      ctx.strokeStyle  = color;
      ctx.globalAlpha  = (0.18 + breath * 0.22) * vi;
      ctx.lineWidth    = lw;
      ctx.beginPath();
      ctx.arc(cx, cy, r, startAngle, startAngle + arcLen);
      ctx.stroke();
    }
    // Soft center glow
    const bloom = 0.5 + 0.5 * Math.sin(t * sweepHz * Math.PI * 2);
    const glowR = 22 + bloom * 12;
    const glow  = ctx.createRadialGradient(cx, cy, 0, cx, cy, glowR);
    glow.addColorStop(0, color + Math.round((0.3 + bloom * 0.25) * 255).toString(16).padStart(2, '0'));
    glow.addColorStop(1, color + '00');
    ctx.fillStyle   = glow;
    ctx.globalAlpha = 0.65 * vi;
    ctx.beginPath();
    ctx.arc(cx, cy, glowR, 0, Math.PI * 2);
    ctx.fill();
  }

  private _pPluck(
    cx: number, cy: number, color: string, now: number,
    energy: number, state: NodeAnimState, vi: number,
  ): void {
    const { ctx } = this;
    if (energy > 0.03 && state.lastEnergy < 0.008) {
      state.ripples.push({ born: now, duration: 300 });
    }
    state.lastEnergy = energy;

    state.ripples = state.ripples.filter(r => now - r.born < r.duration);
    for (const ring of state.ripples) {
      const age = (now - ring.born) / ring.duration;
      const r   = 22 + age * 80;
      ctx.strokeStyle  = color;
      ctx.globalAlpha  = (1 - age) * 0.75 * vi;
      ctx.lineWidth    = Math.max(0.5, 2 - age * 2);
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  private _pVoice(
    cx: number, cy: number, color: string,
    energy: number, waveData: Uint8Array | undefined, vi: number,
  ): void {
    const { ctx } = this;
    if (!waveData || waveData.length === 0) {
      ctx.strokeStyle = color;
      ctx.globalAlpha = (0.2 + energy * 0.5) * vi;
      ctx.lineWidth   = 1.5;
      ctx.beginPath();
      ctx.arc(cx, cy, 22 + energy * 20, 0, Math.PI * 2);
      ctx.stroke();
      return;
    }
    const steps = Math.min(waveData.length, 128);
    ctx.strokeStyle = color;
    ctx.globalAlpha = (0.55 + energy * 0.35) * vi;
    ctx.lineWidth   = 1.5;
    ctx.beginPath();
    for (let i = 0; i <= steps; i++) {
      const idx    = i % steps;
      const theta  = (idx / steps) * Math.PI * 2 - Math.PI / 2;
      const sample = ((waveData[idx] ?? 128) - 128) / 128;
      const r      = 22 + sample * 14 + energy * 18;
      const px     = cx + r * Math.cos(theta);
      const py     = cy + r * Math.sin(theta);
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.stroke();
  }
}
