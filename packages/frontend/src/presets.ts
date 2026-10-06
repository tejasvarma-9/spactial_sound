import type { SpatialNodeDescriptor, SynthParams } from '@spatial-soundscape/engine';

// Preset nodes only need type + the fields that differentiate them.
// The engine fills in base ADSR/gain/wave defaults automatically.
type PresetParams = Pick<SynthParams, 'type'> & Partial<Omit<SynthParams, 'type'>>;
type PresetNode   = Omit<SpatialNodeDescriptor, 'id' | 'params'> & { params: PresetParams };

export interface StarterPreset {
  name: string;
  tag: string;
  description: string;
  bpm?: number;
  nodes: PresetNode[];
}

/*
 * ---------------------------------------------------------------
 *  FAMOUS TUNES — one iconic riff per genre.
 * ---------------------------------------------------------------
 *
 *  Each scene encodes the main hook of a legendary track as a
 *  `melodyScale` on a generative node — array of semitone offsets
 *  from a root frequency, one entry per 16th note, with `null`
 *  meaning "rest / let the previous note ring."
 *
 *  Timing math: GenerativeVoice fires steps at 200 * arpSpeed BPM.
 *  For a step = 16th note at song BPM `B`, use arpSpeed = B / 50.
 *
 *  Ex: 124 BPM → arpSpeed 2.48 → 16-step bar loops every 1.94s.
 * ---------------------------------------------------------------
 */

