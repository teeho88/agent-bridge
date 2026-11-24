import { compactWorkflowSection } from "./managed-section.js";

export function codexManagedSection(options: { hooked?: boolean } = {}): string {
  return `<!-- agent-bridge:start -->

${compactWorkflowSection("codex", options)}

## Runtime Goal Rules
Runtime goal creation is disabled by default. Keep the runtime goal as \`none\`
and do not call \`create_goal\` unless the user explicitly asks to create a goal.
An implementation, change, build, or sustained action alone is not permission
to create a runtime goal. Work Board tasks, sessions and checkpoints remain active.
- If the compiled context contains the task note \`Task intentionally has no runtime goal.\`,
  the Work Board has disabled goal creation for that task. Keep the runtime goal as
  \`none\`, do not call \`create_goal\`, and keep the Work Board task goal empty unless
  the user explicitly asks to create a goal.
Existing runtime goals remain active; do not clear or cancel them. Only when the user explicitly asks to create a goal, read the contract with \`agent-bridge context goal-guide\`. Do not set a token budget unless the user explicitly gives one.


<!-- agent-bridge:end -->`;
}

export function codexGoalContractSection(): string {
  return `- Only when the user explicitly asks to create a goal, use \`create_goal\`.
  Before calling the tool, derive a complete goal contract from the user's
  prompt and the compiled repository context. Pass this exact four-section shape
  as the \`objective\`:
  \`\`\`text
  TASK
  <What the agent should work on>

  GOAL
  <The final state that should exist>

  CONSTRAINTS
  <The rules and limits the work must obey>

  SUCCESS CRITERIA
  <Objective checks that prove completion>
  \`\`\`
  Fill every section with concrete task-specific content. Do not leave template
  questions or placeholders in the created goal. State that no additional
  constraints were identified when the prompt and repository provide none.
  Success criteria must be observable and verifiable, not vague claims such as
  "works correctly". Immediately
  mirror the complete, unabridged runtime goal into the Work Board task and give
  the task a shorter descriptive name:
  \`agent-bridge task update --title "<descriptive task name>" --goal "<full runtime goal>" --agent codex\`.
  The title must describe the work, and must not equal or repeat the goal.
- Leave the runtime goal as \`none\` for questions, explanations, plan-only
  requests, and other response-only work that does not need completion tracking.
  Give that Work Board task a descriptive title while keeping its goal empty:
  \`agent-bridge task update --title "<descriptive task name>" --clear-goal --agent codex\`.
- Do not set a token budget unless the user explicitly gives one.
- Do not create a second goal when the current task already has an unfinished
  runtime goal. Complete it only after the requested outcome is actually achieved.
- Handoffs include \`task.goal\` automatically, so keep it identical to the full
  runtime goal; never shorten the goal for a handoff.`;
}
