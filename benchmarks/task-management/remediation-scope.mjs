import { basename } from 'node:path';

export const remediationScope = Object.freeze({
  cohort: 'luna-medium',
  profiles: Object.freeze(['codex']),
  deferredProviders: Object.freeze(['agy']),
  tests: Object.freeze([
    'comparison', 'comparison-attempts', 'comparison-evidence', 'comparison-gates',
    'remediation-policy', 'remediation-scope', 'profile-storage', 'identity-pool', 'scope-storage', 'powershell-cwd',
    'agent-evidence', 'provider-observations', 'control-outcome', 'compare-validation', 'compare-run-finalization', 'campaign-build', 'invocation-cleanup', 'diagnostic-plan', 'run-workspace',
  ]),
});

export function validateRemediationTests(paths) {
  if (!paths.length || paths.some(path => /^(agy|antigravity)([.-]|$)/i.test(basename(path)))) {
    throw new Error('Active remediation accepts Luna/shared tests only; agy is deferred');
  }
  return paths;
}

export function completedIntegrationProfiles(report) {
  if (report.passed !== true || !Array.isArray(report.results) || !report.results.length) {
    throw new Error('Successful integration results required');
  }
  const profiles = [...new Set(report.results.map(result => result.profile))];
  if (profiles.some(profile => !['codex', 'antigravity'].includes(profile))) {
    throw new Error('Invalid completed integration profiles');
  }
  return profiles;
}
