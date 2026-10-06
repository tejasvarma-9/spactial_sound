export interface Vec2 { x: number; y: number }
export interface Vec3 { x: number; y: number; z: number }

// Branded so a generic string can't accidentally stand in for a NodeId.
export type NodeId = string & { readonly _brand: 'NodeId' };

export function makeNodeId(raw: string = crypto.randomUUID()): NodeId {
  return raw as NodeId;
}

export type SynthType = 'ambient' | 'bass' | 'percussion' | 'voice' | 'generative' | 'bells' | 'strings' | 'pad' | 'pluck' | 'piano';

export type WaveShape = OscillatorType;

export interface SynthParams {
  type: SynthType;
  wave: WaveShape;
  frequency: number;
  gain: number;
  attack: number;
  decay: number;
  sustain: number;
  release: number;
  reverbWet: number;
  chorusDepth: number;
  tempo?: number;  // BPM for PLUCK/PERC/GEN-AI periodic timing

  // Per-type sound design params (all optional — voices use internal defaults when absent)
  filterCutoff?:  number;   // Hz: ambient 200-8000, bass 50-500, strings 200-8000, pad 200-6000, pluck 500-8000
  lfoRate?:       number;   // Hz: ambient LFO (0.1-4), pad sweep (0.05-0.5)
  detuneSpread?:  number;   // cents: ambient 0-50, strings 0-100
  drive?:         number;   // 0-1: bass waveshaper saturation
  subMix?:        number;   // 0-1: bass sub-octave oscillator level
  noiseMix?:      number;   // 0-1: perc noise-to-tone ratio (1=pure noise, 0=pure tone)
  arpSpeed?:      number;   // multiplier 0.5-4: generative arp speed relative to BPM
  arpPattern?:    'pentatonic' | 'major' | 'minor' | 'chromatic';
  // Custom step sequence for generative nodes. Each entry is a semitone offset
  // from `frequency` (the root), or `null` for a rest (previous note rings out).
  // When provided, overrides arpPattern. Steps fire at 16th notes at
  // 200 BPM * arpSpeed. Use rests to control note lengths.
  melodyScale?:   (number | null)[];
  fmRatio?:       number;   // 1-8: bells carrier:modulator frequency ratio
  fmDepth?:       number;   // 0-500: bells FM modulation depth
  harmonicMix?:   number;   // 0-1: pluck harmonic oscillator level
  chordVoicing?:  'maj' | 'min' | 'sus4';
  gateThreshold?: number;   // -60 to -20 dB: voice compressor threshold
}

export interface SpatialNodeDescriptor {
  id: NodeId;
  position: Vec3;
  params: SynthParams;
  label: string;
  color: string;
  innerRadius: number;
  outerRadius: number;
  muted: boolean;
  realmId?: RealmId;
}

/*
 * ─── Realms ────────────────────────────────────────────────────────────
 * A Realm is a named circular musical zone. Nodes dropped inside inherit
 * the realm's key (mapped to a root frequency at each node's natural
 * octave) and its BPM. Store in Yjs so all peers see the same realms.
 */
export type EnvironmentType = 'none' | 'cave' | 'forest' | 'cathedral' | 'tunnel';

/*
 * ─── Portals ────────────────────────────────────────────────────────────
 * A Portal is a circular gateway on the canvas.
 *  - 'local' portals come in pairs — walking through one exits from its
 *    twin. Both portals share a `pairId`.
 *  - 'room' portals link to a different room; walking through switches
 *    room with a visual warp + audio crossfade.
 */
export type PortalId = string & { readonly _brand: 'PortalId' };
export function makePortalId(raw: string = crypto.randomUUID()): PortalId {
  return raw as PortalId;
}
export type PortalType = 'local' | 'room';
export interface Portal {
  id: PortalId;
  type: PortalType;
  center: Vec3;
  radius: number;
  color: string;
  pairId?: PortalId;    // set for 'local' portals — the twin's id
  destRoom?: string;    // set for 'room' portals — target room name
  label: string;        // shown inside the portal
}

export type RealmType = 'bass' | 'melodic' | 'percussive' | 'chaos' | 'custom';
export type RealmId   = string & { readonly _brand: 'RealmId' };
export function makeRealmId(raw: string = crypto.randomUUID()): RealmId {
  return raw as RealmId;
}
export interface Realm {
  id: RealmId;
  name: string;
  color: string;
  center: Vec3;      // world coords, same space as node positions (x, y=0, z)
  radius: number;
  type: RealmType;
  key: string;       // note name: 'C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'
  bpm: number;
}

export interface ListenerState {
  position: Vec3;
  forward: Vec3;
  up: Vec3;
}

export interface AnalyserFrame {
  nodeId: NodeId;
  frequencyData: Uint8Array;
  timeDomainData: Uint8Array;
  rmsEnergy: number;
  timestampMs: number;
}

export type NetworkEvent =
  | { type: 'node:add';    payload: SpatialNodeDescriptor }
  | { type: 'node:move';   payload: { id: NodeId; position: Vec3 } }
  | { type: 'node:update'; payload: { id: NodeId; params: Partial<SynthParams> } }
  | { type: 'node:remove'; payload: { id: NodeId } }
  | { type: 'peer:move';   payload: { peerId: string; position: Vec3 } }
  | { type: 'chat:message'; payload: { peerId: string; text: string; timestampMs: number } };

export type Mood = 'positive' | 'neutral' | 'negative';

export interface MoodAnalysis {
  mood: Mood;
  score: number;
  suggestedKey: number;
  suggestedTempo: number;
  suggestedColor: string;
}

export interface AudioEngineConfig {
  sampleRate?: number;
  fftSize?: 512 | 1024 | 2048 | 4096;
  maxNodes?: number;
  defaultReverbLength?: number;
}
