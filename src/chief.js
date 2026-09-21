// Chief of Staff. Wakes only when a job exists. Runs. Saves. Stops.
// Real Claude Agent SDK execution — no mock responses anywhere.

import { query } from '@anthropic-ai/claude-agent-sdk';
import { db, emit, log, getAgent } from './db.js';

const MODEL = process.env.CHIEF_MODEL || 'claude-sonnet-5';
const MAX_TURNS = Number(process.env.CHIEF_MAX_TURNS || 6);
const MAX_ATTEMPTS = Number(process.env.MAX_ATTEMPTS || 2);

function truncate(s, n) {
  if (!s) return '';
  return s.length <= n ? s : s.slice(0, n - 1) + '...';
}

function firstLine(s) {
  return (s || '').split('\n').find((l) => l.trim()) || '';
}

export async function runJob(job) {
  const chief = await getAgent('chief-of-staff');

  await emit({
    jobId: job.id,
    agentId: chief.id,
    type: 'job_created',
    message: 'Fahad submitted a goal: ' + truncate(job.goal, 120),
    payload: { goal: job.goal },
  });

  const { data: task, error: taskErr } = await db
    .from('tasks')
    .insert({
      job_id: job.id,
      agent_id: chief.id,
      title: job.title || 'Handle the goal',
      brief: job.goal,
      status: 'assigned',
      sequence: 1,
      max_attempts: MAX_ATTEMPTS,
    })
    .select()
    .single();

  if (taskErr) throw new Error('Could not create task: ' + taskErr.message);

  await emit({
    jobId: job.id,
    taskId: task.id,
    agentId: chief.id,
    type: 'agent_assigned',
    message: 'Chief of Staff assigned to the job.',
  });

  let lastError = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) {
      await emit({
        jobId: job.id,
        taskId: task.id,
        agentId: chief.id,
        type: 'retry',
        level: 'warning',
        message: 'Retrying (attempt ' + attempt + ' of ' + MAX_ATTEMPTS + ').',
        payload: { previous_error: lastError },
      });
    }

    const { data: run } = await db
      .from('runs')
      .insert({
        task_id: task.id,
        job_id: job.id,
        agent_id: chief.id,
        attempt_no: attempt,
        status: 'running',
        model: MODEL,
      })
      .select()
      .single();

    await db
      .from('tasks')
      .update({
        status: 'running',
        attempts: attempt,
        started_at: new Date().toISOString(),
      })
      .eq('id', task.id);

    await emit({
      jobId: job.id,
      taskId: task.id,
      runId: run.id,
      agentId: chief.id,
      type: 'agent_started',
      message: 'Chief of Staff started work.',
      payload: { model: MODEL, attempt: attempt },
    });

    try {
      const outcome = await askChief(chief, job, {
        onProgress: async (pct, note) => {
          await db.from('tasks').update({ progress: pct }).eq('id', task.id);
          await db.from('jobs').update({ progress: pct }).eq('id', job.id);
          await emit({
            jobId: job.id,
            taskId: task.id,
            runId: run.id,
            agentId: chief.id,
            type: 'progress',
            message: note,
            payload: { progress: pct },
          });
        },
      });

      const { data: result } = await db
        .from('results')
        .insert({
          job_id: job.id,
          task_id: task.id,
          agent_id: chief.id,
          kind: 'final',
          summary: truncate(firstLine(outcome.text), 300),
          content: outcome.text,
          format: 'markdown',
        })
        .select()
        .single();

      await db
        .from('runs')
        .update({
          status: 'succeeded',
          tokens_in: outcome.tokensIn,
          tokens_out: outcome.tokensOut,
          cost_usd: outcome.costUsd,
          ended_at: new Date().toISOString(),
        })
        .eq('id', run.id);

      await db
        .from('tasks')
        .update({
          status: 'done',
          progress: 100,
          completed_at: new Date().toISOString(),
        })
        .eq('id', task.id);

      await emit({
        jobId: job.id,
        taskId: task.id,
        runId: run.id,
        agentId: chief.id,
        type: 'result_produced',
        level: 'success',
        message: 'Chief of Staff produced a result.',
        payload: { result_id: result.id, chars: outcome.text.length },
      });

      await db
        .from('jobs')
        .update({
          status: 'completed',
          progress: 100,
          final_summary: truncate(firstLine(outcome.text), 300),
          tokens_used: outcome.tokensIn + outcome.tokensOut,
          cost_usd: outcome.costUsd,
          completed_at: new Date().toISOString(),
        })
        .eq('id', job.id);

      await emit({
        jobId: job.id,
        agentId: chief.id,
        type: 'job_completed',
        level: 'success',
        message: 'Job completed.',
        payload: {
          cost_usd: outcome.costUsd,
          tokens: outcome.tokensIn + outcome.tokensOut,
        },
      });

      log('DONE   job ' + job.id + '  cost $' + outcome.costUsd.toFixed(4));
      return;
    } catch (err) {
      lastError = err.message || String(err);

      await db
        .from('runs')
        .update({
          status: 'failed',
          error_message: lastError,
          ended_at: new Date().toISOString(),
        })
        .eq('id', run.id);

      await emit({
        jobId: job.id,
        taskId: task.id,
        runId: run.id,
        agentId: chief.id,
        type: 'error',
        level: 'error',
        message: 'Chief of Staff failed: ' + truncate(lastError, 200),
        payload: { attempt: attempt, error: lastError },
      });

      log('ERROR  attempt ' + attempt + ': ' + lastError);
    }
  }

  await db.from('tasks').update({ status: 'failed' }).eq('id', task.id);

  await db
    .from('jobs')
    .update({
      status: 'failed',
      final_summary: 'Failed after ' + MAX_ATTEMPTS + ' attempts: ' + truncate(lastError, 200),
      completed_at: new Date().toISOString(),
    })
    .eq('id', job.id);

  await emit({
    jobId: job.id,
    agentId: chief.id,
    type: 'job_failed',
    level: 'error',
    message: 'Job failed after ' + MAX_ATTEMPTS + ' attempts.',
    payload: { error: lastError },
  });
}

