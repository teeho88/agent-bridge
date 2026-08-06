type RedactionRule = {
  pattern: RegExp;
  replace: (...args: string[]) => string;
};

const redactionRules: RedactionRule[] = [
  // Private key blocks (PEM). Match first so the inner base64 is not partially
  // caught by other rules.
  {
    pattern: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g,
    replace: () => "[REDACTED_PRIVATE_KEY]"
  },
  // Env/code assignments: KEY=value (optionally quoted). Preserves the key name
  // so output stays "<KEY>=[REDACTED]". Prefixes like AWS_/CLIENT_ are kept.
  {
    pattern:
      /\b([A-Z0-9_]*(?:API_?KEY|ACCESS_?KEY|SECRET_?KEY|CLIENT_SECRET|AUTH_?TOKEN|ACCESS_?TOKEN|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE_?KEY))\s*=\s*["']?[^"'\s]+["']?/gi,
    replace: (_match: string, key: string) => `${key}=[REDACTED]`
  },
  // Authorization: Bearer <token>
  { pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, replace: () => "Bearer [REDACTED]" },
  // AWS access key id
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, replace: () => "[REDACTED_AWS_KEY]" },
  // GitHub tokens (ghp_/gho_/ghu_/ghs_/ghr_)
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, replace: () => "[REDACTED_GITHUB_TOKEN]" },
  // JSON Web Tokens
  { pattern: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, replace: () => "[REDACTED_JWT]" }
];

export function redactSecrets(text: string): string {
  return redactionRules.reduce((current, rule) => current.replace(rule.pattern, rule.replace), text);
}

export const defaultIgnorePaths = [
  ".env",
  ".env.*",
  "*.pem",
  "*.key",
  "id_rsa",
  "id_rsa.pub",
  "secrets.*",
  "credentials.*",
  "node_modules/",
  "dist/",
  "build/",
  ".git/",
  "coverage/",
  ".cache/",
  ".next/",
  ".vite/"
];
