import { TokenPatternConfig } from './types';
import { tokenize } from './tokenizer';

/**
 * Masks structural tokens as <x id="N"/> before machine translation (DeepL tag_handling=xml / LLM prompt)
 * and restores them afterwards. See docs/SPEC_PLURALS_AUTOTRANSLATE.md §4.
 */

export interface MaskedText {
  masked: string;
  tokens: string[];
}

export function maskTokens(text: string, patterns: TokenPatternConfig): MaskedText {
  const tokens: string[] = [];
  const masked = tokenize(text, patterns)
    .map((segment) => {
      if (segment.type === 'text') return segment.value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      tokens.push(segment.raw);
      return `<x id="${tokens.length - 1}"/>`;
    })
    .join('');
  return { masked, tokens };
}

const MASK_TAG = /<x\s+id\s*=\s*["']?(\d+)["']?\s*\/?>(?:\s*<\/x>)?/g;

/** Restores tokens; returns null when a placeholder is missing, duplicated or unknown */
export function unmaskTokens(translated: string, tokens: string[]): string | null {
  const used = new Array(tokens.length).fill(0);
  let invalid = false;
  const restored = translated.replace(MASK_TAG, (_, id: string) => {
    const index = Number(id);
    if (index >= tokens.length) {
      invalid = true;
      return '';
    }
    used[index]++;
    return tokens[index];
  });
  if (invalid || used.some((count) => count !== 1)) return null;
  return restored.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

const PSEUDO_MAP: Record<string, string> = {
  a: 'à', b: 'ƀ', c: 'ç', d: 'ð', e: 'é', f: 'ƒ', g: 'ĝ', h: 'ĥ', i: 'î', j: 'ĵ', k: 'ķ', l: 'ļ', m: 'ɱ',
  n: 'ñ', o: 'ö', p: 'þ', r: 'ŕ', s: 'š', t: 'ţ', u: 'û', w: 'ŵ', y: 'ý', z: 'ž',
  A: 'Å', B: 'Ɓ', C: 'Ç', D: 'Ð', E: 'É', G: 'Ĝ', H: 'Ĥ', I: 'Î', J: 'Ĵ', K: 'Ķ', L: 'Ļ', N: 'Ñ', O: 'Ö',
  R: 'Ŕ', S: 'Š', T: 'Ţ', U: 'Û', W: 'Ŵ', Y: 'Ý', Z: 'Ž',
};

/**
 * Pseudo-localization (demo / QA provider): accents letters and pads the text by ~30%
 * so that truncation, hard-coded strings and broken placeholders are easy to spot. Tags are untouched.
 */
export function pseudoLocalize(masked: string, locale: string): string {
  const parts = masked.split(/(<x\s+id="\d+"\/>|&[a-z]+;)/g);
  const body = parts
    .map((part, i) => (i % 2 === 1 ? part : part.replace(/[A-Za-z]/g, (ch) => PSEUDO_MAP[ch] ?? ch)))
    .join('');
  const visible = masked.replace(/<x\s+id="\d+"\/>/g, '').length;
  const padding = '~'.repeat(Math.max(1, Math.round(visible * 0.3)));
  return `[${locale}] ${body} ${padding}`;
}
