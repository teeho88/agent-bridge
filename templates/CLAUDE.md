<!-- agent-bridge:start -->

# Claude Efficiency Rules

- Keep responses short unless asked.
- Ask before reading large files.
- Read only relevant files/functions.
- Do not repeat long logs.
- Do not load full project unless explicitly requested.
- Prefer summaries over raw dumps.
- Use `.agent-memory/current-task.md` as current task context.
- Use `.agent-memory/compiled-context.md` before starting work.
- Create a portable handoff after meaningful progress with `agent-bridge handoff create`; read `.handoff/CURRENT.md` when resuming.

<!-- agent-bridge:end -->
