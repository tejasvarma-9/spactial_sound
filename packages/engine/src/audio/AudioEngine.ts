import type { AudioEngineConfig, EnvironmentType, ListenerState, NodeId, SpatialNodeDescriptor } from '../types/index.js';
import { SpatialAudioNode } from './SpatialAudioNode.js';

const DEFAULTS = {
  sampleRate: 48_000,
  fftSize: 2048,
  maxNodes: 64,
  defaultReverbLength: 2.5,
} satisfies Required<AudioEngineConfig>;

export class AudioEngine {
  readonly ctx: AudioContext;

  private readonly masterGain: GainNode;
  private readonly compressor: DynamicsCompressorNode;
  private readonly reverbConvolver: ConvolverNode;
  private readonly reverbGain: GainNode;
  private readonly dryGain: GainNode;

  // ── Realm treatment bus ──────────────────────────────────────────────
  // Inserted between the compressor and the destination. Each treatment is
  // an identity when its weight is 0 (extreme cutoff / unity gain / silent
  // modulator) and takes effect as the weight approaches 1.
  private readonly realmLowpass:  BiquadFilterNode;  // bass  → cutoff drops toward 400 Hz
  private readonly realmHighpass: BiquadFilterNode;  // perc  → cutoff rises toward 200 Hz
  private readonly realmTremGain: GainNode;          // chaos → tremolo depth
  private readonly realmTremOsc:  OscillatorNode;    // chaos → 7 Hz LFO
  private readonly realmTremDepth: GainNode;         // chaos → scales LFO into realmTremGain.gain
  private readonly realmMakeup:   GainNode;          // bass  → +3 dB boost when bassW → 1

  // ── Environment bus ──────────────────────────────────────────────────
  // Global acoustic space: replaces the base reverb IR + adds a highshelf
  // filter and an optional comb delay (tunnel).
  private readonly envHighShelf:  BiquadFilterNode;
  private readonly envLowCut:     BiquadFilterNode;  // cathedral direct-signal low cut
  private readonly envCombDelay:  DelayNode;         // tunnel comb filter
  private readonly envCombFB:     GainNode;
  private readonly envCombWet:    GainNode;
  private envCurrent: EnvironmentType = 'none';

  // ── Echo ghost bus ───────────────────────────────────────────────────
  // Master → ghostDelay (~4s) → ghostReverb → ghostGain → destination.
  // ghostGain crossfades from 0 → 0.5 when ghosts are enabled. The signal
  // is reverb-only via a dedicated convolver (larger, wetter than the
  // main space) so the ghost sounds diffuse and disembodied.
  private readonly ghostDelay:    DelayNode;
  private readonly ghostFeedback: GainNode;
  private readonly ghostReverb:   ConvolverNode;
  private readonly ghostGain:     GainNode;

  private readonly nodes = new Map<NodeId, SpatialAudioNode>();
  private readonly config: Required<AudioEngineConfig>;

  private _started = false;

