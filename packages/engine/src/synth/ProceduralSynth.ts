import type { SynthParams, SynthType } from '../types/index.js';
import { getMicStream } from '../audio/MicSource.js';
import { TempoClock } from './TempoClock.js';

interface SynthVoice {
  start(): void;
  stop(): void;
  updateParams(params: Partial<SynthParams>): void;
  readonly currentGain: number;
}

class AmbientVoice implements SynthVoice {
  private readonly oscillators: OscillatorNode[] = [];
  private readonly filter: BiquadFilterNode;
  private readonly gainNode: GainNode;
  private readonly lfo: OscillatorNode;
  private readonly lfoGain: GainNode;
  private _gain: number;
  private _spread: number;

  constructor(
    private readonly ctx: AudioContext,
    private params: SynthParams,
    private readonly destination: AudioNode,
  ) {
    this._gain   = params.gain;
    this._spread = params.detuneSpread ?? 8;
    this.gainNode = ctx.createGain();
    this.gainNode.gain.value = params.gain;

    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.frequency.value = params.filterCutoff ?? 800;
    this.filter.Q.value = 0.7;

    this.lfo = ctx.createOscillator();
    this.lfo.type = 'sine';
    this.lfo.frequency.value = params.lfoRate ?? 0.15;
    this.lfoGain = ctx.createGain();
    this.lfoGain.gain.value = 300;
    this.lfo.connect(this.lfoGain);
    this.lfoGain.connect(this.filter.frequency);

    for (const detune of [-this._spread, 0, this._spread]) {
      const osc = ctx.createOscillator();
      osc.type = params.wave;
      osc.frequency.value = params.frequency;
      osc.detune.value = detune;
      osc.connect(this.filter);
      this.oscillators.push(osc);
    }

    this.filter.connect(this.gainNode);
    this.gainNode.connect(destination);
  }

  start(): void {
    this.oscillators.forEach(o => o.start());
    this.lfo.start();
  }

  stop(): void {
    const t = this.ctx.currentTime + 0.5;
    this.gainNode.gain.linearRampToValueAtTime(0, t);
    this.oscillators.forEach(o => o.stop(t));
    this.lfo.stop(t);
  }

  updateParams(params: Partial<SynthParams>): void {
    if (params.frequency !== undefined) {
      const t = this.ctx.currentTime + 0.05;
      this.oscillators.forEach(o =>
        o.frequency.linearRampToValueAtTime(params.frequency!, t),
      );
    }
    if (params.gain !== undefined) {
      this._gain = params.gain;
      this.gainNode.gain.linearRampToValueAtTime(params.gain, this.ctx.currentTime + 0.05);
    }
    if (params.wave !== undefined) {
      this.oscillators.forEach(o => (o.type = params.wave!));
    }
    if (params.filterCutoff !== undefined) {
      this.filter.frequency.linearRampToValueAtTime(params.filterCutoff, this.ctx.currentTime + 0.05);
    }
    if (params.lfoRate !== undefined) {
      this.lfo.frequency.linearRampToValueAtTime(params.lfoRate, this.ctx.currentTime + 0.05);
    }
    if (params.detuneSpread !== undefined) {
      this._spread = params.detuneSpread;
      this.oscillators[0]!.detune.value = -this._spread;
      this.oscillators[1]!.detune.value = 0;
      this.oscillators[2]!.detune.value =  this._spread;
    }
  }

  get currentGain(): number { return this._gain; }
}


class BassVoice implements SynthVoice {
  private readonly osc: OscillatorNode;
  private readonly subOsc: OscillatorNode;
  private readonly subGain: GainNode;
  private readonly waveshaper: WaveShaperNode;
  private readonly filter: BiquadFilterNode;
  private readonly gainNode: GainNode;
  private _gain: number;
  private _drive: number;

  constructor(
    private readonly ctx: AudioContext,
    private params: SynthParams,
    private readonly destination: AudioNode,
  ) {
    this._gain  = params.gain;
    this._drive = params.drive ?? 0.5;

    this.osc = ctx.createOscillator();
    this.osc.type = 'sine';
    this.osc.frequency.value = params.frequency;

    this.subOsc = ctx.createOscillator();
    this.subOsc.type = 'sine';
    this.subOsc.frequency.value = params.frequency / 2;

    this.subGain = ctx.createGain();
    this.subGain.gain.value = params.subMix ?? 0;

    this.waveshaper = ctx.createWaveShaper();
    this.waveshaper.curve = BassVoice._makeSaturationCurve(1 + this._drive * 399);
    this.waveshaper.oversample = '4x';

    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.frequency.value = params.filterCutoff ?? 300;
    this.filter.Q.value = 1.2;

    this.gainNode = ctx.createGain();
    this.gainNode.gain.value = params.gain;

    this.osc.connect(this.waveshaper);
    this.waveshaper.connect(this.filter);
    this.subOsc.connect(this.subGain);
    this.subGain.connect(this.filter);
    this.filter.connect(this.gainNode);
    this.gainNode.connect(destination);
  }

