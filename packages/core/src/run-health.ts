// Telling an environment failure apart from bad work.
//
// A CLI agent whose every shell command is refused by the OS still exits 0 and
// still writes a polite closing summary explaining what it *would* have done.
// Nothing downstream can tell that apart from a lazy implementation: the run
// looks successful, the subtask goes to review, the reviewer correctly says
// the acceptance criteria are unmet, and adjudication spends a rework cycle
// re-issuing work that will fail exactly the same way. Observed live on
// Windows: 22 of 23 codex runs never executed a single command (pwsh resolved
// to an MSIX App Execution Alias, which cannot be launched under codex's
// unelevated sandbox token — CreateProcessAsUserW fails with error 5), and all
// 23 exited 0.
//
// No agent can fix this by trying harder, so it must not be routed through
// review as if it were a code problem.

export type InfraFailure = {
  kind: string;
  // How many times the OS refused. Kept because it is the whole basis for
  // calling this environmental rather than incidental.
  occurrences: number;
  // What to tell the user and the leader.
  detail: string;
  // One verbatim line of evidence, so the report is checkable.
  sample: string;
};

type InfraPattern = { kind: string; pattern: RegExp; detail: string };

// Deliberately narrow: each of these means the process could not be created at
// all. A permission error from inside a running command (a locked file, a
// read-only path) is a normal failure the agent can work around, and must not
// land here.
const INFRA_PATTERNS: InfraPattern[] = [
  {
    kind: "sandbox-spawn-denied",
    pattern: /(?:windows sandbox|CreateProcessAsUserW)[^\n]*?(?:failed|denied)[^\n]*/gi,
    detail:
      "The sandbox could not start a shell process at all (CreateProcessAsUserW was denied). On Windows this is usually pwsh resolving to an MSIX App Execution Alias, which a lowered sandbox token cannot launch — install PowerShell 7 from the MSI so it lives in Program Files, or relax the provider's Windows sandbox setting.",
  },
  {
    kind: "spawn-permission-denied",
    pattern: /\bspawn\b[^\n]*\b(?:EACCES|EPERM)\b[^\n]*|\b(?:EACCES|EPERM)\b[^\n]*\bspawn\b[^\n]*/gi,
    detail: "The OS refused permission to start the agent's shell (EACCES/EPERM).",
  },
  {
    kind: "shell-not-found",
    pattern: /\bspawn\s+\S+\s+ENOENT\b[^\n]*/gi,
    detail: "The shell or executable the agent tried to run does not exist on this machine (ENOENT).",
  },
];

// One refusal can be a fluke — a transient lock, a single odd command. A run
// that hits the same wall repeatedly never got started, which is the case this
// exists to catch.
const INFRA_FAILURE_THRESHOLD = 3;

export function detectInfraFailure(log: string, threshold = INFRA_FAILURE_THRESHOLD): InfraFailure | undefined {
  if (!log) return undefined;
  let worst: InfraFailure | undefined;
  for (const entry of INFRA_PATTERNS) {
    const matches = log.match(entry.pattern);
    if (!matches || matches.length < threshold) continue;
    if (worst && worst.occurrences >= matches.length) continue;
    worst = {
      kind: entry.kind,
      occurrences: matches.length,
      detail: entry.detail,
      sample: matches[0]!.trim().slice(0, 300),
    };
  }
  return worst;
}

// The assignment summary for a run like this. It replaces the log tail, which
// would otherwise be the agent's own apology — text that reads as "the agent
// chose not to do the work" to every later prompt that replays it.
export function describeInfraFailure(failure: InfraFailure): string {
  return [
    `ENVIRONMENT FAILURE — this agent could not execute any command (${failure.occurrences} refusals).`,
    failure.detail,
    `Evidence: ${failure.sample}`,
    "No code was written. Re-running the same agent on the same machine will fail identically; staff a different provider or fix the environment.",
  ].join(" ");
}