  constructor(config: AudioEngineConfig = {}) {
    this.config = { ...DEFAULTS, ...config };

    this.ctx = new AudioContext({ sampleRate: this.config.sampleRate });

    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = 0.9;

    this.compressor = this.ctx.createDynamicsCompressor();
    this.compressor.threshold.value = -18;
    this.compressor.knee.value = 6;
    this.compressor.ratio.value = 4;
    this.compressor.attack.value = 0.003;
    this.compressor.release.value = 0.25;

    this.reverbConvolver = this.ctx.createConvolver();
    this.reverbGain = this.ctx.createGain();
    this.reverbGain.gain.value = 0.25;
    this.dryGain = this.ctx.createGain();
    this.dryGain.gain.value = 0.75;

    this.masterGain.connect(this.dryGain);
    this.masterGain.connect(this.reverbConvolver);
    this.reverbConvolver.connect(this.reverbGain);
    this.dryGain.connect(this.compressor);
    this.reverbGain.connect(this.compressor);

    // Realm bus: compressor → lowpass → highpass → tremGain → makeup → out
    this.realmLowpass = this.ctx.createBiquadFilter();
    this.realmLowpass.type = 'lowpass';
    this.realmLowpass.frequency.value = 20000;        // bypass by default
    this.realmLowpass.Q.value = 0.707;

    this.realmHighpass = this.ctx.createBiquadFilter();
    this.realmHighpass.type = 'highpass';
    this.realmHighpass.frequency.value = 20;          // bypass by default
    this.realmHighpass.Q.value = 0.707;

    this.realmTremGain = this.ctx.createGain();
    this.realmTremGain.gain.value = 1.0;              // identity + LFO adds/subtracts

    this.realmTremOsc = this.ctx.createOscillator();
    this.realmTremOsc.type = 'sine';
    this.realmTremOsc.frequency.value = 7;            // ~7 Hz tremolo

    this.realmTremDepth = this.ctx.createGain();
    this.realmTremDepth.gain.value = 0;               // no chaos by default → LFO silenced
    this.realmTremOsc.connect(this.realmTremDepth);
    this.realmTremDepth.connect(this.realmTremGain.gain);
    this.realmTremOsc.start();

    this.realmMakeup = this.ctx.createGain();
    this.realmMakeup.gain.value = 1.0;                // no boost by default

    // Environment bus (post-realm) — highshelf + low-cut + optional comb delay
    this.envHighShelf = this.ctx.createBiquadFilter();
    this.envHighShelf.type = 'highshelf';
    this.envHighShelf.frequency.value = 4000;
    this.envHighShelf.gain.value = 0;                 // bypass by default

    this.envLowCut = this.ctx.createBiquadFilter();
    this.envLowCut.type = 'highpass';
    this.envLowCut.frequency.value = 20;              // bypass by default
    this.envLowCut.Q.value = 0.5;

    // Comb filter: input → delay → feedback loop → wet mixed with dry
    this.envCombDelay = this.ctx.createDelay(0.05);
    this.envCombDelay.delayTime.value = 0.018;        // ~18 ms → ~55 Hz comb
    this.envCombFB = this.ctx.createGain();
    this.envCombFB.gain.value = 0;                    // bypass by default
    this.envCombWet = this.ctx.createGain();
    this.envCombWet.gain.value = 0;                   // bypass by default

    // Ghost bus — tap the master pre-compressor for less-squished echoes
    this.ghostDelay = this.ctx.createDelay(6.0);
    this.ghostDelay.delayTime.value = 3.5;              // ~3.5 s echo
    this.ghostFeedback = this.ctx.createGain();
    this.ghostFeedback.gain.value = 0.35;               // long-tail feedback
    this.ghostReverb = this.ctx.createConvolver();
    this.ghostGain = this.ctx.createGain();
    this.ghostGain.gain.value = 0;                      // disabled by default
    this.masterGain.connect(this.ghostDelay);
    this.ghostDelay.connect(this.ghostFeedback);
    this.ghostFeedback.connect(this.ghostDelay);
    this.ghostDelay.connect(this.ghostReverb);
    this.ghostReverb.connect(this.ghostGain);
    this.ghostGain.connect(this.ctx.destination);

    this.compressor.connect(this.realmLowpass);
    this.realmLowpass.connect(this.realmHighpass);
    this.realmHighpass.connect(this.realmTremGain);
    this.realmTremGain.connect(this.realmMakeup);
    // Realm bus feeds environment bus
    this.realmMakeup.connect(this.envHighShelf);
    this.envHighShelf.connect(this.envLowCut);
    // Dry to destination
    this.envLowCut.connect(this.ctx.destination);
    // Comb wet in parallel
    this.envLowCut.connect(this.envCombDelay);
    this.envCombDelay.connect(this.envCombFB);
    this.envCombFB.connect(this.envCombDelay);        // feedback loop
    this.envCombDelay.connect(this.envCombWet);
    this.envCombWet.connect(this.ctx.destination);

    this._buildReverbImpulse(this.config.defaultReverbLength);
    this._buildGhostImpulse();
  }

