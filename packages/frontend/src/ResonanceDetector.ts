import type { NodeId, SpatialNodeDescriptor } from '@spatial-soundscape/engine';

const CONSONANT_RATIOS = [
  { ratio: 2 / 1,  weight: 1.0 },  // octave
  { ratio: 3 / 2,  weight: 0.9 },  // perfect fifth
  { ratio: 4 / 3,  weight: 0.75 }, // perfect fourth
  { ratio: 5 / 4,  weight: 0.65 }, // major third
  { ratio: 6 / 5,  weight: 0.5 },  // minor third
];

const FADE_IN_MS  = 500;
const FADE_OUT_MS = 350;

export interface ResonancePair {
  a: NodeId;
  b: NodeId;
  strength: number; // 0–1 from harmonic ratio + distance attenuation
  age: number;      // 0–1 visibility multiplier (0 = invisible, 1 = fully faded in)
}

interface PairState {
  firstSeenMs: number;
  lastSeenMs: number;
  fadingOut: boolean;
  /** Last computed strength — held during fade-out so the bridge doesn't snap. */
  strength: number;
}

export class ResonanceDetector {
  private readonly _pairs = new Map<string, PairState>();

  private static _pairKey(a: NodeId, b: NodeId): string {
    return a < b ? `${a}::${b}` : `${b}::${a}`;
  }

  detect(nodes: ReadonlyMap<NodeId, SpatialNodeDescriptor>): ResonancePair[] {
    const now = performance.now();
    const arr = Array.from(nodes.values());
    const seenThisFrame = new Set<string>();

    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const a = arr[i]!, b = arr[j]!;
        if (a.muted || b.muted) continue;

        const fA = a.params.frequency;
        const fB = b.params.frequency;
        if (fA <= 0 || fB <= 0) continue;
        const r = Math.max(fA, fB) / Math.min(fA, fB);

        let bestStrength = 0;
        for (const { ratio, weight } of CONSONANT_RATIOS) {
          const error = Math.abs(r - ratio) / ratio;
          if (error < 0.04) {
            const strength = weight * (1 - error / 0.04);
            if (strength > bestStrength) bestStrength = strength;
          }
        }
        if (bestStrength <= 0) continue;

        const dist = Math.hypot(a.position.x - b.position.x, a.position.z - b.position.z);
        const distAtten = Math.max(0, 1 - dist / 900);
        const finalStrength = bestStrength * distAtten;
        if (finalStrength <= 0.05) continue;

        const key = ResonanceDetector._pairKey(a.id, b.id);
        seenThisFrame.add(key);

        const existing = this._pairs.get(key);
        if (existing) {
          existing.lastSeenMs = now;
          existing.fadingOut = false;
          existing.strength = finalStrength;
        } else {
          this._pairs.set(key, {
            firstSeenMs: now,
            lastSeenMs: now,
            fadingOut: false,
            strength: finalStrength,
          });
        }
      }
    }

    // Mark pairs that didn't appear this frame as fading out
    const out: ResonancePair[] = [];
    for (const [key, state] of this._pairs) {
      if (!seenThisFrame.has(key) && !state.fadingOut) {
        state.fadingOut = true;
        state.lastSeenMs = now;
      }

      let age: number;
      if (state.fadingOut) {
        const dt = now - state.lastSeenMs;
        age = 1 - Math.min(1, dt / FADE_OUT_MS);
        if (age <= 0) {
          this._pairs.delete(key);
          continue;
        }
      } else {
        const dt = now - state.firstSeenMs;
        age = Math.min(1, dt / FADE_IN_MS);
      }

      const [aId, bId] = key.split('::') as [NodeId, NodeId];
      // Skip emitting if either node has been removed
      if (!nodes.has(aId) || !nodes.has(bId)) {
        this._pairs.delete(key);
        continue;
      }
      out.push({ a: aId, b: bId, strength: state.strength, age });
    }
    return out;
  }
}
