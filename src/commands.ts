import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  LocaleCode,
  ProjectConfig,
  parseProjectConfig,
  getProjectLanguages,
  matchLocaleFilePath,
  resolveLocaleFilePath,
  serializeLocaleEntries,
  usesNamespaces,
  flattenJson,
  validateLocaleValue,
} from '@mini-tms/core';

/**
 * mini-tms CLI — push / pull / status / validate (docs/SPEC_SYNC_CLI.md §4).
 * All I/O goes through `CliContext` so the commands are testable without a network or real cwd.
 */

export const EXIT = { OK: 0, VALIDATION: 1, CONFIG: 2, NETWORK: 3 } as const;

export interface CliContext {
  cwd: string;
  env: Record<string, string | undefined>;
  fetch: typeof fetch;
  out: (line: string) => void;
  err: (line: string) => void;
}

interface ParsedArgs {
  command: string | undefined;
  flags: Record<string, string | boolean>;
}

const HELP = `mini-tms — synchronizacja plików tłumaczeń z Mini-TMS

Użycie:
  mini-tms push      [--config path] [--dry-run] [--update-source] [--namespace ns]
  mini-tms pull      [--config path] [--dry-run] [--lang pl,de]
  mini-tms status    [--config path]
  mini-tms validate  [--config path]

Zmienne środowiskowe:
  MINI_TMS_TOKEN     token API (mtms_...) — wymagany dla push / pull / status
  MINI_TMS_API_URL   nadpisuje apiBaseUrl z i18n.config.json

Kody wyjścia: 0 OK · 1 błędy walidacji / konflikty · 2 błąd konfiguracji · 3 błąd sieci / autoryzacji`;

export function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  let command: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const [name, inline] = arg.slice(2).split('=', 2);
      if (inline !== undefined) flags[name] = inline;
      else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') && ['config', 'lang', 'namespace'].includes(name)) {
        flags[name] = argv[++i];
      } else flags[name] = true;
    } else if (arg.startsWith('-') && arg.length > 1) {
      flags[arg.slice(1)] = true;
    } else if (!command) {
      command = arg;
    }
  }
  return { command, flags };
}

class CliError extends Error {
  constructor(message: string, public exitCode: number) {
    super(message);
  }
}

interface LoadedConfig {
  project: ProjectConfig;
  baseDir: string;
  apiBaseUrl?: string;
}

async function loadConfig(ctx: CliContext, flags: ParsedArgs['flags']): Promise<LoadedConfig> {
  const configPath = path.resolve(ctx.cwd, typeof flags.config === 'string' ? flags.config : 'i18n.config.json');
  let raw: string;
  try {
    raw = await fs.readFile(configPath, 'utf8');
  } catch {
    throw new CliError(`Nie znaleziono pliku konfiguracyjnego: ${configPath}`, EXIT.CONFIG);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    throw new CliError(`Niepoprawny JSON w ${configPath}: ${(e as Error).message}`, EXIT.CONFIG);
  }
  const { config, errors, apiBaseUrl } = parseProjectConfig(json);
  if (!config) throw new CliError(`Błędy w ${path.basename(configPath)}:\n  - ${errors.join('\n  - ')}`, EXIT.CONFIG);
  return { project: config, baseDir: path.dirname(configPath), apiBaseUrl: ctx.env.MINI_TMS_API_URL || apiBaseUrl };
}

/** Resolves a project-relative locale path and refuses anything escaping the project directory */
function safeJoin(baseDir: string, relative: string): string {
  const full = path.resolve(baseDir, relative);
  if (full !== baseDir && !full.startsWith(baseDir + path.sep)) {
    throw new CliError(`Ścieżka ${relative} wychodzi poza katalog projektu.`, EXIT.CONFIG);
  }
  return full;
}

async function walkJsonFiles(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walkJsonFiles(full)));
    else if (entry.name.endsWith('.json')) files.push(full);
  }
  return files;
}

async function readFlatJson(file: string): Promise<Record<string, string>> {
  const raw = await fs.readFile(file, 'utf8');
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('oczekiwano obiektu');
    return flattenJson(parsed);
  } catch (e) {
    throw new CliError(`Niepoprawny JSON w ${file}: ${(e as Error).message}`, EXIT.VALIDATION);
  }
}

