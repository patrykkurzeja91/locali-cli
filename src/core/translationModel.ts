import {
  KeyItemWithValues,
  LocaleCode,
  ProjectConfig,
  TranslationChange,
  TranslationEntry,
  TranslationStatus,
  User,
} from './types';
import { getProjectLanguages } from './projectConfig';

/**
 * Pure operations on the multilingual key model (PRD F1 + F4).
 * App state handlers call these so that the rules are unit-tested and later mirrored by the PHP backend.
 */

export const EMPTY_ENTRY: TranslationEntry = { value: '', status: 'untranslated', updated_at: null };

export function getEntry(key: KeyItemWithValues, locale: LocaleCode): TranslationEntry {
  return key.translations[locale] ?? EMPTY_ENTRY;
}

export function statusForValue(value: string): TranslationStatus {
  return value.trim() ? 'translated' : 'untranslated';
}

/** Effective status of a value; the source language is never "outdated" */
export function getEffectiveStatus(key: KeyItemWithValues, locale: LocaleCode, project: ProjectConfig): TranslationStatus {
  const entry = getEntry(key, locale);
  if (!entry.value.trim()) return 'untranslated';
  if (locale === project.sourceLanguage) return 'translated';
  return entry.status;
}

export type KeyOverallStatus = 'ready' | 'missing_source' | 'incomplete' | 'outdated' | 'needs_review';

export function getKeyOverallStatus(key: KeyItemWithValues, project: ProjectConfig): KeyOverallStatus {
  if (!getEntry(key, project.sourceLanguage).value.trim()) return 'missing_source';
  const statuses = project.targetLanguages.map((l) => getEffectiveStatus(key, l, project));
  if (statuses.includes('untranslated')) return 'incomplete';
  if (statuses.includes('outdated')) return 'outdated';
  if (statuses.includes('needs_review')) return 'needs_review';
  return 'ready';
}

export interface LanguageStats {
  locale: LocaleCode;
  total: number;
  translated: number;
  outdated: number;
  needs_review: number;
  untranslated: number;
  /** translated / total, 0-100 (outdated and needs_review count as not done) */
  percent: number;
}

export function getLanguageStats(keys: KeyItemWithValues[], project: ProjectConfig): LanguageStats[] {
  const active = keys.filter((k) => !k.is_archived);
  return getProjectLanguages(project).map((locale) => {
    const stats: LanguageStats = { locale, total: active.length, translated: 0, outdated: 0, needs_review: 0, untranslated: 0, percent: 100 };
    for (const key of active) stats[getEffectiveStatus(key, locale, project)]++;
    stats.percent = stats.total > 0 ? Math.round((stats.translated / stats.total) * 100) : 100;
    return stats;
  });
}

export interface KeyEditInput {
  /** New values per locale (only changed or unchanged locales present in the form) */
  values: Record<LocaleCode, string>;
  description: string;
  namespace?: string;
  /** Outdated targets confirmed as still correct without changing the text */
  confirmedLocales?: LocaleCode[];
  /** updated_at the editor saw per locale; the API answers 409 when a changed locale was saved by someone else since */
  expected?: Record<LocaleCode, string | null>;
}

type NewChange = Omit<TranslationChange, 'id'>;

function makeChange(
  key: KeyItemWithValues,
  locale: LocaleCode,
  action: TranslationChange['action_type'],
  oldEntry: TranslationEntry | null,
  newValue: string,
  user: User,
  now: string
): NewChange {
  return {
    translation_key_id: key.id,
    key_name: key.key_name,
    locale,
    action_type: action,
    old_value: oldEntry ? oldEntry.value : null,
    new_value: newValue,
    old_status: oldEntry?.status,
    changed_by: user.id,
    changed_by_name: user.name,
    created_at: now,
    published_at: null,
    publish_batch_id: null,
  };
}

/**
 * Applies an edit to one key.
 * - A changed source value flips every non-empty, untouched target from "translated" / "needs_review" to "outdated".
 * - A saved target becomes "translated" (or "untranslated" when emptied).
 */
