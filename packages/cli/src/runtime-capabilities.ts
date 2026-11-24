export const runtimeCapabilities = {
  codex: { beforeWriteNotification: false, verifiedWriteInterception: false, afterTool: true, commandResult: false, stop: true, compactSignal: false, leaseMode: "batch_fallback" },
  claude: { beforeWriteNotification: false, verifiedWriteInterception: false, afterTool: true, commandResult: false, stop: true, compactSignal: false, leaseMode: "batch_fallback" },
  antigravity: { beforeWriteNotification: true, verifiedWriteInterception: false, afterTool: true, commandResult: false, stop: true, compactSignal: false, leaseMode: "batch_fallback" },
} as const;