  private static _makeSaturationCurve(amount: number): Float32Array<ArrayBuffer> {
    const samples = 256;
    const curve = new Float32Array(new ArrayBuffer(samples * Float32Array.BYTES_PER_ELEMENT));
    const k = amount;
    for (let i = 0; i < samples; i++) {
      const x = (i * 2) / samples - 1;
      curve[i] = ((Math.PI + k) * x) / (Math.PI + k * Math.abs(x));
    }
    return curve;
  }

  start(): void {
    this.osc.start();
    this.subOsc.start();
  }

  stop(): void {
    const t = this.ctx.currentTime + 0.1;
    this.gainNode.gain.linearRampToValueAtTime(0, t);
    this.osc.stop(t + 0.05);
    this.subOsc.stop(t + 0.05);
  }

  updateParams(params: Partial<SynthParams>): void {
    if (params.frequency !== undefined) {
      const t = this.ctx.currentTime + 0.05;
      this.osc.frequency.linearRampToValueAtTime(params.frequency, t);
      this.subOsc.frequency.linearRampToValueAtTime(params.frequency / 2, t);
    }
    if (params.gain !== undefined) {
      this._gain = params.gain;
      this.gainNode.gain.linearRampToValueAtTime(params.gain, this.ctx.currentTime + 0.05);
    }
    if (params.filterCutoff !== undefined) {
      this.filter.frequency.linearRampToValueAtTime(params.filterCutoff, this.ctx.currentTime + 0.05);
    }
    if (params.drive !== undefined) {
      this._drive = params.drive;
      this.waveshaper.curve = BassVoice._makeSaturationCurve(1 + this._drive * 399);
    }
    if (params.subMix !== undefined) {
      this.subGain.gain.linearRampToValueAtTime(params.subMix, this.ctx.currentTime + 0.05);
    }
  }

  get currentGain(): number { return this._gain; }
}


class PercussionVoice implements SynthVoice {
  private readonly bufferSource: AudioBufferSourceNode;
  private readonly filter: BiquadFilterNode;
  private readonly noiseGain: GainNode;
  private readonly toneOsc: OscillatorNode;
  private readonly toneGain: GainNode;
  private readonly gainNode: GainNode;
  private _gain: number;
  private _playing = false;
  private _disposed = false;
  private _percTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly ctx: AudioContext,
    private params: SynthParams,
    private readonly destination: AudioNode,
  ) {
    this._gain = params.gain;
    const noiseMix = params.noiseMix ?? 1;

    this.gainNode = ctx.createGain();
    this.gainNode.gain.value = 0;

    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'bandpass';
    this.filter.frequency.value = params.frequency;
    this.filter.Q.value = 0.5;

    this.noiseGain = ctx.createGain();
    this.noiseGain.gain.value = noiseMix;

    this.bufferSource = ctx.createBufferSource();
    this.bufferSource.buffer = this._makeNoiseBuffer(0.3);
    this.bufferSource.loop = true;

    this.toneOsc = ctx.createOscillator();
    this.toneOsc.type = 'sine';
    this.toneOsc.frequency.value = params.frequency;

    this.toneGain = ctx.createGain();
    this.toneGain.gain.value = 1 - noiseMix;

    this.bufferSource.connect(this.filter);
    this.filter.connect(this.noiseGain);
    this.toneOsc.connect(this.toneGain);
    this.noiseGain.connect(this.gainNode);
    this.toneGain.connect(this.gainNode);
    this.gainNode.connect(destination);
  }

  private _makeNoiseBuffer(durationSec: number): AudioBuffer {
    const { sampleRate } = this.ctx;
    const length = Math.ceil(sampleRate * durationSec);
    const buffer = this.ctx.createBuffer(1, length, sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    return buffer;
  }

  start(): void {
    this.bufferSource.start();
    this.toneOsc.start();
    this._playing = true;
    this._triggerHit();
    if (this.params.tempo !== undefined && this.params.tempo > 0) {
      this._startPercTimer(this.params.tempo);
    }
  }

  private _startPercTimer(bpm: number): void {
    if (this._percTimer) clearInterval(this._percTimer);
    const ms = Math.round(60000 / bpm / 4);
    this._percTimer = setInterval(() => { if (!this._disposed) this._triggerHit(); }, ms);
  }

  triggerHit(): void {
    if (!this._playing) return;
    this._triggerHit();
  }

  private _triggerHit(): void {
    const now = this.ctx.currentTime;
    const g = this.gainNode.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(0, now);
    g.linearRampToValueAtTime(this._gain, now + this.params.attack);
    g.setTargetAtTime(this.params.sustain * this._gain, now + this.params.decay, this.params.release);
  }

  stop(): void {
    this._disposed = true;
    if (this._percTimer) { clearInterval(this._percTimer); this._percTimer = null; }
    this.gainNode.gain.linearRampToValueAtTime(0, this.ctx.currentTime + 0.05);
    this.bufferSource.stop(this.ctx.currentTime + 0.1);
    this.toneOsc.stop(this.ctx.currentTime + 0.1);
    this._playing = false;
  }

  updateParams(params: Partial<SynthParams>): void {
    if (params.frequency !== undefined) {
      this.filter.frequency.value = params.frequency;
      this.toneOsc.frequency.value = params.frequency;
    }
    if (params.gain !== undefined) this._gain = params.gain;
    if (params.noiseMix !== undefined) {
      this.noiseGain.gain.linearRampToValueAtTime(params.noiseMix, this.ctx.currentTime + 0.05);
      this.toneGain.gain.linearRampToValueAtTime(1 - params.noiseMix, this.ctx.currentTime + 0.05);
    }
    if (params.tempo !== undefined) {
      if (this._percTimer) { clearInterval(this._percTimer); this._percTimer = null; }
      if (params.tempo > 0 && this._playing) this._startPercTimer(params.tempo);
    }
  }

  get currentGain(): number { return this._gain; }
}


