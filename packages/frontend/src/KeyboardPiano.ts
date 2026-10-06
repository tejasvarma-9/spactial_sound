import type { AudioEngine, Vec3 } from '@spatial-soundscape/engine';
import { makeNodeId } from '@spatial-soundscape/engine';
import type { LoopRecorder } from './LoopRecorder.ts';

const KEY_TO_MIDI: Record<string, number> = {
  a: 60, w: 61, s: 62, e: 63, d: 64, f: 65, t: 66,
  g: 67, y: 68, h: 69, u: 70, j: 71, k: 72,
};

// Note names shown on the piano overlay keys.
const MIDI_TO_NOTE: Record<number, string> = {
  60: 'C',  61: 'C♯', 62: 'D',  63: 'D♯',
  64: 'E',  65: 'F',  66: 'F♯', 67: 'G',
  68: 'G♯', 69: 'A',  70: 'A♯', 71: 'B', 72: 'C5',
};

const midiToHz = (m: number): number => 440 * Math.pow(2, (m - 69) / 12);

export class KeyboardPiano {
  enabled = false;
  gain = 0.55;
  loopRecorder: LoopRecorder | null = null;
  private readonly listener: () => Vec3;
  private overlay: HTMLDivElement | null = null;
  private active = new Map<string, number>();

  constructor(private readonly engine: AudioEngine, listener: () => Vec3) {
    this.listener = listener;
    window.addEventListener('keydown', (e) => this._onKey(e));
    this._buildOverlay();
  }

  toggle(): void {
    this.enabled = !this.enabled;
    if (this.overlay) this.overlay.style.display = this.enabled ? 'flex' : 'none';
  }

  private _buildOverlay(): void {
    const overlay = document.createElement('div');
    overlay.className = 'piano-overlay';
    overlay.style.display = 'none';
    const keyOrder = ['a','w','s','e','d','f','t','g','y','h','u','j','k'];
    const blackKeys = new Set(['w','e','t','y','u']);
    for (const k of keyOrder) {
      const el = document.createElement('div');
      el.className = `piano-key ${blackKeys.has(k) ? 'black' : 'white'}`;
      el.dataset['key'] = k;

      const midi = KEY_TO_MIDI[k];
      const noteName = midi !== undefined ? (MIDI_TO_NOTE[midi] ?? k.toUpperCase()) : k.toUpperCase();

      const nameSpan = document.createElement('span');
      nameSpan.className = 'note-name';
      nameSpan.textContent = noteName;

      const keySpan = document.createElement('span');
      keySpan.className = 'key-letter';
      keySpan.textContent = k.toUpperCase();

      el.appendChild(nameSpan);
      el.appendChild(keySpan);
      overlay.appendChild(el);
    }
    document.body.appendChild(overlay);
    this.overlay = overlay;

    const tick = () => {
      const now = performance.now();
      for (const [k, expiry] of this.active) {
        if (now > expiry) {
          this.active.delete(k);
          const el = overlay.querySelector(`[data-key="${k}"]`);
          if (el) el.classList.remove('active');
        }
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  private _onKey(e: KeyboardEvent): void {
    if (!this.enabled) return;
    if (e.target instanceof HTMLInputElement) return;
    if (e.repeat) return;
    const k = e.key.toLowerCase();
    const midi = KEY_TO_MIDI[k];
    if (midi === undefined) return;

    // Prevent WASD from also triggering camera movement while piano is active.
    e.stopPropagation();

    this.playNote(midi);

    if (this.overlay) {
      const el = this.overlay.querySelector(`[data-key="${k}"]`);
      if (el) el.classList.add('active');
      this.active.set(k, performance.now() + 300);
    }
  }

  // Public so LoopRecorder can replay notes directly.
  playNote(midi: number): void {
    this.loopRecorder?.recordNote(midi);

    const id = makeNodeId();
    const pos = this.listener();
    const dropPos: Vec3 = { x: pos.x + (Math.random() - 0.5) * 80, y: 0, z: pos.z - 60 };
    const freq = midiToHz(midi);
    const note = MIDI_TO_NOTE[midi] ?? String(midi);

    this.engine.addNode({
      id,
      position: dropPos,
      params: {
        type: 'piano',
        wave: 'sine',
        frequency: freq,
        gain: this.gain,
        attack: 0.003,
        decay: 2.8,
        sustain: 0,
        release: 0.05,
        reverbWet: 0.35,
        chorusDepth: 0,
      },
      label: note,
      color: '#ffd60a',
      innerRadius: 80,
      outerRadius: 500,
      muted: false,
    });

    // Remove after the piano note fully decays.
    setTimeout(() => this.engine.removeNode(id), 3200);
  }
}
