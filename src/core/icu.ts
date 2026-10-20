import { LocaleCode, TokenPatternConfig, ValidationIssue } from './types';
import { validateTokens } from './tokenizer';

/**
 * ICU MessageFormat support (PRD F7, docs/SPEC_PLURALS_AUTOTRANSLATE.md).
 * Parser + serializer for the subset used in UI strings: simple and formatted arguments,
 * plural / selectordinal (with offset and =N selectors), select and `#`.
 * Apostrophe quoting follows ICU's DOUBLE_OPTIONAL mode ('' = literal quote, '{' = literal brace).
 */

export type IcuNode =
  | { type: 'text'; value: string }
  | { type: 'pound' }
  | { type: 'argument'; name: string; raw: string }
  | { type: 'plural'; name: string; kind: 'plural' | 'selectordinal'; offset: number; options: IcuOption[] }
  | { type: 'select'; name: string; options: IcuOption[] };

export interface IcuOption {
  selector: string;
  value: IcuNode[];
}

export type IcuComplexNode = Extract<IcuNode, { type: 'plural' | 'select' }>;

export class IcuParseError extends Error {
  constructor(message: string, public position: number) {
    super(`${message} (znak ${position + 1})`);
  }
}

const PLURAL_ORDER = ['zero', 'one', 'two', 'few', 'many', 'other'];
const IDENT = /[A-Za-z0-9_$][A-Za-z0-9_$.-]*/y;
const SELECTOR = /=-?\d+(\.\d+)?|[A-Za-z0-9_-]+/y;

class Parser {
  pos = 0;
  constructor(private text: string) {}

  parse(): IcuNode[] {
    const nodes = this.message(false, 0);
    if (this.pos < this.text.length) throw new IcuParseError('Nadmiarowy znak "}"', this.pos);
    return nodes;
  }

  private ws() {
    while (this.pos < this.text.length && /\s/.test(this.text[this.pos])) this.pos++;
  }

  private match(re: RegExp): string | null {
    re.lastIndex = this.pos;
    const m = re.exec(this.text);
    if (!m) return null;
    this.pos += m[0].length;
    return m[0];
  }

  private expect(ch: string) {
    if (this.text[this.pos] !== ch) {
      throw new IcuParseError(`Oczekiwano "${ch}"${this.pos >= this.text.length ? ' — niedomknięte wyrażenie' : ''}`, this.pos);
    }
    this.pos++;
  }

  /** Parses until an unmatched "}" (depth > 0) or the end of input */
  private message(inPlural: boolean, depth: number): IcuNode[] {
    const nodes: IcuNode[] = [];
    let text = '';
    const flush = () => {
      if (text) nodes.push({ type: 'text', value: text });
      text = '';
    };

    while (this.pos < this.text.length) {
      const ch = this.text[this.pos];
      if (ch === "'") {
        const next = this.text[this.pos + 1];
        if (next === "'") {
          text += "'";
          this.pos += 2;
        } else if (next === '{' || next === '}' || (inPlural && next === '#') || next === '|') {
          // Quoted literal until the next single apostrophe
          this.pos++;
          while (this.pos < this.text.length) {
            if (this.text[this.pos] === "'") {
              if (this.text[this.pos + 1] === "'") {
                text += "'";
                this.pos += 2;
                continue;
              }
              this.pos++;
              break;
            }
            text += this.text[this.pos++];
          }
        } else {
          text += "'";
          this.pos++;
        }
      } else if (ch === '{') {
        flush();
        nodes.push(this.argument(depth));
      } else if (ch === '}') {
        if (depth === 0) throw new IcuParseError('Nadmiarowy znak "}"', this.pos);
        break;
      } else if (ch === '#' && inPlural) {
        flush();
        nodes.push({ type: 'pound' });
        this.pos++;
      } else {
        text += ch;
        this.pos++;
      }
    }
    flush();
    return nodes;
  }

