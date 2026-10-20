import { KeyItemWithValues, LocaleCode, ProjectConfig, TranslationChange, TranslationEntry, TranslationStatus, User } from './types';
import { KeyEditInput, applyKeyEdit, getEntry } from './translationModel';
import { isValidNamespace } from './projectConfig';
import { validateLocaleValues } from './validation';

/**
 * Batch changes (ROADMAP 4c.3). The panel turns one action on a selection into per-key operations (`BulkOp`)
 * plus the inverse operations used for "Cofnij". The server (api/lib/bulk.php) and demo mode
 * (`applyBulkOpsDemo`) both just execute operations, so the planning logic exists once and is unit-tested.
 */

export type BulkStatus = Extract<TranslationStatus, 'translated' | 'needs_review' | 'outdated'>;

export type BulkAction =
  | { type: 'archive' }
  | { type: 'restore' }
  | { type: 'namespace'; namespace: string }
  | { type: 'status'; locale: LocaleCode; status: BulkStatus }
  | { type: 'clear'; locale: LocaleCode }
  | { type: 'replace'; locale: LocaleCode; find: string; replacement: string; caseSensitive: boolean };

/** Order of execution on one key: archive → namespace → values → statuses */
export interface BulkOp {
  id: number;
  archive?: boolean;
  namespace?: string;
  values?: Record<LocaleCode, string>;
  statuses?: Record<LocaleCode, BulkStatus>;
  /** updated_at the panel saw per changed language; the server skips the key with "conflict" when it differs */
  expected?: Record<LocaleCode, string | null>;
}

export type BulkSkipReason =
  | 'exists'
  | 'invalid'
  | 'conflict'
  | 'forbidden'
  | 'not_found'
  | 'source_empty'
  | 'invalid_namespace'
  | 'error';

export interface BulkResult {
  id: number;
  status: 'ok' | 'unchanged' | 'skipped';
  reason?: BulkSkipReason;
}

export interface BulkPlan {
  action: BulkAction;
  ops: BulkOp[];
  /** Inverse operations, same order as `ops` */
  undo: BulkOp[];
  /** Keys that already are in the requested state */
  unchanged: number;
  skipped: { keyId: number; keyName: string; reason: string }[];
  /** Replace only: what each value turns into */
  preview: { keyId: number; keyName: string; before: string; after: string }[];
}

export const BULK_MAX_OPS_PER_REQUEST = 500;

export const SKIP_REASON_LABELS: Record<string, string> = {
  exists: 'klucz o tej nazwie istnieje już w tej przestrzeni',
  invalid: 'wynik nie przechodzi walidacji',
  conflict: 'ktoś zmienił wartość w międzyczasie',
  forbidden: 'wymaga roli administratora',
  not_found: 'klucz nie istnieje',
  source_empty: 'tekst źródłowy nie może być pusty',
  invalid_namespace: 'nieprawidłowa przestrzeń nazw',
  error: 'błąd serwera',
};

const storedStatus = (entry: TranslationEntry): BulkStatus => (entry.status === 'untranslated' ? 'translated' : entry.status);

export function replaceInValue(value: string, find: string, replacement: string, caseSensitive: boolean): string {
  if (!find) return value;
  const escaped = find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return value.replace(new RegExp(escaped, caseSensitive ? 'g' : 'gi'), () => replacement);
}

