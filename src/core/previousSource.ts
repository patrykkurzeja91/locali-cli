import type { LocaleCode, TranslationChange, TranslationEntry } from './types';

/**
 * Baseline for the source diff: the source text a target translation was last in sync with.
 * = `old_value` of the LATEST source change that flagged this target in `outdated_locales`
 * (flags, not timestamps: a status change also moves updated_at). Mirrors `mtms_previous_sources()` in
 * api/lib/project.php, which the API uses in Live mode.
 */

export type PreviousSourceIndex = Map<string, string | null>;

const slot = (keyId: number, locale: LocaleCode) => `${keyId}:${locale}`;

/** Demo mode: derives the baselines from the change log held in the app state */
export function buildPreviousSourceIndex(changes: TranslationChange[], sourceLocale: LocaleCode): PreviousSourceIndex {
  const index: PreviousSourceIndex = new Map();
  const flagging = changes.filter((c) => c.locale === sourceLocale && c.outdated_locales && c.outdated_locales.length > 0);
  flagging.sort((a, b) => a.id - b.id); // later flags override earlier ones
  for (const change of flagging) {
    for (const locale of change.outdated_locales ?? []) index.set(slot(change.translation_key_id, locale), change.old_value ?? null);
  }
  return index;
}

/** Live mode entries carry `source_previous` from the API; otherwise fall back to the change-log index. */
export function resolvePreviousSource(
  entry: TranslationEntry,
  keyId: number,
  locale: LocaleCode,
  index?: PreviousSourceIndex
): string | null {
  if (entry.source_previous !== undefined) return entry.source_previous;
  return index?.get(slot(keyId, locale)) ?? null;
}
