import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { AgyStream, agyArguments } from './agy-stream.mjs';
import { containedPath, validateBudget, requireRootConfinement } from './remediation-policy.mjs';
import { remediationSessionLimits } from '../../next/runtime/src/session-policy.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export function verifyAgyAuthentication(proof, { workspace, profileName, binaryHash }) {
  if (proof?.passed !== true || proof.workspace !== resolve(workspace) || proof.profileName !== profileName || proof.binaryHash !== binaryHash)
    throw new Error('Same-identity/workspace/binary agy authentication preflight required');
  const receipt = proof.nativeReceipt;
  if (receipt?.appContainer !== true || receipt.writersStopped !== true || receipt.activeProcesses !== 0 || receipt.exitStatus !== 0)
    throw new Error('Native agy authentication/stop receipt required');
  const output = readFileSync(containedPath(proof.modelListPath));
  if (hash(output) !== proof.modelListHash || !/^gemini-3\.8-flash-high\s+Gemini 3\.8 Flash \(High\)\s*$/m.test(output.toString('utf8')))
    throw new Error('Native authenticated model-list binding mismatch');
}

export async function runAgy({ sandbox, workspace, protectedFiles, executable, promptPath, capability, authProof,
  outputDirectory, usageSemantics = {}, budgetPolicy, attemptMs, stopGraceMs, confinementProof }) {
  const limits = remediationSessionLimits(attemptMs, stopGraceMs);
  if (validateBudget(budgetPolicy) !== 'unbounded') throw new Error('New agy comparisons require unbounded budget');
  requireRootConfinement(confinementProof, { workspace, profileName: sandbox.profileName });
  containedPath(workspace); containedPath(executable); containedPath(promptPath); containedPath(outputDirectory);
  const binaryHash = hash(readFileSync(executable));
  if (binaryHash !== capability.binaryHash) throw new Error('agy binary differs from capability proof');
  verifyAgyAuthentication(authProof, { workspace, profileName: sandbox.profileName, binaryHash });
  const boundary = sandbox.verify({ workspace, protectedFiles, internetClient: true });
  const prompt = readFileSync(promptPath, 'utf8');
  const args = agyArguments({ workspace, prompt, capability, boundary });
  mkdirSync(outputDirectory);
  const eventsPath = join(outputDirectory, 'events.jsonl'); writeFileSync(eventsPath, '', { flag: 'wx' });
  const parser = new AgyStream({ workspace, capability, semantics: usageSemantics,
    onEvent: (event, raw, line) => appendFileSync(eventsPath, JSON.stringify({ line, event }) + '\n') });
  const request = { provider: 'agy', model: capability.resolvedId, effort: 'high', binaryHash, workspace,
    argv: args, promptHash: hash(prompt), budgetPolicy, limits, startedAt: new Date().toISOString() };
  writeFileSync(join(outputDirectory, 'request.json'), JSON.stringify(request, null, 2) + '\n', { flag: 'wx' });
  let transport, timer, poll, receipt = null, error = null, watchdogExpired = false;
  const drain = () => { let bytes; while ((bytes = transport.read()).length) parser.write(bytes); };
  try {
    transport = sandbox.start({ workspace, executable, arguments: args, maxSessionMs: limits.nativeSessionMs, readOnlyExecutable: true });
    let fail;
    const parsingFailed = new Promise(resolve => { fail = resolve; });
    poll = setInterval(() => { try { drain(); } catch (failure) { error = failure.stack; fail(); } }, 25);
    const timeout = new Promise(resolve => { timer = setTimeout(() => { watchdogExpired = true; resolve(); }, limits.attemptMs); });
    await Promise.race([transport.closed.then(value => { receipt = value; }), timeout, parsingFailed]);
  } catch (failure) { error = failure.stack; }
  finally {
    clearInterval(poll); clearTimeout(timer);
    if (transport && (receipt?.writersStopped !== true || receipt.activeProcesses !== 0 || receipt.appContainer !== true)) {
      try { receipt = await transport.stop(); } catch (failure) { error ??= failure.stack; }
    }
    if (transport) { try { drain(); } catch (failure) { error ??= failure.stack; } }
  }
  const stderr = receipt?.stderrPath && existsSync(receipt.stderrPath) ? readFileSync(receipt.stderrPath, 'utf8') : '';
  let parsed = null;
  try { parsed = parser.finish({ receipt, stderr }); } catch (failure) { error ??= failure.stack; }
  const result = { ...parsed, passed: parsed?.passed === true && parsed.mandatoryUsageComplete && !error && !watchdogExpired,
    providerInvocations: transport ? 1 : 0, watchdogExpired, stopReason: watchdogExpired ? 'time-watchdog' : error ? 'infrastructure' : 'provider-exit',
    nativeStop: receipt, rawProtocol: receipt?.stdoutPath ?? null,
    rawProtocolHash: receipt?.stdoutPath && existsSync(receipt.stdoutPath) ? hash(readFileSync(receipt.stdoutPath)) : null,
    eventsHash: hash(readFileSync(eventsPath)), error, finishedAt: new Date().toISOString() };
  writeFileSync(join(outputDirectory, 'result.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  return result;
}
