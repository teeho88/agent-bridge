# Work-Git Guide

Work-Git is agent-bridge's lightweight coordination layer for multiple agents working in the same repository. It does not replace Git. It records task lanes, file leases, change sets, and agent requests so agents can avoid overwriting each other and humans can review concurrent work.

## Concepts

- Task lane: the working lane for one task. A lane can be `patch` or `worktree` mode and has a status: `active`, `conflict`, `merged`, or `discarded`.
- File lease: a time-limited claim on a repo-relative path for one task. A `write` lease blocks other tasks from reading or writing the same file through Work-Git lease checks. A `read` lease blocks another task from acquiring a write lease.
- Task change: a recorded file diff summary for review. Changes start as `pending` and can be marked `accepted`, `discarded`, or `conflict`.
- Agent request: a dashboard-visible inbox item for approvals, questions, merge requests, and conflict coordination.

## Required Edit Workflow

Before editing a source, config, test, or doc file, acquire a write lease:

```bash
agent-bridge file lease "packages/cli/src/commands/graph.ts" --mode write --agent codex
```

Continue only when the JSON response contains:

```json
{ "acquired": true }
```

Keep the returned `lease.id`. After editing, record the file brief/change marker:

```bash
agent-bridge graph brief-auto "packages/cli/src/commands/graph.ts" --task-edited
```

`brief-auto --task-edited` now verifies that the current task owns an active write lease for every edited path. If the lease is missing or another task holds the path, the command fails and tells the agent which path is blocked.

Release the lease after the edit is recorded:

```bash
agent-bridge file release "lease-id-from-response"
```

For multiple files, acquire one lease per path before editing, then pass all edited files to `brief-auto`:

```bash
agent-bridge file lease "src/a.ts" --mode write --agent codex
agent-bridge file lease "src/b.ts" --mode write --agent codex
agent-bridge graph brief-auto "src/a.ts" "src/b.ts" --task-edited
```

## If A Lease Is Blocked

A blocked lease response has `acquired: false` and includes `blockingLease` with the owning task, agent, path, mode, and expiry.

When blocked:

1. Do not edit the file.
2. Check the dashboard Work-Git panel or run:

```bash
agent-bridge file leases --path "src/session.ts"
```

3. Coordinate with the owning task through handoff or an agent request.
4. Wait for the lease to be released or expire, then retry the lease command.

## Lane Commands

Create or update the lane for the active task:

```bash
agent-bridge task lane --mode patch --base-ref HEAD
```

For an isolated worktree lane, record the worktree path:

```bash
agent-bridge task lane --mode worktree --base-ref main --worktree-path ".agent-memory/tasks/my-task/worktree"
```

List git working tree changes into the task change set:

```bash
agent-bridge task scan
```

Show recorded changes:

```bash
agent-bridge task changes
```

Mark the recorded change set:

```bash
agent-bridge task accept
agent-bridge task discard
agent-bridge task merge
```

These commands currently mark review state. They do not run `git merge`, apply patches, or create worktrees automatically.

## Dashboard

The Work-Git panel shows:

- Selected task lane: mode, base ref, base commit, worktree path, and status.
- Selected changes: recorded changed files and their review status.
- Selected leases: active file leases for the selected task, with release buttons.
- Open work items: all live tasks, active agents, leases, pending requests, and conflicts.

## Guarantees And Limits

Work-Git prevents same-file conflicts when agents follow the lease workflow or when they call APIs that enforce leases. It cannot intercept arbitrary filesystem writes by external tools. The startup instructions and `brief-auto --task-edited` guard make unleased edits visible and fail the required post-edit checkpoint.

For hard isolation, use separate Git worktrees per task and still record the lane and change set in Work-Git.