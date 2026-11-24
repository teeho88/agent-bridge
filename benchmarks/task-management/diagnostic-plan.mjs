export function diagnosticSchedules(plan) {
  if (plan?.schemaVersion !== 1 || plan.kind !== 'diagnostic-only' || plan.formalPermitted !== false ||
      plan.includeInFormalMetrics !== false || plan.model !== 'chatgpt-web/gpt-6-sol' || plan.effort !== 'high' ||
      plan.budgetMode !== 'unbounded' || plan.maxAttemptsPerLogicalSlot !== 2 ||
      plan.maximumProviderInvocations !== 16 || !Array.isArray(plan.slots) || plan.slots.length !== 8)
    throw Error('Invalid diagnostic-only schedule or policy');
  const expected = ['B', 'S'].flatMap(branch => [['small', 1], ['handoff', 1], ['handoff', 2], ['debug', 1]]
    .map(([taskId, stage]) => ({ id: `${branch}-0-${taskId}-${stage}`, branch, repetition: 0, taskId, stage })));
  for (const [index, slot] of plan.slots.entries()) {
    if (!slot || Object.entries(expected[index]).some(([key, value]) => slot[key] !== value))
      throw Error('Diagnostic first-task/handoff/rework slot binding or order differs');
  }
  return { smoke: expected, formal: [] };
}

export function requireFormalPermission(manifest) {
  if (manifest.formalPermitted === false || manifest.kind === 'diagnostic-only' || manifest.diagnosticPlan)
    throw Error('Diagnostic datasets cannot execute, audit, review or report formal measurements');
}