async function askChief(chief, job, hooks) {
  const prompt = [
    'Fahad has given you the following goal. Handle it yourself and answer him directly.',
    '',
    'GOAL: ' + job.goal,
    '',
    'Answer in the language Fahad used. Lead with the answer, not with your process.',
    'If the goal genuinely needs a specialist you do not have yet, say so plainly and',
    'give him the best answer you can right now.',
  ].join('\n');

  let text = '';
  let tokensIn = 0;
  let tokensOut = 0;
  let costUsd = 0;
  let sawResult = false;
  let turn = 0;

  await hooks.onProgress(10, 'Chief of Staff is reading the goal.');

  const stream = query({
    prompt: prompt,
    options: {
      model: MODEL,
      systemPrompt: chief.system_prompt,
      maxTurns: MAX_TURNS,
      allowedTools: [],
      settingSources: [],
      permissionMode: 'bypassPermissions',
    },
  });

  for await (const message of stream) {
    if (message.type === 'assistant') {
      turn++;
      const blocks = (message.message && message.message.content) || [];
      const chunk = blocks
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('');

      if (chunk.trim()) {
        text += (text ? '\n\n' : '') + chunk;
        await hooks.onProgress(
          Math.min(40 + turn * 20, 90),
          'Chief of Staff is working (step ' + turn + ').'
        );
      }
    }

    if (message.type === 'result') {
      sawResult = true;
      if (message.subtype !== 'success' && !text) {
        throw new Error('Claude returned "' + message.subtype + '" with no output.');
      }
      if (typeof message.result === 'string' && message.result.trim()) {
        text = message.result;
      }
      costUsd = message.total_cost_usd || 0;
      tokensIn = (message.usage && message.usage.input_tokens) || 0;
      tokensOut = (message.usage && message.usage.output_tokens) || 0;
    }
  }

  if (!sawResult) throw new Error('Claude stream ended without a result message.');
  if (!text.trim()) throw new Error('Claude returned an empty response.');

  await hooks.onProgress(95, 'Chief of Staff is finalising the answer.');

  return { text: text.trim(), tokensIn: tokensIn, tokensOut: tokensOut, costUsd: costUsd };
}
