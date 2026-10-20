import { TokenPatternConfig, ValidationIssue } from './types';

/**
 * Universal tokenizer for translation strings (docs/SPEC_EDITOR_TOKENIZER.md).
 *
 * Splits a string into editable text and locked structural tokens:
 * interpolation variables, inline Markdown, links, inline code and HTML tags.
 * `serializeSegments(tokenize(s)) === s` always holds.
 */

export type TokenKind = 'variable' | 'markdown' | 'link' | 'code' | 'html';
export type TokenRole = 'atomic' | 'open' | 'close';

export interface TextSegment {
  type: 'text';
  value: string;
}

export interface TokenSegment {
  type: 'token';
  kind: TokenKind;
  role: TokenRole;
  /** Exact characters from the string */
  raw: string;
  /** Position-independent identity used by validation */
  signature: string;
  /** Short chip caption */
  label: string;
  /** Shared by the open and close token of one pair */
  pairId?: number;
}

export type Segment = TextSegment | TokenSegment;

export const INTERPOLATION_PRESETS = ['icu', 'i18next', 'printf', 'vue-linked'] as const;

export const DEFAULT_TOKEN_PATTERNS: TokenPatternConfig = {
  interpolation: ['icu', 'vue-linked'],
  markdown: true,
  html: true,
};

interface RawMatch {
  start: number;
  end: number;
  token: Omit<TokenSegment, 'type'>;
}

type Matcher = (text: string, pos: number) => Omit<TokenSegment, 'type'> & { length: number } | null;

function sticky(pattern: RegExp): RegExp {
  const flags = pattern.flags.replace(/[gy]/g, '') + 'y';
  return new RegExp(pattern.source, flags);
}

function execAt(re: RegExp, text: string, pos: number): RegExpExecArray | null {
  re.lastIndex = pos;
  return re.exec(text);
}

/** Parses "/source/flags" strings from project config. Returns null for invalid input. */
export function parseCustomPattern(pattern: string): RegExp | null {
  const m = /^\/(.+)\/([a-z]*)$/s.exec(pattern.trim());
  if (!m) return null;
  try {
    return sticky(new RegExp(m[1], m[2].replace(/[^imsu]/g, '')));
  } catch {
    return null;
  }
}

export function isValidInterpolationPattern(pattern: string): boolean {
  return (INTERPOLATION_PRESETS as readonly string[]).includes(pattern) || parseCustomPattern(pattern) !== null;
}

