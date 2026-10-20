# locali

> **Locali CLI** — Developer-first translation synchronization tool. Connects your application codebase with your **Locali** i18n management panel.

[![npm version](https://img.shields.io/npm/v/locali.svg)](https://www.npmjs.com/package/locali)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

Locali CLI is a lightweight, zero-runtime-dependency CLI (similar to Crowdin CLI or Lokalise CLI). It allows you to automatically pull fresh translation files during CI/CD builds or push newly added localization keys from your local development environment directly into the Locali translation panel.

---

## ⚡ Quick Start

### 1. Run directly with `npx` (No installation needed)

Ideal for CI/CD pipelines (GitHub Actions, GitLab CI, Vercel, Docker):

```bash
npx --yes locali pull
```

**Required environment variables:**
* `LOCALI_TOKEN` — Project API token (`locali_...`) with read permissions.
* `LOCALI_API_URL` — (Optional if defined in config) URL of your Locali API server (e.g. `https://translations-api.devwizards.pl`).

### 2. Install as a dev dependency

```bash
pnpm add -D locali
# or
npm install --save-dev locali
# or
yarn add -D locali
```

Add helpful scripts to your `package.json`:

```json
{
  "scripts": {
    "i18n:pull": "locali pull",
    "i18n:push": "locali push",
    "i18n:status": "locali status",
    "i18n:validate": "locali validate"
  }
}
```

---

## ⚙️ Configuration (`locali.config.json`)

Create a `locali.config.json` file in the root of your project:

```json
{
  "projectId": "my-project-slug",
  "sourceLanguage": "en",
  "targetLanguages": ["de", "fr", "es", "pl"],
  "localesDir": "locales",
  "fileStructure": "{localesDir}/{lang}/{namespace}.json",
  "fileFormat": "nested",
  "defaultNamespace": "common",
  "apiBaseUrl": "https://translations-api.devwizards.pl"
}
```

### Configuration Options:

| Property | Type | Description |
| :--- | :--- | :--- |
| `projectId` | `string` | The project slug identifier defined in the Locali panel. |
| `sourceLanguage` | `string` | Base/source language code (e.g., `"en"`, `"pl"`). |
| `targetLanguages` | `string[]` | Array of target language locale codes. |
| `localesDir` | `string` | Base directory containing translation files (e.g., `"locales"` or `"src/locales"`). |
| `fileStructure` | `string` | Path template for locale files: <br>• `{localesDir}/{lang}.json` (one file per language) <br>• `{localesDir}/{lang}/{namespace}.json` (organized by namespace directories) |
| `fileFormat` | `"nested"` \| `"flat"` | `"nested"` for deep objects or `"flat"` for dot-separated keys. Default is `"nested"`. |
| `defaultNamespace` | `string` | Default namespace name when namespaces are used. Default is `"common"`. |
| `apiBaseUrl` | `string` | *(Optional)* Locali API server endpoint (can also be set via `LOCALI_API_URL`). |

> **Note:** Locali also automatically recognizes legacy `i18n.config.json` files.

---

## 🛠️ Command Reference

### `locali pull`

Fetches the latest published translations from the Locali server and writes them to your local translation files.

```bash
# Pull all target languages
locali pull

# Pull only specific languages
locali pull --lang de,fr

# Dry run: preview changes without writing files to disk
locali pull --dry-run

# Specify a custom config file path
locali pull --config custom/i18n.json
```

**Options:**
* `--lang <codes>`: Comma-separated list of language codes to download (e.g. `--lang pl,de`).
* `--dry-run`: Fetches data and reports what files would be modified without writing to disk.
* `--config <path>`: Path to custom configuration file.

---

### `locali push`

Scans local source language files, detects new keys, and uploads them to the Locali server so translators can begin working on them.

```bash
# Scan and push newly added source keys
locali push

# Preview newly detected keys without uploading
locali push --dry-run

# Also update existing source texts if modified locally
locali push --update-source

# Push only a specific namespace
locali push --namespace common
```

**Options:**
* `--dry-run`: Lists new keys that would be pushed without making changes on the server.
* `--update-source`: Updates existing source translations if local text differs from server text.
* `--namespace <name>`: Restricts push to a specific namespace.
* `--config <path>`: Path to custom configuration file.

---

### `locali status`

Compares local translation files against the Locali server database and provides a detailed summary of translation progress, missing keys, and out-of-sync entries.

```bash
locali status
```

**Options:**
* `--config <path>`: Path to custom configuration file.

---

### `locali validate`

Performs static analysis on local translation files:
* Checks for valid JSON syntax.
* Validates token preservation: verifies that variables (`{count}`, `{{name}}`, `%s`), HTML/Markdown tags (`<b>`, `<a>`), and ICU plural placeholders are preserved accurately in target languages without being corrupted.
* Ensures key consistency across languages.

```bash
locali validate
```

---

## 🔐 Environment Variables

| Variable | Description |
| :--- | :--- |
| `LOCALI_TOKEN` | API Token generated in the Locali project settings (`locali_...`). Required for `pull`, `push`, and `status`. |
| `LOCALI_API_URL` | Overrides the `apiBaseUrl` set in `locali.config.json`. |

*(Backward compatibility: `MINI_TMS_TOKEN` and `MINI_TMS_API_URL` are also supported as automatic fallbacks).*

---

## 🚦 Exit Codes

Locali CLI returns standard semantic exit codes, making it straightforward to handle in automated CI/CD scripts:

* `0` — **OK**: Command completed successfully.
* `1` — **Validation / Conflict Error**: Token validation failed, or sync detected unresolvable conflicts.
* `2` — **Configuration Error**: Missing configuration file, invalid JSON schema, or missing credentials.
* `3` — **Network / Auth Error**: Network failure, 401 Unauthorized, or 403 Forbidden.

---

## 🤖 CI/CD Integration (GitHub Actions)

Here is a recommended setup to pull fresh translations during automated builds without checking translation files into git:

```yaml
name: Build and Deploy

on:
  push:
    branches: [main]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 22

      - name: Install dependencies
        run: npm ci

      # Pull latest translations before build
      - name: Pull translations
        env:
          LOCALI_TOKEN: ${{ secrets.LOCALI_TOKEN }}
        run: npx --yes locali pull

      # Build your application (Vite, Next.js, Nuxt, Astro, etc.)
      - name: Build
        run: npm run build
```

---

## 🔄 Backward Compatibility

If your scripts previously used `mini-tms`:
* The binary command `mini-tms` is preserved as an alias for `locali`.
* `MINI_TMS_TOKEN` and `MINI_TMS_API_URL` continue to work as fallbacks.
* `i18n.config.json` is automatically loaded if `locali.config.json` is not found.

---

## 📄 License

MIT © [Patryk Kurzeja](https://github.com/patrykkurzeja91)
