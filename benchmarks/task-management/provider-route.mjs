import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

export function validateProxyRoute(route) {
  if (route?.kind !== 'codex-local-proxy-v1' || typeof route.baseUrl !== 'string')
    throw Error('Pinned local Codex proxy route required');
  const url = new URL(route.baseUrl);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      url.username || url.password || url.search || url.hash || url.pathname !== '/v1')
    throw Error('Expected local Codex proxy HTTP /v1 endpoint without credentials');
  return route;
}

export function readHostProxyRoute(configPath) {
  const bytes = readFileSync(configPath);
  const topLevel = [];
  for (const line of bytes.toString('utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) break;
    topLevel.push(line);
  }
  const matches = topLevel.map(line => line.match(/^\s*openai_base_url\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')\s*(?:#.*)?$/))
    .filter(Boolean);
  if (matches.length !== 1) throw Error('Exactly one host openai_base_url proxy setting required');
  const literal = matches[0][1];
  const baseUrl = literal.startsWith('"') ? JSON.parse(literal) : literal.slice(1, -1);
  return validateProxyRoute({ kind: 'codex-local-proxy-v1', baseUrl,
    source: { path: configPath, sha256: createHash('sha256').update(bytes).digest('hex') } });
}

export function proxyConfigArgs(route) {
  return ['-c', 'openai_base_url=' + JSON.stringify(validateProxyRoute(route).baseUrl)];
}

export function proxyRouteAdmission(preflight) {
  try { validateProxyRoute(preflight?.proxyRoute); } catch { return false; }
  return preflight.effectiveConfig?.openai_base_url === preflight.proxyRoute.baseUrl &&
    preflight.proxyHealth?.passed === true && preflight.proxyHealth.nativeStopVerified === true;
}
