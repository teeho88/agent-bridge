const measured = value => Number.isFinite(value) && value >= 0;
const sum = values => values.length && values.every(measured) ? values.reduce((a, b) => a + b, 0) : null;
const ratio = (s, b) => measured(s) && measured(b) && b > 0 ? s / b : null;

export function distribution(values) {
  const sorted = values.filter(measured).sort((a, b) => a - b);
  const complete = sorted.length === values.length && sorted.length > 0;
  const n = sorted.length;
  return { expected: values.length, observed: n, missing: values.length - n,
    median: complete ? (sorted[Math.floor((n - 1) / 2)] + sorted[Math.floor(n / 2)]) / 2 : null,
    min: complete ? sorted[0] : null, max: complete ? sorted[n - 1] : null,
    p95: complete ? sorted[Math.ceil(0.95 * n) - 1] : null };
}

function outcome(rows, branch, repetition, taskId) {
  const stages = taskId === 'handoff' ? [1, 2] : [1];
  const attempts = rows.filter(row => row.branch === branch && row.repetition === repetition && row.taskId === taskId);
  const final = stages.map(stage => attempts.filter(row => row.stage === stage).at(-1));
  const complete = final.every(row => row?.status === 'finished');
  const quality = complete && final.every(row => row.acceptance?.passed === true && row.review?.verdict === 'pass' && row.integrityPassed === true && !row.failureClass);
  const total = field => complete ? sum(attempts.map(row => row[field])) : null;
  const usage = field => complete ? sum(attempts.map(row => row.usage?.[field])) : null;
  return { complete, quality, attempts: attempts.length,
    firstAttemptPassed: complete && stages.every(stage => {
      const row = attempts.find(row => row.stage === stage);
      return row.acceptance?.passed === true && row.review?.verdict === 'pass' && row.integrityPassed === true && !row.failureClass;
    }),
    totalTokens: complete ? sum(attempts.map(row => sum([row.usage?.inputTokens, row.usage?.outputTokens]))) : null,
    uncachedInputTokens: usage('uncachedInputTokens'), outputTokens: usage('outputTokens'),
    implementationMs: total('implementationMs'), wallMs: total('wallMs'), toolCalls: total('toolCalls') };
}

export function compare(rows) {
  const metrics = ['totalTokens', 'uncachedInputTokens', 'outputTokens', 'implementationMs', 'wallMs', 'toolCalls'];
  const pairs = [1, 2, 3, 4, 5].flatMap(repetition => ['small', 'debug', 'multi', 'handoff'].map(taskId => {
    const B = outcome(rows, 'B', repetition, taskId), S = outcome(rows, 'S', repetition, taskId);
    return { repetition, taskId, B, S, ratios: Object.fromEntries(metrics.map(field => [field, ratio(S[field], B[field])])) };
  }));
  const groups = Object.fromEntries(['independent', 'handoff'].map(group => {
    const selected = pairs.filter(pair => (pair.taskId === 'handoff') === (group === 'handoff'));
    return [group, { expectedPairs: selected.length,
      ratios: Object.fromEntries(metrics.map(field => [field, distribution(selected.map(pair => pair.ratios[field]))])),
      distributions: Object.fromEntries(['B', 'S'].map(branch => [branch, Object.fromEntries(metrics.map(field => [field, distribution(selected.map(pair => pair[branch][field]))]))])),
      totals: Object.fromEntries(['B', 'S'].map(branch => [branch, Object.fromEntries(metrics.map(field => [field, sum(selected.map(pair => pair[branch][field]))]))])),
      regressions: selected.flatMap(pair => metrics.filter(field => pair.ratios[field] > 1).map(field => ({ repetition: pair.repetition, taskId: pair.taskId, metric: field, ratio: pair.ratios[field] }))) }];
  }));
  const quality = pairs.every(pair => pair.B.quality && pair.S.quality);
  const gate = (value, limit) => value === null ? null : value <= limit;
  const thresholds = {
    independentTotalTokens: gate(groups.independent.ratios.totalTokens.median, 0.90),
    independentUncachedInput: gate(groups.independent.ratios.uncachedInputTokens.median, 1.00),
    independentWallTime: gate(groups.independent.ratios.wallMs.median, 1.10),
    independentOutput: gate(groups.independent.ratios.outputTokens.median, 1.10),
    handoffTotalTokens: gate(groups.handoff.ratios.totalTokens.median, 1.00),
  };
  return { expectedInvocations: 50, observedInvocations: rows.length, expectedTaskOutcomesPerBranch: 20,
    qualityPassed: quality, thresholds, releasePassed: quality && Object.values(thresholds).every(value => value === true),
    completion: Object.fromEntries(['B', 'S'].map(branch => [branch, {
      firstAttemptPassRate: pairs.filter(pair => pair[branch].firstAttemptPassed).length / 20,
      retryInclusivePassRate: pairs.filter(pair => pair[branch].quality).length / 20,
    }])),
    groups, pairs, failures: rows.filter(row => row.failureClass).map(row => ({ id: row.id, failureClass: row.failureClass, usage: row.usage ?? null })),
    monetaryCost: null, limitations: ['Five repetitions are a pilot gate, not statistical significance.', 'M is a separate dataset; this report compares B/S only.', 'Missing measurements remain null; incomplete pairs remain in the denominator.'] };
}