  private argument(depth: number): IcuNode {
    const start = this.pos;
    this.expect('{');
    this.ws();
    const name = this.match(IDENT);
    if (!name) throw new IcuParseError('Oczekiwano nazwy argumentu po "{"', this.pos);
    this.ws();
    if (this.text[this.pos] === '}') {
      this.pos++;
      return { type: 'argument', name, raw: this.text.slice(start, this.pos) };
    }
    this.expect(',');
    this.ws();
    const argType = this.match(/[a-z]+/y);
    if (!argType) throw new IcuParseError(`Oczekiwano typu argumentu "${name}"`, this.pos);
    this.ws();

    if (argType === 'plural' || argType === 'selectordinal' || argType === 'select') {
      this.expect(',');
      this.ws();
      let offset = 0;
      if (argType !== 'select' && this.text.startsWith('offset:', this.pos)) {
        this.pos += 'offset:'.length;
        this.ws();
        const num = this.match(/\d+/y);
        if (!num) throw new IcuParseError('Oczekiwano liczby po "offset:"', this.pos);
        offset = Number(num);
        this.ws();
      }
      const options: IcuOption[] = [];
      const seen = new Set<string>();
      while (this.pos < this.text.length && this.text[this.pos] !== '}') {
        const selectorPos = this.pos;
        const selector = this.match(SELECTOR);
        if (!selector) throw new IcuParseError(`Oczekiwano selektora opcji w "${name}"`, this.pos);
        if (seen.has(selector)) throw new IcuParseError(`Zduplikowany selektor "${selector}" w "${name}"`, selectorPos);
        seen.add(selector);
        this.ws();
        this.expect('{');
        const value = this.message(argType !== 'select', depth + 1);
        this.expect('}');
        options.push({ selector, value });
        this.ws();
      }
      this.expect('}');
      if (options.length === 0) throw new IcuParseError(`Wyrażenie "${name}" nie ma żadnych opcji`, start);
      if (!seen.has('other')) throw new IcuParseError(`Wyrażenie "${name}" musi zawierać opcję "other"`, start);
      if (argType === 'select') return { type: 'select', name, options };
      return { type: 'plural', name, kind: argType, offset, options };
    }

    // Formatted argument: {price, number} / {d, date, short} / {n, number, ::currency/EUR}
    if (this.text[this.pos] === ',') {
      let braces = 0;
      while (this.pos < this.text.length) {
        const c = this.text[this.pos];
        if (c === '{') braces++;
        if (c === '}') {
          if (braces === 0) break;
          braces--;
        }
        this.pos++;
      }
    }
    this.expect('}');
    return { type: 'argument', name, raw: this.text.slice(start, this.pos) };
  }
}

export function parseIcu(text: string): IcuNode[] {
  return new Parser(text).parse();
}

export function tryParseIcu(text: string): { nodes: IcuNode[] | null; error: string | null } {
  try {
    return { nodes: parseIcu(text), error: null };
  } catch (e) {
    return { nodes: null, error: (e as Error).message };
  }
}

