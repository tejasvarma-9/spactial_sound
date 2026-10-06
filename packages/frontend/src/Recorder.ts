import type { AudioEngine } from '@spatial-soundscape/engine';

const WARN_MS  = 55 * 60 * 1000;
const LIMIT_MS = 60 * 60 * 1000;

export class Recorder {
  isRecording = false;

  onTick:    ((elapsed: number, bytesEstimate: number) => void) | null = null;
  onWarn:    (() => void) | null = null;
  onStopped: ((blob: Blob) => void) | null = null;

  private recorder: MediaRecorder | null = null;
  private chunks:   Blob[] = [];
  private tap:      MediaStreamAudioDestinationNode | null = null;
  private tickId:   ReturnType<typeof setInterval> | null = null;
  private startMs   = 0;
  private warnFired = false;
  private totalBytes = 0;

  constructor(private readonly engine: AudioEngine) {}

  start(): void {
    if (this.isRecording) return;
    this.chunks     = [];
    this.totalBytes = 0;
    this.warnFired  = false;
    this.startMs    = Date.now();
    this.tap = this.engine.createMediaStreamTap();

    this.recorder = new MediaRecorder(this.tap.stream, {
      mimeType: MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm',
    });
    this.recorder.ondataavailable = (e) => {
      if (e.data.size > 0) {
        this.chunks.push(e.data);
        this.totalBytes += e.data.size;
      }
    };
    this.recorder.start(250);
    this.isRecording = true;

    this.tickId = setInterval(() => {
      const elapsed = Date.now() - this.startMs;
      this.onTick?.(elapsed, this.totalBytes);
      if (!this.warnFired && elapsed >= WARN_MS) {
        this.warnFired = true;
        this.onWarn?.();
      }
      if (elapsed >= LIMIT_MS) {
        void this.stop();
      }
    }, 500);
  }

  async stop(): Promise<Blob> {
    if (!this.isRecording || !this.recorder) return new Blob();
    if (this.tickId !== null) {
      clearInterval(this.tickId);
      this.tickId = null;
    }
    const done = new Promise<Blob>((resolve) => {
      this.recorder!.onstop = () =>
        resolve(new Blob(this.chunks, { type: 'audio/webm' }));
    });
    this.recorder.stop();
    this.isRecording = false;
    const blob = await done;
    if (this.tap) {
      this.engine.removeMediaStreamTap(this.tap);
      this.tap = null;
    }
    this.onStopped?.(blob);
    return blob;
  }

  elapsed(): number {
    return this.isRecording ? Date.now() - this.startMs : 0;
  }
}

export function fmtElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0
    ? `${h}:${pad(m % 60)}:${pad(s % 60)}`
    : `${pad(m)}:${pad(s % 60)}`;
}

export function fmtBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export async function webmToWav(blob: Blob): Promise<Blob> {
  const arrayBuf = await blob.arrayBuffer();
  const ctx = new AudioContext();
  const audioBuf = await ctx.decodeAudioData(arrayBuf);
  await ctx.close();

  const numCh      = audioBuf.numberOfChannels;
  const rate       = audioBuf.sampleRate;
  const numSamples = audioBuf.length;
  const dataSize   = numSamples * numCh * 2;
  const buf        = new ArrayBuffer(44 + dataSize);
  const view       = new DataView(buf);

  const str = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  str(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numCh, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * numCh * 2, true);
  view.setUint16(32, numCh * 2, true);
  view.setUint16(34, 16, true);
  str(36, 'data');
  view.setUint32(40, dataSize, true);

  let off = 44;
  for (let i = 0; i < numSamples; i++) {
    for (let ch = 0; ch < numCh; ch++) {
      const s = Math.max(-1, Math.min(1, audioBuf.getChannelData(ch)[i]!));
      view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      off += 2;
    }
  }
  return new Blob([buf], { type: 'audio/wav' });
}