/** Finds the local files of one language: namespace -> absolute path */
async function discoverLocaleFiles(loaded: LoadedConfig, lang: LocaleCode): Promise<Map<string, string>> {
  const { project, baseDir } = loaded;
  const result = new Map<string, string>();
  if (!usesNamespaces(project)) {
    const file = safeJoin(baseDir, resolveLocaleFilePath(project, lang, project.defaultNamespace));
    try {
      await fs.access(file);
      result.set(project.defaultNamespace, file);
    } catch {
      /* missing file */
    }
    return result;
  }
  const localesRoot = safeJoin(baseDir, project.localesDir);
  for (const file of await walkJsonFiles(localesRoot)) {
    const relative = path.relative(baseDir, file).split(path.sep).join('/');
    const namespace = matchLocaleFilePath(project, lang, relative);
    if (namespace) result.set(namespace, file);
  }
  return result;
}

async function api<T>(ctx: CliContext, loaded: LoadedConfig, method: 'GET' | 'POST', query: Record<string, string>, body?: unknown): Promise<T> {
  if (!loaded.apiBaseUrl) throw new CliError('Brak adresu API: ustaw apiBaseUrl w i18n.config.json lub MINI_TMS_API_URL.', EXIT.CONFIG);
  const token = ctx.env.MINI_TMS_TOKEN;
  if (!token) throw new CliError('Brak tokena: ustaw zmienną środowiskową MINI_TMS_TOKEN.', EXIT.CONFIG);

  const url = new URL(loaded.apiBaseUrl.replace(/\/+$/, '') + '/sync.php');
  url.searchParams.set('project', loaded.project.projectId);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);

  let response: Response;
  try {
    response = await ctx.fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new CliError(`Błąd połączenia z ${url.origin}: ${(e as Error).message}`, EXIT.NETWORK);
  }
  const text = await response.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON error page */
  }
  if (!response.ok) {
    const message = (data as { error?: string } | null)?.error ?? text.slice(0, 200);
    throw new CliError(`API ${response.status}: ${message}`, EXIT.NETWORK);
  }
  return data as T;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

interface PushResult {
  created: string[];
  updated: string[];
  skipped: string[];
  conflicts: string[];
  invalid: string[];
}

const PUSH_CHUNK_KEYS = 5000;

async function commandPush(ctx: CliContext, flags: ParsedArgs['flags']): Promise<number> {
  const loaded = await loadConfig(ctx, flags);
  const { project } = loaded;
  const files = await discoverLocaleFiles(loaded, project.sourceLanguage);
  if (typeof flags.namespace === 'string') {
    for (const ns of Array.from(files.keys())) if (ns !== flags.namespace) files.delete(ns);
  }
  if (files.size === 0) {
    throw new CliError(`Nie znaleziono plików języka źródłowego (${project.sourceLanguage}) wg ${project.fileStructure}.`, EXIT.CONFIG);
  }

  // Chunk by namespace and key count to respect the 2 MB API body limit
  const chunks: Array<Record<string, Record<string, string>>> = [];
  let current: Record<string, Record<string, string>> = {};
  let count = 0;
  for (const [namespace, file] of Array.from(files.entries()).sort()) {
    const entries = await readFlatJson(file);
    ctx.out(`↑ ${path.relative(ctx.cwd, file)} — ${Object.keys(entries).length} kluczy (${namespace})`);
    for (const [key, value] of Object.entries(entries)) {
      if (count >= PUSH_CHUNK_KEYS) {
        chunks.push(current);
        current = {};
        count = 0;
      }
      (current[namespace] ??= {})[key] = value;
      count++;
    }
  }
  if (count > 0) chunks.push(current);

  const total: PushResult = { created: [], updated: [], skipped: [], conflicts: [], invalid: [] };
  for (const namespaces of chunks) {
    const result = await api<PushResult>(ctx, loaded, 'POST', { action: 'push' }, {
      sourceLanguage: project.sourceLanguage,
      namespaces,
      updateSource: flags['update-source'] === true,
      dryRun: flags['dry-run'] === true,
    });
    for (const k of Object.keys(total) as Array<keyof PushResult>) total[k].push(...(result[k] ?? []));
  }

  const prefix = flags['dry-run'] ? '[dry-run] ' : '';
  ctx.out(
    `${prefix}Nowe: ${total.created.length} · zaktualizowane źródła: ${total.updated.length} · bez zmian: ${total.skipped.length} · konflikty: ${total.conflicts.length} · niepoprawne: ${total.invalid.length}`
  );
  for (const key of total.conflicts.slice(0, 20)) {
    ctx.err(`  ! konflikt: ${key} — tekst źródłowy różni się od bazy (użyj --update-source, aby nadpisać)`);
  }
  for (const key of total.invalid.slice(0, 20)) ctx.err(`  ! niepoprawna nazwa klucza: ${key}`);
  return total.conflicts.length > 0 || total.invalid.length > 0 ? EXIT.VALIDATION : EXIT.OK;
}

