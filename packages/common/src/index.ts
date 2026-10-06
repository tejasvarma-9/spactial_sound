export const WS_PATH = '/ws';
export const DEFAULT_ROOM = 'lobby';

export function isValidRoom(name: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,31}$/.test(name);
}

export function midiToHz(note: number): number {
  return 440 * Math.pow(2, (note - 69) / 12);
}

export const CYBERPUNK_PALETTE = [
  '#00f5d4',
  '#f72585',
  '#9b5de5',
  '#ffd60a',
  '#06d6a0',
  '#ff6d00',
  '#4cc9f0',
  '#b5179e',
] as const;
