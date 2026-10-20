import { FileFormat, LocaleCode, MessageFormat, ProjectConfig, TokenPatternConfig } from './types';
import { isValidLocaleCode } from './languages';
import { DEFAULT_TOKEN_PATTERNS, isValidInterpolationPattern } from './tokenizer';

/**
 * i18n.config.json schema & validation (docs/SPEC_SYNC_CLI.md).
 * Shared by the panel's project settings and the mini-tms CLI — keep it free of DOM APIs.
 */

export const DEFAULT_PROJECT: ProjectConfig = {
  projectId: 'default',
  name: 'Default project',
  sourceLanguage: 'pl',
  targetLanguages: ['en'],
  localesDir: './i18n/locales',
  fileStructure: '{localesDir}/{lang}.json',
  fileFormat: 'nested',
  defaultNamespace: 'common',
  messageFormat: 'vue-i18n',
  tokenPatterns: DEFAULT_TOKEN_PATTERNS,
};

const PROJECT_ID_REGEX = /^[a-z0-9][a-z0-9-]*$/;
const NAMESPACE_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

export function isValidNamespace(ns: string): boolean {
  return NAMESPACE_REGEX.test(ns);
}

export function getProjectLanguages(project: Pick<ProjectConfig, 'sourceLanguage' | 'targetLanguages'>): LocaleCode[] {
  return [project.sourceLanguage, ...project.targetLanguages];
}

export interface ParsedProjectConfig {
  config: ProjectConfig | null;
  errors: string[];
  /** Only present when parsing a file: fields that are not part of ProjectConfig */
  apiBaseUrl?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validates a raw i18n.config.json object (or project settings form) and fills defaults. */
export function parseProjectConfig(input: unknown): ParsedProjectConfig {
  const errors: string[] = [];
  if (!isRecord(input)) {
    return { config: null, errors: ['Konfiguracja musi być obiektem JSON.'] };
  }

  const projectId = typeof input.projectId === 'string' ? input.projectId.trim() : '';
  if (!PROJECT_ID_REGEX.test(projectId)) {
    errors.push('projectId jest wymagany i może zawierać tylko małe litery, cyfry i myślniki (np. storefront-web).');
  }

  const sourceLanguage = typeof input.sourceLanguage === 'string' ? input.sourceLanguage.trim() : '';
  if (!isValidLocaleCode(sourceLanguage)) {
    errors.push(`sourceLanguage "${sourceLanguage}" nie jest poprawnym kodem języka BCP-47 (np. pl, en, pt-BR).`);
  }

  let targetLanguages: string[] = [];
  if (input.targetLanguages !== undefined) {
    if (!Array.isArray(input.targetLanguages) || input.targetLanguages.some((l) => typeof l !== 'string')) {
      errors.push('targetLanguages musi być tablicą kodów języków.');
    } else {
      targetLanguages = (input.targetLanguages as string[]).map((l) => l.trim());
      const seen = new Set<string>();
      for (const lang of targetLanguages) {
        if (!isValidLocaleCode(lang)) errors.push(`Kod języka docelowego "${lang}" jest niepoprawny.`);
        if (lang === sourceLanguage) errors.push(`Język źródłowy "${lang}" nie może być jednocześnie językiem docelowym.`);
        if (seen.has(lang)) errors.push(`Język "${lang}" występuje w targetLanguages więcej niż raz.`);
        seen.add(lang);
      }
    }
  }

  const localesDir = typeof input.localesDir === 'string' && input.localesDir.trim() ? input.localesDir.trim() : DEFAULT_PROJECT.localesDir;
  if (localesDir.split(/[\\/]/).includes('..')) {
    errors.push('localesDir nie może wychodzić poza katalog projektu ("..").');
  }

  const fileStructure =
    typeof input.fileStructure === 'string' && input.fileStructure.trim() ? input.fileStructure.trim() : DEFAULT_PROJECT.fileStructure;
  if (!fileStructure.includes('{lang}')) {
    errors.push('fileStructure musi zawierać placeholder {lang}.');
  }
  if (!fileStructure.endsWith('.json')) {
    errors.push('fileStructure musi kończyć się rozszerzeniem .json.');
  }
  const unknownPlaceholders = (fileStructure.match(/\{[^}]*\}/g) || []).filter(
    (p) => !['{localesDir}', '{lang}', '{namespace}'].includes(p)
  );
  if (unknownPlaceholders.length > 0) {
    errors.push(`fileStructure zawiera nieznane placeholdery: ${unknownPlaceholders.join(', ')}.`);
  }

