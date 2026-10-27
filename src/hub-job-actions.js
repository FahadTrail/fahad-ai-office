// Owner recovery actions on an Office objective (a job): stop it, or resume it
// after it failed or was stopped. Both are thin, guarded writes over the
// existing durable state; no SQL function or schema change is involved.
//
// Resume keeps everything already delivered. Only the steps that did not
// finish (failed, blocked behind a failure, or skipped by a stop) go back to
// the queue, each with two fresh attempts, and the job returns to `running`.
// The runtime's claim only takes tasks of running jobs, so the tasks are
// requeued first and the job is flipped last with a status guard: a double
// click or two tabs resume once, and a half-finished resume is harmless and
// can simply be repeated.

const RESUMABLE_JOB = new Set(['failed', 'cancelled']);
const OPEN_JOB = ['planning', 'running'];
const UNFINISHED_TASK = ['failed', 'blocked', 'skipped'];
export const RESUME_ATTEMPTS = 2;

function conflict(message, code) {
  return Object.assign(new Error(message), { statusCode: 409, code });
}

async function readJob(db, jobId) {
  const { data, error } = await db.from('jobs').select('id,status,title,project_id').eq('id', jobId).maybeSingle();
  if (error) throw new Error(`Could not load the objective: ${error.message}`);
  if (!data) throw Object.assign(new Error('Objective not found'), { statusCode: 404, code: 'JOB_NOT_FOUND' });
  return data;
}

async function note(db, jobId, message, payload) {
  // The audit row is useful, never required: the state change already happened.
  await db.from('events').insert({ job_id: jobId, type: 'activity', level: 'info', message, payload });
}

export async function resumeObjective(db, jobId, { actor = null, now = () => new Date() } = {}) {
  const job = await readJob(db, jobId);
  if (!RESUMABLE_JOB.has(job.status)) {
    throw conflict(job.status === 'completed' ? 'This objective is already complete. Send a follow-up to CHIEF instead.' : 'This objective is still in progress.', 'JOB_NOT_RESUMABLE');
  }
  const { data: tasks, error } = await db.from('tasks').select('id,status,attempts').eq('job_id', jobId).in('status', UNFINISHED_TASK);
  if (error) throw new Error(`Could not load the objective's steps: ${error.message}`);
  if (!tasks?.length) throw conflict('Nothing is left to resume in this objective. Send a follow-up to CHIEF to continue the work.', 'NOTHING_TO_RESUME');

  for (const task of tasks) {
    const { error: requeueError } = await db.from('tasks').update({
      status: 'queued', max_attempts: Number(task.attempts || 0) + RESUME_ATTEMPTS,
      wait_count: 0, not_before: null, started_at: null, completed_at: null,
    }).eq('id', task.id).eq('status', task.status);
    if (requeueError) throw new Error(`Could not requeue a step: ${requeueError.message}`);
  }
  const { data: resumed, error: jobError } = await db.from('jobs')
    .update({ status: 'running', completed_at: null, final_summary: null })
    .eq('id', jobId).in('status', [...RESUMABLE_JOB]).select('id');
  if (jobError) throw new Error(`Could not resume the objective: ${jobError.message}`);
  if (!resumed?.length) throw conflict('This objective changed while resuming. Refresh and try again.', 'JOB_CHANGED');

  const counts = Object.fromEntries(UNFINISHED_TASK.map((status) => [status, tasks.filter((task) => task.status === status).length]));
  await note(db, jobId, `Fahad resumed the objective: ${tasks.length} unfinished step${tasks.length === 1 ? '' : 's'} requeued; delivered work is kept.`, {
    kind: 'objective_resumed', from: job.status, requeued: tasks.length, ...counts, by: actor, at: now().toISOString(),
  });
  return { resumed: true, requeued: tasks.length };
}

export async function stopObjective(db, jobId, { actor = null, now = () => new Date() } = {}) {
  const job = await readJob(db, jobId);
  if (!OPEN_JOB.includes(job.status)) throw conflict('This objective is not running.', 'JOB_NOT_RUNNING');
  // Queued steps are skipped; a model call already in flight finishes on its
  // own and its result is kept, but nothing new starts.
  const { error: taskError } = await db.from('tasks').update({ status: 'skipped' }).eq('job_id', jobId).in('status', ['queued', 'assigned']);
  if (taskError) throw new Error(`Could not stop the objective's steps: ${taskError.message}`);
  const { data: stopped, error } = await db.from('jobs').update({ status: 'cancelled', completed_at: now().toISOString() })
    .eq('id', jobId).in('status', OPEN_JOB).select('id');
  if (error) throw new Error(`Could not stop the objective: ${error.message}`);
  if (stopped?.length) await note(db, jobId, 'Fahad stopped the objective. Delivered work is kept; it can be resumed.', { kind: 'objective_stopped', by: actor, at: now().toISOString() });
  return { stopped: Boolean(stopped?.length) };
}