interface RemoteConfig {
  sourceLanguage: string;
  targetLanguages: string[];
  messageFormat?: string;
}

interface PullResponse {
  lang: string;
  namespaces: Record<string, Record<string, string>>;
}

async function commandPull(ctx: CliContext, flags: ParsedArgs['flags']): Promise<number> {
  const loaded = await loadConfig(ctx, flags);
  const { project, baseDir } = loaded;
  const remote = await api<RemoteConfig>(ctx, loaded, 'GET', { action: 'config' });

  const localLanguages = getProjectLanguages(project);
  const remoteLanguages = [remote.sourceLanguage, ...remote.targetLanguages];
  const missingRemotely = localLanguages.filter((l) => !remoteLanguages.includes(l));
  const missingLocally = remoteLanguages.filter((l) => !localLanguages.includes(l));
  if (remote.sourceLanguage !== project.sourceLanguage) {
    ctx.err(`! Język źródłowy na serwerze (${remote.sourceLanguage}) różni się od lokalnego (${project.sourceLanguage}).`);
  }
  if (remote.messageFormat && remote.messageFormat !== project.messageFormat) {
    ctx.err(`! Format wiadomości na serwerze (${remote.messageFormat}) różni się od lokalnego (${project.messageFormat}) — walidacja liczby mnogiej może się różnić.`);
  }
  if (missingRemotely.length) ctx.err(`! Języki z konfiguracji nieobecne na serwerze: ${missingRemotely.join(', ')} (pominięte)`);
  if (missingLocally.length) ctx.err(`! Serwer ma dodatkowe języki: ${missingLocally.join(', ')} — dodaj je do targetLanguages, aby je pobierać`);

  let languages = localLanguages.filter((l) => remoteLanguages.includes(l));
  if (typeof flags.lang === 'string') {
    const requested = flags.lang.split(',').map((l) => l.trim()).filter(Boolean);
    const unknown = requested.filter((l) => !remoteLanguages.includes(l));
    if (unknown.length) throw new CliError(`Nieznane języki: ${unknown.join(', ')}`, EXIT.CONFIG);
    languages = requested;
  }

  const namespaced = usesNamespaces(project);
  let written = 0;
  let unchanged = 0;
  const problems: string[] = [];

  for (const lang of languages) {
    const data = await api<PullResponse>(ctx, loaded, 'GET', { action: 'pull', lang });
    const byFile = new Map<string, Record<string, string>>();
    for (const [namespace, entries] of Object.entries(data.namespaces ?? {})) {
      const target = resolveLocaleFilePath(project, lang, namespaced ? namespace : project.defaultNamespace);
      const merged = byFile.get(target) ?? {};
      for (const [key, value] of Object.entries(entries)) {
        if (merged[key] !== undefined) problems.push(`[${lang}] ${key}: kolizja przestrzeni nazw w ${target}`);
        else merged[key] = value;
      }
      byFile.set(target, merged);
    }

    for (const [relative, entries] of byFile) {
      const { content, conflicts } = serializeLocaleEntries(entries, project.fileFormat);
      problems.push(...conflicts.map((k) => `[${lang}] ${k}: klucz koliduje z prefiksem w ${relative}`));
      const file = safeJoin(baseDir, relative);
      const existing = await fs.readFile(file, 'utf8').catch(() => null);
      if (existing === content) {
        unchanged++;
        continue;
      }
      ctx.out(`${flags['dry-run'] ? '[dry-run] ' : ''}↓ ${relative} — ${Object.keys(entries).length} kluczy${existing === null ? ' (nowy plik)' : ''}`);
      if (!flags['dry-run']) {
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, content, 'utf8');
      }
      written++;
    }
  }

  for (const problem of problems) ctx.err(`  ! ${problem}`);
  ctx.out(`Zapisano plików: ${written} · bez zmian: ${unchanged}`);
  return problems.length > 0 ? EXIT.VALIDATION : EXIT.OK;
}

