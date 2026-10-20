import { LocaleCode } from './types';

export interface LanguageInfo {
  code: LocaleCode;
  /** Name in Polish (panel UI language) */
  label: string;
  /** Endonym, e.g. "Deutsch" */
  nativeLabel: string;
}

/** Common languages offered in project settings. Any valid BCP-47 code can still be added manually. */
export const LANGUAGE_CATALOG: LanguageInfo[] = [
  { code: 'pl', label: 'Polski', nativeLabel: 'Polski' },
  { code: 'en', label: 'Angielski', nativeLabel: 'English' },
  { code: 'de', label: 'Niemiecki', nativeLabel: 'Deutsch' },
  { code: 'es', label: 'Hiszpański', nativeLabel: 'Español' },
  { code: 'fr', label: 'Francuski', nativeLabel: 'Français' },
  { code: 'it', label: 'Włoski', nativeLabel: 'Italiano' },
  { code: 'pt', label: 'Portugalski', nativeLabel: 'Português' },
  { code: 'pt-BR', label: 'Portugalski (Brazylia)', nativeLabel: 'Português (Brasil)' },
  { code: 'nl', label: 'Niderlandzki', nativeLabel: 'Nederlands' },
  { code: 'cs', label: 'Czeski', nativeLabel: 'Čeština' },
  { code: 'sk', label: 'Słowacki', nativeLabel: 'Slovenčina' },
  { code: 'uk', label: 'Ukraiński', nativeLabel: 'Українська' },
  { code: 'lt', label: 'Litewski', nativeLabel: 'Lietuvių' },
  { code: 'ro', label: 'Rumuński', nativeLabel: 'Română' },
  { code: 'hu', label: 'Węgierski', nativeLabel: 'Magyar' },
  { code: 'sv', label: 'Szwedzki', nativeLabel: 'Svenska' },
  { code: 'nb', label: 'Norweski', nativeLabel: 'Norsk bokmål' },
  { code: 'da', label: 'Duński', nativeLabel: 'Dansk' },
  { code: 'fi', label: 'Fiński', nativeLabel: 'Suomi' },
  { code: 'tr', label: 'Turecki', nativeLabel: 'Türkçe' },
  { code: 'ja', label: 'Japoński', nativeLabel: '日本語' },
  { code: 'zh-Hans', label: 'Chiński (uproszczony)', nativeLabel: '简体中文' },
  { code: 'ar', label: 'Arabski', nativeLabel: 'العربية' },
];

/** BCP-47 subset: language (2-3 letters) + optional script (4) / region (2 letters or 3 digits) */
const LOCALE_CODE_REGEX = /^[a-z]{2,3}(-[A-Z][a-z]{3})?(-([A-Z]{2}|[0-9]{3}))?$/;

export function isValidLocaleCode(code: string): boolean {
  return LOCALE_CODE_REGEX.test(code);
}

export function getLanguageLabel(code: LocaleCode): string {
  return LANGUAGE_CATALOG.find((l) => l.code === code)?.label ?? code.toUpperCase();
}

/** Stable per-language accent colour (dot / badge) — Tailwind classes must be literal for the JIT scanner */
const LANGUAGE_ACCENTS = [
  { dot: 'bg-rose-500', badge: 'bg-rose-50 text-rose-700', bar: 'bg-rose-500' },
  { dot: 'bg-blue-500', badge: 'bg-blue-50 text-blue-700', bar: 'bg-blue-600' },
  { dot: 'bg-amber-500', badge: 'bg-amber-50 text-amber-800', bar: 'bg-amber-500' },
  { dot: 'bg-emerald-500', badge: 'bg-emerald-50 text-emerald-700', bar: 'bg-emerald-600' },
  { dot: 'bg-violet-500', badge: 'bg-violet-50 text-violet-700', bar: 'bg-violet-600' },
  { dot: 'bg-cyan-500', badge: 'bg-cyan-50 text-cyan-700', bar: 'bg-cyan-600' },
  { dot: 'bg-orange-500', badge: 'bg-orange-50 text-orange-700', bar: 'bg-orange-500' },
  { dot: 'bg-fuchsia-500', badge: 'bg-fuchsia-50 text-fuchsia-700', bar: 'bg-fuchsia-600' },
];

export function getLanguageAccent(code: LocaleCode) {
  const catalogIndex = LANGUAGE_CATALOG.findIndex((l) => l.code === code);
  let index = catalogIndex;
  if (index < 0) {
    index = 0;
    for (let i = 0; i < code.length; i++) index = (index * 31 + code.charCodeAt(i)) >>> 0;
  }
  return LANGUAGE_ACCENTS[index % LANGUAGE_ACCENTS.length];
}