function escapeText(value: string, inPlural: boolean): string {
  let out = value.replace(/'/g, "''");
  out = out.replace(inPlural ? /[{}#|]+/g : /[{}|]+/g, (m) => `'${m}'`);
  return out;
}

export function serializeIcu(nodes: IcuNode[], inPlural = false): string {
  return nodes.map((n) => serializeNode(n, inPlural)).join('');
}

function serializeNode(node: IcuNode, inPlural: boolean): string {
  switch (node.type) {
    case 'text':
      return escapeText(node.value, inPlural);
    case 'pound':
      return '#';
    case 'argument':
      return node.raw;
    case 'select':
      return `{${node.name}, select, ${node.options.map((o) => `${o.selector} {${serializeIcu(o.value, inPlural)}}`).join(' ')}}`;
    case 'plural': {
      const offset = node.offset ? `offset:${node.offset} ` : '';
      return `{${node.name}, ${node.kind}, ${offset}${node.options.map((o) => `${o.selector} {${serializeIcu(o.value, true)}}`).join(' ')}}`;
    }
  }
}

const ICU_COMPLEX_HINT = /\{\s*[A-Za-z0-9_]+\s*,\s*(plural|select|selectordinal)\s*,/;

/** True when the string contains a plural / select / selectordinal expression (also when it is malformed) */
export function hasIcuComplexArgument(text: string): boolean {
  if (!text) return false;
  const { nodes } = tryParseIcu(text);
  if (nodes) return nodes.some((n) => n.type === 'plural' || n.type === 'select');
  return ICU_COMPLEX_HINT.test(text);
}

// ---------------------------------------------------------------------------
// CLDR plural categories via Intl.PluralRules (no bundled dataset)
// ---------------------------------------------------------------------------

export function getPluralCategories(locale: LocaleCode, kind: 'plural' | 'selectordinal' = 'plural'): string[] {
  try {
    const rules = new Intl.PluralRules(locale, { type: kind === 'selectordinal' ? 'ordinal' : 'cardinal' });
    const categories = rules.resolvedOptions().pluralCategories as string[];
    return PLURAL_ORDER.filter((c) => categories.includes(c));
  } catch {
    return ['one', 'other'];
  }
}

/** Example numbers per category, e.g. pl: few → "2, 3, 4, 22…" */
export function getPluralExamples(locale: LocaleCode, kind: 'plural' | 'selectordinal' = 'plural'): Record<string, string> {
  const result: Record<string, string> = {};
  try {
    const rules = new Intl.PluralRules(locale, { type: kind === 'selectordinal' ? 'ordinal' : 'cardinal' });
    const samples: Record<string, number[]> = {};
    for (let n = 0; n <= 200; n++) {
      const cat = rules.select(n);
      (samples[cat] ??= []).length < 4 && samples[cat].push(n);
    }
    for (const fraction of [0.5, 1.5, 2.5]) {
      const cat = rules.select(fraction);
      if (!samples[cat]) samples[cat] = [fraction];
    }
    for (const [cat, nums] of Object.entries(samples)) result[cat] = nums.join(', ') + (nums.length >= 4 ? '…' : '');
  } catch {
    /* unsupported locale */
  }
  return result;
}

export function sortPluralOptions(options: IcuOption[]): IcuOption[] {
  const rank = (s: string) => (s.startsWith('=') ? -1000 + Number(s.slice(1)) : PLURAL_ORDER.indexOf(s) === -1 ? 50 : PLURAL_ORDER.indexOf(s));
  return [...options].sort((a, b) => rank(a.selector) - rank(b.selector));
}

// ---------------------------------------------------------------------------
// Alignment: build / complete a target structure from the source
// ---------------------------------------------------------------------------

function findOption(options: IcuOption[], selector: string): IcuOption | undefined {
  return options.find((o) => o.selector === selector);
}

/**
 * Returns the target nodes completed with everything the target language needs:
 * required plural categories, source =N selectors and select keys (new options are empty).
 * Complex arguments missing in the target are appended as empty skeletons.
 */
export function alignIcuToSource(target: IcuNode[], source: IcuNode[], locale: LocaleCode): IcuNode[] {
  const aligned = target.map((node) => {
    if (node.type !== 'plural' && node.type !== 'select') return node;
    const sourceNode = source.find((s) => (s.type === 'plural' || s.type === 'select') && s.name === node.name && s.type === node.type) as
      | IcuComplexNode
      | undefined;
    return alignComplex(node, sourceNode, locale);
  });

  for (const sourceNode of source) {
    if (sourceNode.type !== 'plural' && sourceNode.type !== 'select') continue;
    const exists = aligned.some((n) => n.type === sourceNode.type && (n as IcuComplexNode).name === sourceNode.name);
    if (!exists) aligned.push(skeletonFor(sourceNode, locale));
  }
  return aligned;
}

function alignComplex(node: IcuComplexNode, sourceNode: IcuComplexNode | undefined, locale: LocaleCode): IcuComplexNode {
  const options = node.options.map((o) => {
    const sourceOption = sourceNode ? findOption(sourceNode.options, o.selector) ?? findOption(sourceNode.options, 'other') : undefined;
    return { selector: o.selector, value: sourceOption ? alignIcuToSource(o.value, sourceOption.value, locale) : o.value };
  });
  const required: string[] = [];
  if (node.type === 'plural') {
    required.push(...(sourceNode?.options.map((o) => o.selector).filter((s) => s.startsWith('=')) ?? []));
    required.push(...getPluralCategories(locale, node.kind));
  } else {
    required.push(...(sourceNode?.options.map((o) => o.selector) ?? []), 'other');
  }
  for (const selector of required) {
    if (!findOption(options, selector)) {
      const sourceOption = sourceNode ? findOption(sourceNode.options, selector) ?? findOption(sourceNode.options, 'other') : undefined;
      options.push({ selector, value: sourceOption ? emptySkeleton(sourceOption.value, locale) : [] });
    }
  }
  return { ...node, options: node.type === 'plural' ? sortPluralOptions(options) : options };
}

function skeletonFor(node: IcuComplexNode, locale: LocaleCode): IcuComplexNode {
  return alignComplex({ ...node, options: [] } as IcuComplexNode, node, locale);
}

/** Keeps nested complex structure but drops all text (used for newly added options) */
function emptySkeleton(nodes: IcuNode[], locale: LocaleCode): IcuNode[] {
  return nodes
    .filter((n): n is IcuComplexNode => n.type === 'plural' || n.type === 'select')
    .map((n) => skeletonFor(n, locale));
}

// ---------------------------------------------------------------------------
// Validation (PRD F7): structure per target language + tokens per option
// ---------------------------------------------------------------------------

interface CollectedArgs {
  simple: Set<string>;
  complex: Map<string, number>;
}

function collectArgs(nodes: IcuNode[], acc: CollectedArgs = { simple: new Set(), complex: new Map() }): CollectedArgs {
  for (const n of nodes) {
    if (n.type === 'argument') acc.simple.add(n.name);
    if (n.type === 'plural' || n.type === 'select') {
      const key = `${n.name}:${n.type === 'plural' ? n.kind : 'select'}`;
      acc.complex.set(key, (acc.complex.get(key) ?? 0) + 1);
      for (const o of n.options) collectArgs(o.value, acc);
    }
  }
  return acc;
}

const POUND_PATTERN = '/#/';

/**
 * Validates an ICU target message against its ICU source for `locale`.
 * Errors: syntax, missing / unexpected arguments, missing required plural categories or select keys,
 * token mismatches inside matching options. Warnings: categories unused by the language, dropped =N selectors.
 */
export function validateIcuMessage(
  source: string,
  target: string,
  locale: LocaleCode,
  tokenPatterns?: TokenPatternConfig,
  localeLabel = locale.toUpperCase()
): ValidationIssue[] {
  if (!target) return [];
  const prefix = `[${localeLabel}] `;
  const t = tryParseIcu(target);
  if (!t.nodes) return [{ type: 'error', message: `${prefix}Błąd składni ICU: ${t.error}` }];
  const s = tryParseIcu(source);
  if (!s.nodes) return [];

  const issues: ValidationIssue[] = [];
  const sourceArgs = collectArgs(s.nodes);
  const targetArgs = collectArgs(t.nodes);

  for (const name of sourceArgs.simple) {
    if (!targetArgs.simple.has(name)) issues.push({ type: 'error', message: `${prefix}Brakuje argumentu {${name}}.` });
  }
  for (const name of targetArgs.simple) {
    if (!sourceArgs.simple.has(name)) issues.push({ type: 'error', message: `${prefix}Nieoczekiwany argument {${name}} — nie występuje w źródle.` });
  }
  for (const [key, count] of sourceArgs.complex) {
    if ((targetArgs.complex.get(key) ?? 0) < count) {
      const [name, type] = key.split(':');
      issues.push({ type: 'error', message: `${prefix}Brakuje wyrażenia {${name}, ${type}, …}.` });
    }
  }
  for (const key of targetArgs.complex.keys()) {
    if (!sourceArgs.complex.has(key)) {
      const [name, type] = key.split(':');
      issues.push({ type: 'error', message: `${prefix}Nieoczekiwane wyrażenie {${name}, ${type}, …} — nie występuje w źródle.` });
    }
  }

  const patterns: TokenPatternConfig | undefined = tokenPatterns
    ? { ...tokenPatterns, interpolation: [...tokenPatterns.interpolation, POUND_PATTERN] }
    : undefined;
  checkNodes(t.nodes, s.nodes, locale, prefix, issues, patterns, false);
  return issues;
}

function checkNodes(
  target: IcuNode[],
  source: IcuNode[],
  locale: LocaleCode,
  prefix: string,
  issues: ValidationIssue[],
  patterns: TokenPatternConfig | undefined,
  inPlural: boolean
) {
  // Markdown / HTML / variables in the plain parts must match the plain parts of the source
  const plain = (nodes: IcuNode[]) => serializeIcu(nodes.filter((n) => n.type !== 'plural' && n.type !== 'select'), inPlural);
  if (patterns) {
    const sourcePlain = plain(source);
    const targetPlain = plain(target);
    if (sourcePlain.trim() && targetPlain.trim()) {
      for (const issue of validateTokens(sourcePlain, targetPlain, patterns)) {
        if (!/\{[A-Za-z0-9_$]/.test(issue.message)) issues.push({ ...issue, message: prefix + issue.message });
      }
    }
  }

  for (const node of target) {
    if (node.type !== 'plural' && node.type !== 'select') continue;
    const sourceNode = source.find((n) => n.type === node.type && (n as IcuComplexNode).name === node.name) as IcuComplexNode | undefined;
    if (!sourceNode) continue;
    const label = `${prefix.slice(0, -2)} › ${node.name}] `;

    if (node.type === 'plural') {
      const categories = getPluralCategories(locale, node.kind);
      for (const category of categories) {
        if (!findOption(node.options, category)) {
          issues.push({
            type: 'error',
            message: `${label}Brakuje formy "${category}" wymaganej w języku ${locale} (kategorie: ${categories.join(', ')}).`,
          });
        }
      }
      for (const option of node.options) {
        if (!option.selector.startsWith('=') && !categories.includes(option.selector)) {
          issues.push({ type: 'warning', message: `${label}Forma "${option.selector}" nie jest używana w języku ${locale} — zostanie zignorowana.` });
        }
      }
      for (const option of sourceNode.options) {
        if (option.selector.startsWith('=') && !findOption(node.options, option.selector)) {
          issues.push({ type: 'warning', message: `${label}Pominięto wariant dokładny "${option.selector}" obecny w źródle.` });
        }
      }
    } else {
      for (const option of sourceNode.options) {
        if (!findOption(node.options, option.selector)) {
          issues.push({ type: 'error', message: `${label}Brakuje wariantu "${option.selector}" z tekstu źródłowego.` });
        }
      }
      for (const option of node.options) {
        if (!findOption(sourceNode.options, option.selector)) {
          issues.push({ type: 'warning', message: `${label}Wariant "${option.selector}" nie występuje w źródle.` });
        }
      }
    }

    for (const option of node.options) {
      const sourceOption = findOption(sourceNode.options, option.selector) ?? findOption(sourceNode.options, 'other');
      if (!sourceOption) continue;
      if (option.value.length === 0 || serializeIcu(option.value).trim() === '') {
        issues.push({ type: 'error', message: `${label}Forma "${option.selector}" jest pusta.` });
        continue;
      }
      checkNodes(option.value, sourceOption.value, locale, `${label.slice(0, -2)}=${option.selector}] `, issues, patterns, node.type === 'plural' || inPlural);
    }
  }
}

/** Syntax check for a source ICU string */
export function validateIcuSyntax(text: string, localeLabel: string): ValidationIssue[] {
  const { error } = tryParseIcu(text);
  return error ? [{ type: 'error', message: `[${localeLabel}] Błąd składni ICU: ${error}` }] : [];
}

/** Wraps a plain string into a plural expression (source editor helper) */
export function wrapInPlural(text: string, variable: string, locale: LocaleCode): string {
  const nodes = tryParseIcu(text).nodes ?? [{ type: 'text', value: text } as IcuNode];
  const inner = serializeIcu(nodes, true);
  const options = getPluralCategories(locale).map((c) => `${c} {${inner}}`);
  return `{${variable}, plural, ${options.join(' ')}}`;
}
