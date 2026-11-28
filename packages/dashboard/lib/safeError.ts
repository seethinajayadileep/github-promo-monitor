const SECRET_ASSIGNMENT = /\b(?:password|secret|api[_-]?key|token|authorization)\s*[=:]\s*\S+/gi;
const CONNECTION_URL = /\b(?:postgres|postgresql|mysql|mongodb|redis):\/\/\S+/gi;
const BEARER = /\bbearer\s+[a-z0-9\-._~+/]+=*/gi;

/** Log fields safe to print. Connection strings and assigned secrets are removed. */
export function statsErrorLog(error: unknown): { code: string; message: string } {
  const code = error && typeof error === 'object' && 'code' in error
    ? String((error as { code: unknown }).code)
    : '';
  const raw = error instanceof Error ? error.message : 'unknown';
  const message = raw
    .replace(CONNECTION_URL, '[redacted-url]')
    .replace(BEARER, 'bearer [redacted]')
    .replace(SECRET_ASSIGNMENT, '[redacted]')
    .slice(0, 500);
  return { code: code || 'unknown', message };
}
