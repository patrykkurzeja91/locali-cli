import { TokenPatternConfig, ValidationIssue } from './types';
import { getTokens, validateTokens } from './tokenizer';

/**
 * vue-i18n pipe plurals: "no apples | one apple | {count} apples" (PRD F7, ROADMAP 4.2).
 * Separators inside {…} (e.g. the literal {'|'}) are ignored.
 */

export function splitPipeForms(text: string): string[] {
  const forms: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of text) {
    if (ch === '{') depth++;
    if (ch === '}' && depth > 0) depth--;
    if (ch === '|' && depth === 0) {
      forms.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  forms.push(current.trim());
  return forms;
}

export function hasPipePlural(text: string): boolean {
  return !!text && splitPipeForms(text).length > 1;
}

export function joinPipeForms(forms: string[]): string {
  return forms.map((f) => f.trim()).join(' | ');
}

/** Meaning of each form under vue-i18n's default choice rule */
export function getPipeFormLabels(count: number): string[] {
  if (count === 2) return ['1 — liczba pojedyncza', '0, 2+ — pozostałe'];
  if (count === 3) return ['0 — brak', '1 — jeden', '2+ — wiele'];
  return Array.from({ length: count }, (_, i) => `forma ${i + 1} (wg pluralRules aplikacji)`);
}

const variableSignatures = (forms: string[], patterns?: TokenPatternConfig) =>
  new Set(forms.flatMap((f) => getTokens(f, patterns).filter((t) => t.kind === 'variable').map((t) => t.signature)));

export function validatePipePlural(
  source: string,
  target: string,
  patterns?: TokenPatternConfig,
  localeLabel = ''
): ValidationIssue[] {
  if (!target) return [];
  const prefix = localeLabel ? `[${localeLabel}] ` : '';
  const sourceForms = splitPipeForms(source);
  const targetForms = splitPipeForms(target);
  const issues: ValidationIssue[] = [];

  targetForms.forEach((form, i) => {
    if (!form) issues.push({ type: 'error', message: `${prefix}Forma ${i + 1} jest pusta.` });
  });

  if (sourceForms.length === targetForms.length) {
    targetForms.forEach((form, i) => {
      if (!form) return;
      const label = localeLabel ? `${localeLabel} › forma ${i + 1}` : `forma ${i + 1}`;
      issues.push(...validateTokens(sourceForms[i], form, patterns, label));
    });
    return issues;
  }

  issues.push({
    type: 'warning',
    message: `${prefix}Liczba form (${targetForms.length}) różni się od źródła (${sourceForms.length}). Upewnij się, że reguła pluralRules w vue-i18n dla tego języka zwraca tyle form.`,
  });
  const sourceVars = variableSignatures(sourceForms, patterns);
  const targetVars = variableSignatures(targetForms, patterns);
  for (const sig of sourceVars) {
    if (!targetVars.has(sig)) issues.push({ type: 'error', message: `${prefix}Brakuje zmiennej ${sig.slice(4)} we wszystkich formach.` });
  }
  for (const sig of targetVars) {
    if (!sourceVars.has(sig)) issues.push({ type: 'error', message: `${prefix}Nieoczekiwana zmienna ${sig.slice(4)} — nie występuje w źródle.` });
  }
  return issues;
}