export function applyKeyEdit(
  key: KeyItemWithValues,
  input: KeyEditInput,
  project: ProjectConfig,
  user: User,
  now: string
): { key: KeyItemWithValues; changes: NewChange[] } {
  const translations: Record<LocaleCode, TranslationEntry> = { ...key.translations };
  const changes: NewChange[] = [];
  const source = project.sourceLanguage;

  const changedLocales = Object.keys(input.values).filter((locale) => getEntry(key, locale).value !== input.values[locale]);

  for (const locale of changedLocales) {
    const oldEntry = getEntry(key, locale);
    const value = input.values[locale];
    translations[locale] = { value, status: statusForValue(value), updated_at: now };
    changes.push(makeChange(key, locale, 'update', key.translations[locale] ? oldEntry : null, value, user, now));
  }

  if (changedLocales.includes(source)) {
    const outdated: LocaleCode[] = [];
    for (const locale of Object.keys(translations)) {
      if (locale === source || changedLocales.includes(locale)) continue;
      const entry = translations[locale];
      if (entry.value.trim() && (entry.status === 'translated' || entry.status === 'needs_review')) {
        translations[locale] = { ...entry, status: 'outdated' };
        outdated.push(locale);
      }
    }
    const sourceChange = changes.find((c) => c.locale === source)!;
    if (outdated.length > 0) sourceChange.outdated_locales = outdated;
  }

  for (const locale of input.confirmedLocales ?? []) {
    const entry = translations[locale];
    if (entry && (entry.status === 'outdated' || entry.status === 'needs_review') && entry.value.trim()) {
      translations[locale] = { ...entry, status: 'translated', updated_at: now };
    }
  }

  const descriptionChanged = (key.description || '') !== input.description;
  const namespaceChanged = input.namespace !== undefined && input.namespace !== key.namespace;
  const touched = changes.length > 0 || descriptionChanged || namespaceChanged || (input.confirmedLocales?.length ?? 0) > 0;

  return {
    key: {
      ...key,
      translations,
      description: input.description || null,
      namespace: input.namespace ?? key.namespace,
      has_unpublished_changes: key.has_unpublished_changes || changes.length > 0 || namespaceChanged,
      updated_at: touched ? now : key.updated_at,
      updated_by_name: touched ? user.name : key.updated_by_name,
    },
    changes,
  };
}

export function createKey(
  id: number,
  keyName: string,
  namespace: string,
  values: Record<LocaleCode, string>,
  description: string,
  project: ProjectConfig,
  user: User,
  now: string
): { key: KeyItemWithValues; changes: NewChange[] } {
  const translations: Record<LocaleCode, TranslationEntry> = {};
  for (const locale of getProjectLanguages(project)) {
    const value = values[locale] ?? '';
    translations[locale] = { value, status: statusForValue(value), updated_at: value ? now : null };
  }
  const key: KeyItemWithValues = {
    id,
    key_name: keyName,
    namespace,
    description: description || null,
    is_archived: false,
    translations,
    has_unpublished_changes: true,
    updated_at: now,
    updated_by_name: user.name,
  };
  const changes = Object.entries(translations)
    .filter(([locale, entry]) => entry.value || locale === project.sourceLanguage)
    .map(([locale, entry]) => makeChange(key, locale, 'create', null, entry.value, user, now));
  return { key, changes };
}

/** Reverts a single draft change on its key (value, status and any targets it marked outdated) */
export function revertChangeOnKey(key: KeyItemWithValues, change: TranslationChange): KeyItemWithValues {
  const translations = { ...key.translations };
  if (change.old_value === null) {
    translations[change.locale] = { ...EMPTY_ENTRY };
  } else {
    translations[change.locale] = {
      value: change.old_value,
      status: change.old_status ?? statusForValue(change.old_value),
      updated_at: translations[change.locale]?.updated_at ?? null,
    };
  }
  for (const locale of change.outdated_locales ?? []) {
    const entry = translations[locale];
    if (entry && entry.status === 'outdated') translations[locale] = { ...entry, status: 'translated' };
  }
  return { ...key, translations };
}

