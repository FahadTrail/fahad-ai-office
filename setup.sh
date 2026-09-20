#!/usr/bin/env bash
# ============================================================
#  Fahad AI Office — Runtime installer
#
#  Creates the complete standalone runtime in /opt/fahad-ai-office
#
#  Isolation guarantees:
#    - own directory, own container, own Docker network, own volumes
#    - no ports published, no inbound connections possible
#    - touches nothing else on this server
#
#  Run with:  bash setup.sh
# ============================================================

set -euo pipefail

DIR=/opt/fahad-ai-office

echo ""
echo "Fahad AI Office — installing runtime into $DIR"
echo "------------------------------------------------------------"

mkdir -p "$DIR/src" "$DIR/logs"
cd "$DIR"

# ------------------------------------------------------------
# package.json
# ------------------------------------------------------------
cat > package.json <<'ENDFILE'
{
  "name": "fahad-ai-office-runtime",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "src/index.js",
  "scripts": {
    "start": "node src/index.js",
    "selftest": "node src/selftest.js"
  },
  "engines": { "node": ">=20" },
  "dependencies": {
    "@anthropic-ai/claude-agent-sdk": "^0.3.0",
    "@supabase/supabase-js": "^2.45.0"
  }
}
ENDFILE
echo "  created  package.json"

# ------------------------------------------------------------
# Dockerfile
# ------------------------------------------------------------
cat > Dockerfile <<'ENDFILE'
FROM node:22-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git ripgrep \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src

RUN mkdir -p /app/workspace /app/logs /app/.claude \
 && chown -R node:node /app

USER node
ENV NODE_ENV=production
ENV CLAUDE_CONFIG_DIR=/app/.claude

CMD ["node", "src/index.js"]
ENDFILE
echo "  created  Dockerfile"

# ------------------------------------------------------------
# docker-compose.yml
# ------------------------------------------------------------
cat > docker-compose.yml <<'ENDFILE'
services:
  runtime:
    build: .
    image: fahad-ai-office/runtime:0.1.0
    container_name: fahad-office-runtime
    restart: unless-stopped
    env_file:
      - .env
    networks:
      - fahad-office-net
    volumes:
      - ./logs:/app/logs
      - office-workspace:/app/workspace
      - office-claude-home:/app/.claude
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "5"

networks:
  fahad-office-net:
    name: fahad-office-net
    driver: bridge

volumes:
  office-workspace:
    name: fahad-office-workspace
  office-claude-home:
    name: fahad-office-claude-home
ENDFILE
echo "  created  docker-compose.yml"

printf 'node_modules\nlogs\n.env\n.git\n' > .dockerignore

# ------------------------------------------------------------
# src/db.js
# ------------------------------------------------------------
cat > src/db.js <<'ENDFILE'
// Database layer. Every meaningful thing that happens in the office
// is written to `events` — the single source of truth for the future
// Live Feed and 3D office.

import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  console.error('FATAL: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env');
  process.exit(1);
}

export const db = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});

export function log(...parts) {
  console.log('[' + new Date().toISOString() + ']', ...parts);
}

// Never throws: a logging failure must not kill a job.
export async function emit(event) {
  const row = {
    job_id: event.jobId ?? null,
    task_id: event.taskId ?? null,
    run_id: event.runId ?? null,
    agent_id: event.agentId ?? null,
    from_agent_id: event.fromAgentId ?? null,
    to_agent_id: event.toAgentId ?? null,
    type: event.type,
    level: event.level ?? 'info',
    message: event.message,
    payload: event.payload ?? {},
  };

  const { error } = await db.from('events').insert(row);
  if (error) {
    log('WARN  could not write event:', error.message);
  } else {
    log('event  ' + row.type.padEnd(18) + ' ' + row.message);
  }
}

export async function getAgent(slug) {
  const { data, error } = await db
    .from('agents')
    .select('*')
    .eq('slug', slug)
    .single();

  if (error) throw new Error('Agent "' + slug + '" not found: ' + error.message);
  return data;
}

export async function claimNextJob() {
  const { data, error } = await db.schema('private').rpc('claim_next_job');
  if (error) throw new Error('claim_next_job failed: ' + error.message);
  return data && data.id ? data : null;
}
ENDFILE
echo "  created  src/db.js"

# ------------------------------------------------------------
# src/chief.js
# ------------------------------------------------------------
cat > src/chief.js <<'ENDFILE'
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
ENDFILE
echo "  created  src/chief.js"

# ------------------------------------------------------------
# src/index.js
# ------------------------------------------------------------
cat > src/index.js <<'ENDFILE'
// Office Runtime v1.
// The only always-on process, and deliberately tiny. Holds no AI in
// memory and spends no tokens while idle. Opens no ports.

import { claimNextJob, log } from './db.js';
import { runJob } from './chief.js';

const IDLE_MS = Number(process.env.POLL_INTERVAL_MS || 5000);

let running = true;
let busy = false;

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

