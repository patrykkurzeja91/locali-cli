/**
 * Password policy shared by the panel (live feedback) and mirrored in api/lib/auth.php (enforcement).
 * Follows NIST SP 800-63B: length over composition rules, block common / context-specific passwords.
 * See docs/SPEC_USER_ACCOUNTS.md §3.
 */

export const PASSWORD_MIN_LENGTH = 12;
/** bcrypt ignores everything after 72 bytes, so longer inputs are rejected instead of silently truncated */
export const PASSWORD_MAX_BYTES = 72;

/** Lower-case blocklist; keep in sync with MTMS_COMMON_PASSWORDS in api/lib/auth.php */
export const COMMON_PASSWORDS = [
  'password', 'password1', 'password12', 'password123', 'password1234', 'passw0rd', 'p@ssw0rd', 'p@ssword',
  'qwerty', 'qwerty123', 'qwertyuiop', 'qwerty123456', 'asdfghjkl', 'zaq12wsx', '1qaz2wsx', '1q2w3e4r5t',
  '123456', '12345678', '123456789', '1234567890', '123456789012', '111111111111', '000000000000',
  'iloveyou', 'welcome', 'welcome123', 'admin', 'admin123', 'admin12345', 'administrator', 'letmein',
  'haslo', 'haslo123', 'haslo1234', 'haslo12345', 'zaq1@wsx', 'polska', 'polska123', 'kochamcie',
  'mini-tms', 'minitms', 'minitms123', 'translations', 'tlumaczenia', 'editor123', 'changeme', 'changeme123',
];

export interface PasswordContext {
  email?: string;
  name?: string;
}

export interface PasswordCheck {
  ok: boolean;
  /** Human-readable problems (Polish UI) */
  issues: string[];
  /** 0–4, for the strength meter only (not a policy rule) */
  score: number;
}

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

function isTrivialSequence(lower: string): boolean {
  if (/^(.)\1+$/u.test(lower)) return true;
  const sequences = ['abcdefghijklmnopqrstuvwxyz', '01234567890', 'qwertyuiopasdfghjklzxcvbnm'];
  return sequences.some((seq) => seq.includes(lower) || seq.split('').reverse().join('').includes(lower));
}

export function checkPassword(password: string, context: PasswordContext = {}): PasswordCheck {
  const issues: string[] = [];
  const length = Array.from(password).length;
  const lower = password.toLowerCase();

  if (length < PASSWORD_MIN_LENGTH) {
    issues.push(`Hasło musi mieć co najmniej ${PASSWORD_MIN_LENGTH} znaków (obecnie ${length}).`);
  }
  if (utf8Length(password) > PASSWORD_MAX_BYTES) {
    issues.push(`Hasło może mieć maksymalnie ${PASSWORD_MAX_BYTES} bajtów (ok. ${PASSWORD_MAX_BYTES} znaków bez polskich liter).`);
  }
  if (password.trim() !== password) {
    issues.push('Hasło nie może zaczynać się ani kończyć spacją.');
  }
  // Also catches a common word with digits/symbols tacked on, e.g. "password123456" or "qwerty2024!"
  const candidates = [lower, lower.replace(/[^a-z0-9@-]+$/, ''), lower.replace(/[^a-z]+$/, '')];
  if (candidates.some((c) => COMMON_PASSWORDS.includes(c))) {
    issues.push('To hasło znajduje się na liście często używanych haseł.');
  }
  if (length >= 4 && isTrivialSequence(lower)) {
    issues.push('Hasło nie może być powtórzeniem jednego znaku ani prostą sekwencją.');
  }
  if (new Set(Array.from(password)).size < 5 && length > 0) {
    issues.push('Hasło musi zawierać co najmniej 5 różnych znaków.');
  }

  const fragments = [
    ...(context.email ? [context.email.split('@')[0]] : []),
    ...(context.name ? context.name.split(/\s+/) : []),
  ]
    .map((f) => f.toLowerCase())
    .filter((f) => f.length >= 4);
  if (fragments.some((f) => lower.includes(f))) {
    issues.push('Hasło nie może zawierać Twojego imienia, nazwiska ani nazwy użytkownika z adresu e-mail.');
  }

  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
  let score = 0;
  if (length >= PASSWORD_MIN_LENGTH) score++;
  if (length >= 16) score++;
  if (length >= 20 || classes >= 3) score++;
  if (classes >= 3 && length >= 14) score++;
  if (issues.length > 0) score = Math.min(score, 1);

  return { ok: issues.length === 0, issues, score };
}
