import { KeyItemWithValues, LocaleCode, ProjectConfig, PublishBatchFile } from './types';
import { getProjectLanguages } from './projectConfig';
import { calculateSha256, serializeFormattedJson } from './i18nUtils';

/**
 * Locale file layout (fileStructure / fileFormat) shared by export, publish manifest and the CLI.
 * See docs/SPEC_SYNC_CLI.md §2.
 */

export interface LocaleFile {
  path: string;
  locale: LocaleCode;
  /** null when all namespaces are merged into one file per language */
  namespace: string | null;
  /** Flat dot-notation map, sorted by key */
  entries: Record<string, string>;
  content: string;
}

export interface BuildLocaleFilesResult {
  files: LocaleFile[];
  /** Non-fatal problems (skipped keys) */
  errors: string[];
}

type FileLayout = Pick<ProjectConfig, 'localesDir' | 'fileStructure'>;

export function usesNamespaces(project: Pick<ProjectConfig, 'fileStructure'>): boolean {
  return project.fileStructure.includes('{namespace}');
}

function normalizePath(path: string): string {
  return path
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/^(\.\/)+/, '')
    .replace(/\/\.\//g, '/');
}

export function resolveLocaleFilePath(project: FileLayout, lang: LocaleCode, namespace: string): string {
  const localesDir = project.localesDir.replace(/[\\/]+$/, '');
  return normalizePath(
    project.fileStructure
      .replace(/\{localesDir\}/g, localesDir)
      .replace(/\{lang\}/g, lang)
      .replace(/\{namespace\}/g, namespace)
  );
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Reverse of resolveLocaleFilePath: returns the namespace encoded in `path` for `lang`,
 * the default namespace for single-file layouts, or null when the path does not match.
 */
export function matchLocaleFilePath(
  project: FileLayout & Pick<ProjectConfig, 'defaultNamespace'>,
  lang: LocaleCode,
  path: string
): string | null {
  const localesDir = normalizePath(project.localesDir.replace(/[\\/]+$/, ''));
  const template = normalizePath(project.fileStructure.replace(/\{localesDir\}/g, localesDir).replace(/\{lang\}/g, lang));
  const parts = template.split('{namespace}').map(escapeRegex);
  const regex = new RegExp('^' + parts.join('([a-zA-Z0-9][a-zA-Z0-9_-]*)') + '$');
  const m = regex.exec(normalizePath(path));
  if (!m) return null;
  return parts.length > 1 ? m[1] : project.defaultNamespace;
}

export interface UnflattenResult {
  tree: Record<string, unknown>;
  conflicts: string[];
}

/** Like unflattenJson, but reports keys that are both a leaf and a prefix (e.g. "a.b" and "a.b.c") */
export function unflattenWithConflicts(flat: Record<string, string>): UnflattenResult {
  const tree: Record<string, unknown> = {};
  const conflicts: string[] = [];
  for (const key of Object.keys(flat).sort()) {
    const parts = key.split('.');
    let node: Record<string, unknown> = tree;
    let ok = true;
    for (let i = 0; i < parts.length - 1; i++) {
      const existing = node[parts[i]];
      if (existing === undefined) {
        node[parts[i]] = {};
      } else if (typeof existing !== 'object') {
        ok = false;
        break;
      }
      node = node[parts[i]] as Record<string, unknown>;
    }
    const leaf = parts[parts.length - 1];
    if (!ok || (node[leaf] !== undefined && typeof node[leaf] === 'object')) {
      conflicts.push(key);
      continue;
    }
    node[leaf] = flat[key];
  }
  return { tree, conflicts };
}

function sortedEntries(map: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(map).sort()) out[key] = map[key];
  return out;
}

export function serializeLocaleEntries(entries: Record<string, string>, format: ProjectConfig['fileFormat']): { content: string; conflicts: string[] } {
  if (format === 'flat') return { content: serializeFormattedJson(sortedEntries(entries)), conflicts: [] };
  const { tree, conflicts } = unflattenWithConflicts(entries);
  return { content: serializeFormattedJson(tree), conflicts };
}

/**
 * Builds every locale file for the given languages (default: source + all targets).
 * Archived keys and empty values are omitted (the app falls back to fallbackLocale).
 */
export function buildLocaleFiles(
  keys: KeyItemWithValues[],
  project: ProjectConfig,
  locales: LocaleCode[] = getProjectLanguages(project)
): BuildLocaleFilesResult {
  const errors: string[] = [];
  const activeKeys = keys.filter((k) => !k.is_archived);
  const namespaced = usesNamespaces(project);

  const namespaces = namespaced
    ? Array.from(new Set(activeKeys.map((k) => k.namespace || project.defaultNamespace))).sort()
    : [project.defaultNamespace];
  if (namespaces.length === 0) namespaces.push(project.defaultNamespace);

  const files: LocaleFile[] = [];
  for (const locale of locales) {
    for (const namespace of namespaces) {
      const entries: Record<string, string> = {};
      const origin: Record<string, string> = {};
      for (const key of activeKeys) {
        const keyNamespace = key.namespace || project.defaultNamespace;
        if (namespaced && keyNamespace !== namespace) continue;
        const value = key.translations[locale]?.value;
        if (!value) continue;
        if (entries[key.key_name] !== undefined) {
          errors.push(
            `[${locale}] Klucz "${key.key_name}" istnieje w przestrzeniach "${origin[key.key_name]}" i "${keyNamespace}" — pominięto drugi, bo fileStructure nie zawiera {namespace}.`
          );
          continue;
        }
        entries[key.key_name] = value;
        origin[key.key_name] = keyNamespace;
      }
      const { content, conflicts } = serializeLocaleEntries(entries, project.fileFormat);
      for (const conflict of conflicts) {
        errors.push(`[${locale}] Klucz "${conflict}" koliduje z innym kluczem będącym jego prefiksem — pominięto w zagnieżdżonym JSON.`);
      }
      files.push({
        path: resolveLocaleFilePath(project, locale, namespace),
        locale,
        namespace: namespaced ? namespace : null,
        entries: sortedEntries(entries),
        content,
      });
    }
  }
  return { files, errors };
}

export async function toManifestFiles(files: LocaleFile[]): Promise<PublishBatchFile[]> {
  const encoder = new TextEncoder();
  return Promise.all(
    files.map(async (f) => ({
      path: f.path,
      locale: f.locale,
      namespace: f.namespace,
      sha256: await calculateSha256(f.content),
      bytes: encoder.encode(f.content).length,
      keys_count: Object.keys(f.entries).length,
    }))
  );
}

export function serializeManifest(batchId: number, files: PublishBatchFile[]): string {
  return serializeFormattedJson({ batch_id: batchId, files });
}
