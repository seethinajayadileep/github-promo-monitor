const SECRET_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: 'openai-style-key', pattern: /\bsk-[A-Za-z0-9_-]{10,}\b/ },
  { name: 'github-token', pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{10,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
  { name: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{20,}\b/ },
  { name: 'aws-access-key', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'slack-token', pattern: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/ },
  { name: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{5,}\b/ },
  { name: 'bearer-token', pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/i },
  { name: 'env-assignment', pattern: /(?:^|[\r\n;])\s*(?:export\s+)?(?:[A-Z0-9_]*(?:API_KEY|SECRET|TOKEN|PRIVATE_KEY)|PASSWORD)\s*=\s*[^\s'\"]+/i },
  { name: 'pem-block', pattern: /-----BEGIN (?:RSA |EC |OPENSSH |PGP |)?PRIVATE KEY-----/i }
];

export interface SecretRejection {
  rejected: boolean;
  reason?: string;
}

function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

function hasPromoCodeStructure(token: string): boolean {
  if (!/^[A-Z0-9][A-Z0-9_-]{4,31}$/.test(token)) return false;
  if (token.length > 32) return false;
  const hasDigit = /\d/.test(token);
  const hasSeparator = /[-_]/.test(token);
  const looksWordlike = /[AEIOU]/.test(token);
  return hasDigit || hasSeparator || looksWordlike;
}

function hasHighEntropyCredential(text: string): boolean {
  for (const match of text.matchAll(/\b[A-Za-z0-9+/=_-]{25,}\b/g)) {
    const token = match[0];
    if (hasPromoCodeStructure(token)) continue;
    const entropy = shannonEntropy(token);
    if (entropy >= 4.1) return true;
  }
  return false;
}

/**
 * Stage 1 hard rejector. It inspects text only in memory and returns only a
 * reason label, never the matched secret or surrounding snippet.
 */
export function rejectSecrets(text: string): SecretRejection {
  for (const { name, pattern } of SECRET_PATTERNS) {
    if (pattern.test(text)) return { rejected: true, reason: name };
  }
  if (hasHighEntropyCredential(text)) return { rejected: true, reason: 'high-entropy-credential' };
  return { rejected: false };
}

export function containsSecret(text: string): boolean {
  return rejectSecrets(text).rejected;
}