const ARP_SCALES: Record<string, (number | null)[]> = {
  pentatonic: [0, 2, 4, 7, 9, 12, 14, 16, 19, 21],
  major:      [0, 2, 4, 5, 7, 9, 11, 12, 14, 16],
  minor:      [0, 2, 3, 5, 7, 8, 10, 12, 14, 15],
  chromatic:  [0, 1, 2, 3, 4, 5,  6,  7,  8,  9],
};

class GenerativeVoice implements SynthVoice {
  private readonly osc: OscillatorNode;
  private readonly filter: BiquadFilterNode;
  private readonly gainNode: GainNode;
  private _gain: number;
  private _stepIndex = 0;
  private _rootHz: number;
  private _baseBpm = 200;
  private _arpSpeed: number;
  private _scale: (number | null)[];
  private clock: TempoClock | null = null;
  private _disposed = false;

  constructor(
    private readonly ctx: AudioContext,
    private params: SynthParams,
    private readonly destination: AudioNode,
  ) {
    this._gain     = params.gain;
    this._rootHz   = params.frequency;
    this._arpSpeed = params.arpSpeed ?? 1;
    // melodyScale overrides arpPattern when present — used for encoded riffs.
    this._scale    = params.melodyScale ?? ARP_SCALES[params.arpPattern ?? 'pentatonic']!;

    this.osc = ctx.createOscillator();
    this.osc.type = params.wave;
    this.osc.frequency.value = this._rootHz;

    // Gentle lowpass to remove ear-piercing high harmonics from sawtooth/square.
    // Cutoff scales with root freq so bass melodies stay warm, leads stay bright.
    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.frequency.value = params.filterCutoff ?? Math.max(1600, this._rootHz * 10);
    this.filter.Q.value = 0.5;

    this.gainNode = ctx.createGain();
    this.gainNode.gain.value = 0;

    this.osc.connect(this.filter);
    this.filter.connect(this.gainNode);
    this.gainNode.connect(destination);
  }

  start(): void {
    this.osc.start();
    void TempoClock.create(this.ctx, this._baseBpm * this._arpSpeed).then((clock) => {
      if (this._disposed) { clock.dispose(); return; }
      this.clock = clock;
      clock.onBeat = (audioTime) => this._scheduleStep(audioTime);
    }).catch((err) => {
      console.warn('AudioWorklet unavailable, falling back to setInterval:', err);
      const id = setInterval(() => this._scheduleStep(this.ctx.currentTime), 300);
      this.clock = { dispose: () => clearInterval(id), setBpm: () => {}, reset: () => {} } as unknown as TempoClock;
    });
  }

