/**
 * Pure helpers for ErrorBoundary: classify an error and build the text a user can send when reporting a problem.
 * No React or DOM here, so it is unit-tested with node:test.
 */

/** A lazy chunk that could not be downloaded (offline, or an old build whose hashed files were replaced by a deploy) */
export function isChunkLoadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.name === 'ChunkLoadError' ||
    /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Loading chunk [\w-]+ failed/i.test(error.message)
  );
}

const MAX_STACK_CHARS = 2000;

export interface ErrorReportInput {
  error: unknown;
  componentStack?: string | null;
  /** Where in the app it happened, e.g. "tab:drafts" or "modal:PublishModal" */
  label: string;
  now: Date;
  userAgent: string;
  /** location.pathname only — never the query or hash, which can carry one-time password-link tokens */
  path: string;
}

export function buildErrorReport({ error, componentStack, label, now, userAgent, path }: ErrorReportInput): string {
  const err = error instanceof Error ? error : new Error(String(error));
  const clip = (text: string | null | undefined) => (text ?? '').trim().slice(0, MAX_STACK_CHARS) || '(brak)';
  return [
    'Mini-TMS — zgłoszenie błędu',
    `Kiedy: ${now.toISOString()}`,
    `Gdzie: ${label}`,
    `Strona: ${path}`,
    `Przeglądarka: ${userAgent}`,
    `Błąd: ${err.name}: ${err.message}`,
    '',
    'Stos:',
    clip(err.stack),
    '',
    'Stos komponentów:',
    clip(componentStack),
  ].join('\n');
}
