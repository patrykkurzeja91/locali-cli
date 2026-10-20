import type { MessageFormat, TokenPatternConfig } from './types';
import { DEFAULT_TOKEN_PATTERNS, TokenSegment, tokenize } from './tokenizer';
import { IcuNode, hasIcuComplexArgument, serializeIcu, tryParseIcu } from './icu';
import { getPipeFormLabels, hasPipePlural, splitPipeForms } from './pipePlural';

/**
 * Word-level diff of a source text (docs/tickets/p0-source-diff-for-outdated-keys.md).
 *
 * "What changed since this translation was made?" — words and punctuation marks are the units, but variables,
 * tags, Markdown and links from the tokenizer are single atomic units, so `{name}` → `{user}` is one removed and
 * one added chip, never half a variable. ICU and vue-i18n plurals are compared form by form when both sides have
 * the same forms; otherwise the whole string is compared.
 * Pure: no React, no DOM.
 */

export interface DiffUnit {
  text: string;
  /** Whitespace preceded this unit in its own text */
  spaceBefore: boolean;
  /** Present for locked tokens, which the UI renders as chips */
  token?: TokenSegment;
}

export type DiffType = 'same' | 'removed' | 'added';

export interface DiffPart {
  type: DiffType;
  units: DiffUnit[];
}

export interface FormDiff {
  label: string;
  changed: boolean;
  parts: DiffPart[];
}

export type SourceDiff =
  | { kind: 'identical'; onlySpacing: boolean }
  | { kind: 'text'; parts: DiffPart[] }
  | { kind: 'forms'; forms: FormDiff[] };

/** Above this many unit pairs the O(n·m) comparison is skipped and the whole text is shown as replaced */
const MAX_CELLS = 4_000_000;

// A word (letters, digits, inner apostrophes and hyphens), a number with separators, or one punctuation mark
const UNIT_RE = /[\p{L}\p{M}][\p{L}\p{M}\p{N}'’_-]*|\p{N}+(?:[.,]\p{N}+)*|[^\s\p{L}\p{M}\p{N}]/gu;

export function toUnits(text: string, patterns: TokenPatternConfig = DEFAULT_TOKEN_PATTERNS): DiffUnit[] {
  const units: DiffUnit[] = [];
  let pendingSpace = false;
  for (const segment of tokenize(text, patterns)) {
    if (segment.type === 'token') {
      units.push({ text: segment.raw, spaceBefore: pendingSpace, token: segment });
      pendingSpace = false;
      continue;
    }
    const value = segment.value;
    let cursor = 0;
    for (const match of value.matchAll(UNIT_RE)) {
      const index = match.index ?? 0;
      const gap = value.slice(cursor, index);
      units.push({ text: match[0], spaceBefore: pendingSpace || /\s/.test(gap), });
      pendingSpace = false;
      cursor = index + match[0].length;
    }
    pendingSpace = pendingSpace || /\s/.test(value.slice(cursor)) ;
  }
  return units;
}

const unitKey = (u: DiffUnit) => (u.token ? `t:${u.token.raw}` : `w:${u.text}`);

type Op = { type: DiffType; unit: DiffUnit };

function lcsOps(a: DiffUnit[], b: DiffUnit[]): Op[] {
  // Trim what both sides share at the start and the end: usually most of the text
  let start = 0;
  while (start < a.length && start < b.length && unitKey(a[start]) === unitKey(b[start])) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && unitKey(a[endA - 1]) === unitKey(b[endB - 1])) {
    endA--;
    endB--;
  }

  const ops: Op[] = [];
  for (let i = 0; i < start; i++) ops.push({ type: 'same', unit: b[i] });

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const n = midA.length;
  const m = midB.length;

  if (n * m > MAX_CELLS) {
    for (const unit of midA) ops.push({ type: 'removed', unit });
    for (const unit of midB) ops.push({ type: 'added', unit });
  } else if (n === 0 || m === 0) {
    for (const unit of midA) ops.push({ type: 'removed', unit });
    for (const unit of midB) ops.push({ type: 'added', unit });
  } else {
    // table[i][j] = length of the longest common subsequence of midA[i..] and midB[j..]
    const width = m + 1;
    const table = new Uint16Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        table[i * width + j] =
          unitKey(midA[i]) === unitKey(midB[j]) ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
      }
    }
    // Walk forward; within a changed block removals come before additions
    let i = 0;
    let j = 0;
    let removed: DiffUnit[] = [];
    let added: DiffUnit[] = [];
    const flush = () => {
      for (const unit of removed) ops.push({ type: 'removed', unit });
      for (const unit of added) ops.push({ type: 'added', unit });
      removed = [];
      added = [];
    };
    while (i < n && j < m) {
      if (unitKey(midA[i]) === unitKey(midB[j])) {
        flush();
        ops.push({ type: 'same', unit: midB[j] });
        i++;
        j++;
      } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
        removed.push(midA[i++]);
      } else {
        added.push(midB[j++]);
      }
    }
    while (i < n) removed.push(midA[i++]);
    while (j < m) added.push(midB[j++]);
    flush();
  }

  for (let i = endB; i < b.length; i++) ops.push({ type: 'same', unit: b[i] });
  return ops;
}