const RE_CODE = /`([^`\n]+)`/y;
const RE_I18NEXT = /\{\{\s*([^{}]+?)\s*\}\}/y;
const RE_ICU_SIMPLE = /\{\s*([A-Za-z0-9_$][A-Za-z0-9_$.-]*)\s*\}/y;
const RE_ICU_FORMATTED = /\{\s*([A-Za-z0-9_]+)\s*,\s*(number|date|time|spellout|ordinal|duration)\s*(,[^{}]*)?\}/y;
const RE_VUE_LITERAL = /\{'[^'\n]*'\}/y;
const RE_PRINTF = /%(?:%|\d+\$[sdifu@]|\([A-Za-z0-9_]+\)[sdifu]|[sdifu@])/y;
const RE_VUE_LINKED = /@(?:\.[a-zA-Z]+)?:(?:\([^)\n]+\)|[A-Za-z0-9_][A-Za-z0-9_.-]*[A-Za-z0-9_]|[A-Za-z0-9_])/y;
const RE_HTML = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[a-zA-Z_:][a-zA-Z0-9_:.-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/y;
const RE_LINK = /\[([^[\]\n]*)\]\(([^()\s]+)\)/y;
const RE_ICU_COMPLEX = /\{\s*[A-Za-z0-9_]+\s*,\s*(plural|select|selectordinal)\s*,/;

const HTML_VOID = new Set(['br', 'hr', 'img', 'input', 'wbr', 'meta', 'link', 'source']);

function variable(raw: string, signatureBody: string): Omit<TokenSegment, 'type'> & { length: number } {
  return { kind: 'variable', role: 'atomic', raw, signature: `var:${signatureBody}`, label: raw.trim(), length: raw.length };
}

function buildMatchers(options: TokenPatternConfig): Matcher[] {
  const matchers: Matcher[] = [];
  const presets = new Set(options.interpolation);

  if (options.markdown) {
    matchers.push((text, pos) => {
      const m = execAt(RE_CODE, text, pos);
      if (!m) return null;
      return {
        kind: 'code', role: 'atomic', raw: m[0], signature: `code:${m[1]}`,
        label: m[1].length > 24 ? m[1].slice(0, 23) + '…' : m[1], length: m[0].length,
      };
    });
  }

  if (presets.has('i18next')) {
    matchers.push((text, pos) => {
      const m = execAt(RE_I18NEXT, text, pos);
      return m ? variable(m[0], `{{${m[1].trim()}}}`) : null;
    });
  }

  if (presets.has('icu')) {
    matchers.push((text, pos) => {
      const m = execAt(RE_VUE_LITERAL, text, pos);
      return m ? variable(m[0], m[0]) : null;
    });
    matchers.push((text, pos) => {
      const m = execAt(RE_ICU_FORMATTED, text, pos);
      return m ? variable(m[0], m[0].replace(/\s+/g, '')) : null;
    });
    matchers.push((text, pos) => {
      const m = execAt(RE_ICU_SIMPLE, text, pos);
      return m ? variable(m[0], `{${m[1]}}`) : null;
    });
  }

  if (presets.has('printf')) {
    matchers.push((text, pos) => {
      const m = execAt(RE_PRINTF, text, pos);
      return m ? variable(m[0], m[0]) : null;
    });
  }

  if (presets.has('vue-linked')) {
    matchers.push((text, pos) => {
      const m = execAt(RE_VUE_LINKED, text, pos);
      return m ? variable(m[0], m[0]) : null;
    });
  }

  for (const pattern of options.interpolation) {
    if ((INTERPOLATION_PRESETS as readonly string[]).includes(pattern)) continue;
    const re = parseCustomPattern(pattern);
    if (!re) continue;
    matchers.push((text, pos) => {
      const m = execAt(re, text, pos);
      if (!m || m[0].length === 0) return null;
      return variable(m[0], m[0]);
    });
  }

  if (options.html) {
    matchers.push((text, pos) => {
      const m = execAt(RE_HTML, text, pos);
      if (!m) return null;
      const [raw, slash, tagName, attrs, selfClose] = m;
      const tag = tagName.toLowerCase();
      const normalizedAttrs = attrs.trim().replace(/\s+/g, ' ');
      if (slash) {
        return { kind: 'html', role: 'close', raw, signature: `html:close:${tag}`, label: `</${tag}>`, length: raw.length };
      }
      const role: TokenRole = selfClose || HTML_VOID.has(tag) ? 'atomic' : 'open';
      return {
        kind: 'html', role, raw,
        signature: `html:${role}:${tag}${normalizedAttrs ? ' ' + normalizedAttrs : ''}`,
        label: role === 'atomic' ? `<${tag}/>` : `<${tag}>`,
        length: raw.length,
      };
    });
  }

  return matchers;
}

interface DelimiterCandidate {
  start: number;
  delim: string;
  canOpen: boolean;
  canClose: boolean;
}

const EMPHASIS_LABELS: Record<string, string> = { '**': 'B', __: 'B', '~~': 'S', '*': 'I', _: 'I' };
const EMPHASIS_NAMES: Record<string, string> = {
  '**': 'pogrubienie', __: 'pogrubienie', '~~': 'przekreślenie', '*': 'kursywa', _: 'kursywa',
};

const isSpace = (ch: string | undefined) => ch === undefined || /\s/.test(ch);
const isAlnum = (ch: string | undefined) => ch !== undefined && /[\p{L}\p{N}]/u.test(ch);

function findDelimiterCandidates(text: string, start: number, end: number, out: DelimiterCandidate[]) {
  let i = start;
  while (i < end) {
    const two = text.slice(i, i + 2);
    let delim: string | null = null;
    if ((two === '**' || two === '__' || two === '~~') && i + 2 <= end) delim = two;
    else if (text[i] === '*' || text[i] === '_') delim = text[i];

    if (!delim) {
      i++;
      continue;
    }
    // A run of 3+ identical characters (e.g. "***", "___") is treated as plain text
    const runChar = text[i];
    let runEnd = i;
    while (runEnd < end && text[runEnd] === runChar) runEnd++;
    if (runEnd - i > 2 || (delim.length === 1 && runEnd - i > 1)) {
      i = runEnd;
      continue;
    }

    const prev = text[i - 1];
    const next = text[i + delim.length];
    let canOpen = !isSpace(next);
    let canClose = !isSpace(prev);
    if (delim === '_' || delim === '__') {
      // Intraword underscores (snake_case) are never emphasis
      if (isAlnum(prev)) canOpen = false;
      if (isAlnum(next)) canClose = false;
    }
    if (canOpen || canClose) out.push({ start: i, delim, canOpen, canClose });
    i += delim.length;
  }
}

export function tokenize(text: string, options: TokenPatternConfig = DEFAULT_TOKEN_PATTERNS): Segment[] {
  if (!text) return [];
  const matchers = buildMatchers(options);
  const matches: RawMatch[] = [];
  const textRanges: Array<[number, number]> = [];
  let pairCounter = 0;
  let linkCounter = 0;

  // Pending link closers: position -> token; `limit` stops inner matches from crossing a closer
  const pendingClosers: RawMatch[] = [];

  let pos = 0;
  let textStart = 0;
  const flushText = (until: number) => {
    if (until > textStart) textRanges.push([textStart, until]);
  };

  while (pos < text.length) {
    const closer = pendingClosers[pendingClosers.length - 1];
    if (closer && pos === closer.start) {
      flushText(pos);
      matches.push(pendingClosers.pop()!);
      pos = closer.end;
      textStart = pos;
      continue;
    }
    const limit = closer ? closer.start : text.length;

    let matched: RawMatch | null = null;
    for (const matcher of matchers) {
      const result = matcher(text, pos);
      if (result && result.length > 0 && pos + result.length <= limit) {
        const { length, ...token } = result;
        matched = { start: pos, end: pos + length, token };
        break;
      }
    }

    if (!matched && options.markdown && text[pos] === '[') {
      const m = execAt(RE_LINK, text, pos);
      if (m && pos + m[0].length <= limit) {
        const pairId = ++pairCounter;
        const linkNo = ++linkCounter;
        const closeStart = pos + 1 + m[1].length;
        matched = {
          start: pos,
          end: pos + 1,
          token: { kind: 'link', role: 'open', raw: '[', signature: 'link:open', label: `Link ${linkNo}`, pairId },
        };
        pendingClosers.push({
          start: closeStart,
          end: pos + m[0].length,
          token: {
            kind: 'link', role: 'close', raw: text.slice(closeStart, pos + m[0].length),
            signature: `link:close:${m[2]}`, label: m[2], pairId,
          },
        });
      }
    }

    if (matched) {
      flushText(pos);
      matches.push(matched);
      pos = matched.end;
      textStart = pos;
    } else {
      pos++;
    }
  }
  flushText(text.length);

  // Markdown emphasis pairing across the whole string (delimiters live in text ranges only)
  if (options.markdown) {
    const candidates: DelimiterCandidate[] = [];
    for (const [s, e] of textRanges) findDelimiterCandidates(text, s, e, candidates);

    const openStacks = new Map<string, DelimiterCandidate[]>();
    const pairs: Array<[DelimiterCandidate, DelimiterCandidate]> = [];
    for (const c of candidates) {
      const stack = openStacks.get(c.delim) ?? [];
      if (c.canClose && stack.length > 0) {
        pairs.push([stack.pop()!, c]);
      } else if (c.canOpen) {
        stack.push(c);
      }
      openStacks.set(c.delim, stack);
    }

    for (const [open, close] of pairs) {
      const pairId = ++pairCounter;
      const label = EMPHASIS_LABELS[open.delim];
      matches.push({
        start: open.start, end: open.start + open.delim.length,
        token: { kind: 'markdown', role: 'open', raw: open.delim, signature: `md:${open.delim}:open`, label, pairId },
      });
      matches.push({
        start: close.start, end: close.start + close.delim.length,
        token: { kind: 'markdown', role: 'close', raw: close.delim, signature: `md:${close.delim}:close`, label, pairId },
      });
    }
  }

  matches.sort((a, b) => a.start - b.start);

  const segments: Segment[] = [];
  let cursor = 0;
  for (const m of matches) {
    if (m.start > cursor) segments.push({ type: 'text', value: text.slice(cursor, m.start) });
    segments.push({ type: 'token', ...m.token });
    cursor = m.end;
  }
  if (cursor < text.length) segments.push({ type: 'text', value: text.slice(cursor) });
  return segments;
}

export function serializeSegments(segments: Segment[]): string {
  return segments.map((s) => (s.type === 'text' ? s.value : s.raw)).join('');
}

export function getTokens(text: string, options?: TokenPatternConfig): TokenSegment[] {
  return tokenize(text, options).filter((s): s is TokenSegment => s.type === 'token');
}

/** ICU plural/select/selectordinal expressions are edited in raw mode until Phase 2 (PRD F7) */
export function detectIcuMessage(text: string): boolean {
  return RE_ICU_COMPLEX.test(text);
}

/** Human-readable token description used in validation messages */
export function describeToken(token: Pick<TokenSegment, 'kind' | 'role' | 'raw' | 'label'>): string {
  switch (token.kind) {
    case 'variable':
      return token.raw.trim();
    case 'code':
      return `\`${token.label}\` (kod)`;
    case 'link':
      return token.role === 'open' ? 'początek linku [' : `koniec linku → ${token.label}`;
    case 'markdown': {
      const name = EMPHASIS_NAMES[token.raw] ?? 'formatowanie';
      return `${token.role === 'open' ? 'otwarcie' : 'zamknięcie'} ${token.raw} (${name})`;
    }
    case 'html':
      return token.raw;
  }
}

