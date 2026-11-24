import { powershellWorkspaceCommand } from './powershell-cwd.mjs';

export const slotIdentity = row => row.slotId ?? row.id;
export const invocationIdentity = (slotId, attempt) => attempt === 1 ? slotId : slotId + '-attempt-' + attempt;
const attemptCap = (maxAttempts, slotId) => typeof maxAttempts === 'number' ? maxAttempts : (maxAttempts?.[slotId] ?? maxAttempts?.default ?? 2);
export function weightedCapTokens(usage, outputTokenWeight = 8) {
  return usage.inputTokens - usage.cachedInputTokens + usage.outputTokens * outputTokenWeight;
}
export function latestAttempt(rows, slotId) {
  return rows.filter(row => slotIdentity(row) === slotId).at(-1);
}

export function validateAttempts(schedule, rows, maxAttempts = 2) {
  const ids = new Set();
  for (const row of rows) {
    if (ids.has(row.id)) throw new Error('Duplicate invocation: ' + row.id);
    ids.add(row.id);
  }
  let previousIndex = 0;
  for (const row of rows) {
    const slot = schedule.find(slot => slot.id === slotIdentity(row));
    if (!slot) throw new Error('Unscheduled invocation: ' + row.id);
    const index = schedule.indexOf(slot);
    if (index < previousIndex || index > previousIndex + 1 || row === rows[0] && index !== 0) throw new Error('Invalid slot launch order');
    previousIndex = index;
    const attempts = rows.filter(item => slotIdentity(item) === slot.id);
    if (attempts.length > attemptCap(maxAttempts, slot.id) || attempts.some((item, index) => (item.attempt ?? 1) !== index + 1 || item.id !== invocationIdentity(slot.id, index + 1))) throw new Error('Invalid attempt order/cap: ' + slot.id);
    if (['branch', 'repetition', 'taskId', 'stage'].some(field => row[field] !== slot[field])) throw new Error('Attempt slot binding differs: ' + row.id);
  }
}

