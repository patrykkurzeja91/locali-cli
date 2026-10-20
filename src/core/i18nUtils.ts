import { ValidationIssue } from './types';

/**
 * Validates names of keys created in the panel (house style):
 * dot-separated camelCase segments, e.g. checkout.promoCode.apply
 */
export function validateKeyName(key: string): { isValid: boolean; message?: string } {
  const trimmed = key.trim();
  if (!trimmed) {
    return { isValid: false, message: 'Klucz nie może być pusty.' };
  }
  const keyRegex = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)*$/;
  if (!keyRegex.test(trimmed)) {
    if (trimmed.includes('..')) {
      return { isValid: false, message: 'Klucz nie może zawierać podwójnych kropek (np. common..save).' };
    }
    if (/(^|\.)[A-Z]/.test(trimmed)) {
      return { isValid: false, message: 'Segment klucza musi zaczynać się małą literą (np. checkout.summary.total, nie checkout.Summary).' };
    }
    if (trimmed.includes(' ') || trimmed.includes('-') || trimmed.includes('_')) {
      return { isValid: false, message: 'Klucz nie powinien zawierać spacji, myślników ani podkreśleń (używaj notacji kropkowej i camelCase, np. checkout.promoCode).' };
    }
    if (/(^|\.)[0-9]/.test(trimmed)) {
      return { isValid: false, message: 'Segment klucza nie może zaczynać się od cyfry.' };
    }
    return { isValid: false, message: 'Niepoprawny format klucza. Oczekiwano notacji kropkowej (np. common.save).' };
  }
  return { isValid: true };
}

/**
 * Permissive rule for keys that come from existing locale files (import, `mini-tms push`):
 * any dot-separated segments of letters, digits, "_" and "-" (snake_case, camelCase, kebab-case).
 * Mirrored by KEY_NAME_SYNC_REGEX in the PHP sync endpoint.
 */
export const KEY_NAME_SYNC_REGEX = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/;

export function isValidSyncKeyName(key: string): boolean {
  return KEY_NAME_SYNC_REGEX.test(key) && key.length <= 255;
}

/**
 * Checks for Vue-i18n risky syntax:
 * - Unescaped @ (like email address) which triggers linked messages in vue-i18n
 * - Unclosed braces {
 * - Pipe symbol | used in pluralization
 */
export function detectVueI18nWarnings(text: string, localeLabel: string): ValidationIssue[] {
  const warnings: ValidationIssue[] = [];
  if (!text) return warnings;

  // Unclosed or unbalanced curly braces
  const openBraces = (text.match(/\{/g) || []).length;
  const closeBraces = (text.match(/\}/g) || []).length;
  if (openBraces !== closeBraces) {
    warnings.push({
      type: 'error',
      message: `[${localeLabel}] Niezrównoważone nawiasy klamrowe { } (${openBraces} otwórz, ${closeBraces} zamknij). Spowoduje to błąd parsera vue-i18n.`,
    });
  }

  // Check for bare '@' symbol (e.g. in emails or handles: kontakt@firma.pl)
  // In vue-i18n, '@' starts a linked message like @:message.foo
  // Emails should ideally use {'@'} or @@
  if (/@/.test(text) && !/@:/.test(text) && !/\{'@'\}/.test(text) && !/@@/.test(text)) {
    warnings.push({
      type: 'warning',
      message: `[${localeLabel}] Tekst zawiera znak '@'. W vue-i18n znak ten służy do linkowania wiadomości. Dla adresu e-mail zalecane jest użycie {'@'} lub @@.`,
    });
  }

  // Check for linked message syntax @:
  if (/@:[a-zA-Z0-9_.]+/.test(text)) {
    warnings.push({
      type: 'warning',
      message: `[${localeLabel}] Wykryto referencję vue-i18n (@:...). Upewnij się, że docelowy klucz istnieje w słowniku.`,
    });
  }

  return warnings;
}

/**
 * Unflattens flat dot-notation keys into nested JSON
 * e.g. { "checkout.summary.total": "Razem" } -> { checkout: { summary: { total: "Razem" } } }
 */
export function unflattenJson(flat: Record<string, string>): Record<string, any> {
  const result: Record<string, any> = {};

  for (const [key, value] of Object.entries(flat)) {
    if (value === undefined || value === null) continue;
    const parts = key.split('.');
    let current = result;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (i === parts.length - 1) {
        current[part] = value;
      } else {
        if (!current[part] || typeof current[part] !== 'object' || Array.isArray(current[part])) {
          current[part] = {};
        }
        current = current[part];
      }
    }
  }

  return result;
}

/**
 * Flattens nested JSON object into dot-notation map
 * e.g. { checkout: { summary: { total: "Razem" } } } -> { "checkout.summary.total": "Razem" }
 */
export function flattenJson(nested: Record<string, unknown>, prefix = ''): Record<string, string> {
  const result: Record<string, string> = {};

  for (const [key, value] of Object.entries(nested)) {
    const newKey = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      Object.assign(result, flattenJson(value as Record<string, unknown>, newKey));
    } else if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      result[newKey] = String(value);
    }
  }

  return result;
}

/**
 * Generates formatted JSON string adhering to PHP json_encode flags:
 * JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT
 */
export function serializeFormattedJson(obj: any): string {
  return JSON.stringify(obj, null, 2) + '\n';
}

/**
 * Calculates SHA-256 hash of a string
 */
export async function calculateSha256(content: string): Promise<string> {
  if (typeof crypto !== 'undefined' && crypto.subtle && typeof TextEncoder !== 'undefined') {
    const encoder = new TextEncoder();
    const data = encoder.encode(content);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  // Fallback simple checksum if crypto.subtle not available
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0;
  }
  return Math.abs(hash).toString(16).padStart(64, '0');
}