export const STARTER_PRESETS: StarterPreset[] = [

  // ═════ POP — Michael Jackson · Billie Jean · F#m · 117 BPM ═════════════
  //
  //  The signature bass line: F# F# A F# B F# A F# (one bar, 8 eighths).
  //  Semitones from F# root: 0, 0, 3, 0, 5, 0, 3, 0 — each held one eighth
  //  (= 2 sixteenths) so we pad with `null` rests between hits.
  //
  {
    name: 'Billie Jean',
    tag: 'POP · 117 BPM · MJ',
    description: 'The iconic F#m bass groove with a kick-snare-hat drum kit.',
    bpm: 117,
    nodes: [
      // Melodic bass line — the star of Billie Jean. Sawtooth-ish via bass drive.
      {
        position: { x: 0, y: 0, z: 220 },
        params: {
          type: 'generative',
          wave: 'triangle',
          frequency: 92.50,      // F#2
          gain: 0.32,
          arpSpeed: 2.34,        // 117 / 50 = 16ths at 117 BPM
          melodyScale: [
            0, null, 0, null,    // F# F#
            3, null, 0, null,    // A  F#
            5, null, 0, null,    // B  F#
            3, null, 0, null,    // A  F#
          ],
          filterCutoff: 900,
          reverbWet: 0.25,
          chorusDepth: 0.10,
        },
        label: 'F# bass line', color: '#f72585',
        innerRadius: 120, outerRadius: 1000, muted: false,
      },
      // F#m chord pad — quiet, holds the vibe under the bass
      {
        position: { x: -240, y: 0, z: -100 },
        params: {
          type: 'pad',
          frequency: 185.00,     // F#3
          gain: 0.10,
          filterCutoff: 1200,
          lfoRate: 0.08,
          chordVoicing: 'min',   // F# A C#
          reverbWet: 0.55,
          chorusDepth: 0.25,
        },
        label: 'F#m pad', color: '#9b5de5',
        innerRadius: 120, outerRadius: 1000, muted: false,
      },
      // Kick — quarter notes at 117 BPM (tempo 29 → 16ths @ 29 ≈ quarters @ 117)
      {
        position: { x: -240, y: 0, z: 80 },
        params: {
          type: 'percussion',
          frequency: 62,
          gain: 0.34,
          noiseMix: 0.08,
          tempo: 29,
          attack: 0.001,
          decay: 0.03,
          sustain: 0,
          release: 0.10,
          reverbWet: 0.12,
        },
        label: 'kick', color: '#ffd60a',
        innerRadius: 120, outerRadius: 1000, muted: false,
      },
      // Hi-hat — 8ths at 117 BPM (tempo 58)
      {
        position: { x: 240, y: 0, z: 80 },
        params: {
          type: 'percussion',
          frequency: 7200,
          gain: 0.10,
          noiseMix: 0.98,
          tempo: 58,
          attack: 0.001,
          decay: 0.008,
          sustain: 0,
          release: 0.035,
          reverbWet: 0.10,
        },
        label: 'hat', color: '#ff6d00',
        innerRadius: 120, outerRadius: 1000, muted: false,
      },
    ],
  },


  // ═════ ROCK — Nirvana · Come As You Are · Em · 120 BPM ═════════════════
  //
  //  The clean, wistful bass/guitar riff — chorus-drenched, no aggression.
  //  Notes across one bar: E-E-F#-G-F#-E-E-D (eighth notes).
  //  Root E2. Semitones from E: 0, +2 (F#), +3 (G), -2 (D).
  //
  {
    name: 'Come As You Are',
    tag: 'ROCK · 120 BPM · NIRVANA',
    description: 'The moody clean-guitar riff over an Em bed with a soft kick.',
    bpm: 120,
    nodes: [
      // The riff — triangle wave for that soft, chorus-y clean-guitar feel
      {
        position: { x: 0, y: 0, z: -220 },
        params: {
          type: 'generative',
          wave: 'triangle',
          frequency: 82.41,      // E2 — sits in the bass/mid where the song lives
          gain: 0.26,
          arpSpeed: 2.40,        // 120 / 50 → 16ths at 120 BPM
          //  E    F#   G    F#   E    E    D    (over 16 eighths across 2 bars)
          melodyScale: [
            // Bar 1
            0, null, 0, null,    // E, E (eighths)
            2, null, 3, null,    // F#, G
            2, null, 0, null,    // F#, E
            0, null, -2, null,   // E, D
            // Bar 2 — repeat with a resolving tail
            0, null, 0, null,    // E, E
            2, null, 3, null,    // F#, G
            2, null, 0, null,    // F#, E
            null, null, null, null,
          ],
          filterCutoff: 1200,
          reverbWet: 0.40,
          chorusDepth: 0.30,     // Nirvana's characteristic chorus-pedal wash
        },
        label: 'E riff', color: '#4cc9f0',
        innerRadius: 120, outerRadius: 1000, muted: false,
      },
      // Em pad — atmospheric, sits under the riff
      {
        position: { x: -260, y: 0, z: 0 },
        params: {
          type: 'pad',
          frequency: 164.81,     // E3
          gain: 0.10,
          filterCutoff: 900,
          lfoRate: 0.06,
          chordVoicing: 'min',   // E G B
          reverbWet: 0.60,
          chorusDepth: 0.25,
        },
        label: 'Em pad', color: '#9b5de5',
        innerRadius: 120, outerRadius: 1000, muted: false,
      },
      // Soft kick — quarter notes at 120 BPM (tempo 30 → 16ths @ 30)
      {
        position: { x: 0, y: 0, z: 240 },
        params: {
          type: 'percussion',
          frequency: 62,
          gain: 0.30,
          noiseMix: 0.10,
          tempo: 30,
          attack: 0.001,
          decay: 0.04,
          sustain: 0,
          release: 0.14,
          reverbWet: 0.15,
        },
        label: 'kick', color: '#ffd60a',
        innerRadius: 120, outerRadius: 1000, muted: false,
      },
      // Brushed hat — subtle, not driving
      {
        position: { x: 260, y: 0, z: 0 },
        params: {
          type: 'percussion',
          frequency: 6800,
          gain: 0.09,
          noiseMix: 0.98,
          tempo: 120,            // 16ths at ~60 BPM feel (offbeat presence)
          attack: 0.001,
          decay: 0.01,
          sustain: 0,
          release: 0.04,
          reverbWet: 0.20,
        },
        label: 'hat', color: '#ff6d00',
        innerRadius: 120, outerRadius: 1000, muted: false,
      },
    ],
  },


  // ═════ HIP-HOP — Dr. Dre · Still D.R.E. · Bm · 93 BPM ══════════════════
  //
  //  The descending piano hook — F# F# F# F# E D C# D C# B.
  //  Root B3. Semitones from B: 7=F#, 5=E, 3=D, 2=C#, 0=B.
  //
  {
    name: 'Still D.R.E.',
    tag: 'HIP-HOP · 93 BPM · DR. DRE',
    description: 'The descending Bm piano hook, sub bass, laid-back 93 BPM kit.',
    bpm: 93,
    nodes: [
      // The piano hook — bells give the FM piano-like timbre
      {
        position: { x: 0, y: 0, z: -240 },
        params: {
          type: 'generative',
          wave: 'triangle',
          frequency: 246.94,     // B3
          gain: 0.22,
          arpSpeed: 1.86,        // 93 / 50 → 16ths at 93 BPM
          melodyScale: [
            7, null, 7, null,    // F# F#
            7, null, 7, null,    // F# F#
            5, 3, 2, 3,          // E D C# D
            2, null, 0, null,    // C# - B -
          ],
          filterCutoff: 2400,
          reverbWet: 0.45,
          chorusDepth: 0.15,
        },
        label: 'Bm hook', color: '#00f5d4',
        innerRadius: 120, outerRadius: 1000, muted: false,
      },
      // Sub bass — B1 root, heavy
      {
        position: { x: -240, y: 0, z: 60 },
        params: {
          type: 'bass',
          frequency: 61.74,      // B1
          gain: 0.36,
          drive: 0.35,
          filterCutoff: 180,
          subMix: 0.65,
          reverbWet: 0.15,
        },
        label: 'B1 sub', color: '#f72585',
        innerRadius: 120, outerRadius: 1000, muted: false,
      },
      // Kick — hip-hop shuffle at 93 BPM (tempo 23)
      {
        position: { x: 240, y: 0, z: 60 },
        params: {
          type: 'percussion',
          frequency: 58,
          gain: 0.34,
          noiseMix: 0.05,
          tempo: 23,
          attack: 0.001,
          decay: 0.04,
          sustain: 0,
          release: 0.13,
          reverbWet: 0.12,
        },
        label: 'kick', color: '#ffd60a',
        innerRadius: 120, outerRadius: 1000, muted: false,
      },
      // Hi-hat — trap-ish 16ths
      {
        position: { x: 0, y: 0, z: 240 },
        params: {
          type: 'percussion',
          frequency: 9000,
          gain: 0.09,
          noiseMix: 0.99,
          tempo: 186,            // 16ths at 93 BPM
          attack: 0.001,
          decay: 0.006,
          sustain: 0,
          release: 0.03,
          reverbWet: 0.08,
        },
        label: 'hat', color: '#ff6d00',
        innerRadius: 120, outerRadius: 1000, muted: false,
      },
    ],
  },


  // ═════ CLASSICAL — Beethoven · Symphony No. 5 · Cm · ≈108 BPM ══════════
  //
  //  The fate motif: "G G G Eb — F F F D".
  //  Root G3. Semitones from G: 0=G, -4=Eb, -2=F, -5=D.
  //  Motif 1 fills 16 steps, motif 2 fills the next 16 → 32-step loop.
  //
  {
    name: 'Fate Motif',
    tag: 'CLASSICAL · 108 BPM · BEETHOVEN',
    description: 'Beethoven\'s 5th opening. Cm orchestral strings, brass swells.',
    bpm: 108,
    nodes: [
      // The famous motif — triangle wave (softer than sawtooth), filtered
      {
        position: { x: 0, y: 0, z: 0 },
        params: {
          type: 'generative',
          wave: 'triangle',
          frequency: 196.00,     // G3
          gain: 0.20,
          arpSpeed: 2.16,        // 108 / 50 → 16ths at 108 BPM
          melodyScale: [
            // Motif 1: G G G — Eb (three staccato eighths + held half)
            0, null, 0, null, 0, null, -4, null,
            null, null, null, null, null, null, null, null,
            // Motif 2: F F F — D (transposed step down)
            -2, null, -2, null, -2, null, -5, null,
            null, null, null, null, null, null, null, null,
          ],
          filterCutoff: 1400,
          reverbWet: 0.55,
          chorusDepth: 0.18,
        },
        label: 'fate motif', color: '#ffd60a',
        innerRadius: 120, outerRadius: 1100, muted: false,
      },
      // C minor string section — Cm triad = C Eb G
      {
        position: { x: -260, y: 0, z: -80 },
        params: {
          type: 'strings',
          frequency: 130.81,     // C3
          gain: 0.11,
          detuneSpread: 40,
          filterCutoff: 1200,
          reverbWet: 0.55,
          chorusDepth: 0.22,
        },
        label: 'Cm strings', color: '#9b5de5',
        innerRadius: 120, outerRadius: 1100, muted: false,
      },
      // Low brass drone — bass at C2, minimal drive for a horn-like tone
      {
        position: { x: 260, y: 0, z: -80 },
        params: {
          type: 'bass',
          frequency: 65.41,      // C2
          gain: 0.22,
          drive: 0.20,
          filterCutoff: 320,
          subMix: 0.25,
          reverbWet: 0.40,
        },
        label: 'low brass', color: '#f72585',
        innerRadius: 120, outerRadius: 1100, muted: false,
      },
      // Cm pad — extra body for the orchestral wash
      {
        position: { x: 0, y: 0, z: 260 },
        params: {
          type: 'pad',
          frequency: 130.81,     // C3
          gain: 0.10,
          filterCutoff: 900,
          lfoRate: 0.04,
          chordVoicing: 'min',   // C Eb G
          reverbWet: 0.65,
          chorusDepth: 0.30,
        },
        label: 'Cm swell', color: '#4cc9f0',
        innerRadius: 120, outerRadius: 1100, muted: false,
      },
    ],
  },


  // ═════ JAZZ — Dave Brubeck · Take Five · Ebm · 174 BPM 5/4 ═════════════
  //
  //  The alto sax head, played on FM bells for that vibraphone/piano tone.
  //  Root Eb4. Sax notes: Bb - - Bb - Gb Bb - - Ab - Gb - F - Eb - - -
  //  Semitones from Eb: 7=Bb, 3=Gb, 5=Ab, 2=F, 0=Eb.
  //  20-step loop = one bar of 5/4 (5 * 4 sixteenths).
  //
  {
    name: 'Take Five',
    tag: 'JAZZ · 174 BPM · BRUBECK',
    description: 'Ebm7 vamp in 5/4 with the unmistakable descending sax theme.',
    bpm: 174,
    nodes: [
      // The sax theme — bells give an FM vibraphone-piano hybrid tone
      {
        position: { x: 0, y: 0, z: -260 },
        params: {
          type: 'generative',
          wave: 'triangle',
          frequency: 311.13,     // Eb4
          gain: 0.24,
          arpSpeed: 3.48,        // 174 / 50 → 16ths at 174 BPM
          melodyScale: [
            // 20 steps = 1 bar of 5/4 at 174
            7, null, null, null,   // Bb (long)
            7, null, 3, 7,         // Bb  Gb Bb
            null, null, 5, null,   // -   -  Ab
            3, null, 2, null,      // Gb  -  F
            0, null, null, null,   // Eb (long)
          ],
          filterCutoff: 3000,
          reverbWet: 0.42,
          chorusDepth: 0.10,
        },
        label: 'sax theme', color: '#ffd60a',
        innerRadius: 120, outerRadius: 1000, muted: false,
      },
      // Walking upright bass — Eb2, plucks quarter notes at 174 (tempo 174)
      {
        position: { x: -240, y: 0, z: 100 },
        params: {
          type: 'pluck',
          wave: 'triangle',
          frequency: 77.78,      // Eb2
          gain: 0.34,
          tempo: 174,            // quarter-note walking bass at 174 BPM
          decay: 0.32,
          harmonicMix: 40,
          filterCutoff: 750,
          reverbWet: 0.25,
          chorusDepth: 0.05,
        },
        label: 'walk bass', color: '#f72585',
        innerRadius: 120, outerRadius: 1000, muted: false,
      },
      // Ebm7 vamp chord — pad with min voicing (Eb Gb Bb) + optional 7 comes from sax
      {
        position: { x: 240, y: 0, z: 100 },
        params: {
          type: 'pad',
          frequency: 155.56,     // Eb3
          gain: 0.12,
          filterCutoff: 1400,
          lfoRate: 0.08,
          chordVoicing: 'min',
          reverbWet: 0.50,
          chorusDepth: 0.20,
        },
        label: 'Ebm7 vamp', color: '#9b5de5',
        innerRadius: 120, outerRadius: 1000, muted: false,
      },
      // Brush ride — busy noise-heavy perc at 16ths, very quiet
      {
        position: { x: 0, y: 0, z: 260 },
        params: {
          type: 'percussion',
          frequency: 5500,
          gain: 0.11,
          noiseMix: 0.92,
          tempo: 174,            // 16ths at ~174/4 quarter-note pulse
          attack: 0.001,
          decay: 0.02,
          sustain: 0,
          release: 0.06,
          reverbWet: 0.30,
        },
        label: 'brushes', color: '#ff6d00',
        innerRadius: 120, outerRadius: 1000, muted: false,
      },
    ],
  },


  // ═════ Empty Canvas ════════════════════════════════════════════════════
  {
    name: 'Empty Canvas',
    tag: 'clear · 0 nodes',
    description: 'Remove everything and start fresh.',
    nodes: [],
  },
];
