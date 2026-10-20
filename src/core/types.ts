export type UserRole = 'admin' | 'editor';

export interface User {
  id: number;
  name: string;
  email: string;
  role: UserRole;
  avatar?: string;
}

/** BCP-47 language code, e.g. "pl", "en", "pt-BR" */
export type LocaleCode = string;

/** needs_review = filled by machine translation (or awaiting approval), not yet confirmed by a person */
export type TranslationStatus = 'untranslated' | 'translated' | 'outdated' | 'needs_review';

export type ChangeOrigin = 'human' | 'machine' | 'import' | 'sync';

export interface TranslationEntry {
  value: string;
  status: TranslationStatus;
  updated_at: string | null;
  /**
   * Outdated targets only (set by the API in Live mode): the source text this translation was last in sync with.
   * `null` = not recorded; `undefined` = not provided (demo mode derives it from the change log).
   */
  source_previous?: string | null;
}

export type FileFormat = 'nested' | 'flat';

/** Plural / placeholder dialect of the consuming app */
export type MessageFormat = 'vue-i18n' | 'icu';

export interface TokenPatternConfig {
  /** Presets: 'icu' | 'i18next' | 'printf' | 'vue-linked', or custom regex strings like "/%[a-z]+%/g" */
  interpolation: string[];
  markdown: boolean;
  html: boolean;
}

/** Mirrors i18n.config.json (see docs/SPEC_SYNC_CLI.md) and the `projects` table */
export interface ProjectConfig {
  projectId: string;
  name: string;
  sourceLanguage: LocaleCode;
  targetLanguages: LocaleCode[];
  localesDir: string;
  fileStructure: string;
  fileFormat: FileFormat;
  defaultNamespace: string;
  messageFormat: MessageFormat;
  tokenPatterns: TokenPatternConfig;
}

export interface KeyItemWithValues {
  id: number;
  key_name: string;
  namespace: string;
  description: string | null;
  is_archived: boolean;
  translations: Record<LocaleCode, TranslationEntry>;
  has_unpublished_changes: boolean;
  updated_at: string;
  updated_by_name: string;
}

export type ActionType = 'create' | 'update' | 'archive';

export interface TranslationChange {
  id: number;
  translation_key_id: number;
  key_name: string;
  locale: LocaleCode;
  action_type: ActionType;
  old_value: string | null;
  new_value: string | null;
  /** Status of the value before this change, used to restore it on discard */
  old_status?: TranslationStatus;
  /** Source-language changes only: targets that were flipped to "outdated" by this change */
  outdated_locales?: LocaleCode[];
  /** Who produced the value (defaults to human) */
  origin?: ChangeOrigin;
  changed_by: number;
  changed_by_name: string;
  created_at: string;
  published_at: string | null;
  publish_batch_id: number | null;
}

export type PublishStatus = 'pending' | 'dispatched' | 'processing' | 'pull_request_created' | 'failed';

export interface PublishBatchFile {
  path: string;
  locale: LocaleCode;
  namespace: string | null;
  sha256: string;
  bytes: number;
  keys_count: number;
}

export interface PublishBatch {
  id: number;
  status: PublishStatus;
  requested_by: number;
  requested_by_name: string;
  requested_at: string;
  completed_at: string | null;
  message: string;
  export_token_hash: string | null;
  manifest_sha256: string | null;
  files: PublishBatchFile[];
  github_dispatch_id: string | null;
  pull_request_url: string | null;
  branch_name: string;
  changes_count: number;
  error_message: string | null;
}

export interface ValidationIssue {
  type: 'error' | 'warning';
  message: string;
}

export interface JwtHeader {
  alg: 'HS256' | 'RS256';
  typ: 'JWT';
}

export interface JwtPayload {
  sub: number; // User ID
  name: string;
  email: string;
  role: UserRole;
  iss: string; // Issuer
  aud: string; // Audience
  iat: number; // Issued at (unix seconds)
  exp: number; // Expires at (unix seconds)
  jti: string; // Token unique identifier
}

export interface AuthSession {
  user: User;
  token: string;
  refreshToken: string;
  payload: JwtPayload;
  expiresAt: string;
}

/** Account as seen by an administrator (api/users.php) — never contains password hashes or tokens */
export interface AdminUser {
  id: number;
  name: string;
  email: string;
  role: UserRole;
  is_active: boolean;
  password_set: boolean;
  invite_pending: boolean;
  last_login_at: string | null;
  created_at: string;
}

/** One-time set / reset password link returned once to the admin who generated it */
export interface PasswordLink {
  user: AdminUser;
  link: string;
  purpose: 'invite' | 'reset';
  expires_at: string;
  mailed: boolean;
}

export interface UserSecurityEvent {
  event: string;
  ip: string | null;
  actor_name: string | null;
  created_at: string;
}