export interface TokenUsage {
  signature: string;
  token: TokenSegment;
  sourceCount: number;
  targetCount: number;
}

/** Per-signature counts for the token palette (source order first, then unexpected target tokens) */
export function getTokenUsage(source: string, target: string, options?: TokenPatternConfig): TokenUsage[] {
  const usage = new Map<string, TokenUsage>();
  for (const token of getTokens(source, options)) {
    const entry = usage.get(token.signature);
    if (entry) entry.sourceCount++;
    else usage.set(token.signature, { signature: token.signature, token, sourceCount: 1, targetCount: 0 });
  }
  for (const token of getTokens(target, options)) {
    const entry = usage.get(token.signature);
    if (entry) entry.targetCount++;
    else usage.set(token.signature, { signature: token.signature, token, sourceCount: 0, targetCount: 1 });
  }
  return Array.from(usage.values());
}

/**
 * Structural validation of a translation against its source (PRD R2.4).
 * Errors block saving; token order may differ freely.
 */
export function validateTokens(
  source: string,
  target: string,
  options?: TokenPatternConfig,
  localeLabel?: string
): ValidationIssue[] {
  if (!target || !source) return [];
  const prefix = localeLabel ? `[${localeLabel}] ` : '';
  const issues: ValidationIssue[] = [];

  for (const u of getTokenUsage(source, target, options)) {
    const desc = describeToken(u.token);
    if (u.sourceCount === 0) {
      issues.push({ type: 'error', message: `${prefix}Nieoczekiwany token ${desc} — nie występuje w tekście źródłowym.` });
    } else if (u.targetCount < u.sourceCount) {
      issues.push({
        type: 'error',
        message: `${prefix}Brakuje tokenu ${desc} (źródło: ${u.sourceCount}×, tłumaczenie: ${u.targetCount}×).`,
      });
    } else if (u.targetCount > u.sourceCount) {
      issues.push({
        type: 'error',
        message: `${prefix}Token ${desc} jest zduplikowany (źródło: ${u.sourceCount}×, tłumaczenie: ${u.targetCount}×).`,
      });
    }
  }

  // HTML open/close order (Markdown and links are paired by construction).
  // Skipped when the source itself is malformed, so copying the source is always valid.
  if (findHtmlOrderProblems(source, options).length === 0) {
    for (const problem of findHtmlOrderProblems(target, options)) {
      issues.push({ type: 'error', message: prefix + problem });
    }
  }

  return issues;
}

function findHtmlOrderProblems(text: string, options?: TokenPatternConfig): string[] {
  const problems: string[] = [];
  const stack: string[] = [];
  for (const token of getTokens(text, options)) {
    if (token.kind !== 'html') continue;
    const tag = token.label.replace(/[</>]/g, '');
    if (token.role === 'open') stack.push(tag);
    if (token.role === 'close') {
      if (stack[stack.length - 1] === tag) {
        stack.pop();
      } else {
        problems.push(`Znacznik ${token.raw} zamyka element, który nie został otwarty w tej kolejności.`);
        const idx = stack.lastIndexOf(tag);
        if (idx >= 0) stack.splice(idx, 1);
      }
    }
  }
  for (const tag of stack) problems.push(`Znacznik <${tag}> nie został zamknięty.`);
  return problems;
}