  private _scheduleStep(audioTime: number): void {
    if (this._disposed) return;
    const step = this._scale[this._stepIndex % this._scale.length];
    this._stepIndex++;
    // null / out-of-range = rest: leave osc and gain alone so the previous note rings out
    if (step === null || step === undefined) return;
    const freq = this._rootHz * Math.pow(2, step / 12);
    const g = this.gainNode.gain;
    this.osc.frequency.setValueAtTime(freq, audioTime);
    // Note envelope: short attack → sustain at ~55% until next note cancels us
    // (via `cancelScheduledValues` on the next step). Rests still let the note
    // ring out audibly because the sustain target is non-zero.
    g.cancelScheduledValues(audioTime);
    g.setValueAtTime(0, audioTime);
    g.linearRampToValueAtTime(this._gain, audioTime + 0.015);
    g.setTargetAtTime(this._gain * 0.55, audioTime + 0.10, 0.35);
  }

  stop(): void {
    this._disposed = true;
    this.clock?.dispose();
    this.clock = null;
    const t = this.ctx.currentTime;
    this.gainNode.gain.cancelScheduledValues(t);
    this.gainNode.gain.linearRampToValueAtTime(0, t + 0.1);
    this.osc.stop(t + 0.15);
  }

  updateParams(params: Partial<SynthParams>): void {
    if (params.frequency !== undefined) this._rootHz = params.frequency;
    if (params.gain !== undefined) this._gain = params.gain;
    if (params.wave !== undefined) this.osc.type = params.wave;
    if (params.arpSpeed !== undefined) {
      this._arpSpeed = params.arpSpeed;
      this.clock?.setBpm(this._baseBpm * this._arpSpeed);
    }
    if (params.arpPattern !== undefined) {
      this._scale = ARP_SCALES[params.arpPattern] ?? ARP_SCALES['pentatonic']!;
      this._stepIndex = 0;
    }
    if (params.melodyScale !== undefined) {
      this._scale = params.melodyScale;
      this._stepIndex = 0;
    }
    if (params.tempo !== undefined && params.tempo > 0) {
      this._baseBpm = params.tempo;
      this.clock?.setBpm(this._baseBpm * this._arpSpeed);
    }
  }

  get currentGain(): number { return this._gain; }
}


class BellsVoice implements SynthVoice {
  private readonly carrier: OscillatorNode;
  private readonly modulator: OscillatorNode;
  private readonly modGain: GainNode;
  private readonly masterGain: GainNode;
  private _gain: number;
  private _fmRatio: number;
  private _fmDepth: number;
  private _decayTime: number;
  private _disposed = false;
  private _ringTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly ctx: AudioContext,
    private readonly params: SynthParams,
    destination: AudioNode,
  ) {
    this._gain      = params.gain;
    this._fmRatio   = params.fmRatio   ?? 3.5;
    this._fmDepth   = params.fmDepth   ?? -1;  // -1 = auto (freq * 6)
    this._decayTime = params.decay      ?? 3.5;
    const freq = params.frequency;

    this.carrier = ctx.createOscillator();
    this.carrier.type = 'sine';
    this.carrier.frequency.value = freq;

    this.modulator = ctx.createOscillator();
    this.modulator.type = 'sine';
    this.modulator.frequency.value = freq * this._fmRatio;

    this.modGain = ctx.createGain();
    this.modGain.gain.value = this._fmDepth < 0 ? freq * 6 : this._fmDepth;

    this.masterGain = ctx.createGain();
    this.masterGain.gain.value = 0;

    this.modulator.connect(this.modGain);
    this.modGain.connect(this.carrier.frequency);
    this.carrier.connect(this.masterGain);
    this.masterGain.connect(destination);
  }

  private _scheduleBell(): void {
    const now  = this.ctx.currentTime;
    const freq = this.carrier.frequency.value;
    const depth = this._fmDepth < 0 ? freq * 6 : this._fmDepth;
    this.modGain.gain.cancelScheduledValues(now);
    this.modGain.gain.setValueAtTime(depth, now);
    this.modGain.gain.exponentialRampToValueAtTime(0.01, now + this._decayTime * 0.5);
    const g = this.masterGain.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(0, now);
    g.linearRampToValueAtTime(this._gain, now + 0.002);
    g.exponentialRampToValueAtTime(0.001, now + this._decayTime);
  }

  private _restartTimer(): void {
    if (this._ringTimer !== null) clearInterval(this._ringTimer);
    this._ringTimer = setInterval(() => {
      if (!this._disposed) this._scheduleBell();
    }, this._decayTime * 1000);
  }

  start(): void {
    this.carrier.start();
    this.modulator.start();
    this._scheduleBell();
    this._restartTimer();
  }

  stop(): void {
    this._disposed = true;
    if (this._ringTimer !== null) clearInterval(this._ringTimer);
    const t = this.ctx.currentTime;
    this.masterGain.gain.cancelScheduledValues(t);
    this.masterGain.gain.linearRampToValueAtTime(0, t + 0.05);
    this.carrier.stop(t + 0.1);
    this.modulator.stop(t + 0.1);
  }

  updateParams(params: Partial<SynthParams>): void {
    if (params.frequency !== undefined) {
      this.carrier.frequency.value = params.frequency;
      this.modulator.frequency.value = params.frequency * this._fmRatio;
    }
    if (params.fmRatio !== undefined) {
      this._fmRatio = params.fmRatio;
      this.modulator.frequency.value = this.carrier.frequency.value * this._fmRatio;
    }
    if (params.fmDepth !== undefined) {
      this._fmDepth = params.fmDepth;
      this.modGain.gain.setValueAtTime(this._fmDepth, this.ctx.currentTime);
    }
    if (params.decay !== undefined) {
      this._decayTime = Math.max(0.5, params.decay);
      this._restartTimer();
    }
    if (params.gain !== undefined) this._gain = params.gain;
  }

  get currentGain(): number { return this._gain; }
}


