import { KeyItemWithValues, PublishBatch, TranslationEntry, TranslationStatus } from './types';

/**
 * localStorage schema upgrades for demo mode (PRD R1.6).
 * v1: keys with fixed `pl` / `en` string fields, batches with `pl_sha256` / `en_sha256`.
 * v2: keys with a `translations` map + namespace, batches with a `files` manifest.
 */

export const STORAGE_SCHEMA_VERSION = 2;

type LegacyKey = Omit<KeyItemWithValues, 'translations' | 'namespace'> & {
  pl?: string;
  en?: string;
  status?: string;
  namespace?: string;
  translations?: Record<string, TranslationEntry>;
};

type LegacyBatch = Omit<PublishBatch, 'files' | 'manifest_sha256'> & {
  pl_sha256?: string;
  en_sha256?: string;
  files?: PublishBatch['files'];
  manifest_sha256?: string | null;
};

const entryFor = (value: string | undefined, updatedAt: string, status: TranslationStatus = 'translated'): TranslationEntry => {
  const v = value ?? '';
  return { value: v, status: v.trim() ? status : 'untranslated', updated_at: v ? updatedAt : null };
};

export function migrateKeys(raw: unknown, defaultNamespace: string): KeyItemWithValues[] {
  if (!Array.isArray(raw)) return [];
  return (raw as LegacyKey[]).map((k) => {
    if (k.translations) {
      return { ...k, namespace: k.namespace || defaultNamespace, translations: k.translations } as KeyItemWithValues;
    }
    const { pl, en, status: _legacyStatus, ...rest } = k;
    return {
      ...rest,
      namespace: defaultNamespace,
      translations: {
        pl: entryFor(pl, k.updated_at),
        en: entryFor(en, k.updated_at),
      },
    } as KeyItemWithValues;
  });
}

export function migrateBatches(raw: unknown): PublishBatch[] {
  if (!Array.isArray(raw)) return [];
  return (raw as LegacyBatch[]).map((b) => {
    if (Array.isArray(b.files)) return { ...b, manifest_sha256: b.manifest_sha256 ?? null } as PublishBatch;
    const { pl_sha256, en_sha256, ...rest } = b;
    const files: PublishBatch['files'] = [];
    if (pl_sha256) files.push({ path: 'i18n/locales/pl.json', locale: 'pl', namespace: null, sha256: pl_sha256, bytes: 0, keys_count: 0 });
    if (en_sha256) files.push({ path: 'i18n/locales/en.json', locale: 'en', namespace: null, sha256: en_sha256, bytes: 0, keys_count: 0 });
    return { ...rest, files, manifest_sha256: null } as PublishBatch;
  });
}
