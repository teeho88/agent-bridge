#!/usr/bin/env node
import { Command } from "commander";
import { registerAgent } from "./commands/agent.js";
import { registerAntigravity } from "./commands/antigravity.js";
import { registerAssignment } from "./commands/assignment.js";
import { registerClaude } from "./commands/claude.js";
import { registerCodex } from "./commands/codex.js";
import { registerContext } from "./commands/context.js";
import { registerCredential } from "./commands/credential.js";
import { registerFile } from "./commands/file.js";
import { registerGit } from "./commands/git.js";
import { registerGraph } from "./commands/graph.js";
import { registerHandoff } from "./commands/handoff.js";
import { registerInit } from "./commands/init.js";
import { registerMemory } from "./commands/memory.js";
import { registerOptimize } from "./commands/optimize.js";
import { registerRepair } from "./commands/repair.js";
import { registerReport } from "./commands/report.js";
import { registerRequest } from "./commands/request.js";
import { registerRun } from "./commands/run.js";
import { registerSession } from "./commands/session.js";
import { registerSubtask } from "./commands/subtask.js";
import { registerTask } from "./commands/task.js";
import { registerUi } from "./commands/ui.js";
import { registerWatch } from "./commands/watch.js";
import { registerOrchestration } from "./commands/workforce.js";
import { installSpawnedRunGuard } from "./spawned-guard.js";

const program = new Command();

program.name("agent-bridge").description("Local memory and handoff sidecar for coding agents").version("0.1.0");

registerInit(program);
registerAgent(program);
registerClaude(program);
registerCodex(program);
registerAntigravity(program);
registerTask(program);
registerSession(program);
registerSubtask(program);
registerAssignment(program);
registerMemory(program);
registerContext(program);
registerCredential(program);
registerHandoff(program);
registerOptimize(program);
registerFile(program);
registerRequest(program);
registerRun(program);
registerGit(program);
registerGraph(program);
registerUi(program);
registerRepair(program);
registerReport(program);
registerWatch(program);
registerOrchestration(program);

installSpawnedRunGuard(program);

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});