class StringsVoice implements SynthVoice {
  private readonly oscs: OscillatorNode[] = [];
  private readonly filter: BiquadFilterNode;
  private readonly gainNode: GainNode;
  private readonly lfo: OscillatorNode;
  private readonly lfoGain: GainNode;
  private _gain: number;

  constructor(
    private readonly ctx: AudioContext,
    private readonly params: SynthParams,
    destination: AudioNode,
  ) {
    this._gain = params.gain;
    this.gainNode = ctx.createGain();
    this.gainNode.gain.value = 0;

    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.frequency.value = params.filterCutoff ?? 1800;
    this.filter.Q.value = 0.5;

    // Slow vibrato LFO.
    this.lfo = ctx.createOscillator();
    this.lfo.type = 'sine';
    this.lfo.frequency.value = 5.2;
    this.lfoGain = ctx.createGain();
    this.lfoGain.gain.value = 5;
    this.lfo.connect(this.lfoGain);
    this.lfoGain.connect(this.filter.frequency);

    for (const detune of [-14, -5, 5, 14]) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = params.frequency;
      osc.detune.value = detune;
      osc.connect(this.filter);
      this.oscs.push(osc);
    }
    this.filter.connect(this.gainNode);
    this.gainNode.connect(destination);
  }

  start(): void {
    this.oscs.forEach(o => o.start());
    this.lfo.start();
    const now = this.ctx.currentTime;
    this.gainNode.gain.setValueAtTime(0, now);
    this.gainNode.gain.linearRampToValueAtTime(this._gain, now + 1.2);
  }

  stop(): void {
    const t = this.ctx.currentTime;
    this.gainNode.gain.linearRampToValueAtTime(0, t + 0.5);
    this.oscs.forEach(o => o.stop(t + 0.6));
    this.lfo.stop(t + 0.6);
  }

  updateParams(params: Partial<SynthParams>): void {
    if (params.frequency !== undefined) {
      const t = this.ctx.currentTime + 0.1;
      this.oscs.forEach(o => o.frequency.linearRampToValueAtTime(params.frequency!, t));
    }
    if (params.gain !== undefined) {
      this._gain = params.gain;
      this.gainNode.gain.linearRampToValueAtTime(params.gain, this.ctx.currentTime + 0.05);
    }
    if (params.filterCutoff !== undefined) {
      this.filter.frequency.linearRampToValueAtTime(params.filterCutoff, this.ctx.currentTime + 0.05);
    }
    if (params.detuneSpread !== undefined) {
      // ratios keep the internal relative spread; scale to the requested spread in cents
      const ratios = [-1, -0.357, 0.357, 1];
      this.oscs.forEach((o, i) => { o.detune.value = (ratios[i] ?? 0) * params.detuneSpread!; });
    }
  }

  get currentGain(): number { return this._gain; }
}


class PadVoice implements SynthVoice {
  private readonly oscs: OscillatorNode[] = [];
  private readonly oscGains: GainNode[] = [];
  private readonly filter: BiquadFilterNode;
  private readonly gainNode: GainNode;
  private readonly lfo: OscillatorNode;
  private readonly lfoGain: GainNode;
  private _gain: number;
  private _rootHz: number;
  private _voicingSemis: number[];