export function nextInvocation(schedule, rows, reviews, maxAttempts = 2, capacityRecovery = null) {
  validateAttempts(schedule, rows, maxAttempts);
  for (const slot of schedule) {
    const previous = latestAttempt(rows, slot.id);
    if (!previous) return { action: 'run', slot, attempt: 1, previous: null, feedback: null };
    const capacityEntry = capacityRecovery?.formalDisconnectRecovery?.entries?.[previous.id];
    if (previous.status === 'terminal_infrastructure_failed' && (capacityEntry?.capacityFailure || capacityEntry?.startupFailure || capacityEntry?.hostInterruptedFailure)) {
      if (previous.attempt + 1 !== capacityEntry.attempt || attemptCap(maxAttempts, slot.id) !== capacityEntry.maxAttempts) throw Error('Capacity continuation cap mismatch');
      const reviewed = reviews.find(row => row.id === previous.id);
      if (!reviewed) return {action: 'review', id: previous.id};
      if (!['blocked', 'rework'].includes(reviewed.verdict)) throw Error('Capacity predecessor must remain blocked');
      const feedback = {...reviewed, verdict: 'rework', hostInfrastructureIssues: true,
        issues: capacityEntry.feedbackIssues ?? reviewed.issues, reason: capacityEntry.feedbackReason,
        recoveryAuthorizationHash: capacityEntry.authorizationHash};
      return {action: 'run', slot, attempt: capacityEntry.attempt, previous, feedback};
    }
    const cancelled = capacityRecovery?.cancelledRecovery;
    if (previous.id === cancelled?.predecessorId && previous.status === 'finished' && previous.turn?.status === 'failed' &&
        previous.attempt === 1 && cancelled.maxAttempts === 2 && attemptCap(maxAttempts, slot.id) === 2) {
      if (rows.some(row => schedule.slice(schedule.indexOf(slot) + 1).some(later => later.id === slotIdentity(row)))) throw Error('Cancelled predecessor has a successor');
      const feedback = reviews.find(row => row.id === previous.id);
      if (!feedback) return { action: 'review', id: previous.id };
      if (!['blocked', 'rework'].includes(feedback.verdict)) throw Error('Cancelled predecessor must retain its blocked review');
      return { action: 'run', slot, attempt: 2, previous, feedback: { ...feedback, verdict: 'rework', reason: cancelled.reason,
        issues: cancelled.issues, hostInfrastructureIssues: true, recoveryAuthorizationHash: cancelled.authorizationHash } };
    }
    const interrupted = capacityRecovery?.interruptedRecovery;
    if (previous.status === 'terminal_infrastructure_failed' && previous.id === interrupted?.predecessorId &&
        previous.attempt === 1 && interrupted.maxAttempts === 2 && attemptCap(maxAttempts, slot.id) === 2) {
      if (rows.some(row => schedule.slice(schedule.indexOf(slot) + 1).some(later => later.id === slotIdentity(row)))) throw Error('Interrupted predecessor has a successor');
      const feedback = reviews.find(row => row.id === previous.id);
      if (!feedback) return { action: 'review', id: previous.id };
      if (!['blocked', 'rework'].includes(feedback.verdict)) throw Error('Interrupted predecessor must retain its blocked review');
      return { action: 'run', slot, attempt: 2, previous, feedback: { ...feedback, verdict: 'rework',
        reason: interrupted.reason, issues: interrupted.issues, hostInfrastructureIssues: true,
        recoveryAuthorizationHash: capacityRecovery.authorizationHash } };
    }
    if (previous.status === 'terminal_infrastructure_failed' && previous.attempt < capacityRecovery?.maxAttempts &&
        capacityRecovery?.predecessorIds?.includes(previous.id) && attemptCap(maxAttempts, slot.id) === capacityRecovery.maxAttempts) {
      if (rows.some(row => schedule.slice(schedule.indexOf(slot) + 1).some(later => later.id === slotIdentity(row)))) throw Error('Capacity predecessor has a successor');
      return { action: 'run', slot, attempt: previous.attempt + 1, previous, feedback: null, capacityRetry: true };
    }
    if (previous.status !== 'finished') throw new Error('Unresolved invocation; no replay: ' + previous.id);
    const feedback = reviews.find(row => row.id === previous.id);
    if (!feedback) return { action: 'review', id: previous.id };
    if (feedback.verdict === 'pass') continue;
    if (feedback.verdict === 'blocked' || (previous.attempt ?? 1) >= attemptCap(maxAttempts, slot.id)) return { action: 'blocked', id: previous.id, reason: feedback.reason };
    if (feedback.verdict !== 'rework') throw new Error('Invalid review verdict');
    const later = schedule.slice(schedule.indexOf(slot) + 1);
    if (rows.some(row => later.some(slot => slot.id === slotIdentity(row)))) throw new Error('Cannot rework predecessor after successor launch');
    return { action: 'run', slot, attempt: (previous.attempt ?? 1) + 1, previous, feedback };
  }
  return { action: 'complete' };
}

export function lifecycleInstruction(taskId = null, capturedSpec = null) {
  if (capturedSpec !== null) {
    if (!/^\.bridge-runtime\/evidence\/lifecycle-[A-Za-z0-9_-]+\.json$/.test(capturedSpec)) throw Error('Invalid read-only lifecycle command spec');
    return `MANDATORY STARTUP: first execute this complete PowerShell command with the absolute workspace as workdir:\n${powershellWorkspaceCommand('node .bridge-runtime/evidence/agent-evidence-command.cjs ' + capturedSpec)}\nThe host prepared this read-only structured spec ${taskId === null ? 'to create exactly one Bridge task and its initial session' : 'to open exactly one fresh session for retained task ' + JSON.stringify(taskId)}. Its pinned startupContext spec automatically executes and captures context startup next, then checks the Task/Session binding. This one command emits two immutable receipt references. Do not call task start, session start or context startup directly, author a second startup spec, or rerun this command after success. Read both emitted receipts and their stdout.path/stderr.path directly and reuse the actual task/session IDs. A signed direct command is not a captured lifecycle/context receipt and cannot pass this diagnostic. If the context child actually fails, preserve both receipts and correct only that failure through a new unique captured context spec; never restart the task/session. Never create an extra session for a first task; do not create a new task for continuation. Retain predecessor source and all original evidence.`;
  }
  return taskId === null
    ? 'First create exactly one Bridge task using task start "Short title" --goal "Current goal" --agent codex; task start already opens one session, so do not also session start. Read and reuse the captured task/session IDs before context startup, leases and checkpoint.'
    : `Continue existing Bridge task ${JSON.stringify(taskId)}: session start --task ${JSON.stringify(taskId)} --agent codex opens exactly one fresh session after the predecessor session is closed. Do not create a new task. Read the actual predecessor Bridge handoff when present and verify the source revision before editing.`;
}

