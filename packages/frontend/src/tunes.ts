// Famous single-line riffs, encoded as (semitone offset from root, null = rest)
// 16th-note step sequences. The generative voice fires steps at 200*arpSpeed BPM,
// so for a step = 16th note at song BPM `B`, arpSpeed = B / 50.

export interface FamousTune {
  name: string;
  artist: string;
  bpm: number;
  rootHz: number;   // the frequency to place the node at
  arpSpeed: number; // = bpm / 50 for 16th-note stepping
  melodyScale: (number | null)[];
}

export const TUNES: FamousTune[] = [
  {
    name: 'Billie Jean',
    artist: 'Michael Jackson',
    bpm: 117,
    rootHz: 92.50,                   // F#2
    arpSpeed: 2.34,
    // F# F# A F# B F# A F#  (one bar)
    melodyScale: [
      0, null, 0, null,
      3, null, 0, null,
      5, null, 0, null,
      3, null, 0, null,
    ],
  },
  {
    name: 'Come As You Are',
    artist: 'Nirvana',
    bpm: 120,
    rootHz: 82.41,                   // E2 — bass/mid where the riff sits
    arpSpeed: 2.40,
    // E-E-F#-G-F#-E-E-D — the clean bass riff, in eighth notes
    melodyScale: [
      0, null, 0, null,      // E, E
      2, null, 3, null,      // F#, G
      2, null, 0, null,      // F#, E
      0, null, -2, null,     // E, D
    ],
  },
  {
    name: 'Still D.R.E.',
    artist: 'Dr. Dre',
    bpm: 93,
    rootHz: 246.94,                  // B3
    arpSpeed: 1.86,
    // F# F# F# F# — E D C# D — C# — B —
    melodyScale: [
      7, null, 7, null,
      7, null, 7, null,
      5, 3, 2, 3,
      2, null, 0, null,
    ],
  },
  {
    name: 'Fate Motif',
    artist: 'Beethoven · 5th',
    bpm: 108,
    rootHz: 196.00,                  // G3
    arpSpeed: 2.16,
    // Motif 1: G G G — Eb (hold) · Motif 2: F F F — D (hold)
    melodyScale: [
      0, null, 0, null, 0, null, -4, null,
      null, null, null, null, null, null, null, null,
      -2, null, -2, null, -2, null, -5, null,
      null, null, null, null, null, null, null, null,
    ],
  },
  {
    name: 'Take Five',
    artist: 'Dave Brubeck',
    bpm: 174,
    rootHz: 311.13,                  // Eb4
    arpSpeed: 3.48,
    // 20 steps = 1 bar of 5/4: Bb - - - Bb - Gb Bb - - Ab - Gb - F - Eb - - -
    melodyScale: [
      7, null, null, null,
      7, null, 3, 7,
      null, null, 5, null,
      3, null, 2, null,
      0, null, null, null,
    ],
  },
];