  constructor(
    private readonly ctx: AudioContext,
    private readonly params: SynthParams,
    destination: AudioNode,
  ) {
    this._gain         = params.gain;
    this._rootHz       = params.frequency;
    this._voicingSemis = params.chordVoicing === 'min' ? [0,3,7]
                       : params.chordVoicing === 'sus4' ? [0,5,7]
                       : [0,4,7];

    this.gainNode = ctx.createGain();
    this.gainNode.gain.value = 0;

    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.frequency.value = params.filterCutoff ?? 700;
    this.filter.Q.value = 0.8;

    this.lfo = ctx.createOscillator();
    this.lfo.type = 'sine';
    this.lfo.frequency.value = params.lfoRate ?? 0.07;
    this.lfoGain = ctx.createGain();
    this.lfoGain.gain.value = 350;
    this.lfo.connect(this.lfoGain);
    this.lfoGain.connect(this.filter.frequency);

    for (const semi of this._voicingSemis) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = params.frequency * Math.pow(2, semi / 12);
      const g = ctx.createGain();
      g.gain.value = 0.4;
      osc.connect(g);
      g.connect(this.filter);
      this.oscs.push(osc);
      this.oscGains.push(g);
    }
    this.filter.connect(this.gainNode);
    this.gainNode.connect(destination);
  }

  start(): void {
    this.oscs.forEach(o => o.start());
    this.lfo.start();
    const now = this.ctx.currentTime;
    this.gainNode.gain.setValueAtTime(0, now);
    this.gainNode.gain.linearRampToValueAtTime(this._gain, now + 1.8);
  }

  stop(): void {
    const t = this.ctx.currentTime;
    this.gainNode.gain.linearRampToValueAtTime(0, t + 0.8);
    this.oscs.forEach(o => o.stop(t + 1.0));
    this.lfo.stop(t + 1.0);
  }

  updateParams(params: Partial<SynthParams>): void {
    if (params.frequency !== undefined) {
      this._rootHz = params.frequency;
      const t = this.ctx.currentTime + 0.1;
      this.oscs.forEach((o, i) =>
        o.frequency.linearRampToValueAtTime(
          this._rootHz * Math.pow(2, (this._voicingSemis[i] ?? 0) / 12), t,
        ),
      );
    }
    if (params.gain !== undefined) {
      this._gain = params.gain;
      this.gainNode.gain.linearRampToValueAtTime(params.gain, this.ctx.currentTime + 0.1);
    }
    if (params.filterCutoff !== undefined) {
      this.filter.frequency.linearRampToValueAtTime(params.filterCutoff, this.ctx.currentTime + 0.05);
    }
    if (params.lfoRate !== undefined) {
      this.lfo.frequency.linearRampToValueAtTime(params.lfoRate, this.ctx.currentTime + 0.05);
    }
    if (params.chordVoicing !== undefined) {
      const map: Record<string, number[]> = { maj: [0,4,7], min: [0,3,7], sus4: [0,5,7] };
      this._voicingSemis = map[params.chordVoicing] ?? [0,4,7];
      if (this._rootHz > 0) {
        const t = this.ctx.currentTime + 0.1;
        this.oscs.forEach((o, i) =>
          o.frequency.linearRampToValueAtTime(
            this._rootHz * Math.pow(2, (this._voicingSemis[i] ?? 0) / 12), t,
          ),
        );
      }
    }
  }

  get currentGain(): number { return this._gain; }
}


class PluckVoice implements SynthVoice {
  private readonly osc1: OscillatorNode;
  private readonly osc2: OscillatorNode;
  private readonly osc2Gain: GainNode;
  private readonly filter: BiquadFilterNode;
  private readonly gainNode: GainNode;
  private _gain: number;
  private _disposed = false;
  private _stepTimer: ReturnType<typeof setInterval> | null = null;
  private _intervalMs = 460;

  constructor(
    private readonly ctx: AudioContext,
    private params: SynthParams,
    destination: AudioNode,
  ) {
    this._gain = params.gain;
    const freq = params.frequency;

    this.osc1 = ctx.createOscillator();
    this.osc1.type = 'triangle';
    this.osc1.frequency.value = freq;

    this.osc2 = ctx.createOscillator();
    this.osc2.type = 'sine';
    this.osc2.frequency.value = freq * 2.003;
    this.osc2Gain = ctx.createGain();
    this.osc2Gain.gain.value = 0.3;

    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.frequency.value = freq * 6;

    this.gainNode = ctx.createGain();
    this.gainNode.gain.value = 0;

    this.osc2.connect(this.osc2Gain);
    this.osc2Gain.connect(this.filter);
    this.osc1.connect(this.filter);
    this.filter.connect(this.gainNode);
    this.gainNode.connect(destination);
  }

  start(): void {
    this.osc1.start();
    this.osc2.start();
    this._pluck();
    this._stepTimer = setInterval(() => { if (!this._disposed) this._pluck(); }, this._intervalMs);
  }

