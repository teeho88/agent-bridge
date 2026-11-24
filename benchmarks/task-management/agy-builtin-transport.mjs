import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { containedPath, validateBudget } from './remediation-policy.mjs';
import { agyBuiltinArguments, agyBuiltinBackend, verifyAgyBuiltinProof } from './agy-builtin.mjs';
import { AgyStream } from './agy-stream.mjs';
import { remediationSessionLimits } from '../../next/runtime/src/session-policy.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
export async function runAgyBuiltin({ job, executable, capability, config, proof, promptPath, outputDirectory, budgetPolicy,
  usageSemantics = {}, attemptMs, stopGraceMs }) {
  const limits = remediationSessionLimits(attemptMs, stopGraceMs);
  if (validateBudget(budgetPolicy) !== 'unbounded') throw Error('Builtin agy comparisons require unbounded budget');
  containedPath(executable); containedPath(promptPath); containedPath(outputDirectory);
  const binaryHash = hash(readFileSync(executable));
  if (binaryHash !== capability.binaryHash) throw Error('Builtin binary differs from capability');
  verifyAgyBuiltinProof(proof, config, binaryHash);
  const args = agyBuiltinArguments({ capability, prompt: readFileSync(promptPath, 'utf8') });
  mkdirSync(outputDirectory);
  const eventsPath = join(outputDirectory, 'events.jsonl'); writeFileSync(eventsPath, '', { flag: 'wx' });
  const parser = new AgyStream({ workspace: config.workspace, capability, backend: agyBuiltinBackend, semantics: usageSemantics,
    onEvent: (event, raw, line) => appendFileSync(eventsPath, JSON.stringify({ line, event }) + '\n') });
  writeFileSync(join(outputDirectory, 'request.json'), JSON.stringify({ backend: agyBuiltinBackend, binaryHash, config, argv: args, limits,
    proofHash: hash(JSON.stringify(proof)), budgetPolicy }, null, 2) + '\n', { flag: 'wx' });
  let transport, receipt, poll, timer, error = null, watchdogExpired = false;
  const drain = () => { let bytes; while ((bytes = transport.read()).length) parser.write(bytes); };
  try {
    transport = job.start({ workspace: config.workspace, executable, arguments: args, maxSessionMs: limits.nativeSessionMs });
    let fail;
    const parsingFailed = new Promise(resolve => { fail = resolve; });
    poll = setInterval(() => { try { drain(); } catch (failure) { error = failure.stack; fail(); } }, 25);
    const timeout = new Promise(resolve => { timer = setTimeout(() => { watchdogExpired = true; resolve(); }, limits.attemptMs); });
    await Promise.race([transport.closed.then(value => { receipt = value; }), timeout, parsingFailed]);
  } catch (failure) { error = failure.stack; }
  finally {
    clearInterval(poll); clearTimeout(timer);
    if (transport && !(receipt?.hostCoordinator === true && receipt.appContainer === false && receipt.writersStopped === true && receipt.activeProcesses === 0)) {
      try { receipt = await transport.stop(); } catch (failure) { error ??= failure.stack; }
    }
    if (transport) { try { drain(); } catch (failure) { error ??= failure.stack; } }
  }
  const stderr = receipt?.stderrPath && existsSync(receipt.stderrPath) ? readFileSync(receipt.stderrPath, 'utf8') : '';
  const parsed = parser.finish({ receipt, stderr });
  let configUnchanged = false;
  try { verifyAgyBuiltinProof(proof, config, binaryHash); configUnchanged = true; } catch (failure) { error ??= failure.stack; }
  const result = { ...parsed, backend: agyBuiltinBackend, passed: parsed.passed && parsed.mandatoryUsageComplete && configUnchanged && !error && !watchdogExpired,
    providerInvocations: transport ? 1 : 0, nativeStop: receipt ?? null, configUnchanged, watchdogExpired, error,
    rawProtocol: receipt?.stdoutPath ?? null, rawProtocolHash: receipt?.stdoutPath && existsSync(receipt.stdoutPath) ? hash(readFileSync(receipt.stdoutPath)) : null };
  writeFileSync(join(outputDirectory, 'result.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  return result;
}
