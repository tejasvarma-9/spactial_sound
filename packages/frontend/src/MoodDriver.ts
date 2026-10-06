import type { AudioEngine, NodeId, SpatialNodeDescriptor, MoodAnalysis } from '@spatial-soundscape/engine';

const MOOD_COLORS = {
  positive: '#00f5d4',
  neutral:  '#9b5de5',
  negative: '#f72585',
} as const;

const MOOD_ROOT_NOTE = { positive: 64, neutral: 60, negative: 56 } as const;
const MOOD_TEMPO     = { positive: 128, neutral: 90, negative: 72 } as const;

const LEXICON: Record<string, number> = {
  good: 2, great: 3, amazing: 3, awesome: 3, beautiful: 3, brilliant: 3,
  excellent: 3, fantastic: 3, gorgeous: 3, incredible: 3, lovely: 2,
  perfect: 3, wonderful: 3, fabulous: 3, magnificent: 3, sublime: 3,
  happy: 2, joyful: 3, glad: 2, excited: 2, thrilled: 3, delighted: 3,
  cheerful: 2, content: 2, peaceful: 2, calm: 2, serene: 3, blissful: 3,
  love: 3, like: 1, enjoy: 2, adore: 3, treasure: 2,
  bright: 2, warm: 2, soft: 1, smooth: 1, soothing: 2,
  yes: 1, win: 2, success: 2, victory: 3,
  cool: 2, nice: 1, fun: 2, fine: 1, ok: 0,
  best: 3, better: 1, hope: 2, dream: 1, alive: 2,

  bad: -2, terrible: -3, awful: -3, horrible: -3, dreadful: -3,
  worst: -3, worse: -2, poor: -2, ugly: -2, gross: -2,
  sad: -2, depressed: -3, miserable: -3, unhappy: -2, sorrowful: -3,
  heavy: -2, dark: -2, gloomy: -2, bleak: -3, hopeless: -3,
  angry: -2, mad: -2, furious: -3, rage: -3, hate: -3,
  fear: -2, afraid: -2, scared: -2, terrified: -3, anxious: -2,
  pain: -2, painful: -3, hurt: -2, suffering: -3, agony: -3,
  lost: -2, broken: -2, empty: -2, alone: -2, lonely: -2,
  cry: -2, tears: -2, weep: -2,
  tired: -1, exhausted: -2, sick: -2,
  no: -1, never: -1, nothing: -1, none: -1,
  dying: -3, dead: -2, kill: -3, death: -3,
  failure: -2, fail: -2, lose: -2,
  brooding: -2, melancholy: -2, sombre: -2, somber: -2, weary: -2,

  fire: 3, lit: 3, slay: 3, vibe: 2, vibes: 2, banger: 3, dope: 2,
  rock: 2, rocks: 2, fresh: 2, crisp: 2, chill: 2, chilled: 2,
  goated: 3, peak: 3, godly: 3, epic: 3, legendary: 3, clean: 2,
  bro: 1, dude: 1, fam: 1,
  mid: -1, cringe: -2, trash: -2, wack: -2, ass: -2, bust: -2, flop: -2,
  bored: -1, boring: -2, dull: -2, meh: -1, ugh: -2,
};

const INTENSIFIERS = new Set(['very', 'really', 'extremely', 'so', 'totally', 'absolutely', 'incredibly', 'utterly']);
const DOWNTONERS  = new Set(['kind', 'sort', 'somewhat', 'slightly', 'a little', 'a bit']);
const NEGATORS    = new Set(['not', 'never', 'no', "n't", 'cannot', "can't", "won't", "isn't", "wasn't", "aren't", "don't"]);

interface LexiconResult { score: number; matches: number; matchedWords: string[] }