  private _pluck(): void {
    const now = this.ctx.currentTime;
    const g = this.gainNode.gain;
    const decayTime = this.params.decay ?? 0.45;
    g.cancelScheduledValues(now);
    g.setValueAtTime(this._gain, now);
    g.exponentialRampToValueAtTime(0.001, now + decayTime);
  }

  stop(): void {
    this._disposed = true;
    if (this._stepTimer) clearInterval(this._stepTimer);
    const t = this.ctx.currentTime;
    this.gainNode.gain.cancelScheduledValues(t);
    this.gainNode.gain.linearRampToValueAtTime(0, t + 0.05);
    this.osc1.stop(t + 0.1);
    this.osc2.stop(t + 0.1);
  }

  updateParams(params: Partial<SynthParams>): void {
    if (params.frequency !== undefined) {
      const t = this.ctx.currentTime + 0.05;
      this.osc1.frequency.linearRampToValueAtTime(params.frequency, t);
      this.osc2.frequency.linearRampToValueAtTime(params.frequency * 2.003, t);
      // Only auto-set filter from freq if no explicit cutoff has been given
      if (params.filterCutoff === undefined && this.params.filterCutoff === undefined) {
        this.filter.frequency.value = params.frequency * 6;
      }
      this.params = { ...this.params, frequency: params.frequency };
    }
    if (params.gain !== undefined) this._gain = params.gain;
    if (params.decay !== undefined) this.params = { ...this.params, decay: params.decay };
    if (params.harmonicMix !== undefined) {
      this.osc2Gain.gain.linearRampToValueAtTime(params.harmonicMix, this.ctx.currentTime + 0.05);
    }
    if (params.filterCutoff !== undefined) {
      this.filter.frequency.linearRampToValueAtTime(params.filterCutoff, this.ctx.currentTime + 0.05);
      this.params = { ...this.params, filterCutoff: params.filterCutoff };
    }
    if (params.tempo !== undefined && params.tempo > 0) {
      const ms = Math.round(60000 / params.tempo);
      if (ms !== this._intervalMs) {
        this._intervalMs = ms;
        if (this._stepTimer !== null) {
          clearInterval(this._stepTimer);
          this._stepTimer = setInterval(() => { if (!this._disposed) this._pluck(); }, ms);
        }
      }
    }
  }

  get currentGain(): number { return this._gain; }
}


class PianoVoice implements SynthVoice {
  private readonly oscs: OscillatorNode[] = [];
  private readonly masterGain: GainNode;
  private _gain: number;

  constructor(
    private readonly ctx: AudioContext,
    private readonly params: SynthParams,
    destination: AudioNode,
  ) {
    this._gain = params.gain;
    this.masterGain = ctx.createGain();
    this.masterGain.gain.value = 0;
    this.masterGain.connect(destination);

    // Slightly inharmonic overtones mimic real piano string physics.
    const ratios     = [1, 2.0012, 3.0034, 4.0064, 5.0098];
    const amplitudes = [1, 0.45,   0.22,   0.10,   0.05  ];
    for (let i = 0; i < ratios.length; i++) {
      const g = ctx.createGain();
      g.gain.value = amplitudes[i]!;
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = params.frequency * ratios[i]!;
      o.connect(g);
      g.connect(this.masterGain);
      this.oscs.push(o);
    }
  }

  start(): void {
    this.oscs.forEach(o => o.start());
    const now = this.ctx.currentTime;
    const g = this.masterGain.gain;
    g.setValueAtTime(0, now);
    g.linearRampToValueAtTime(this._gain, now + 0.003);
    g.exponentialRampToValueAtTime(0.001, now + 2.8);
  }

  stop(): void {
    const t = this.ctx.currentTime;
    this.masterGain.gain.cancelScheduledValues(t);
    this.masterGain.gain.linearRampToValueAtTime(0, t + 0.05);
    this.oscs.forEach(o => o.stop(t + 0.1));
  }

  updateParams(params: Partial<SynthParams>): void {
    if (params.frequency !== undefined) {
      const ratios = [1, 2.0012, 3.0034, 4.0064, 5.0098];
      this.oscs.forEach((o, i) =>
        o.frequency.setValueAtTime(params.frequency! * (ratios[i] ?? 1), this.ctx.currentTime),
      );
    }
    if (params.gain !== undefined) this._gain = params.gain;
  }

  get currentGain(): number { return this._gain; }
}


export type MicVoiceStatus = 'pending' | 'live' | 'blocked' | 'unavailable';

