import { compactWorkflowSection } from "./managed-section.js";

export function claudeManagedSection(options: { hooked?: boolean } = {}): string {
  return `<!-- agent-bridge:start -->\n\n${compactWorkflowSection("claude", options).replace("# Agent Bridge Context", "# Claude Efficiency Rules")}\n\n<!-- agent-bridge:end -->`;
}
