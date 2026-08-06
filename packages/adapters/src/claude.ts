export function claudeManagedSection(): string {
  return `<!-- agent-bridge:start -->

# Claude Efficiency Rules

- Keep responses short unless asked.
- Ask before reading large files.
- Read only relevant files/functions.
- Do not repeat long logs.
- Do not load full project unless explicitly requested.
- Prefer summaries over raw dumps.
- Use \`.agent-memory/current-task.md\` as current task context.
- Use \`.agent-memory/compiled-context.md\` before starting work.
- Before editing a relevant source/config/test/doc file, run \`agent-bridge file lease "<repo-relative-path>" --mode write --agent claude\`; continue only if the response has \`"acquired": true\`.
- After the edit is recorded with \`brief-auto --task-edited\`, release the lease with \`agent-bridge file release "<lease-id>"\`.
- Work-Git leases are enforced by \`brief-auto --task-edited\`; if another task holds the file, coordinate through handoff/request and do not edit it.
- After reading a relevant source/config/test/doc file, run \`agent-bridge graph brief-auto "<repo-relative-path>"\`.
- After editing a relevant source/config/test/doc file, run \`agent-bridge graph brief-auto "<repo-relative-path>" --task-edited\`.
- You may pass multiple paths to one \`brief-auto\` call. Skip generated/vendor files and unrelated files.
- Update \`.agent-memory/handoff.md\` after meaningful progress.

<!-- agent-bridge:end -->`;
}
