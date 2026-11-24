export function controlOutcome({ id, control, status, signal, error, stdout = '', stderr = '' }) {
  const tests = Number(stdout.match(/^# tests (\d+)$/m)?.[1] ?? 0), failures = Number(stdout.match(/^# fail (\d+)$/m)?.[1] ?? 0);
  const infrastructure = Boolean(error || signal || /\b(?:EACCES|EPERM|ENOENT|ERR_MODULE_NOT_FOUND|ERR_ACCESS_DENIED|ETIMEDOUT)\b|permission denied|access is denied/i.test(stdout + '\n' + stderr));
  const complete = tests === 2 && /^1\.\.2$/m.test(stdout) && /^# cancelled 0$/m.test(stdout) && /^# skipped 0$/m.test(stdout);
  const blocks = stdout.split(/(?=^not ok \d+ - )/m).filter(block => /^not ok \d+ - /m.test(block));
  const expectedFailures = blocks.length === failures && blocks.every(block => {
    if (/^\s+code: 'ERR_ASSERTION'$/m.test(block)) return true;
    if (id === 'small') return /^not ok 1 - equal endpoints and ordinary bounds$/m.test(block) && /^\s+error: 'bounds'$/m.test(block) && /^\s+name: 'RangeError'$/m.test(block) && /src[\\/]clamp\.mjs/.test(block);
    if (id === 'handoff-1') return /^not ok 1 - current shipping rule, equality and immutable inputs$/m.test(block) && /^\s+error: 'Not implemented'$/m.test(block) && /src[\\/]shipping\.mjs/.test(block);
    return false;
  });
  const passed = !infrastructure && complete && (control === 'positive' ? status === 0 && failures === 0 :
    control === 'negative' && status === 1 && failures > 0 && expectedFailures);
  return { tests, failures, infrastructure, complete, expectedFailures, passed };
}
