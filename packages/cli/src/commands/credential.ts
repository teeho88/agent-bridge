import type { Command } from "commander";
import type { CredentialRefKind } from "@agent-bridge/memory";
import { openStore } from "../workspace.js";

export function registerCredential(program: Command): void {
  const credential = program.command("credential").description("Manage credential references without storing raw secrets");

  credential
    .command("add")
    .argument("<provider>", "provider name")
    .requiredOption("--kind <kind>", "env | command | os-store | manual")
    .requiredOption("--ref <ref>", "environment variable name or secret reference")
    .action((provider: string, options: { kind: string; ref: string }) => {
      const store = openStore();
      try {
        console.log(JSON.stringify(store.createCredentialRef({ provider, kind: parseKind(options.kind), ref: options.ref }), null, 2));
      } finally {
        store.close();
      }
    });

  credential.command("list").option("--provider <provider>", "filter by provider").action((options: { provider?: string }) => {
    const store = openStore();
    try {
      console.log(JSON.stringify(store.listCredentialRefs(options.provider), null, 2));
    } finally {
      store.close();
    }
  });

  credential.command("test").argument("<provider>", "provider name").action((provider: string) => {
    const store = openStore();
    try {
      const refs = store.listCredentialRefs(provider);
      if (!refs.length) throw new Error(`No credential references for provider: ${provider}`);
      for (const ref of refs) {
        if (ref.kind === "env" && !process.env[ref.ref]) throw new Error(`Environment variable is not set: ${ref.ref}`);
      }
      console.log(`Credential references for ${provider} are resolvable.`);
    } finally {
      store.close();
    }
  });
}

function parseKind(value: string): CredentialRefKind {
  const allowed: CredentialRefKind[] = ["env", "command", "os-store", "manual"];
  if (allowed.includes(value as CredentialRefKind)) return value as CredentialRefKind;
  throw new Error(`Invalid credential kind "${value}". Use one of: ${allowed.join(", ")}.`);
}
