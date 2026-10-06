export class LoopRecorder {
  private events: Array<{ delayMs: number; midi: number }> = [];
  private startMs = 0;
  private loopMs = 4000;
  private loopTimer: ReturnType<typeof setInterval> | null = null;
  isRecording = false;
  isPlaying = false;

  constructor(private readonly playNote: (midi: number) => void) {}

  startRecord(): void {
    this.stop();
    this.events = [];
    this.startMs = performance.now();
    this.isRecording = true;
  }

  recordNote(midi: number): void {
    if (!this.isRecording) return;
    this.events.push({ delayMs: performance.now() - this.startMs, midi });
  }

  stopRecord(): void {
    if (!this.isRecording) return;
    this.isRecording = false;
    if (this.events.length === 0) return;
    // Round loop duration to nearest 500ms, minimum 1s.
    const dur = performance.now() - this.startMs;
    this.loopMs = Math.max(1000, Math.ceil(dur / 500) * 500);
    this._startPlayback();
  }

  private _startPlayback(): void {
    this.isPlaying = true;
    const fire = () => {
      if (!this.isPlaying) return;
      for (const ev of this.events) {
        setTimeout(() => { if (this.isPlaying) this.playNote(ev.midi); }, ev.delayMs);
      }
    };
    fire();
    this.loopTimer = setInterval(fire, this.loopMs);
  }

  stop(): void {
    this.isRecording = false;
    this.isPlaying = false;
    if (this.loopTimer) { clearInterval(this.loopTimer); this.loopTimer = null; }
  }

  get isEmpty(): boolean { return this.events.length === 0; }
}