  let fileFormat: FileFormat = DEFAULT_PROJECT.fileFormat;
  if (input.fileFormat !== undefined) {
    if (input.fileFormat === 'nested' || input.fileFormat === 'flat') fileFormat = input.fileFormat;
    else errors.push('fileFormat musi mieć wartość "nested" lub "flat".');
  }

  const defaultNamespace =
    typeof input.defaultNamespace === 'string' && input.defaultNamespace.trim() ? input.defaultNamespace.trim() : DEFAULT_PROJECT.defaultNamespace;
  if (!isValidNamespace(defaultNamespace)) {
    errors.push(`defaultNamespace "${defaultNamespace}" może zawierać tylko litery, cyfry, "_" i "-".`);
  }

  let messageFormat: MessageFormat = DEFAULT_PROJECT.messageFormat;
  if (input.messageFormat !== undefined) {
    if (input.messageFormat === 'vue-i18n' || input.messageFormat === 'icu') messageFormat = input.messageFormat;
    else errors.push('messageFormat musi mieć wartość "vue-i18n" lub "icu".');
  }

  let tokenPatterns: TokenPatternConfig = DEFAULT_TOKEN_PATTERNS;
  if (input.tokenPatterns !== undefined) {
    if (!isRecord(input.tokenPatterns)) {
      errors.push('tokenPatterns musi być obiektem.');
    } else {
      const tp = input.tokenPatterns;
      const interpolation = Array.isArray(tp.interpolation)
        ? tp.interpolation.filter((p): p is string => typeof p === 'string')
        : DEFAULT_TOKEN_PATTERNS.interpolation;
      for (const pattern of interpolation) {
        if (!isValidInterpolationPattern(pattern)) {
          errors.push(`Wzorzec interpolacji "${pattern}" jest niepoprawny (dozwolone: icu, i18next, printf, vue-linked lub "/regex/flags").`);
        }
      }
      tokenPatterns = {
        interpolation,
        markdown: typeof tp.markdown === 'boolean' ? tp.markdown : DEFAULT_TOKEN_PATTERNS.markdown,
        html: typeof tp.html === 'boolean' ? tp.html : DEFAULT_TOKEN_PATTERNS.html,
      };
    }
  }

  const name = typeof input.name === 'string' && input.name.trim() ? input.name.trim() : projectId;
  const apiBaseUrl = typeof input.apiBaseUrl === 'string' ? input.apiBaseUrl.trim() : undefined;

  if (errors.length > 0) return { config: null, errors, apiBaseUrl };
  return {
    config: {
      projectId,
      name,
      sourceLanguage,
      targetLanguages,
      localesDir,
      fileStructure,
      fileFormat,
      defaultNamespace,
      messageFormat,
      tokenPatterns,
    },
    errors,
    apiBaseUrl,
  };
}

/** Serializes the project as an i18n.config.json file for the consuming repository */
export function toConfigFileJson(project: ProjectConfig, apiBaseUrl?: string): string {
  const { name: _name, ...rest } = project;
  const file = {
    projectId: rest.projectId,
    ...(apiBaseUrl ? { apiBaseUrl } : {}),
    sourceLanguage: rest.sourceLanguage,
    targetLanguages: rest.targetLanguages,
    localesDir: rest.localesDir,
    fileStructure: rest.fileStructure,
    fileFormat: rest.fileFormat,
    defaultNamespace: rest.defaultNamespace,
    messageFormat: rest.messageFormat,
    tokenPatterns: rest.tokenPatterns,
  };
  return JSON.stringify(file, null, 2) + '\n';
}