  private _buildGhostImpulse(): void {
    // Long, wet, diffuse — 3s tail
    const { sampleRate } = this.ctx;
    const length = Math.ceil(sampleRate * 3.0);
    const buffer = this.ctx.createBuffer(2, length, sampleRate);
    const decay = 2.4;
    for (let ch = 0; ch < 2; ch++) {
      const channel = buffer.getChannelData(ch);
      for (let i = 0; i < length; i++) {
        channel[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
      }
    }
    this.ghostReverb.buffer = buffer;
  }

  /** Enable/disable the ghost bus with a smooth crossfade. */
  setGhostsEnabled(enabled: boolean): void {
    const now = this.ctx.currentTime;
    this.ghostGain.gain.setTargetAtTime(enabled ? 0.5 : 0, now, 0.2);
  }

  // Must be triggered by a user gesture to satisfy browser autoplay policy.
  async start(): Promise<void> {
    if (this._started) return;
    if (this.ctx.state === 'suspended') {
      await this.ctx.resume();
    }
    this._started = true;
  }

  async suspend(): Promise<void> {
    await this.ctx.suspend();
  }

  async close(): Promise<void> {
    this.nodes.forEach(n => n.dispose());
    this.nodes.clear();
    try { this.realmTremOsc.stop(); } catch { /* already stopped */ }
    await this.ctx.close();
  }

  get isRunning(): boolean {
    return this.ctx.state === 'running';
  }

  updateListenerPosition(state: ListenerState): void {
    const { listener } = this.ctx;
    const { position, forward, up } = state;

    if (listener.positionX) {
      listener.positionX.value = position.x;
      listener.positionY.value = position.y;
      listener.positionZ.value = position.z;
      listener.forwardX.value = forward.x;
      listener.forwardY.value = forward.y;
      listener.forwardZ.value = forward.z;
      listener.upX.value = up.x;
      listener.upY.value = up.y;
      listener.upZ.value = up.z;
    } else {
      // Fallback for older Safari.
      listener.setPosition(position.x, position.y, position.z);
      listener.setOrientation(forward.x, forward.y, forward.z, up.x, up.y, up.z);
    }
  }

  addNode(descriptor: SpatialNodeDescriptor): SpatialAudioNode {
    if (this.nodes.size >= this.config.maxNodes) {
      throw new Error(`AudioEngine: node limit (${this.config.maxNodes}) reached`);
    }
    if (this.nodes.has(descriptor.id)) {
      throw new Error(`AudioEngine: node "${descriptor.id}" already exists`);
    }
    const node = new SpatialAudioNode(this.ctx, descriptor, this.masterGain);
    this.nodes.set(descriptor.id, node);
    return node;
  }

  removeNode(id: NodeId): void {
    const node = this.nodes.get(id);
    if (!node) return;
    node.dispose();
    this.nodes.delete(id);
  }

  getNode(id: NodeId): SpatialAudioNode | undefined {
    return this.nodes.get(id);
  }

  getAllNodes(): ReadonlyMap<NodeId, SpatialAudioNode> {
    return this.nodes;
  }

  setMasterVolume(value: number, rampMs = 50): void {
    const t = this.ctx.currentTime + rampMs / 1000;
    this.masterGain.gain.linearRampToValueAtTime(Math.max(0, Math.min(1, value)), t);
  }

  setReverbWet(value: number): void {
    this.reverbGain.gain.value = Math.max(0, Math.min(1, value));
    this.dryGain.gain.value = 1 - this.reverbGain.gain.value;
  }

  /**
   * Apply realm-based audio treatment. Each weight is in [0, 1] and reflects
   * how much of that treatment is active based on the listener's proximity
   * to realms of that type. Melodic weight is "bypass" (no effect).
   * All parameter changes cross-fade over `rampSeconds` (default 0.5s).
   */
  setRealmTreatment(
    weights: { bassW?: number; percussiveW?: number; chaosW?: number; melodicW?: number },
    rampSeconds = 0.5,
  ): void {
    const clamp = (v: number) => Math.max(0, Math.min(1, v));
    const bassW = clamp(weights.bassW ?? 0);
    const percW = clamp(weights.percussiveW ?? 0);
    const chaosW = clamp(weights.chaosW ?? 0);
    // melodicW currently has no signal effect; accepted for future use.
    void (weights.melodicW ?? 0);

    // Use setTargetAtTime for a moving-target exponential approach — safe to
    // call every frame without piling up automation events. Time constant ~=
    // rampSeconds/3 so the value reaches ~95% of the target in rampSeconds.
    const now = this.ctx.currentTime;
    const tau = Math.max(0.02, rampSeconds) / 3;
    // Bass: lowpass drops from 20 kHz → 400 Hz as bassW → 1
    const lpCutoff = 20000 * Math.pow(400 / 20000, bassW);   // log-scale
    this.realmLowpass.frequency.setTargetAtTime(lpCutoff, now, tau);
    // Percussive: highpass rises from 20 Hz → 200 Hz as percW → 1
    const hpCutoff = 20 * Math.pow(200 / 20, percW);
    this.realmHighpass.frequency.setTargetAtTime(hpCutoff, now, tau);
    // Chaos: tremolo depth scales with chaosW. LFO amplitude adds to a base
    // gain of 1.0, so full depth = tremolo between (1 − d) and (1 + d).
    this.realmTremDepth.gain.setTargetAtTime(chaosW * 0.35, now, tau);
    // Bass: +3 dB (≈ ×1.41) makeup boost as bassW → 1
    const boost = 1 + bassW * 0.41;
    this.realmMakeup.gain.setTargetAtTime(boost, now, tau);
  }

  createMediaStreamTap(): MediaStreamAudioDestinationNode {
    // Tap after realm + environment so recordings capture the same audio
    // the local listener is hearing (filters, tremolo, boost, env space).
    const tap = this.ctx.createMediaStreamDestination();
    this.envLowCut.connect(tap);
    this.envCombWet.connect(tap);
    return tap;
  }

  removeMediaStreamTap(tap: MediaStreamAudioDestinationNode): void {
    try { this.envLowCut.disconnect(tap); } catch { /* already disconnected */ }
    try { this.envCombWet.disconnect(tap); } catch { /* already disconnected */ }
  }

  // Synthesised impulse response — no external IR file needed.
  // `preDelaySec` adds silence at the start (early-reflection feel for Forest).
  // `stereoWidth` in [0,1]: 0 = mono, 1 = full stereo decorrelation.
  private _buildReverbImpulse(durationSec: number, preDelaySec = 0, stereoWidth = 1.0): void {
    const { sampleRate } = this.ctx;
    const preDelayLen = Math.ceil(sampleRate * preDelaySec);
    const bodyLen    = Math.ceil(sampleRate * durationSec);
    const length     = preDelayLen + bodyLen;
    const buffer = this.ctx.createBuffer(2, length, sampleRate);
    const decay = 3.0;

    // Build two ~identical channels for narrow stereo, decorrelate as width→1
    const seed = () => Math.random() * 2 - 1;
    const shared: number[] = new Array(bodyLen);
    for (let i = 0; i < bodyLen; i++) shared[i] = seed();

    for (let ch = 0; ch < 2; ch++) {
      const channel = buffer.getChannelData(ch);
      // Pre-delay silence
      for (let i = 0; i < preDelayLen; i++) channel[i] = 0;
      for (let i = 0; i < bodyLen; i++) {
        const wide = seed();
        const mixed = shared[i]! * (1 - stereoWidth) + wide * stereoWidth;
        const env = Math.pow(1 - i / bodyLen, decay);
        channel[preDelayLen + i] = mixed * env;
      }
    }
    this.reverbConvolver.buffer = buffer;
  }

  /**
   * Apply a named acoustic environment. Regenerates the master reverb IR
   * (length / pre-delay / stereo width) and adjusts the environment bus
   * highshelf, low-cut, and comb-delay params. Change is roughly immediate
   * (IR is swapped) but wet/filter params ramp smoothly over ~0.5s.
   */
  setEnvironment(env: EnvironmentType): void {
    this.envCurrent = env;
    const now = this.ctx.currentTime;
    const tau = 0.15;   // ~0.5s smoothing
    switch (env) {
      case 'cave':
        this._buildReverbImpulse(2.5, 0, 0.35);            // dark, narrow
        this.reverbGain.gain.setTargetAtTime(0.55, now, tau);
        this.dryGain.gain.setTargetAtTime(0.55, now, tau);
        this.envHighShelf.frequency.setValueAtTime(4000, now);
        this.envHighShelf.gain.setTargetAtTime(-12, now, tau);   // −12 dB above 4 kHz
        this.envLowCut.frequency.setTargetAtTime(20, now, tau);
        this.envCombFB.gain.setTargetAtTime(0, now, tau);
        this.envCombWet.gain.setTargetAtTime(0, now, tau);
        break;
      case 'forest':
        this._buildReverbImpulse(1.2, 0.03, 0.7);          // short + pre-delay
        this.reverbGain.gain.setTargetAtTime(0.35, now, tau);
        this.dryGain.gain.setTargetAtTime(0.75, now, tau);
        this.envHighShelf.frequency.setValueAtTime(6000, now);
        this.envHighShelf.gain.setTargetAtTime(-6, now, tau); // gentle HF damping
        this.envLowCut.frequency.setTargetAtTime(20, now, tau);
        this.envCombFB.gain.setTargetAtTime(0, now, tau);
        this.envCombWet.gain.setTargetAtTime(0, now, tau);
        break;
      case 'cathedral':
        this._buildReverbImpulse(4.0, 0, 1.0);             // long + wide
        this.reverbGain.gain.setTargetAtTime(0.70, now, tau);
        this.dryGain.gain.setTargetAtTime(0.45, now, tau);
        this.envHighShelf.gain.setTargetAtTime(0, now, tau);
        this.envLowCut.frequency.setTargetAtTime(80, now, tau);   // subtle low-cut on direct
        this.envCombFB.gain.setTargetAtTime(0, now, tau);
        this.envCombWet.gain.setTargetAtTime(0, now, tau);
        break;
      case 'tunnel':
        this._buildReverbImpulse(1.5, 0, 0.25);            // narrow, mid-length
        this.reverbGain.gain.setTargetAtTime(0.35, now, tau);
        this.dryGain.gain.setTargetAtTime(0.75, now, tau);
        this.envHighShelf.gain.setTargetAtTime(-4, now, tau);
        this.envLowCut.frequency.setTargetAtTime(20, now, tau);
        this.envCombDelay.delayTime.setTargetAtTime(0.018, now, tau);
        this.envCombFB.gain.setTargetAtTime(0.65, now, tau);      // comb resonance
        this.envCombWet.gain.setTargetAtTime(0.35, now, tau);
        break;
      case 'none':
      default:
        this._buildReverbImpulse(this.config.defaultReverbLength);
        this.reverbGain.gain.setTargetAtTime(0.25, now, tau);
        this.dryGain.gain.setTargetAtTime(0.75, now, tau);
        this.envHighShelf.gain.setTargetAtTime(0, now, tau);
        this.envLowCut.frequency.setTargetAtTime(20, now, tau);
        this.envCombFB.gain.setTargetAtTime(0, now, tau);
        this.envCombWet.gain.setTargetAtTime(0, now, tau);
        break;
    }
  }

  getEnvironment(): EnvironmentType { return this.envCurrent; }
}
