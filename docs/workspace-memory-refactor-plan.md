# Workspace Task and Memory Refactor Plan

## Goal

Make Agent Bridge represent all work in one repository reliably: live sessions,
their task state, task-scoped context, and curated shared repository knowledge.

## Principles

- A session writes immutable events; it does not directly guess task state.
- A task's live state is projected from its most recent session events.
- Repository knowledge is curated. Captured findings enter an inbox before they
  become shared memory.
- Existing tasks and memories remain readable during the migration.

## Delivery phases

- [x] **1. Persistence model** — add session-event and memory-candidate tables,
  store APIs, migrations, and focused tests.
- [x] **2. Event ingestion** — have Claude lifecycle hooks record session start,
  prompt, summary, and end events; derive active task state from those events.
- [x] **3. Knowledge promotion** — replace automatic shared-memory capture with a
  reviewable repository-memory inbox and promote/reject actions.
- [x] **4. Workspace API** — expose a repository-centric projection: live tasks,
  sessions, task memories, shared memory, and pending candidates.
- [x] **5. Overview UI** — reorganize around live work, selected-task timeline,
  and repository knowledge/inbox; make active work visually distinct.
- [x] **6. Backfill and validation** — preserve legacy memories, backfill only
  safe derived data, build packages, and cover concurrent-session behaviour.

## Acceptance checks

- Two simultaneous Claude sessions in one repository appear independently.
- Ending one session cannot hide or overwrite the other task.
- A task's state follows lifecycle events instead of stale task rows.
- Task findings remain visible after the response that created them.
- Shared instructions, decisions, and notes are visible as repository memory
  only after promotion from the inbox.

## Rollout note

Existing task and memory rows remain intact. Live state starts being event-driven
on the next hook event from each Claude session; restart or resume currently open
sessions once after upgrading so they emit a fresh `SessionStart`/prompt event.
