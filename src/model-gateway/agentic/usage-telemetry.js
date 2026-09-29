// Owner-facing model usage, from ONE source of truth: model_attempts.
//
// TOTAL MODEL USAGE = Σ (input_tokens + output_tokens) over every model
// attempt of the job (Office steps and Coding turns), successful AND failed.
// Failed attempts are included because a provider may bill or count them
// against a free quota; they are also shown separately so waste is visible.
//   - cached input tokens are a PART of input tokens (not added again);
//   - reasoning tokens are a PART of output tokens where the provider reports
//     them (not added again);
//   - retries = attempts beyond the first on the same route for the same
//     step (attempt_no > 1);
//   - tool-loop overhead = successful calls beyond the first per task.
// jobs.tokens_used and runs.tokens_in/out are older per-stage counters and
// may differ (they miss failed attempts and some continuation turns); the
// owner sees only this metric.

const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);

export function modelUsage(attempts = []) {
  const usage = {
    totalTokens: 0,
    successful: { calls: 0, inputTokens: 0, outputTokens: 0 },
    failed: { calls: 0, inputTokens: 0, outputTokens: 0 },
    cachedInputTokens: 0, reasoningTokens: 0, retries: 0, toolLoopCalls: 0, costUsd: 0,
  };
  const perTask = new Map();
  for (const row of attempts) {
    const input = num(row.input_tokens ?? row.inputTokens);
    const output = num(row.output_tokens ?? row.outputTokens);
    const ok = row.status === 'succeeded';
    const bucket = ok ? usage.successful : usage.failed;
    bucket.calls += 1;
    bucket.inputTokens += input;
    bucket.outputTokens += output;
    usage.totalTokens += input + output;
    usage.cachedInputTokens += num(row.cached_input_tokens ?? row.cachedInputTokens);
    usage.reasoningTokens += num(row.reasoning_tokens ?? row.reasoningTokens);
    usage.costUsd += num(row.cost_usd ?? row.costUsd);
    if (num(row.attempt_no ?? row.attemptNo) > 1) usage.retries += 1;
    if (ok && row.task_id) perTask.set(row.task_id, (perTask.get(row.task_id) || 0) + 1);
  }
  for (const calls of perTask.values()) usage.toolLoopCalls += Math.max(0, calls - 1);
  usage.costUsd = Number(usage.costUsd.toFixed(6));
  return usage;
}
