// Sample-accurate beat clock that runs in the audio thread to avoid
// setInterval jitter.

const WORKLET_CODE = /* javascript */`
class TempoClockProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this._samplesPerBeat = sampleRate * 60 / (options.processorOptions?.bpm ?? 120);
    this._sampleCounter = 0;
    this._beatNumber = 0;
    this.port.onmessage = (ev) => {
      const { type, bpm } = ev.data;
      if (type === 'setBpm' && typeof bpm === 'number' && bpm > 10 && bpm < 800) {
        this._samplesPerBeat = sampleRate * 60 / bpm;
      } else if (type === 'reset') {
        this._sampleCounter = 0;
        this._beatNumber = 0;
      }
    };
  }
  process() {
    this._sampleCounter += 128;
    if (this._sampleCounter >= this._samplesPerBeat) {
      const overshoot = this._sampleCounter - this._samplesPerBeat;
      this._sampleCounter = overshoot;
      this.port.postMessage({
        beatNumber: this._beatNumber++,
        sampleOffset: 128 - overshoot,
      });
    }
    return true;
  }
}
registerProcessor('spatial-tempo-clock', TempoClockProcessor);
`;

let modulePromise: Promise<void> | null = null;
function ensureModuleLoaded(ctx: AudioContext): Promise<void> {
  if (!modulePromise) {
    const blob = new Blob([WORKLET_CODE], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    modulePromise = ctx.audioWorklet.addModule(url).finally(() => URL.revokeObjectURL(url));
  }
  return modulePromise;
}

export type BeatHandler = (audioTime: number, beatNumber: number) => void;

export class TempoClock {
  private node: AudioWorkletNode;
  onBeat: BeatHandler | null = null;
  lastBeatAudioTime = 0;

  private constructor(private readonly ctx: AudioContext, node: AudioWorkletNode) {
    this.node = node;
    node.port.onmessage = (ev) => {
      const { beatNumber, sampleOffset } = ev.data as { beatNumber: number; sampleOffset: number };
      const audioTime = ctx.currentTime + (128 - sampleOffset) / ctx.sampleRate;
      this.lastBeatAudioTime = audioTime;
      this.onBeat?.(audioTime, beatNumber);
    };
  }

  static async create(ctx: AudioContext, bpm: number): Promise<TempoClock> {
    await ensureModuleLoaded(ctx);
    const node = new AudioWorkletNode(ctx, 'spatial-tempo-clock', {
      processorOptions: { bpm },
      outputChannelCount: [1],
    });
    // Worklet must be wired to the graph to run; route to a silent sink.
    const sink = ctx.createGain();
    sink.gain.value = 0;
    node.connect(sink);
    sink.connect(ctx.destination);
    return new TempoClock(ctx, node);
  }

  setBpm(bpm: number): void {
    this.node.port.postMessage({ type: 'setBpm', bpm });
  }

  reset(): void {
    this.node.port.postMessage({ type: 'reset' });
  }

  dispose(): void {
    this.node.port.onmessage = null;
    this.node.disconnect();
  }
}