export function nextChangeId(changes: TranslationChange[]): number {
  return Math.max(100, ...changes.map((c) => c.id)) + 1;
}

/** Checks whether `locale` can become the source language (every active key needs a value in it) */
export function findKeysMissingLocale(keys: KeyItemWithValues[], locale: LocaleCode): KeyItemWithValues[] {
  return keys.filter((k) => !k.is_archived && !getEntry(k, locale).value.trim());
}

export interface ImportSummary {
  created: number;
  updated: number;
  unchanged: number;
  invalid: string[];
}

/**
 * Merges a flat locale file (one language, one namespace) into the key list.
 * New keys are created, changed values are applied through applyKeyEdit (so source changes mark
 * targets outdated), and every modification produces a draft change for the next publish.
 */
export function importLocaleEntries(
  keys: KeyItemWithValues[],
  project: ProjectConfig,
  locale: LocaleCode,
  namespace: string,
  entries: Record<string, string>,
  user: User,
  now: string,
  isValidKeyName: (name: string) => boolean
): { keys: KeyItemWithValues[]; changes: NewChange[]; summary: ImportSummary } {
  const summary: ImportSummary = { created: 0, updated: 0, unchanged: 0, invalid: [] };
  const changes: NewChange[] = [];
  const result = [...keys];
  const index = new Map(result.map((k, i) => [`${k.namespace}:${k.key_name}`, i]));
  let nextId = Math.max(0, ...keys.map((k) => k.id)) + 1;

  for (const [keyName, value] of Object.entries(entries)) {
    if (!isValidKeyName(keyName)) {
      summary.invalid.push(keyName);
      continue;
    }
    const existingIndex = index.get(`${namespace}:${keyName}`);
    if (existingIndex === undefined) {
      const created = createKey(nextId++, keyName, namespace, { [locale]: value }, 'Zaimportowano z pliku JSON', project, user, now);
      index.set(`${namespace}:${keyName}`, result.length);
      result.push(created.key);
      changes.push(...created.changes.map((c) => ({ ...c, origin: 'import' as const })));
      summary.created++;
      continue;
    }
    const existing = result[existingIndex];
    if (getEntry(existing, locale).value === value) {
      summary.unchanged++;
      continue;
    }
    const edited = applyKeyEdit(existing, { values: { [locale]: value }, description: existing.description || '' }, project, user, now);
    result[existingIndex] = edited.key;
    changes.push(...edited.changes.map((c) => ({ ...c, origin: 'import' as const })));
    summary.updated++;
  }
  return { keys: result, changes, summary };
}

/**
 * Applies machine translations: values become drafts with status "needs_review"
 * and change records with origin "machine" (PRD F8).
 */
export function applyMachineTranslations(
  keys: KeyItemWithValues[],
  updates: Array<{ keyId: number; locale: LocaleCode; value: string }>,
  project: ProjectConfig,
  user: User,
  now: string
): { keys: KeyItemWithValues[]; changes: NewChange[] } {
  const byKey = new Map<number, Record<LocaleCode, string>>();
  for (const u of updates) byKey.set(u.keyId, { ...(byKey.get(u.keyId) ?? {}), [u.locale]: u.value });

  const changes: NewChange[] = [];
  const result = keys.map((key) => {
    const values = byKey.get(key.id);
    if (!values) return key;
    const edited = applyKeyEdit(key, { values, description: key.description || '' }, project, user, now);
    const translations = { ...edited.key.translations };
    for (const locale of Object.keys(values)) {
      if (translations[locale]?.value.trim()) translations[locale] = { ...translations[locale], status: 'needs_review' };
    }
    changes.push(...edited.changes.map((c) => ({ ...c, origin: 'machine' as const })));
    return { ...edited.key, translations };
  });
  return { keys: result, changes };
}
