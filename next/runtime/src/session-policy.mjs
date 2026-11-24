export const remediationAttemptMs = 60 * 60 * 1000;
export const remediationStopGraceMs = 60 * 1000;
export const maxNativeSessionMs = remediationAttemptMs + remediationStopGraceMs;

export function remediationSessionLimits(attemptMs = remediationAttemptMs, stopGraceMs = remediationStopGraceMs) {
  if (attemptMs !== remediationAttemptMs || stopGraceMs !== remediationStopGraceMs) throw new Error('Remediation requires 60 minute attempts and separate 60 second native grace');
  return { attemptMs, stopGraceMs, nativeSessionMs: attemptMs + stopGraceMs };
}
