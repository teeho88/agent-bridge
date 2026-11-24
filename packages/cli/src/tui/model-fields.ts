import { providerDefaultCommands, type ProviderCatalog } from "@agent-bridge/adapters";
import type { Field } from "./actions.js";

export interface ModelForm {
  fields: Field[];
  values: Record<string, string>;
  initialProvider?: string;
  catalogProvider?: string;
  catalogModel?: string;
}

export function updateModelFields(form: ModelForm, catalogs: ProviderCatalog[], fallbackProvider = form.initialProvider ?? ""): void {
  const model = form.fields.find((field) => field.key === "model" || field.key === "leaderModel");
  if (!model) return;
  const leader = model.key === "leaderModel";
  const providerKey = leader ? "leaderProvider" : "provider";
  const provider = form.fields.some((field) => field.key === providerKey) ? form.values[providerKey] ?? "" : fallbackProvider;
  const reasoning = form.fields.find((field) => field.key === (leader ? "leaderReasoning" : "reasoningEffort"));
  const commandKey = leader ? "leaderCommand" : "command";
  const catalog = catalogs.find((item) => item.provider === provider);
  const changed = form.catalogProvider !== undefined && form.catalogProvider !== provider;
  if (changed) {
    form.values[model.key] = "";
    if (reasoning) form.values[reasoning.key] = "";
  }
  const commands = providerDefaultCommands();
  if (form.fields.some((field) => field.key === commandKey) && (!form.values[commandKey] || changed && form.values[commandKey] === commands[form.catalogProvider ?? ""])) {
    form.values[commandKey] = catalog?.defaultCommand ?? commands[provider] ?? "";
  }
  const suggest = (field: Field, options: { value: string; label: string }[]): void => {
    field.allowCustom = true;
    field.choices = options.length ? ["", ...new Set(options.map((option) => option.value))] : undefined;
    field.choiceLabels = options.length ? Object.fromEntries([["", "(provider default)"], ...options.map((option) => [option.value, option.label === option.value ? option.value : `${option.value} · ${option.label}`])]) : undefined;
  };
  suggest(model, catalog?.models ?? []);
  const value = form.values[model.key] ?? "";
  const levels = catalog?.models.find((item) => item.value === value)?.reasoning ?? catalog?.reasoning ?? [];
  if (reasoning) {
    if (form.catalogModel !== undefined && form.catalogModel !== value && levels.length && !levels.some((level) => level.value === form.values[reasoning.key])) form.values[reasoning.key] = "";
    suggest(reasoning, levels);
  }
  form.catalogProvider = provider;
  form.catalogModel = value;
}