function shutdown() {
  if (!running) return;
  running = false;
  log('Shutdown signal received. Finishing current job, then stopping.');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  log('------------------------------------------------------------');
  log('Fahad AI Office - Runtime v1');
  log('Agents online: Chief of Staff');
  log('Model: ' + (process.env.CHIEF_MODEL || 'claude-sonnet-5'));
  log('Idle check every ' + IDLE_MS + 'ms. No ports exposed.');
  log('------------------------------------------------------------');

  while (running) {
    try {
      const job = await claimNextJob();

      if (!job) {
        await sleep(IDLE_MS);
        continue;
      }

      busy = true;
      log('WAKE   job ' + job.id + ' - "' + job.goal.slice(0, 80) + '"');

      await runJob(job);

      busy = false;
      log('SLEEP  office idle, waiting for the next job.');
    } catch (err) {
      busy = false;
      log('RUNTIME ERROR:', err.message || err);
      await sleep(IDLE_MS * 2);
    }
  }

  while (busy) await sleep(500);
  log('Runtime stopped cleanly.');
  process.exit(0);
}

main().catch((err) => {
  log('FATAL:', err);
  process.exit(1);
});
ENDFILE
echo "  created  src/index.js"

# ------------------------------------------------------------
# src/selftest.js
# ------------------------------------------------------------
cat > src/selftest.js <<'ENDFILE'
// Verifies everything the runtime depends on, without creating a job.

import { db, getAgent } from './db.js';
import { query } from '@anthropic-ai/claude-agent-sdk';

let failures = 0;

function pass(name, detail) {
  console.log('  PASS  ' + name + (detail ? ' ' + detail : ''));
}

function fail(name, detail) {
  failures++;
  console.log('  FAIL  ' + name + (detail ? ' ' + detail : ''));
}

console.log('\nFahad AI Office - self test\n');

for (const k of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'ANTHROPIC_API_KEY']) {
  if (process.env[k] && process.env[k].length > 10) pass('env ' + k + ' is set');
  else fail('env ' + k + ' is missing or still a placeholder');
}

try {
  const { error } = await db.from('agents').select('id').limit(1);
  if (error) throw new Error(error.message);
  pass('Supabase connection');
} catch (e) {
  fail('Supabase connection', e.message);
}

try {
  const { data } = await db.from('agents').select('slug');
  pass('agents table', '(' + ((data && data.length) || 0) + ' employees found)');
} catch (e) {
  fail('agents table', e.message);
}

try {
  const chief = await getAgent('chief-of-staff');
  if (chief.system_prompt && chief.system_prompt.length > 100) {
    pass('Chief of Staff loaded', '(' + chief.system_prompt.length + ' chars of instructions)');
  } else {
    fail('Chief of Staff has no system prompt');
  }
} catch (e) {
  fail('Chief of Staff', e.message);
}

try {
  const { error } = await db.schema('private').rpc('claim_next_job');
  if (error) throw new Error(error.message);
  pass('claim_next_job() callable');
} catch (e) {
  fail('claim_next_job()', e.message);
}

try {
  let reply = '';
  const stream = query({
    prompt: 'Reply with exactly the word: READY',
    options: {
      model: process.env.CHIEF_MODEL || 'claude-sonnet-5',
      maxTurns: 1,
      allowedTools: [],
      settingSources: [],
      permissionMode: 'bypassPermissions',
    },
  });
  for await (const m of stream) {
    if (m.type === 'result' && typeof m.result === 'string') reply = m.result;
  }
  if (reply.toUpperCase().includes('READY')) {
    pass('Claude Agent SDK execution', '(replied "' + reply.trim() + '")');
  } else {
    fail('Claude Agent SDK execution', '(unexpected reply: "' + reply + '")');
  }
} catch (e) {
  fail('Claude Agent SDK execution', e.message);
}

console.log(
  failures === 0
    ? '\nAll checks passed. The office is ready.\n'
    : '\n' + failures + ' check(s) failed. Fix these before running a job.\n'
);

process.exit(failures === 0 ? 0 : 1);
ENDFILE
echo "  created  src/selftest.js"

# ------------------------------------------------------------
# .env — only created if missing, so re-running never wipes keys
# ------------------------------------------------------------
if [ -f .env ]; then
  echo "  kept     .env (already exists, your keys are safe)"
else
  cat > .env <<'ENDFILE'
# Supabase project: fahad-ai-office — already correct, do not change
SUPABASE_URL=https://zkzibipinjeswhdxnfgf.supabase.co

# Dashboard > Project Settings > API Keys > service_role
SUPABASE_SERVICE_ROLE_KEY=PASTE_HERE

# console.anthropic.com > Settings > API Keys
ANTHROPIC_API_KEY=PASTE_HERE

CHIEF_MODEL=claude-sonnet-5
CHIEF_MAX_TURNS=6
MAX_ATTEMPTS=2
POLL_INTERVAL_MS=5000
ENDFILE
  echo "  created  .env (needs your two keys)"
fi

chmod 600 .env

echo "------------------------------------------------------------"
echo "Files in place:"
find . -type f -not -path './logs/*' -not -path './node_modules/*' | sort | sed 's/^/  /'
echo ""
echo "NEXT STEP: add your two keys with   nano /opt/fahad-ai-office/.env"
echo ""
