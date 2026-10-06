// ─────────────────────────────────────────────────────────────────────────────
// @spatial-soundscape/engine — public API surface
// ─────────────────────────────────────────────────────────────────────────────

export { AudioEngine } from './audio/AudioEngine.js';
export { SpatialAudioNode } from './audio/SpatialAudioNode.js';
export { ProceduralSynth } from './synth/ProceduralSynth.js';
export { AnalyserBridge } from './analysis/AnalyserBridge.js';
export { getMicStream, releaseMic } from './audio/MicSource.js';
export { TempoClock } from './synth/TempoClock.js';
export { MicVoice, type MicVoiceStatus } from './synth/ProceduralSynth.js';

export type {
  Vec2,
  Vec3,
  NodeId,
  SynthType,
  WaveShape,
  SynthParams,
  SpatialNodeDescriptor,
  ListenerState,
  AnalyserFrame,
  NetworkEvent,
  Mood,
  MoodAnalysis,
  AudioEngineConfig,
  Realm,
  RealmId,
  RealmType,
  EnvironmentType,
  Portal,
  PortalId,
  PortalType,
} from './types/index.js';

export { makeNodeId, makeRealmId, makePortalId } from './types/index.js';