export class MicVoice implements SynthVoice {
  private readonly fadeGain: GainNode;
  private readonly compressor: DynamicsCompressorNode;
  private source: MediaStreamAudioSourceNode | null = null;
  private _gain: number;
  private _disposed = false;

  static onStatus: ((s: MicVoiceStatus) => void) | null = null;
  private static _lastStatus: MicVoiceStatus | null = null;
  private static _setStatus(s: MicVoiceStatus): void {
    if (s === MicVoice._lastStatus) return;
    MicVoice._lastStatus = s;
    MicVoice.onStatus?.(s);
  }

  constructor(
    private readonly ctx: AudioContext,
    private params: SynthParams,
    private readonly destination: AudioNode,
  ) {
    this._gain = params.gain;
    this.fadeGain = ctx.createGain();
    this.fadeGain.gain.value = 0;

    // High-ratio compressor doubles as a gate when threshold is raised
    this.compressor = ctx.createDynamicsCompressor();
    this.compressor.threshold.value = params.gateThreshold ?? -40;
    this.compressor.ratio.value = 16;
    this.compressor.attack.value = 0.003;
    this.compressor.release.value = 0.1;
    this.compressor.knee.value = 0;

    this.fadeGain.connect(this.compressor);
    this.compressor.connect(destination);
    MicVoice._setStatus('pending');
  }

  async start(): Promise<void> {
    try {
      const stream = await getMicStream();
      if (this._disposed) return;

      const track = stream.getAudioTracks()[0];
      if (!track) throw new Error('no audio track');
      track.enabled = true;

      this.source = this.ctx.createMediaStreamSource(stream);
      this.source.connect(this.fadeGain);
      const t = this.ctx.currentTime + 0.08;
      this.fadeGain.gain.linearRampToValueAtTime(1, t);
      MicVoice._setStatus('live');
    } catch (err) {
      const name = (err as Error).name;
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
        MicVoice._setStatus('blocked');
        console.warn('🎙 Mic blocked — click the address-bar mic icon to re-allow.');
      } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
        MicVoice._setStatus('unavailable');
        console.warn('🎙 No microphone found on this device.');
      } else {
        MicVoice._setStatus('unavailable');
        console.warn('🎙 Mic init failed:', err);
      }
    }
  }

  stop(): void {
    this._disposed = true;
    this.fadeGain.gain.linearRampToValueAtTime(0, this.ctx.currentTime + 0.05);
    setTimeout(() => {
      try { this.source?.disconnect(); } catch { /* ignore */ }
      try { this.fadeGain.disconnect(); } catch { /* ignore */ }
      try { this.compressor.disconnect(); } catch { /* ignore */ }
    }, 100);
  }

  updateParams(params: Partial<SynthParams>): void {
    if (params.gain !== undefined) this._gain = params.gain;
    if (params.gateThreshold !== undefined) {
      this.compressor.threshold.linearRampToValueAtTime(params.gateThreshold, this.ctx.currentTime + 0.05);
    }
  }

  get currentGain(): number { return this._gain; }
}

function createVoice(
  ctx: AudioContext,
  params: SynthParams,
  destination: AudioNode,
): SynthVoice {
  const map: Record<SynthType, () => SynthVoice> = {
    ambient:    () => new AmbientVoice(ctx, params, destination),
    bass:       () => new BassVoice(ctx, params, destination),
    percussion: () => new PercussionVoice(ctx, params, destination),
    generative: () => new GenerativeVoice(ctx, params, destination),
    voice:      () => new MicVoice(ctx, params, destination),
    bells:      () => new BellsVoice(ctx, params, destination),
    strings:    () => new StringsVoice(ctx, params, destination),
    pad:        () => new PadVoice(ctx, params, destination),
    pluck:      () => new PluckVoice(ctx, params, destination),
    piano:      () => new PianoVoice(ctx, params, destination),
  };
  return map[params.type]();
}

export class ProceduralSynth {
  private voice: SynthVoice;

  constructor(
    private readonly ctx: AudioContext,
    private params: SynthParams,
    private readonly destination: AudioNode,
  ) {
    this.voice = createVoice(ctx, params, destination);
  }

  start(): void { this.voice.start(); }
  stop(): void { this.voice.stop(); }

  updateParams(params: Partial<SynthParams>): void {
    // Rebuild the underlying voice if the synth type changed.
    if (params.type !== undefined && params.type !== this.params.type) {
      this.voice.stop();
      this.params = { ...this.params, ...params };
      this.voice = createVoice(this.ctx, this.params, this.destination);
      this.voice.start();
    } else {
      this.params = { ...this.params, ...params };
      this.voice.updateParams(params);
    }
  }

  get currentGain(): number { return this.voice.currentGain; }
}
