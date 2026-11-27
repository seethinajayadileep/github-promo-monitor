import { describe, expect, it } from 'vitest';
import { formatGitHubError } from '../src/github.js';

describe('formatGitHubError', () => {
  it('includes the HTTP status, message, and first GitHub errors[].message', () => {
    expect(formatGitHubError(422, {
      message: 'Validation Failed',
      errors: [{ message: 'More than five AND / OR / NOT operators were used.' }]
    })).toBe('GitHub request failed: 422 Validation Failed: More than five AND / OR / NOT operators were used.');
  });

  it('falls back to status and message when no error detail is present', () => {
    expect(formatGitHubError(403, { message: 'Requires authentication' })).toBe('GitHub request failed: 403 Requires authentication');
    expect(formatGitHubError(500, undefined)).toBe('GitHub request failed: 500 HTTP 500');
  });
});