interface StatusResponse {
  totalKeys: number;
  languages: Record<string, { translated: number; outdated: number; untranslated: number }>;
}

async function commandStatus(ctx: CliContext, flags: ParsedArgs['flags']): Promise<number> {
  const loaded = await loadConfig(ctx, flags);
  const status = await api<StatusResponse>(ctx, loaded, 'GET', { action: 'status' });
  ctx.out(`Projekt ${loaded.project.projectId}: ${status.totalKeys} aktywnych kluczy`);
  ctx.out('język   przetł.  nieakt.  brak   %');
  for (const [lang, s] of Object.entries(status.languages)) {
    const percent = status.totalKeys ? Math.round((s.translated / status.totalKeys) * 100) : 100;
    ctx.out(`${lang.padEnd(8)}${String(s.translated).padStart(7)}  ${String(s.outdated).padStart(7)}  ${String(s.untranslated).padStart(5)}  ${String(percent).padStart(3)}%`);
  }
  return EXIT.OK;
}

async function commandValidate(ctx: CliContext, flags: ParsedArgs['flags']): Promise<number> {
  const loaded = await loadConfig(ctx, flags);
  const { project } = loaded;
  const sourceFiles = await discoverLocaleFiles(loaded, project.sourceLanguage);
  if (sourceFiles.size === 0) throw new CliError(`Brak plików języka źródłowego (${project.sourceLanguage}).`, EXIT.CONFIG);

  let errorCount = 0;
  let checked = 0;
  for (const [namespace, sourceFile] of sourceFiles) {
    const source = await readFlatJson(sourceFile);
    for (const lang of project.targetLanguages) {
      const relative = resolveLocaleFilePath(project, lang, namespace);
      const targetFile = safeJoin(loaded.baseDir, relative);
      const target = await readFlatJson(targetFile).catch((e) => {
        if (e instanceof CliError) throw e;
        return null;
      });
      if (!target) {
        ctx.err(`? brak pliku ${relative}`);
        continue;
      }
      for (const [key, value] of Object.entries(target)) {
        checked++;
        if (source[key] === undefined) {
          ctx.err(`? [${lang}] ${namespace}:${key} — klucz nie istnieje w języku źródłowym`);
          continue;
        }
        for (const issue of validateLocaleValue(project, lang, value, source[key])) {
          if (issue.type !== 'error') continue;
          errorCount++;
          ctx.err(`✗ [${lang}] ${namespace}:${key} — ${issue.message.replace(/^\[[A-Za-z-]+\] /, '')}`);
        }
      }
    }
  }
  ctx.out(`Sprawdzono ${checked} tłumaczeń: ${errorCount === 0 ? 'brak błędów struktury tokenów ✓' : `${errorCount} błędów`}`);
  return errorCount > 0 ? EXIT.VALIDATION : EXIT.OK;
}

export async function runCli(argv: string[], ctx: CliContext): Promise<number> {
  const { command, flags } = parseArgs(argv);
  if (flags.version || flags.v || command === 'version') {
    ctx.out('0.1.0');
    return EXIT.OK;
  }
  if (flags.help || flags.h || command === 'help') {
    ctx.out(HELP);
    return EXIT.OK;
  }
  try {
    switch (command) {
      case 'push':
        return await commandPush(ctx, flags);
      case 'pull':
        return await commandPull(ctx, flags);
      case 'status':
        return await commandStatus(ctx, flags);
      case 'validate':
        return await commandValidate(ctx, flags);
      case undefined:
        ctx.out(HELP);
        return EXIT.CONFIG;
      default:
        ctx.err(`Nieznane polecenie: ${command}\n\n${HELP}`);
        return EXIT.CONFIG;
    }
  } catch (e) {
    if (e instanceof CliError) {
      ctx.err(e.message);
      return e.exitCode;
    }
    throw e;
  }
}