export function sharedLifecycleAgents(original, shared) {
  const marker = '## Protected Workflow';
  if (!original.includes(marker) || !shared.includes(marker) || !shared.includes('task start already opens the initial session')) throw Error('Manual lifecycle section unavailable');
  return shared.slice(0, shared.indexOf(marker)) + original.slice(original.indexOf(marker));
}

export function evidenceInstruction() {
  return [
    'Evidence workflow (identical B/S, first task and rework): complete each step in order. Keep all actual failures, including exit-zero shells with failing child commands. Never manufacture issues, stdout, receipts or PASS.',
    'The mandatory startup command automatically captures task/session start and then context startup --agent codex through its host-prepared hash-pinned startupContext spec. Read both emitted immutable receipts and full stdout/stderr, and reuse their matched Task/Session IDs. Do not separately run context startup after this paired bootstrap succeeds. If a real context failure requires correction, create a new unique captured spec with argv [".bridge-runtime/node_modules/@agent-bridge/cli/dist/index.js","context","startup","--agent","codex"], keep the original failure and do not restart the task/session. A direct uncaptured context startup does not satisfy the workflow audit, even when its signed command exits zero and prints the correct IDs. Retain the context receipt and streams for first-task, handoff and rework invocations.',
    'Use a short publication cycle: implement and test the current request, author the required metadata once, checkpoint, publish, verify, then finish. Before each corrective publication, update the same in-memory payload from the actual ledger and enumerate immutable FAIL reports from disk; include each artifact path exactly once. Do not carry stale counts, verifier predictions or claims from an earlier payload. A later PASS does not erase a FAIL report.',
    'For failure reconciliation inspect the signed envelope.message.params.item of each .handoff/provider-observations/*.json: its exitCode is the completed command exit code. Text printed by a successful reader may contain historical exitCode:1, SyntaxError or FAIL; that data is not a new execution failure. Do not build regex scanners that classify printed JSON as child executions. For genuine outer-zero inner errors, inspect the actual command and its captured child receipt/output. Preserve exact original command/output; keep successful correction receipts separate. After any failed scanner/verifier/readback, include that new failure before publishing again.',
    '1. Every new PowerShell tool call, including direct readback and -NoProfile shells, uses the full preceding PowerShell workspace bootstrap and the absolute native workdir. PowerShell PSDrive state does not persist between calls. Prefer UTF-8 .cjs scripts under .handoff for complex writes/JSON. Check CURRENT existence with Node fs before reading; absent CURRENT is not an error until an actual failed read occurs. If rg was never executed, do not invent an rg-unavailable failure.',
    '2. For a first task run task start exactly once: it already creates the initial session; never also call session start. For handoff stage 2 or reviewed REWORK keep the existing task/workspace and open exactly one fresh session after the predecessor session is closed. For another prompt in an active session reuse its task/session. Read task/session IDs from captured startup stdout; never guess IDs or start again to recover them. Check binding before context startup --agent codex, leases and checkpoint. Read real predecessor source-after and handoff when available. Save the original source-before SHA-256 map for ancestor, the actual before-edit map for this invocation, and the preceding invocation source-after map even if it published no CURRENT. Before rework/continuation edits require actualBefore === predecessorFinal for every src path. First task predecessor must be null.',
    '3. Acquire required leases, edit only src/** and RESULT.md. Capture fresh acceptance and each actual helper command using .handoff/specs/<unique-id>.json {id,executable,argv,timeoutMs:30000} and node .bridge-runtime/evidence/agent-evidence-command.cjs <spec-file>. For Node acceptance use argv ["--test","--experimental-test-isolation=none","<acceptance-file>"]; the Windows capture helper also enforces this compatibility and records the actual argv. It defaults to a 30000ms timeout (maximum 600000ms) and writes a failure receipt on child timeout; the host still verifies native writer stop. Before retrying, inspect the original command directory and choose a NEW spec ID; never reuse or delete a reserved ID, even if command.json is absent. Inspect immutable .handoff/commands/<id>/command.json via direct uncaptured readback: const receipt=JSON.parse(fs.readFileSync(receiptPath,"utf8")); for(const stream of ["stdout","stderr"]) console.log(fs.readFileSync(receipt[stream].path,"utf8"));. stdout/stderr are objects with workspace-relative path and hash; do not concatenate them with a directory. Use a literal PowerShell here-string to write UTF-8 .cjs scripts instead of nested node -e quoting. Record the full actual bytes/output. Never use a successful command receipt as proof of another failure.',
    '4. Author .handoff/manifests.json with {original,before,final,predecessor}; original/before/final are path-to-SHA-256 maps and predecessor is null only on first task, otherwise the real prior invocation source-after map. Author .handoff/source-claims.json as {predecessorStatus:"matched"|"absent",reason:string,files:{"src/path":{originalBefore,predecessorFinal,actualBefore,final}}}. Use predecessorStatus absent only for first task, with predecessorFinal null and a truthful reason. A previous unpublished CURRENT never makes an existing source predecessor absent.',
    '5. Author .handoff/errors.json (array or {issues:[]}), preserving all earlier issues and actual failures from every raw completed call, discovery, syntax, verifier and rejected publish. Each entry needs stable id, actual attempt number, exact command, output or actualOutput (or full artifact-reference), correction, reference, verified verificationStatus and a valid outputReference to its own failure bytes. Empty ledger is valid only if no real errors. Keep actual successful corrections separately. Review raw command completions and signed observations in both directions; never claim a tool missing/unavailable without executed raw proof.',
    '6. Write RESULT.md listing changed files, actual commands/results, decisions with reasons, constraints, error IDs/corrections, limitations, real blocker (or none only if all gates pass) and next step. Embed the identical compact JSON.stringify(source-claims) in RESULT, and summary/done in CURRENT. Checkpoint the actual task before FINAL publish and retain its receipt and full output. If checkpoint fails, record and correct within the same attempt. Never checkpoint after final publication.',
    '7. Build UTF-8 structured handoff payload with JSON.stringify and parse it back before using handoff create --payload-file. Schema: {summary:string,done:[],next:[],risks:[],filesChanged:[],evidence:[{command:string,result:string,cases:nonnegative_integer,artifact:existing_path}],decisions:[{decision,reason}],unresolved:[]}. Include actual canonical artifacts for source-claims.json, errors.json, acceptance receipt/full output, checkpoint receipt/full output, every failed verifier report and each signed failure observation. Acceptance evidence cases=2; metadata evidence cases=0. Keep source hashes and every error ID in CURRENT/full evidence/RESULT.',
    '8. After publish, directly read final CURRENT, full canonical and every referenced artifact. Verify with node .bridge-runtime/evidence/agent-verify.mjs .handoff/manifests.json <new-unique-revision>; preserve immutable .handoff/verifications/<revision>.json with PASS or FAIL. If verifier FAIL, rejected publish or later discovery occurs, record it in errors/RESULT, correct cause, update checkpoint before new final publication if needed, republish and verify using another revision; never overwrite old report. Do not end claiming Blocker:none or completion while latest verification is FAIL. Canonical stores evidence/decisions/unresolved while CURRENT contains summary/done/next/risks/filesChanged.',
    '9. Read back verification report and all bindings, reconcile old/new errors across handoff/rework, and end only after source hashes, claims, ledger, checkpoint, publication, verifier and acceptance are consistent. Review and content verdict remain with host; do not create source answers or content-review PASS from a helper. Unsupported managed-attempt APIs are a limitation, not instructions to retry them.'
  ].join('\n');
}
export function sourceRevisionEvidence(sourceManifest, packet) {
  const portablePacket = packet.replaceAll('\\', '/').toLowerCase();
  const missing = Object.entries(sourceManifest).filter(([path, hash]) => path.startsWith('src/') &&
    (!portablePacket.includes(path.toLowerCase()) || !portablePacket.includes(hash.toLowerCase()))).map(([path]) => path);
  return { passed: missing.length === 0 && Object.keys(sourceManifest).some(path => path.startsWith('src/')), missing };
}