export function planBulk(
  selected: KeyItemWithValues[],
  action: BulkAction,
  project: ProjectConfig,
  allKeys: KeyItemWithValues[]
): BulkPlan {
  const plan: BulkPlan = { action, ops: [], undo: [], unchanged: 0, skipped: [], preview: [] };
  const skip = (key: KeyItemWithValues, reason: string) => plan.skipped.push({ keyId: key.id, keyName: key.key_name, reason });
  const add = (op: BulkOp, undo: BulkOp) => {
    plan.ops.push(op);
    plan.undo.push(undo);
  };

  // Namespace moves: names already taken, including keys moved earlier in the same batch
  const taken = new Set(allKeys.map((k) => `${k.namespace}:${k.key_name}`));

  for (const key of selected) {
    switch (action.type) {
      case 'archive':
      case 'restore': {
        const archive = action.type === 'archive';
        if (key.is_archived === archive) plan.unchanged++;
        else add({ id: key.id, archive }, { id: key.id, archive: !archive });
        break;
      }

      case 'namespace': {
        if (!isValidNamespace(action.namespace)) {
          skip(key, 'invalid_namespace');
        } else if (key.namespace === action.namespace) {
          plan.unchanged++;
        } else if (taken.has(`${action.namespace}:${key.key_name}`)) {
          skip(key, 'exists');
        } else {
          taken.delete(`${key.namespace}:${key.key_name}`);
          taken.add(`${action.namespace}:${key.key_name}`);
          add({ id: key.id, namespace: action.namespace }, { id: key.id, namespace: key.namespace });
        }
        break;
      }

      case 'status': {
        const entry = getEntry(key, action.locale);
        if (!entry.value.trim() || entry.status === action.status) {
          plan.unchanged++;
        } else {
          add(
            { id: key.id, statuses: { [action.locale]: action.status } },
            { id: key.id, statuses: { [action.locale]: storedStatus(entry) } }
          );
        }
        break;
      }

      case 'clear': {
        const entry = getEntry(key, action.locale);
        if (!entry.value) {
          plan.unchanged++;
        } else {
          add(
            { id: key.id, values: { [action.locale]: '' }, expected: { [action.locale]: entry.updated_at } },
            { id: key.id, values: { [action.locale]: entry.value }, statuses: { [action.locale]: storedStatus(entry) } }
          );
        }
        break;
      }

      case 'replace': {
        const entry = getEntry(key, action.locale);
        const next = replaceInValue(entry.value, action.find, action.replacement, action.caseSensitive).trim();
        if (!action.find || next === entry.value) {
          plan.unchanged++;
          break;
        }
        const values: Record<LocaleCode, string> = {};
        for (const l of [project.sourceLanguage, ...project.targetLanguages]) values[l] = getEntry(key, l).value;
        values[action.locale] = next;
        const broken = validateLocaleValues(project, values)[action.locale]?.some((i) => i.type === 'error');
        if (broken) {
          skip(key, 'invalid');
          break;
        }
        add(
          { id: key.id, values: { [action.locale]: next }, expected: { [action.locale]: entry.updated_at } },
          { id: key.id, values: { [action.locale]: entry.value }, statuses: entry.value.trim() ? { [action.locale]: storedStatus(entry) } : undefined }
        );
        plan.preview.push({ keyId: key.id, keyName: key.key_name, before: entry.value, after: next });
        break;
      }
    }
  }
  return plan;
}

type NewChange = Omit<TranslationChange, 'id'>;

/** Demo mode: executes operations on localStorage data with the same semantics as api/lib/bulk.php */
export function applyBulkOpsDemo(
  keys: KeyItemWithValues[],
  ops: BulkOp[],
  project: ProjectConfig,
  user: User,
  now: string
): { keys: KeyItemWithValues[]; changes: NewChange[]; results: BulkResult[] } {
  const byId = new Map(keys.map((k) => [k.id, k]));
  const taken = new Set(keys.map((k) => `${k.namespace}:${k.key_name}`));
  const changes: NewChange[] = [];
  const results: BulkResult[] = [];

  for (const op of ops) {
    let key = byId.get(op.id);
    if (!key) {
      results.push({ id: op.id, status: 'skipped', reason: 'not_found' });
      continue;
    }
    const skip = (reason: BulkSkipReason) => results.push({ id: op.id, status: 'skipped', reason });
    const touchesAdminOnly = op.archive !== undefined || op.namespace !== undefined;
    if (touchesAdminOnly && user.role !== 'admin') {
      skip('forbidden');
      continue;
    }
    if (op.values && op.values[project.sourceLanguage] !== undefined && !op.values[project.sourceLanguage].trim()) {
      skip('source_empty');
      continue;
    }

    let next: KeyItemWithValues = key;
    let changed = false;
    let opChanges: NewChange[] = [];

    if (op.archive !== undefined && next.is_archived !== op.archive) {
      next = { ...next, is_archived: op.archive };
      changed = true;
    }
    if (op.namespace !== undefined && op.namespace !== next.namespace) {
      if (!isValidNamespace(op.namespace)) {
        skip('invalid_namespace');
        continue;
      }
      if (taken.has(`${op.namespace}:${next.key_name}`)) {
        skip('exists');
        continue;
      }
      taken.delete(`${next.namespace}:${next.key_name}`);
      taken.add(`${op.namespace}:${next.key_name}`);
      next = { ...next, namespace: op.namespace };
      changed = true;
    }
    if (op.values) {
      const input: KeyEditInput = { values: op.values, description: next.description ?? '', namespace: next.namespace };
      const edited = applyKeyEdit(next, input, project, user, now);
      if (edited.changes.length > 0) {
        next = edited.key;
        opChanges = edited.changes;
        changed = true;
      }
    }
    if (op.statuses) {
      const translations = { ...next.translations };
      for (const [locale, status] of Object.entries(op.statuses)) {
        const entry = translations[locale];
        if (locale === project.sourceLanguage || !entry || !entry.value.trim() || entry.status === status) continue;
        translations[locale] = { ...entry, status, updated_at: now };
        changed = true;
      }
      next = { ...next, translations };
    }

    if (changed) {
      byId.set(op.id, { ...next, updated_at: now, updated_by_name: user.name });
      changes.push(...opChanges);
    }
    results.push({ id: op.id, status: changed ? 'ok' : 'unchanged' });
  }

  return { keys: keys.map((k) => byId.get(k.id) ?? k), changes, results };
}

/** Splits a long list of operations into server-sized requests */
export function chunkOps<T>(ops: T[], size = BULK_MAX_OPS_PER_REQUEST): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < ops.length; i += size) chunks.push(ops.slice(i, i + size));
  return chunks;
}
