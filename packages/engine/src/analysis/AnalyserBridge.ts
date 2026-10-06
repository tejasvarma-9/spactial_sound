import type { AnalyserFrame, NodeId } from '../types/index.js';
import type { AudioEngine } from '../audio/AudioEngine.js';

export type FrameCallback = (frames: ReadonlyArray<AnalyserFrame>) => void;

export class AnalyserBridge {
  onFrame: FrameCallback | null = null;

  private _rafHandle: number | null = null;
  private readonly _freqBuffers = new Map<string, Uint8Array<ArrayBuffer>>();
  private readonly _timeBuffers = new Map<string, Uint8Array<ArrayBuffer>>();

  constructor(private readonly engine: AudioEngine) {}

  start(): void {
    if (this._rafHandle !== null) return;
    this._tick();
  }

  stop(): void {
    if (this._rafHandle !== null) {
      cancelAnimationFrame(this._rafHandle);
      this._rafHandle = null;
    }
  }

  private _tick = (): void => {
    this._rafHandle = requestAnimationFrame(this._tick);
    if (!this.onFrame) return;
    if (!this.engine.isRunning) return;

    const frames: AnalyserFrame[] = [];
    const now = performance.now();

    for (const [id, node] of this.engine.getAllNodes()) {
      const { analyser } = node;
      const binCount = analyser.frequencyBinCount;

      // Reuse buffers to avoid GC pressure each frame.
      if (!this._freqBuffers.has(id)) {
        this._freqBuffers.set(id, new Uint8Array(new ArrayBuffer(binCount)));
        this._timeBuffers.set(id, new Uint8Array(new ArrayBuffer(binCount)));
      }
      const freqData = this._freqBuffers.get(id)!;
      const timeData = this._timeBuffers.get(id)!;

      analyser.getByteFrequencyData(freqData);
      analyser.getByteTimeDomainData(timeData);

      frames.push({
        nodeId: id,
        frequencyData: freqData,
        timeDomainData: timeData,
        rmsEnergy: AnalyserBridge._computeRms(timeData),
        timestampMs: now,
      });
    }

    for (const id of this._freqBuffers.keys()) {
      if (!this.engine.getAllNodes().has(id as NodeId)) {
        this._freqBuffers.delete(id);
        this._timeBuffers.delete(id);
      }
    }

    this.onFrame(frames);
  };

  private static _computeRms(data: Uint8Array<ArrayBuffer>): number {
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      const sample = (data[i]! - 128) / 128;
      sum += sample * sample;
    }
    return Math.sqrt(sum / data.length);
  }
}
