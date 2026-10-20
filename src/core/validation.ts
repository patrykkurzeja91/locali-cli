import { LocaleCode, ProjectConfig, ValidationIssue } from './types';
import { detectVueI18nWarnings } from './i18nUtils';
import { validateTokens } from './tokenizer';
import { hasIcuComplexArgument, validateIcuMessage, validateIcuSyntax } from './icu';
import { hasPipePlural, validatePipePlural } from './pipePlural';

/** How a value is edited and validated */
export type ValueSyntax = 'plain' | 'icu' | 'pipe';

export function detectValueSyntax(project: Pick<ProjectConfig, 'messageFormat'>, ...values: string[]): ValueSyntax {
  if (values.some((v) => hasIcuComplexArgument(v))) return 'icu';
  if (project.messageFormat === 'vue-i18n' && values.some((v) => hasPipePlural(v))) return 'pipe';
  return 'plain';
}

/**
 * All checks for one value (editor, import, CLI validate):
 * structure vs. source (blocking errors) + dialect-specific heuristics (warnings).
 */
export function validateLocaleValue(
  project: ProjectConfig,
  locale: LocaleCode,
  value: string,
  sourceValue: string
): ValidationIssue[] {
  const label = locale.toUpperCase();
  const isSource = locale === project.sourceLanguage;
  const syntax = detectValueSyntax(project, sourceValue, value);
  const issues: ValidationIssue[] = [];

  if (syntax === 'icu') {
    if (isSource) issues.push(...validateIcuSyntax(value, label));
    else issues.push(...validateIcuMessage(sourceValue, value, locale, project.tokenPatterns, label));
    if (project.messageFormat === 'vue-i18n' && value && hasIcuComplexArgument(value)) {
      issues.push({
        type: 'warning',
        message: `[${label}] Składnia ICU plural/select nie jest obsługiwana przez vue-i18n. Użyj form rozdzielonych "|" lub zmień format wiadomości projektu na ICU.`,
      });
    }
    return issues;
  }

  if (!isSource) {
    issues.push(
      ...(syntax === 'pipe'
        ? validatePipePlural(sourceValue, value, project.tokenPatterns, label)
        : validateTokens(sourceValue, value, project.tokenPatterns, label))
    );
  }
  if (project.messageFormat === 'vue-i18n') issues.push(...detectVueI18nWarnings(value, label));
  return issues;
}

export function validateLocaleValues(
  project: ProjectConfig,
  values: Record<LocaleCode, string>
): Record<LocaleCode, ValidationIssue[]> {
  const sourceValue = values[project.sourceLanguage] ?? '';
  const result: Record<LocaleCode, ValidationIssue[]> = {};
  for (const [locale, value] of Object.entries(values)) {
    result[locale] = validateLocaleValue(project, locale, value, sourceValue);
  }
  return result;
}

export const hasBlockingIssues = (issues: Record<LocaleCode, ValidationIssue[]>) =>
  Object.values(issues).some((list) => list.some((i) => i.type === 'error'));
