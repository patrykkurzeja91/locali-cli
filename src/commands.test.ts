import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCli, parseArgs, CliContext, EXIT } from './commands.ts';

interface FakeServer {
  keys: Record<string, Record<string, Record<string, string>>>; // lang -> namespace -> key -> value
  requests: Array<{ method: string; url: URL; body: unknown; auth: string | null }>;
}

function makeContext(cwd: string, server: FakeServer) {
  const out: string[] = [];
  const err: string[] = [];
  const fakeFetch = (async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const headers = new Headers(init?.headers);
    server.requests.push({ method: init?.method ?? 'GET', url, body, auth: headers.get('Authorization') });
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
    if (headers.get('Authorization') !== 'Bearer mtms_test') return json({ error: 'Token API jest nieważny' }, 401);

    switch (url.searchParams.get('action')) {
      case 'config':
        return json({ sourceLanguage: 'en', targetLanguages: ['pl', 'de'] });
      case 'pull':
        return json({ lang: url.searchParams.get('lang'), namespaces: server.keys[url.searchParams.get('lang')!] ?? {} });
      case 'push': {
        const result = { created: [] as string[], updated: [], skipped: [] as string[], conflicts: [] as string[], invalid: [] };
        for (const [ns, entries] of Object.entries(body.namespaces as Record<string, Record<string, string>>)) {
          for (const [key, value] of Object.entries(entries)) {
            const existing = server.keys.en?.[ns]?.[key];
            if (existing === undefined) result.created.push(`${ns}:${key}`);
            else if (existing === value) result.skipped.push(`${ns}:${key}`);
            else result.conflicts.push(`${ns}:${key}`);
          }
        }
        return json(result);
      }
      case 'status':
        return json({ totalKeys: 2, languages: { en: { translated: 2, outdated: 0, untranslated: 0 }, pl: { translated: 1, outdated: 1, untranslated: 0 } } });
      default:
        return json({ error: 'unknown' }, 400);
    }
  }) as typeof fetch;

  const ctx: CliContext = {
    cwd,
    env: { MINI_TMS_TOKEN: 'mtms_test' },
    fetch: fakeFetch,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
  };
  return { ctx, out, err };
}

const CONFIG = {
  projectId: 'storefront-web',
  apiBaseUrl: 'https://tms.example.com/api/',
  sourceLanguage: 'en',
  targetLanguages: ['pl', 'de'],
  localesDir: './public/locales',
  fileStructure: '{localesDir}/{lang}/{namespace}.json',
};

let dir: string;
let server: FakeServer;