function groupOps(ops: Op[]): DiffPart[] {
  const parts: DiffPart[] = [];
  for (const op of ops) {
    const last = parts[parts.length - 1];
    if (last && last.type === op.type) last.units.push(op.unit);
    else parts.push({ type: op.type, units: [op.unit] });
  }
  return parts;
}

export function diffText(oldText: string, newText: string, patterns: TokenPatternConfig = DEFAULT_TOKEN_PATTERNS): DiffPart[] {
  return groupOps(lcsOps(toUnits(oldText, patterns), toUnits(newText, patterns)));
}

const hasChanges = (parts: DiffPart[]) => parts.some((p) => p.type !== 'same');

interface Slot {
  label: string;
  text: string;
}

/** ICU message → its plural / select forms (+ the text outside them), each as plain text */
function icuSlots(nodes: IcuNode[]): Slot[] | null {
  const complex = nodes.filter((n): n is Extract<IcuNode, { type: 'plural' | 'select' }> => n.type === 'plural' || n.type === 'select');
  if (complex.length === 0) return null;
  const slots: Slot[] = [{ label: 'Tekst poza formami', text: serializeIcu(nodes.filter((n) => n.type !== 'plural' && n.type !== 'select')) }];
  const seen = new Map<string, number>();
  for (const node of complex) {
    for (const option of node.options) {
      const base = `${node.name} — ${option.selector}`;
      const count = (seen.get(base) ?? 0) + 1;
      seen.set(base, count);
      slots.push({ label: count > 1 ? `${base} (${count})` : base, text: serializeIcu(option.value, node.type === 'plural') });
    }
  }
  return slots;
}

function diffSlots(oldSlots: Slot[], newSlots: Slot[], patterns: TokenPatternConfig): FormDiff[] | null {
  const oldByLabel = new Map(oldSlots.map((s) => [s.label, s.text]));
  const sameForms = oldSlots.length === newSlots.length && newSlots.every((s) => oldByLabel.has(s.label));
  if (!sameForms) return null;
  const forms = newSlots.map((slot) => {
    const parts = diffText(oldByLabel.get(slot.label) ?? '', slot.text, patterns);
    return { label: slot.label, changed: hasChanges(parts), parts };
  });
  return forms.some((f) => f.changed) ? forms : null;
}

function diffForms(oldText: string, newText: string, patterns: TokenPatternConfig, format: MessageFormat): FormDiff[] | null {
  if (hasIcuComplexArgument(oldText) && hasIcuComplexArgument(newText)) {
    const a = tryParseIcu(oldText).nodes;
    const b = tryParseIcu(newText).nodes;
    const oldSlots = a && icuSlots(a);
    const newSlots = b && icuSlots(b);
    if (oldSlots && newSlots) return diffSlots(oldSlots, newSlots, patterns);
    return null;
  }
  if (format === 'vue-i18n' && hasPipePlural(oldText) && hasPipePlural(newText)) {
    const oldForms = splitPipeForms(oldText);
    const newForms = splitPipeForms(newText);
    if (oldForms.length !== newForms.length) return null;
    const labels = getPipeFormLabels(newForms.length);
    return diffSlots(
      oldForms.map((text, i) => ({ label: labels[i], text })),
      newForms.map((text, i) => ({ label: labels[i], text })),
      patterns
    );
  }
  return null;
}

export function diffSource(
  oldText: string,
  newText: string,
  patterns: TokenPatternConfig = DEFAULT_TOKEN_PATTERNS,
  format: MessageFormat = 'icu'
): SourceDiff {
  if (oldText === newText) return { kind: 'identical', onlySpacing: false };

  const forms = diffForms(oldText, newText, patterns, format);
  if (forms) return { kind: 'forms', forms };

  const parts = diffText(oldText, newText, patterns);
  if (!hasChanges(parts)) return { kind: 'identical', onlySpacing: true };
  return { kind: 'text', parts };
}

/** Plain-text rendering of a diff, e.g. "Przejdź do [-koszyka-] {+kasy+}" — handy for tests and screen-reader fallbacks */
export function describeParts(parts: DiffPart[]): string {
  return parts
    .map((part) => {
      const text = part.units.map((u, i) => (i > 0 && u.spaceBefore ? ' ' : '') + u.text).join('');
      return part.type === 'removed' ? `[-${text}-]` : part.type === 'added' ? `{+${text}+}` : text;
    })
    .reduce((acc, chunk, i) => acc + (i > 0 ? ' ' : '') + chunk, '')
    .replace(/ ([.,;:!?…)])/g, '$1');
}
