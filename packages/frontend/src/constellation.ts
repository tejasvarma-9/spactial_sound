import type { Vec3 } from '@spatial-soundscape/engine';

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

export function constellationLayout(count: number, baseRadius: number): Vec3[] {
  const out: Vec3[] = [];
  for (let i = 0; i < count; i++) {
    const angle = i * GOLDEN_ANGLE;
    const radius = baseRadius * Math.sqrt(i + 1);
    out.push({
      x: Math.cos(angle) * radius,
      y: 0,
      z: Math.sin(angle) * radius,
    });
  }
  return out;
}
