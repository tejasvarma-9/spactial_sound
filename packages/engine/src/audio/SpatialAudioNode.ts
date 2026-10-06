import type { NodeId, SpatialNodeDescriptor, SynthParams, Vec3 } from '../types/index.js';
import { ProceduralSynth } from '../synth/ProceduralSynth.js';

export class SpatialAudioNode {
  readonly id: NodeId;

  private readonly ctx: AudioContext;
  private readonly panner: PannerNode;
  private readonly gainNode: GainNode;
  readonly analyser: AnalyserNode;

  private synth: ProceduralSynth;
  private _position: Vec3;
  private _muted: boolean;
  private _disposed = false;

  constructor(ctx: AudioContext, descriptor: SpatialNodeDescriptor, destination: AudioNode) {
    this.ctx = ctx;
    this.id = descriptor.id;
    this._position = { ...descriptor.position };
    this._muted = descriptor.muted;

    // Pre-panner: capture raw energy regardless of listener position.
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.8;

    this.gainNode = ctx.createGain();
    this.gainNode.gain.value = descriptor.muted ? 0 : descriptor.params.gain;

    this.panner = ctx.createPanner();
    this.panner.panningModel = 'HRTF';
    this.panner.distanceModel = 'inverse';
    this.panner.refDistance = descriptor.innerRadius;
    this.panner.maxDistance = descriptor.outerRadius;
    this.panner.rolloffFactor = 1.5;
    this.panner.coneInnerAngle = 360;
    this.panner.coneOuterAngle = 360;
    this.panner.coneOuterGain = 0;
    this._applyPosition(descriptor.position);

    this.gainNode.connect(this.analyser);
    this.analyser.connect(this.panner);
    this.panner.connect(destination);

    this.synth = new ProceduralSynth(ctx, descriptor.params, this.gainNode);
    this.synth.start();
  }

  get position(): Readonly<Vec3> {
    return this._position;
  }

  setPosition(pos: Vec3, rampMs = 0): void {
    this._position = { ...pos };
    if (rampMs > 0) {
      const end = this.ctx.currentTime + rampMs / 1000;
      this.panner.positionX.linearRampToValueAtTime(pos.x, end);
      this.panner.positionY.linearRampToValueAtTime(pos.y, end);
      this.panner.positionZ.linearRampToValueAtTime(pos.z, end);
    } else {
      this._applyPosition(pos);
    }
  }

  private _applyPosition(pos: Vec3): void {
    if (this.panner.positionX) {
      this.panner.positionX.value = pos.x;
      this.panner.positionY.value = pos.y;
      this.panner.positionZ.value = pos.z;
    } else {
      this.panner.setPosition(pos.x, pos.y, pos.z);
    }
  }

  updateParams(params: Partial<SynthParams>): void {
    this.synth.updateParams(params);
    if (params.gain !== undefined && !this._muted) {
      const t = this.ctx.currentTime + 0.02;
      this.gainNode.gain.linearRampToValueAtTime(params.gain, t);
    }
  }

  setMuted(muted: boolean): void {
    this._muted = muted;
    const targetGain = muted ? 0 : this.synth.currentGain;
    const t = this.ctx.currentTime + 0.05;
    this.gainNode.gain.linearRampToValueAtTime(targetGain, t);
  }

  get muted(): boolean {
    return this._muted;
  }

  setRadii(inner: number, outer: number): void {
    this.panner.refDistance = inner;
    this.panner.maxDistance = outer;
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this.synth.stop();
    this.gainNode.disconnect();
    this.analyser.disconnect();
    this.panner.disconnect();
  }
}