function lexiconScore(text: string): LexiconResult {
  const tokens = text.toLowerCase().split(/[^a-z']+/).filter(Boolean);
  let sum = 0, matches = 0;
  const matchedWords: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    const base = LEXICON[tok];
    if (base === undefined) continue;
    let v = base;
    const prev = tokens[i - 1];
    if (prev && INTENSIFIERS.has(prev)) v *= 1.6;
    else if (prev && DOWNTONERS.has(prev))    v *= 0.4;
    const win = [tokens[i - 1], tokens[i - 2]];
    if (win.some(w => w && NEGATORS.has(w))) v = -v;
    sum += v;
    matches++;
    matchedWords.push(tok);
  }
  return { score: sum, matches, matchedWords };
}


type SentimentPipeline = (text: string) => Promise<Array<{ label: string; score: number }>>;
let mlPipeline: SentimentPipeline | null = null;
let mlAttempted = false;

async function tryLoadMlUpgrade(): Promise<SentimentPipeline | null> {
  if (mlPipeline) return mlPipeline;
  if (mlAttempted) return null;
  mlAttempted = true;
  try {
    // Function() avoids TS resolving the URL as a module path at compile time.
    const url = 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2/+esm';
    const dynImport = new Function('u', 'return import(u)') as
      (u: string) => Promise<{ pipeline: (task: string, model: string) => Promise<SentimentPipeline> }>;
    const mod = await dynImport(url);
    mlPipeline = await mod.pipeline(
      'sentiment-analysis',
      'Xenova/distilbert-base-uncased-finetuned-sst-2-english',
    );
    console.log('🧠 distilbert sentiment loaded — mood engine upgraded to ML mode');
    return mlPipeline;
  } catch (err) {
    console.warn('🧠 ML upgrade unavailable, staying on lexicon mode:', err);
    return null;
  }
}


export type MoodMode = 'lexicon' | 'ml';

export class MoodDriver {
  lastMode: MoodMode = 'lexicon';
  lastMatchedWords: string[] = [];

  constructor() {
    void tryLoadMlUpgrade();
  }

  async analyse(text: string): Promise<MoodAnalysis> {
    if (mlPipeline) {
      try {
        const res = await mlPipeline(text);
        const top = res[0];
        const label = (top?.label ?? 'NEUTRAL').toUpperCase();
        const score = top?.score ?? 0.5;
        this.lastMode = 'ml';
        this.lastMatchedWords = [];
        return MoodDriver._build(
          label === 'POSITIVE' ? (score > 0.6 ? 'positive' : 'neutral')
          : label === 'NEGATIVE' ? (score > 0.6 ? 'negative' : 'neutral')
          : 'neutral',
          score,
        );
      } catch { /* fall through */ }
    }

    const { score, matches, matchedWords } = lexiconScore(text);
    this.lastMode = 'lexicon';
    this.lastMatchedWords = matchedWords;
    if (matches === 0) {
      return MoodDriver._build('neutral', 0.5);
    }
    const avg = score / Math.max(1, matches);
    const confidence = Math.min(0.98, 0.5 + Math.abs(avg) * 0.18);
    const mood: MoodAnalysis['mood'] =
      avg >  0.35 ? 'positive' :
      avg < -0.35 ? 'negative' :
      'neutral';
    return MoodDriver._build(mood, confidence);
  }

  private static _build(mood: MoodAnalysis['mood'], score: number): MoodAnalysis {
    return {
      mood,
      score,
      suggestedKey: MOOD_ROOT_NOTE[mood],
      suggestedTempo: MOOD_TEMPO[mood],
      suggestedColor: MOOD_COLORS[mood],
    };
  }

  applyToScene(
    result: MoodAnalysis,
    nodes: Map<NodeId, SpatialNodeDescriptor>,
    engine: AudioEngine,
  ): void {
    const rootHz = 440 * Math.pow(2, (result.suggestedKey - 69) / 12);
    // Major triad / minor triad / open fourths.
    const intervals =
      result.mood === 'positive' ? [0, 4, 7, 12, 16, 19] :
      result.mood === 'negative' ? [0, 3, 7, 10, 15, 19] :
      [0, 5, 7, 12, 17, 19];

    let i = 0;
    for (const [id, n] of nodes) {
      if (n.params.type === 'bass') { i++; continue; }
      const semitones = intervals[i % intervals.length] ?? 0;
      const f = rootHz * Math.pow(2, semitones / 12);
      const updated: SpatialNodeDescriptor = { ...n, params: { ...n.params, frequency: f } };
      nodes.set(id, updated);
      engine.getNode(id)?.updateParams({ frequency: f });
      i++;
    }

    engine.setReverbWet(
      result.mood === 'negative' ? 0.55 :
      result.mood === 'positive' ? 0.25 :
      0.35,
    );

    document.documentElement.style.setProperty('--neon-cyan', result.suggestedColor);
  }
}