async function writeJson(relative: string, data: unknown) {
  const file = path.join(dir, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(data, null, 2));
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-tms-'));
  await writeJson('i18n.config.json', CONFIG);
  server = {
    requests: [],
    keys: {
      en: { common: { 'cart.title': 'Cart', 'cart.hello': 'Hi {name}' } },
      pl: { common: { 'cart.title': 'Koszyk', 'cart.hello': 'Cześć {name}' }, auth: { 'login.submit': 'Zaloguj' } },
      de: {},
    },
  };
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('parseArgs', () => {
  it('parses commands, boolean flags and value flags', () => {
    assert.deepEqual(parseArgs(['pull', '--lang', 'pl,de', '--dry-run', '--config=x.json']), {
      command: 'pull',
      flags: { lang: 'pl,de', 'dry-run': true, config: 'x.json' },
    });
  });
});

describe('mini-tms pull', () => {
  it('writes nested files per language/namespace and is idempotent', async () => {
    const { ctx, out } = makeContext(dir, server);
    assert.equal(await runCli(['pull'], ctx), EXIT.OK);
    const pl = JSON.parse(await fs.readFile(path.join(dir, 'public/locales/pl/common.json'), 'utf8'));
    assert.deepEqual(pl, { cart: { hello: 'Cześć {name}', title: 'Koszyk' } });
    assert.ok(await fs.readFile(path.join(dir, 'public/locales/pl/auth.json'), 'utf8'));
    assert.match(out.at(-1)!, /Zapisano plików: 3/);
    assert.equal(server.requests[0].url.toString(), 'https://tms.example.com/api/sync.php?project=storefront-web&action=config');

    const second = makeContext(dir, server);
    assert.equal(await runCli(['pull'], second.ctx), EXIT.OK);
    assert.match(second.out.at(-1)!, /Zapisano plików: 0 · bez zmian: 3/);
  });

  it('respects --dry-run and --lang', async () => {
    const { ctx, out } = makeContext(dir, server);
    assert.equal(await runCli(['pull', '--dry-run', '--lang', 'pl'], ctx), EXIT.OK);
    await assert.rejects(fs.access(path.join(dir, 'public/locales/pl/common.json')));
    assert.ok(out.some((l) => l.startsWith('[dry-run] ↓ public/locales/pl/common.json')));
    assert.equal(server.requests.filter((r) => r.url.searchParams.get('action') === 'pull').length, 1);
  });

  it('warns about languages that exist only locally', async () => {
    await writeJson('i18n.config.json', { ...CONFIG, targetLanguages: ['pl', 'fr'] });
    const { ctx, err } = makeContext(dir, server);
    assert.equal(await runCli(['pull'], ctx), EXIT.OK);
    assert.ok(err.some((l) => l.includes('fr')));
    assert.ok(err.some((l) => l.includes('de')));
  });

  it('merges namespaces into one file per language when fileStructure has no {namespace}', async () => {
    await writeJson('i18n.config.json', { ...CONFIG, fileStructure: '{localesDir}/{lang}.json', fileFormat: 'flat' });
    const { ctx } = makeContext(dir, server);
    assert.equal(await runCli(['pull', '--lang', 'pl'], ctx), EXIT.OK);
    const pl = JSON.parse(await fs.readFile(path.join(dir, 'public/locales/pl.json'), 'utf8'));
    assert.deepEqual(Object.keys(pl), ['cart.hello', 'cart.title', 'login.submit']);
  });
});

describe('mini-tms push', () => {
  it('uploads source files grouped by namespace and reports conflicts', async () => {
    await writeJson('public/locales/en/common.json', { cart: { title: 'Basket', hello: 'Hi {name}', new: 'New!' } });
    await writeJson('public/locales/en/auth.json', { login: { submit: 'Sign in' } });
    await writeJson('public/locales/pl/common.json', { cart: { title: 'Koszyk' } });
    const { ctx, out, err } = makeContext(dir, server);
    assert.equal(await runCli(['push', '--dry-run'], ctx), EXIT.VALIDATION);
    const push = server.requests.find((r) => r.method === 'POST')!;
    const body = push.body as { namespaces: Record<string, Record<string, string>>; dryRun: boolean; sourceLanguage: string };
    assert.deepEqual(Object.keys(body.namespaces).sort(), ['auth', 'common']);
    assert.equal(body.dryRun, true);
    assert.equal(body.sourceLanguage, 'en');
    assert.equal(body.namespaces.common['cart.new'], 'New!');
    assert.match(out.at(-1)!, /Nowe: 2 .* bez zmian: 1 .* konflikty: 1/);
    assert.ok(err.some((l) => l.includes('common:cart.title')));
  });
});

describe('mini-tms validate', () => {
  it('fails on missing / changed tokens in local target files', async () => {
    await writeJson('public/locales/en/common.json', { hello: 'Hi {name}', link: 'Read [docs](https://x.io)' });
    await writeJson('public/locales/pl/common.json', { hello: 'Cześć', link: 'Czytaj [dokumentację](https://x.io)' });
    const { ctx, err, out } = makeContext(dir, server);
    assert.equal(await runCli(['validate'], ctx), EXIT.VALIDATION);
    assert.ok(err.some((l) => l.includes('[pl] common:hello') && l.includes('{name}')));
    assert.ok(err.some((l) => l.includes('brak pliku public/locales/de/common.json')));
    assert.match(out.at(-1)!, /1 błędów/);
  });
});

describe('errors', () => {
  it('returns config / network exit codes', async () => {
    const noToken = makeContext(dir, server);
    noToken.ctx.env = {};
    assert.equal(await runCli(['status'], noToken.ctx), EXIT.CONFIG);

    const badToken = makeContext(dir, server);
    badToken.ctx.env = { MINI_TMS_TOKEN: 'mtms_wrong' };
    assert.equal(await runCli(['status'], badToken.ctx), EXIT.NETWORK);
    assert.match(badToken.err[0], /API 401/);

    await writeJson('i18n.config.json', { projectId: 'x' });
    const badConfig = makeContext(dir, server);
    assert.equal(await runCli(['pull'], badConfig.ctx), EXIT.CONFIG);
  });

  it('prints status table', async () => {
    const { ctx, out } = makeContext(dir, server);
    assert.equal(await runCli(['status'], ctx), EXIT.OK);
    assert.ok(out.some((l) => /^pl\s+1\s+1\s+0\s+50%$/.test(l)));
  });
});

describe('mini-tms validate — plurals', () => {
  it('validates ICU plurals per target-language CLDR categories', async () => {
    await writeJson('i18n.config.json', { ...CONFIG, targetLanguages: ['pl'], messageFormat: 'icu' });
    await writeJson('public/locales/en/common.json', { files: '{n, plural, one {# file} other {# files}}' });
    await writeJson('public/locales/pl/common.json', { files: '{n, plural, one {# plik} other {# plików}}' });
    const { ctx, err } = makeContext(dir, server);
    assert.equal(await runCli(['validate'], ctx), EXIT.VALIDATION);
    assert.ok(err.some((l) => l.includes('Brakuje formy "few"')));
    assert.ok(err.some((l) => l.includes('Brakuje formy "many"')));
  });

  it('accepts vue-i18n pipe plurals with matching tokens', async () => {
    await writeJson('i18n.config.json', { ...CONFIG, targetLanguages: ['pl'] });
    await writeJson('public/locales/en/common.json', { apples: 'no apples | one apple | {count} apples' });
    await writeJson('public/locales/pl/common.json', { apples: 'brak jabłek | jedno jabłko | {count} jabłek' });
    const { ctx } = makeContext(dir, server);
    assert.equal(await runCli(['validate'], ctx), EXIT.OK);
  });
});
