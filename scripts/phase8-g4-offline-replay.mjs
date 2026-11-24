import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync, readdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { validateEvidenceAssessment } from '../benchmarks/task-management/comparison-evidence.mjs';

const root = resolve(import.meta.dirname, '..');
const diagnostic = join(root, 'docs/phase8-2-remediation-20261019/diagnostics/g4-retry-20261022-0abbf0b9');
const attempt = join(diagnostic, 'rounds/d2179a16-3666-4445-bbb1-a50ddb8717c1/e/001');
const out = join(root, 'docs/phase8-2-remediation-20261019/offline', `g4-unblock-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const load = path => JSON.parse(readFileSync(path, 'utf8'));
const save = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' }); };
const relativePaths = [
  'benchmarks/task-management/compare-run.mjs', 'benchmarks/task-management/comparison-attempts.mjs',
  'benchmarks/task-management/powershell-cwd.mjs', 'benchmarks/task-management/comparison-evidence.mjs',
  'benchmarks/task-management/provider-observations.mjs', 'benchmarks/task-management/agent-verify.mjs',
  'benchmarks/task-management/PROTOCOL.md', 'docs/phase8-2-g4-unblock-plan-20261022.md',
];
const originalPaths = [
  'report.md', 'requirements.json', 'terminal-assessment.json', 'source-manifest-diagnosis.json',
  'execution-plan.json', 'round.json',
].map(path => join(diagnostic, path)).concat([
  'tool-calls.json', 'events.jsonl', 'result.json', 'handoff/manifests.json', 'handoff/source-claims.json',
  'handoff/errors.json', 'handoff/CURRENT.md', 'RESULT.md', 'source-after.json',
].map(path => join(attempt, path)));
const manifest = Object.fromEntries([...relativePaths.map(path => join(root, path)), ...originalPaths]
  .filter(existsSync).map(path => [path.slice(root.length + 1).replaceAll('\\', '/'), {
    sha256: sha(readFileSync(path)), bytes: readFileSync(path).length,
  }]));
mkdirSync(out, { recursive: false });
save(join(out, 'manifest.json'), { owner: out.split(/[\\/]/).at(-1), purpose: 'Immutable offline G4 failure fixtures',
  retainedEvidence: [join(out, 'fixtures')], registeredTemporary: [], providerInvocations: 0 });
const calls = load(join(attempt, 'tool-calls.json'));
if (calls.length !== 23 || new Set(calls.map(call => call.id)).size !== 23) throw Error('Expected exactly 23 unique original completed calls');
const raw = readFileSync(join(attempt, 'events.jsonl'), 'utf8').trim().split(/\r?\n/).map(JSON.parse);
const completions = raw.filter(event => event.message?.method === 'item/completed' && event.message.params?.item?.type === 'commandExecution');
const byId = new Map(completions.map(event => [event.message.params.item.id, event]));
const ledger = load(join(attempt, 'handoff/errors.json'));
const role = {
  1: 'failed-direct-help-or-startup', 11: 'failed-direct-readback-and-bootstrap',
  15: 'failed-captured-handoff-preparation', 22: 'failed-direct-verifier-command',
  23: 'outer-success-with-inner-self-verification-failure',
};
const checks = [];
const list = calls.map((call, index) => {
  const number = index + 1, event = byId.get(call.id);
  if (!event || JSON.stringify(event.message.params.item) !== JSON.stringify(call)) throw Error('Raw item mismatch: ' + call.id);
  const text = call.aggregatedOutput ?? '';
  const relatedLedger = ledger.filter(entry => JSON.stringify(entry).includes(call.id));
  const issues = [];
  if (number === 11) issues.push('bootstrap-missing-set-location', 'ledger-references-successful-acceptance-not-this-failure');
  if (number === 15) issues.push('prepare-handoff-failed-before-retry');
  if (number === 22) issues.push('direct-verifier-command-failure-unrecorded');
  if (number === 23) issues.push('self-verifier-failed-inside-exit-zero', 'no-correction-or-new-verification');
  if (number === 1) issues.push('early-direct-command-nonzero-not-in-ledger');
  if (number === 5) issues.push('context-startup-success-misattributed-to-missing-current');
  if (number === 10) issues.push('acceptance-success-misattributed-to-readback-failure');
  if (number === 13) issues.push('inspect-tools-success-misattributed-to-rg-unavailable');
  if (number === 21) issues.push('canonical-published-without-source-claims-or-error-ledger');
  const result = { ordinal: number, id: call.id, exitCode: call.exitCode, rawCompletedAt: event.at,
    envelopeHash: sha(Buffer.from(JSON.stringify(event))), outputSha256: sha(Buffer.from(text)),
    status: role[number] ?? 'completed-without-observed-failure', issues,
    ledgerReferencesThisRawEvent: relatedLedger.map(entry => entry.id),
    correctedInLaterCall: number === 11 ? calls[11].id : number === 15 ? calls[16].id : null };
  checks.push({ id: call.id, failure: call.exitCode !== 0 || number === 23, reviewed: true });
  return result;
});
const rgExecuted = calls.some(call => /(?:^|[;&\s])rg(?:\s|\b)/.test(call.command) && !/\brg-unavailable\b/.test(call.command));
const ledgerIssues = ledger.map(entry => ({ id: entry.id, rawReferenceValid: list.some(call =>
  entry.outputReference?.kind === 'provider-launch-failure' ? entry.outputReference.eventId === call.id :
    entry.outputReference?.commandId && call.ledgerReferencesThisRawEvent.includes(entry.id)),
  defect: entry.id === 'rg-unavailable' && !rgExecuted ? 'No executed rg failure in original trace' :
    entry.id === 'readback-path' ? 'References successful acceptance receipt/output' :
      entry.id === 'missing-current' ? 'References successful context-startup receipt/output' : null }));
const roundRoot = join(diagnostic, 'rounds/d2179a16-3666-4445-bbb1-a50ddb8717c1');
const processScript = `$ErrorActionPreference='Stop'; $round=$env:PHASE8_ORIGINAL_ROUND;
  $hits=@(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($round) } |
    Select-Object ProcessId,ParentProcessId,Name);
  [ordered]@{scanComplete=$true; matchingProcesses=$hits; checkedAt=[DateTimeOffset]::UtcNow.ToString('o')} |
    ConvertTo-Json -Depth 4 -Compress`;
const scan = spawnSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', processScript], {
  cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30000,
  env: { ...process.env, PHASE8_ORIGINAL_ROUND: roundRoot },
});
const osState = scan.status === 0 && !scan.error && !scan.signal ? JSON.parse(scan.stdout.trim()) : null;
save(join(out, 'process-inventory.json'), { command: 'pwsh.exe -NoProfile -NonInteractive -Command <processScript>',
  scanExitCode: scan.status, scanError: scan.error?.message ?? null, stderr: scan.stderr,
  originalRound: roundRoot, osState, leaseEvidence: 'Original terminal assessment; removed workspace cannot provide a fresh lease DB read' });
save(join(out, 'resume-inventory.json'), { createdAt: new Date().toISOString(), originalRound: 'd2179a16-3666-4445-bbb1-a50ddb8717c1',
  frozenFingerprint: 'ccf3f5a9bc506bf2170110b090ceb68dcee9860ee3b70e80b73d897c84ed80e6',
  originalSourceHashes: manifest, originalAttemptStatus: 'infrastructure_failed',
  resourceState: osState?.scanComplete === true && osState.matchingProcesses?.length === 0
    ? 'Fresh OS process scan found no original-round process; historical session/lease cleanup only'
    : 'Fresh process scan incomplete or matching original-round processes remain',
  processInventory: 'process-inventory.json',
  processSessionsLeases: load(join(diagnostic, 'terminal-assessment.json')).cleanup?.sessionRelease ?? null });
save(join(out, 'failure-map.json'), { completedCalls: calls.length, matchedRawCompleted: list.length,
  nonzeroCommands: list.filter(call => call.exitCode !== 0).map(call => call.id),
  exitZeroWithInnerFailure: [calls[22].id], rawToIssues: list, ledgerToRaw: ledgerIssues,
  missingLedger: [calls[0].id, calls[14].id, calls[21].id, calls[22].id],
  lacksCheckpoint: !readdirSync(join(attempt, 'handoff')).some(name => /checkpoint/i.test(name)),
  selfVerifierFailure: /"passed":false/.test(calls[22].aggregatedOutput ?? ''),
  rgFailureExecuted: rgExecuted });

// Reproduce each blocked layer on independent offline copies. Keep original diagnostics untouched.
const runtimeHelpers = ['agent-verify.mjs', 'comparison-evidence.mjs', 'provider-observations.mjs'];
const fixtureBase = join(out, 'fixtures');
function fixture(name) {
  const target = join(fixtureBase, name);
  mkdirSync(join(target, '.bridge-runtime/evidence'), { recursive: true });
  cpSync(join(attempt, 'handoff'), join(target, '.handoff'), { recursive: true });
  cpSync(join(attempt, 'source-after'), join(target, 'src'), { recursive: true });
  cpSync(join(attempt, 'RESULT.md'), join(target, 'RESULT.md'));
  for (const helper of runtimeHelpers) cpSync(join(root, 'benchmarks/task-management', helper), join(target, '.bridge-runtime/evidence', helper));
  return target;
}
function verify(target, revision) {
  const result = spawnSync(process.execPath, ['.bridge-runtime/evidence/agent-verify.mjs', '.handoff/manifests.json', revision],
    { cwd: target, encoding: 'utf8', windowsHide: true });
  const output = JSON.parse((result.stdout ?? '').trim().split(/\r?\n/).at(-1));
  return { exitCode: result.status, ...output };
}
const original = fixture('01-missing-source-claims');
const missing = verify(original, 'missing-claims');
function referenceClaims(target) {
  const current = readFileSync(join(target, '.handoff/CURRENT.md'), 'utf8');
  const evidenceName = current.match(/^Full evidence: (.+)$/m)?.[1];
  if (!evidenceName) throw Error('Missing fixture canonical reference');
  const file = join(target, evidenceName.replace(/^\.handoff\//, '.handoff/'));
  const payload = load(file);
  payload.evidence.push({ command: 'source-claim-authored', result: 'agent source claim artifact',
    cases: 0, artifact: '.handoff/source-claims.json' });
  writeFileSync(file, JSON.stringify(payload, null, 2) + '\n');
}
const invalidManifest = fixture('02-invalid-predecessor');
referenceClaims(invalidManifest);
const badPredecessor = verify(invalidManifest, 'bad-predecessor');
const wrongLedger = fixture('03-incorrect-ledger');
referenceClaims(wrongLedger);
const manifestFile = join(wrongLedger, '.handoff/manifests.json'), manifests = load(manifestFile);
manifests.predecessor = null;
writeFileSync(manifestFile, JSON.stringify(manifests, null, 2) + '\n');
const ledgerFailure = verify(wrongLedger, 'bad-ledger');
const scenarios = [
  { name: 'missing-canonical-source-claims', actual: missing.error, expected: 'Source claims artifact missing' },
  { name: 'predecessor-object-instead-of-null', actual: badPredecessor.error, expected: 'Invalid predecessor status/reason' },
  { name: 'wrong-ledger-reference-or-omission', actual: ledgerFailure.error, expectedPattern: 'Published error history|Successful checkpoint|Raw failure|Provider|agent error|ledger' },
];
const binding = { canonicalHash: manifest[relativePaths[0]]?.sha256, eventsHash: sha(readFileSync(join(attempt, 'events.jsonl'))),
  resultHash: sha(readFileSync(join(attempt, 'RESULT.md'))) };
function hostAssessmentFixture(name, { command, claimedIssue = null, reviewerFailed = true, checkpointBeforeFinal = true, expected }) {
  const commands = command ? [command] : [];
  const assessment = { ...binding, rawTraceReviewed: true, checkpointBeforeFinal, freshAcceptanceReviewed: true,
    rubricPassed: true, commands: commands.map(item => ({ id: item.id, failed: reviewerFailed, reason: 'Complete original output reviewed' })),
    issues: claimedIssue ? [{ id: claimedIssue, rawReference: 'exec-invented-' + claimedIssue,
      command: 'unsupported error claim', output: 'claimed failure', correction: 'uncorroborated',
      resultReference: 'RESULT.md', canonicalReference: '.handoff/CURRENT.md',
      ledgerReference: '.handoff/errors.json', reason: 'no matching raw event', verified: true }] : [] };
  const dir = join(fixtureBase, name); mkdirSync(dir, { recursive: true });
  save(join(dir, 'input.json'), { binding, commands, assessment, expected });
  let actual = null;
  try { validateEvidenceAssessment(assessment, binding, [], commands); }
  catch (error) { actual = error.message; }
  scenarios.push({ name, actual, expected });
}
hostAssessmentFixture('04-missing-direct-syntax-failure', {
  command: calls[14], expected: 'Observed command failure omitted: ' + calls[14].id });
hostAssessmentFixture('05-missing-inner-verifier-failure', {
  command: calls[22], expected: 'Observed command failure omitted: ' + calls[22].id });
hostAssessmentFixture('06-invented-rg-unavailable', {
  command: calls[12], claimedIssue: 'rg-unavailable', reviewerFailed: false,
  expected: 'Issue has no completed raw command: rg-unavailable' });
hostAssessmentFixture('07-missing-prepublish-checkpoint', {
  checkpointBeforeFinal: false, expected: 'Full raw/content review required' });
save(join(out, 'fixture-replay.json'), { scenarios: scenarios.map(s => ({ ...s,
  passed: s.expected ? s.actual === s.expected : new RegExp(s.expectedPattern, 'i').test(s.actual ?? '') })),
  additionalHostReview: { missingSyntaxFailure: true, missingVerifierFailure: true,
    inventedRgFailure: !rgExecuted, missingCheckpoint: true, missingCorrectionRevision: true } });
const passed = scenarios.every(s => s.expected ? s.actual === s.expected : new RegExp(s.expectedPattern, 'i').test(s.actual ?? '')) &&
  osState?.scanComplete === true && osState.matchingProcesses?.length === 0;
save(join(out, 'offline-p0-result.json'), { passed, outputDirectory: out, completedCalls: calls.length,
  replay: scenarios.map(s => ({ name: s.name, actual: s.actual })), originalArtifactsUnmodified: true });
console.log(JSON.stringify({ passed, directory: out, scenarios: scenarios.map(s => ({ name: s.name, actual: s.actual })) }));
if (!passed) process.exitCode = 1;
