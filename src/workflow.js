import { WORKFLOW_LIMITS, chiefJob, planJob, reviewResearch, validatePlan } from './chief.js';
import { DISPATCHABLE, mentionedEmployees, officeAgent } from './office/agents.js';
import { converseDirect, parseConsultRequest, parseRevisionRequest, performOfficeWork, synthesizeWorkflow } from './office/specialist.js';
import { parseArtifacts, parseSources } from './office/artifacts.js';
import { performSpecialist, specialistFor, SPECIALISTS } from './research.js';
import { EscalationRequired, classifyOfficeData } from './office/pool-runner.js';
import {
  CHIEF_MODEL,
  DEEPSEEK_MODEL,
  MODEL_PROVIDER,
  RESEARCH_MODEL,
  STALE_TASK_MINUTES,
  TASK_MAX_ATTEMPTS,
} from './config.js';
import { ScopedToolBrokerSession } from './tool-broker/session.js';

export const WORKFLOW = 'chief-research-chief';
export const WORKFLOW_VERSION = 1;
export const STAGES = Object.freeze({
  PLAN: 'chief_plan', RESEARCH: 'research', REVIEW: 'chief_review',
  // Multi-agent Office: one task per workstream, the Chief's synthesis, a
  // hand-off to the Coding Agent, and direct conversations with an employee.
  SPECIALIST: 'specialist', SYNTHESIS: 'synthesis', LAUNCH_DEV: 'launch_dev', DIRECT: 'direct',
  // An employee asking a colleague (e.g. FINANCE asking CODING) during a
  // direct conversation, without Fahad relaying anything.
  CONSULT: 'consult',
});
export const SEQUENCES = Object.freeze({ PLAN: 10, RESEARCH: 20, REVIEW: 30, WORKSTREAM: 100, CONSULT: 300, DIRECT_FOLLOWUP: 400, REVISION: 500, SYNTHESIS: 900, SYNTHESIS_FINAL: 950 });
// How long web-sourced knowledge stays trusted before it must be re-checked.
const KNOWLEDGE_DAYS = Object.freeze({ legal: 180, social: 30, research: 90, finance: 60, product: 120 });

export class OfficeWorkflow {
  constructor({
    store,
    plan = planJob,
    research = performSpecialist,
    review = reviewResearch,
    specialist = performOfficeWork,
    synthesize = synthesizeWorkflow,
    direct = converseDirect,
    parallelTasks = 1,
    staleMinutes = STALE_TASK_MINUTES,
    maxAttempts = TASK_MAX_ATTEMPTS,
    recoveryIntervalMs = 60_000,
    now = () => Date.now(),
    workspacePolicyStore = null,
    enforceLegacyWorkspacePolicy = false,
    toolBroker = null,
    modelRunner = null,
    env = process.env,
  }) {
    // modelRunner: the shared Model Pool runner (office/pool-runner.js). When
    // present every stage asks for a job type and the shared router picks the
    // model; without it the legacy Anthropic-first gateway is used.
    this.modelRunner = modelRunner;
    this.env = env;
    this.store = store;
    this.executors = { plan, research, review, specialist, synthesize, direct };
    // Independent workstreams are claimed together and run concurrently.
    this.parallelTasks = Math.max(1, Math.min(6, Number(parallelTasks) || 1));
    this.staleMinutes = staleMinutes;
    this.maxAttempts = maxAttempts;
    this.recoveryIntervalMs = recoveryIntervalMs;
    this.now = now;
    this.lastRecoveryAt = 0;
    this.workspacePolicyStore = workspacePolicyStore;
    this.enforceLegacyWorkspacePolicy = enforceLegacyWorkspacePolicy;
    this.toolBroker = toolBroker;
  }

  async runOnce() {
    let progressed = false;
    if (this.now() - this.lastRecoveryAt >= this.recoveryIntervalMs) {
      const recovered = await this.store.requeueStaleTasks(this.staleMinutes);
      this.lastRecoveryAt = this.now();
      progressed = recovered > 0;
    }

    const job = await this.store.claimNextJob();
    if (job) {
      await this.bootstrap(job);
      progressed = true;
    }

    const claimed = [];
    while (claimed.length < this.parallelTasks) {
      const task = await this.store.claimNextTask();
      if (!task) break;
      claimed.push(task);
    }
    if (!claimed.length) return progressed;
    await Promise.all(claimed.map((task) => this.execute(task)));
    return true;
  }

  async bootstrap(job) {
    // A conversation held directly with one employee skips the Chief.
    const direct = typeof this.store.conversationAgent === 'function' ? officeAgent(await this.store.conversationAgent(job.id).catch(() => null)) : null;
    if (direct && direct.executor === 'office') return this.bootstrapDirect(job, direct);
    await this.store.emit({
      jobId: job.id,
      type: 'job_created',
      message: 'Fahad request accepted by the Step 3C workflow.',
      payload: { workflow: WORKFLOW, workflow_version: WORKFLOW_VERSION, status: 'WORKING' },
    });
    const brief = encodeBrief(STAGES.PLAN, { goal: job.goal });
    const task = await this.store.ensureTask({
      jobId: job.id,
      agentSlug: 'chief-of-staff',
      title: 'Chief planning',
      brief,
      sequence: SEQUENCES.PLAN,
      maxAttempts: this.maxAttempts,
    });
    await this.store.emit({
      jobId: job.id,
      taskId: task.id,
      agentId: task.agent_id,
      type: 'status_changed',
      message: 'Chief of Staff started the job.',
      payload: { status: 'WORKING', stage: 'CHIEF_STARTED' },
    });
  }

  async bootstrapDirect(job, employee) {
    const task = await this.store.ensureTask({
      jobId: job.id, agentSlug: employee.slug, title: `Conversation with ${employee.label}`,
      brief: encodeBrief(STAGES.DIRECT, { agent: employee.key }), sequence: SEQUENCES.PLAN, maxAttempts: this.maxAttempts,
    });
    await this.store.emit({
      jobId: job.id, taskId: task.id, agentId: task.agent_id, type: 'status_changed',
      message: `Fahad is talking directly to ${employee.label}.`,
      payload: { status: 'WORKING', stage: 'DIRECT_CONVERSATION', agent_slug: employee.slug },
    });
  }

  async execute(task) {
    let brief;
    try {
      brief = decodeBrief(task.brief);
      if (brief.stage === STAGES.PLAN) await this.executePlan(task);
      else if (brief.stage === STAGES.RESEARCH) await this.executeResearch(task, brief);
      else if (brief.stage === STAGES.REVIEW) await this.executeReview(task, brief);
      else if (brief.stage === STAGES.SPECIALIST) await this.executeSpecialist(task, brief);
      else if (brief.stage === STAGES.SYNTHESIS) await this.executeSynthesis(task, brief);
      else if (brief.stage === STAGES.LAUNCH_DEV) await this.executeLaunchDev(task, brief);
      else if (brief.stage === STAGES.DIRECT) await this.executeDirect(task, brief);
      else if (brief.stage === STAGES.CONSULT) await this.executeConsult(task, brief);
      else throw new Error('Unsupported workflow stage');
    } catch (error) {
      const safe = safeError(error);
      const failure = await this.store.failTask(task, safe);
      if (failure?.ignored) return { ok: failure.status === 'done', error: safe };
      await this.store.emit({
        jobId: task.job_id,
        taskId: task.task_id,
        runId: task.run_id,
        agentId: task.agent_id,
        type: 'status_changed',
        level: failure?.will_retry ? 'warning' : 'error',
        message: failure?.will_retry ? 'Task is queued for a safe retry.' : 'Task failed after exhausting retries.',
        payload: { status: failure?.will_retry ? 'RETRYING' : 'FAILED', attempt: task.attempt_no },
      });
      return { ok: false, error: safe };
    }
    return { ok: true };
  }

  async executePlan(task) {
    assertAgent(task, 'chief-of-staff');
    const agent = await this.store.getAgent('chief-of-staff');
    const preference = await this.providerPreference(task, STAGES.PLAN);
    const model = preference === 'deepseek' ? DEEPSEEK_MODEL : CHIEF_MODEL;
    const request = officeRequest(task.goal, this.env);
    const job = chiefJob(request.goal);
    if (this.modelRunner) {
      await this.startStage(task, agent, 'CHIEF_PLANNING', `shared-pool:${job}`, `Chief of Staff is planning (job: ${job}; free-first shared Model Pool).`, preference, { job, dataClass: request.dataClass });
    } else {
      await this.startStage(task, agent, 'CHIEF_PLANNING', model, 'Chief of Staff is planning.', preference);
    }
    // Conversation + project context so follow-ups need no re-explaining.
    const context = typeof this.store.jobContext === 'function' ? await this.store.jobContext(task.job_id).catch(() => null) : null;
    const outcome = await this.withHeartbeat(task, (onActivity) => this.executors.plan({
      agent,
      goal: request.goal,
      context: context?.text || '',
      onActivity,
      execution: this.modelExecution(task, STAGES.PLAN, preference, model),
      toolBroker: this.toolSession(task, STAGES.PLAN),
      ...(this.modelRunner ? { run: this.poolRun(task, STAGES.PLAN, { job, request, preference, validate: request.drills.escalate ? escalationDrill(validatePlan) : validatePlan }) } : {}),
    }));

    if (outcome.plan.route === 'answer') return this.finishWithAnswer(task, outcome, outcome.plan.answer, 'Chief answered directly.');
    if (outcome.plan.route === 'development') return this.launchDevelopment(task, outcome, context, request);
    if (outcome.plan.route === 'orchestrate') return this.dispatchWorkflow(task, outcome);

    const specialist = specialistFor(outcome.plan.specialist);
    const researchTask = await this.store.ensureTask({
      jobId: task.job_id,
      agentSlug: this.modelRunner ? specialist.agentSlug : 'research-strategy',
      title: this.modelRunner ? `${specialist.label} (job: ${specialist.job})` : 'Research & Strategy investigation',
      brief: encodeBrief(STAGES.RESEARCH, { researchBrief: outcome.plan.research_brief, ...(this.modelRunner ? { role: outcome.plan.specialist } : {}) }),
      sequence: SEQUENCES.RESEARCH,
      dependsOn: [task.task_id],
      maxAttempts: this.maxAttempts,
    });
    const reviewTask = await this.store.ensureTask({
      jobId: task.job_id,
      agentSlug: 'chief-of-staff',
      title: 'Chief final review',
      brief: encodeBrief(STAGES.REVIEW, { reviewBrief: outcome.plan.review_brief }),
      sequence: SEQUENCES.REVIEW,
      dependsOn: [researchTask.id],
      maxAttempts: this.maxAttempts,
    });

    await this.recordOutcome(task, outcome, 'Chief plan is ready to save.');
    await this.store.emit({
      jobId: task.job_id,
      taskId: task.task_id,
      runId: task.run_id,
      agentId: task.agent_id,
      type: 'plan_created',
      message: 'Chief created the Research delegation and final-review dependency.',
      payload: {
        status: 'COMPLETED',
        research_task_id: researchTask.id,
        review_task_id: reviewTask.id,
      },
    });
    await this.store.completeTask(task, outcome, outcome.plan.plan_summary);
    await this.store.emit({
      jobId: task.job_id,
      taskId: task.task_id,
      runId: task.run_id,
      agentId: task.agent_id,
      type: 'status_changed',
      message: 'Chief is waiting for Research.',
      payload: { status: 'WAITING', stage: 'RESEARCH' },
    });
  }

  // The Chief's own reply completes the request in one step (no specialist).
  async finishWithAnswer(task, outcome, text, message) {
    const answered = { ...outcome, text };
    await this.recordOutcome(task, answered, message);
    await this.store.completeTask(task, answered, String(text).slice(0, 300));
    await this.store.emit({
      jobId: task.job_id, taskId: task.task_id, runId: task.run_id, agentId: task.agent_id,
      type: 'status_changed', message, payload: { status: 'COMPLETED', stage: 'CHIEF_ANSWERED' },
    });
  }

  // "Build/fix/check this": the Chief hands the request to the Coding Agent as
  // a durable task linked to this conversation, then replies with what it did.
  async launchDevelopment(task, outcome, context, request) {
    const plan = outcome.plan;
    const repository = context?.project?.defaultRepository || null;
    if (!repository || typeof this.store.createCodingSession !== 'function') {
      return this.finishWithAnswer(task, outcome, [
        `This needs development work: **${plan.development_title}**.`,
        '',
        'This project has no repository set yet, so I could not start the Coding Agent. Set the project repository in **Projects → Settings** (for example `owner/name`) and send the request again.',
      ].join('\n'), 'Development requested, but the project has no repository.');
    }
    const session = await this.store.createCodingSession({
      workspaceId: context.project.id,
      title: plan.development_title,
      objective: [plan.development_objective, '', `Original request from Fahad: ${request.goal}`].join('\n').slice(0, 40_000),
      repository,
      conversationId: context.conversationId || null,
      createdBy: 'chief-of-staff',
    });
    const text = [
      `I've started a development task: **${plan.development_title}**`,
      '',
      plan.plan_summary,
      '',
      `The Coding Agent is working on \`${repository}\`. You can leave this page — progress appears in **Tasks**, and I'll flag it under **Needs attention** if I need an answer or your approval.`,
    ].join('\n');
    await this.store.emit({
      jobId: task.job_id, taskId: task.task_id, runId: task.run_id, agentId: task.agent_id,
      type: 'activity', message: `Chief launched a Coding Agent task: ${plan.development_title}`,
      payload: { kind: 'task_launched', session_id: session.id, repository },
    });
    return this.finishWithAnswer(task, outcome, text, 'Chief started a Coding Agent task.');
  }

  async executeResearch(task, brief) {
    const role = this.modelRunner && SPECIALISTS[brief.role] ? brief.role : 'research';
    const specialist = specialistFor(role);
    assertAgent(task, specialist.agentSlug);
    const agent = await this.store.getAgent(specialist.agentSlug);
    if (specialist.webTools) assertAuthorizedResearchTools(agent.allowed_tools || []);
    const request = officeRequest(task.goal, this.env);
    if (this.modelRunner) {
      await this.startStage(task, agent, 'RESEARCH_WORKING', `shared-pool:${specialist.job}`, `${specialist.label} is working (job: ${specialist.job}; free-first shared Model Pool).`, MODEL_PROVIDER, { job: specialist.job, dataClass: request.dataClass, role });
    } else {
      await this.startStage(task, agent, 'RESEARCH_WORKING', RESEARCH_MODEL, 'Research & Strategy is working.');
    }
    const outcome = await this.withHeartbeat(task, (onActivity) => this.executors.research({
      agent,
      goal: request.goal,
      brief: brief.researchBrief,
      role,
      onActivity,
      execution: this.modelExecution(task, STAGES.RESEARCH),
      toolBroker: this.toolSession(task, STAGES.RESEARCH),
      ...(this.modelRunner ? { run: this.poolRun(task, STAGES.RESEARCH, { job: specialist.job, request, preference: MODEL_PROVIDER, drillFailover: request.drills.failover }) } : {}),
    }));
    await this.recordOutcome(task, outcome, 'Research result is ready to save.');
    await this.store.completeTask(task, outcome, summarize(outcome.text));
  }

  async executeReview(task, brief) {
    assertAgent(task, 'chief-of-staff');
    const upstream = Array.isArray(task.upstream) ? task.upstream : [];
    const specialistSlugs = new Set(Object.values(SPECIALISTS).map((entry) => entry.agentSlug));
    if (upstream.length !== 1 || !specialistSlugs.has(upstream[0].agent_slug) || !upstream[0].content) {
      throw new Error('Chief review received an invalid Research handoff');
    }
    const agent = await this.store.getAgent('chief-of-staff');
    const preference = await this.providerPreference(task, STAGES.REVIEW);
    const model = preference === 'deepseek' ? DEEPSEEK_MODEL : CHIEF_MODEL;
    const request = officeRequest(task.goal, this.env);
    const job = chiefJob(request.goal, { stage: 'review' });
    if (this.modelRunner) {
      await this.startStage(task, agent, 'CHIEF_REVIEW_STARTED', `shared-pool:${job}`, `Chief is reviewing the specialist result (job: ${job}; free-first shared Model Pool).`, preference, { job, dataClass: request.dataClass });
    } else {
      await this.startStage(task, agent, 'CHIEF_REVIEW_STARTED', model, 'Chief is reviewing Research.', preference);
    }
    const outcome = await this.withHeartbeat(task, (onActivity) => this.executors.review({
      agent,
      goal: request.goal,
      reviewBrief: brief.reviewBrief,
      research: upstream[0],
      onActivity,
      execution: this.modelExecution(task, STAGES.REVIEW, preference, model),
      toolBroker: this.toolSession(task, STAGES.REVIEW),
      ...(this.modelRunner ? { run: this.poolRun(task, STAGES.REVIEW, { job, request, preference }) } : {}),
    }));
    await this.recordOutcome(task, outcome, 'Chief final result is ready to save.');
    await this.store.completeTask(task, outcome, summarize(outcome.text));
  }

  // The Chief's plan becomes durable tasks: one per workstream (dependencies
  // are task dependencies, so independent work runs in parallel and each
  // employee receives the outputs it depends on), then the Chief's synthesis
  // over every output. Idempotent by sequence, so a restart resumes it.
  async dispatchWorkflow(task, outcome) {
    const plan = outcome.plan;
    const created = new Map();
    for (const [index, stream] of plan.workstreams.entries()) {
      const employee = officeAgent(stream.agent);
      const dependsOn = stream.dependsOn.map((id) => created.get(id).id);
      const row = await this.store.ensureTask({
        jobId: task.job_id, agentSlug: employee.slug, title: stream.title,
        brief: encodeBrief(employee.executor === 'coding' ? STAGES.LAUNCH_DEV : STAGES.SPECIALIST, {
          workstream: stream.id, agent: employee.key, title: stream.title, brief: stream.brief,
        }),
        sequence: SEQUENCES.WORKSTREAM + index,
        dependsOn: dependsOn.length ? dependsOn : [task.task_id],
        maxAttempts: this.maxAttempts,
      });
      created.set(stream.id, row);
    }
    const streams = plan.workstreams.map((stream) => ({ id: stream.id, agent: stream.agent, title: stream.title, brief: stream.brief, taskId: created.get(stream.id).id }));
    const synthesis = await this.store.ensureTask({
      jobId: task.job_id, agentSlug: 'chief-of-staff', title: 'Chief synthesis',
      brief: encodeBrief(STAGES.SYNTHESIS, { round: 1, synthesisBrief: plan.synthesis_brief, workstreams: streams }),
      sequence: SEQUENCES.SYNTHESIS, dependsOn: streams.map((stream) => stream.taskId), maxAttempts: this.maxAttempts,
    });
    const planText = workflowPlanMarkdown(plan);
    await this.recordOutcome(task, outcome, 'Chief plan is ready to save.');
    await this.store.emit({
      jobId: task.job_id, taskId: task.task_id, runId: task.run_id, agentId: task.agent_id, type: 'plan_created',
      message: `Chief dispatched ${streams.length} workstream${streams.length === 1 ? '' : 's'}: ${streams.map((stream) => `${officeAgent(stream.agent).label} (${stream.title})`).join(', ')}.`,
      payload: {
        status: 'COMPLETED', kind: 'workflow_planned', synthesis_task_id: synthesis.id,
        workstreams: streams.map((stream) => ({ id: stream.id, agent: stream.agent, title: stream.title, task_id: stream.taskId,
          depends_on: plan.workstreams.find((entry) => entry.id === stream.id).dependsOn })),
      },
    });
    await this.store.completeTask(task, { ...outcome, text: planText }, plan.plan_summary);
  }

  async executeSpecialist(task, brief) {
    const employee = officeAgent(brief.agent);
    if (!employee || employee.executor !== 'office') throw new Error(`Unknown Office employee ${brief.agent}`);
    assertAgent(task, employee.slug);
    const agent = await this.store.getAgent(employee.slug);
    const webTools = employee.webTools && hasWebTools(agent.allowed_tools);
    const request = officeRequest(task.goal, this.env);
    await this.startStage(task, agent, 'SPECIALIST_WORKING', `shared-pool:${employee.job}`, `${employee.label} is working on: ${brief.title}${brief.revision ? ' (revision)' : ''}.`, MODEL_PROVIDER,
      { job: employee.job, dataClass: request.dataClass, role: employee.key });
    const context = typeof this.store.jobContext === 'function' ? await this.store.jobContext(task.job_id).catch(() => null) : null;
    const upstream = (Array.isArray(task.upstream) ? task.upstream : []).filter((entry) => entry.content);
    const previous = brief.revision ? upstream.find((entry) => entry.task_id === brief.revisesTaskId)?.content : null;
    const knowledge = await this.knowledgeFor(context, employee);
    const outcome = await this.withHeartbeat(task, (onActivity) => this.executors.specialist({
      agent, role: employee.key, goal: request.goal, brief: brief.brief, title: brief.title,
      upstream: brief.revision ? upstream.filter((entry) => entry.task_id !== brief.revisesTaskId) : upstream,
      context: context?.project ? projectLine(context) : '', knowledge, revision: brief.revision || null, previous, webTools, onActivity,
      execution: this.modelExecution(task, STAGES.SPECIALIST),
      toolBroker: this.toolSession(task, STAGES.SPECIALIST),
      ...(this.modelRunner ? { run: this.poolRun(task, STAGES.SPECIALIST, { job: employee.job, request, preference: MODEL_PROVIDER }) } : {}),
    }));
    const parsed = parseOutputSummary(outcome.text);
    await this.recordOutcome(task, outcome, `${employee.label} finished: ${brief.title}.`);
    const stored = await this.persistOutputs(task, employee, outcome.text, context);
    await this.store.emit({
      jobId: task.job_id, taskId: task.task_id, runId: task.run_id, agentId: task.agent_id, type: 'activity',
      message: `${employee.label} delivered: ${brief.title}.`,
      payload: { kind: 'output_ready', agent: employee.key, workstream: brief.workstream, deliverable: brief.title,
        summary: parsed.summary.slice(0, 600), has_decisions: Boolean(parsed.decisions), revision: Boolean(brief.revision),
        artifacts: stored.artifacts, sources: stored.sources },
    });
    await this.store.completeTask(task, outcome, parsed.summary.slice(0, 300) || summarize(outcome.text));
  }

  async executeSynthesis(task, brief) {
    assertAgent(task, 'chief-of-staff');
    const agent = await this.store.getAgent('chief-of-staff');
    const request = officeRequest(task.goal, this.env);
    const job = chiefJob(request.goal, { stage: 'review' });
    await this.startStage(task, agent, 'CHIEF_SYNTHESIS', this.modelRunner ? `shared-pool:${job}` : CHIEF_MODEL, 'Chief is reviewing the employees’ work and consolidating the result.', MODEL_PROVIDER,
      this.modelRunner ? { job, dataClass: request.dataClass } : null);
    const outputs = (Array.isArray(task.upstream) ? task.upstream : []).filter((entry) => entry.content);
    if (!outputs.length) throw new Error('Chief synthesis received no employee outputs');
    const context = typeof this.store.jobContext === 'function' ? await this.store.jobContext(task.job_id).catch(() => null) : null;
    const streams = Array.isArray(brief.workstreams) ? brief.workstreams : [];
    const revisable = brief.round === 1 && streams.filter((stream) => stream.agent !== 'coding').length >= 1;
    const synthesize = (allowRevision) => this.withHeartbeat(task, (onActivity) => this.executors.synthesize({
      agent, goal: request.goal, synthesisBrief: brief.synthesisBrief, outputs, allowRevision, workstreams: streams,
      context: context?.project ? projectLine(context) : '', onActivity,
      execution: this.modelExecution(task, `${STAGES.SYNTHESIS}:${allowRevision ? 1 : 2}`),
      toolBroker: this.toolSession(task, STAGES.SYNTHESIS),
      ...(this.modelRunner ? { run: this.poolRun(task, `${STAGES.SYNTHESIS}:${allowRevision ? 1 : 2}`, { job, request, preference: MODEL_PROVIDER }) } : {}),
    }));
    let outcome = await synthesize(revisable);
    const revisions = revisable ? parseRevisionRequest(outcome.text, streams, WORKFLOW_LIMITS.maxRevisions) : [];
    if (revisions.length) return this.requestRevisions(task, outcome, brief, streams, revisions);
    // A malformed revision request is never shown to Fahad as the answer.
    if (/^\s*(```(?:json)?\s*)?\{\s*"revise"/.test(outcome.text)) outcome = await synthesize(false);
    await this.recordOutcome(task, outcome, 'Chief final result is ready to save.');
    await this.persistOutputs(task, officeAgent('chief'), outcome.text, context);
    await this.store.completeTask(task, outcome, summarize(outcome.text));
  }

  // One bounded revision round: the named employees redo their workstream
  // with the Chief's instruction, then a final synthesis runs over everything.
  async requestRevisions(task, outcome, brief, streams, revisions) {
    const revisionTasks = [];
    for (const [index, revision] of revisions.entries()) {
      const stream = streams.find((entry) => entry.id === revision.workstream);
      const employee = officeAgent(stream.agent);
      revisionTasks.push(await this.store.ensureTask({
        jobId: task.job_id, agentSlug: employee.slug, title: `${stream.title} (revision)`,
        brief: encodeBrief(STAGES.SPECIALIST, { workstream: stream.id, agent: employee.key, title: stream.title, brief: stream.brief, revision: revision.instruction, revisesTaskId: stream.taskId }),
        sequence: SEQUENCES.REVISION + index, dependsOn: [stream.taskId, task.task_id], maxAttempts: this.maxAttempts,
      }));
    }
    const revised = new Map(revisions.map((revision, index) => [revision.workstream, revisionTasks[index].id]));
    const finalStreams = streams.map((stream) => ({ ...stream, taskId: revised.get(stream.id) || stream.taskId }));
    await this.store.ensureTask({
      jobId: task.job_id, agentSlug: 'chief-of-staff', title: 'Chief final synthesis',
      brief: encodeBrief(STAGES.SYNTHESIS, { round: 2, synthesisBrief: brief.synthesisBrief, workstreams: finalStreams }),
      sequence: SEQUENCES.SYNTHESIS_FINAL, dependsOn: finalStreams.map((stream) => stream.taskId), maxAttempts: this.maxAttempts,
    });
    const text = ['Revisions requested before the final result:', ...revisions.map((revision) => `- ${officeAgent(streams.find((entry) => entry.id === revision.workstream).agent).label}: ${revision.instruction}`)].join('\n');
    await this.recordOutcome(task, { ...outcome, text }, 'Chief requested revisions.');
    await this.store.emit({
      jobId: task.job_id, taskId: task.task_id, runId: task.run_id, agentId: task.agent_id, type: 'activity',
      message: `Chief asked for ${revisions.length} revision${revisions.length === 1 ? '' : 's'} before the final result.`,
      payload: { kind: 'revision_requested', revisions: revisions.map((revision) => ({ workstream: revision.workstream, instruction: revision.instruction })) },
    });
    await this.store.completeTask(task, { ...outcome, text }, `Revisions requested (${revisions.length}).`);
  }

  // A development workstream: the Coding Agent receives the Chief's brief plus
  // the outputs it depends on, as its own durable engineering task.
  async executeLaunchDev(task, brief) {
    assertAgent(task, 'coding-agent');
    const agent = await this.store.getAgent('coding-agent');
    await this.startStage(task, agent, 'DEV_HANDOFF', 'coding-agent', `Handing "${brief.title}" to the Coding Agent.`);
    const context = typeof this.store.jobContext === 'function' ? await this.store.jobContext(task.job_id).catch(() => null) : null;
    const repository = context?.project?.defaultRepository || null;
    const upstream = (Array.isArray(task.upstream) ? task.upstream : []).filter((entry) => entry.content);
    let text;
    let payload;
    if (!repository || typeof this.store.createCodingSession !== 'function') {
      text = `## Summary\nThe development workstream "${brief.title}" was not started: this project has no repository set.\n\n## Handoff\nSet the project repository in Projects, then ask the Chief again.\n\n## Decisions for Fahad\nChoose the repository for this project.`;
      payload = { kind: 'task_launch_skipped', reason: 'NO_REPOSITORY' };
    } else {
      const inputs = upstream.map((entry) => `### ${officeAgent(entry.agent_slug)?.label || entry.agent_slug} — ${entry.title}\n${String(entry.content).slice(0, 6000)}`).join('\n\n');
      const session = await this.store.createCodingSession({
        workspaceId: context.project.id, title: brief.title, repository, conversationId: context.conversationId || null, createdBy: 'chief-of-staff',
        objective: [brief.brief, inputs ? `\nINPUTS FROM THE OFFICE:\n${inputs}` : '', `\nOriginal objective from Fahad: ${officeRequest(task.goal, this.env).goal}`].join('\n').slice(0, 40_000),
      });
      text = `## Summary\nThe Coding Agent started the development task "${brief.title}" on \`${repository}\`.\n\n## Work\nTask: [${brief.title}](#/task/${session.id}) — it plans, edits, tests, opens a pull request and follows CI on its own.\n\n## Handoff\nProgress is visible under Tasks; approvals it needs appear under Needs attention.\n\n## Decisions for Fahad\nNone now; the Coding Agent will ask if it needs approval.`;
      payload = { kind: 'task_launched', session_id: session.id, repository };
    }
    await this.store.emit({
      jobId: task.job_id, taskId: task.task_id, runId: task.run_id, agentId: task.agent_id, type: 'activity',
      message: payload.kind === 'task_launched' ? `Chief handed "${brief.title}" to the Coding Agent.` : `Development workstream "${brief.title}" not started (no repository).`, payload,
    });
    await this.store.completeTask(task, { text, tokensIn: 0, tokensOut: 0, costUsd: 0 }, parseOutputSummary(text).summary);
  }

  async executeDirect(task, brief) {
    const employee = officeAgent(brief.agent);
    if (!employee || employee.executor !== 'office') throw new Error(`Unknown Office employee ${brief.agent}`);
    assertAgent(task, employee.slug);
    const agent = await this.store.getAgent(employee.slug);
    const request = officeRequest(task.goal, this.env);
    const consults = brief.followUp ? (Array.isArray(task.upstream) ? task.upstream : []).filter((entry) => entry.content) : [];
    await this.startStage(task, agent, 'DIRECT_WORKING', `shared-pool:${employee.job}`,
      consults.length ? `${employee.label} is answering Fahad with input from ${consults.map((entry) => officeAgent(entry.agent_slug)?.label || entry.agent_slug).join(', ')}.` : `${employee.label} is answering Fahad.`,
      MODEL_PROVIDER, { job: employee.job, dataClass: request.dataClass, role: employee.key });
    const context = typeof this.store.jobContext === 'function' ? await this.store.jobContext(task.job_id).catch(() => null) : null;
    const knowledge = await this.knowledgeFor(context, employee);
    const allowConsult = !brief.followUp;
    // Fahad named a colleague ("اسأل الكودينج", "ask CODING first"): consult
    // them first without relying on the model to decide it.
    const named = allowConsult ? mentionedEmployees(request.goal).filter((key) => key !== employee.key && DISPATCHABLE.includes(key)).slice(0, 2) : [];
    if (named.length) {
      return this.requestConsults(task, { text: '', tokensIn: 0, tokensOut: 0, costUsd: 0, model: 'no model call (named colleague)' }, employee, named.map((key) => ({
        employee: key, question: `Fahad asked ${employee.label}: "${request.goal.slice(0, 1500)}". Give ${employee.label} the input from your specialty that this needs.`,
      })));
    }
    const outcome = await this.withHeartbeat(task, (onActivity) => this.executors.direct({
      agent, role: employee.key, goal: request.goal, context: context?.text || '', knowledge, consults, allowConsult,
      webTools: employee.webTools && hasWebTools(agent.allowed_tools), onActivity,
      execution: this.modelExecution(task, brief.followUp ? `${STAGES.DIRECT}:2` : STAGES.DIRECT),
      toolBroker: this.toolSession(task, STAGES.DIRECT),
      ...(this.modelRunner ? { run: this.poolRun(task, brief.followUp ? `${STAGES.DIRECT}:2` : STAGES.DIRECT, { job: employee.job, request, preference: MODEL_PROVIDER }) } : {}),
    }));
    const requests = allowConsult ? parseConsultRequest(outcome.text, employee.key) : [];
    if (requests.length) return this.requestConsults(task, outcome, employee, requests);
    await this.recordOutcome(task, outcome, `${employee.label} answered.`);
    await this.persistOutputs(task, employee, outcome.text, context);
    await this.store.completeTask(task, outcome, summarize(outcome.text));
  }

  // The employee asked colleagues first: one consult task per colleague, then
  // the same employee answers Fahad with their input (no further consults).
  async requestConsults(task, outcome, employee, requests) {
    const consultTasks = [];
    for (const [index, entry] of requests.entries()) {
      const colleague = officeAgent(entry.employee);
      consultTasks.push(await this.store.ensureTask({
        jobId: task.job_id, agentSlug: colleague.slug, title: `${employee.label} asks ${colleague.label}`,
        brief: encodeBrief(STAGES.CONSULT, { agent: colleague.key, from: employee.key, question: entry.question }),
        sequence: SEQUENCES.CONSULT + index, dependsOn: [task.task_id], maxAttempts: this.maxAttempts,
      }));
    }
    await this.store.ensureTask({
      jobId: task.job_id, agentSlug: employee.slug, title: `Conversation with ${employee.label}`,
      brief: encodeBrief(STAGES.DIRECT, { agent: employee.key, followUp: true }),
      sequence: SEQUENCES.DIRECT_FOLLOWUP, dependsOn: consultTasks.map((row) => row.id), maxAttempts: this.maxAttempts,
    });
    const text = [`${employee.label} is asking colleagues before answering:`, ...requests.map((entry) => `- ${officeAgent(entry.employee).label}: ${entry.question}`)].join('\n');
    await this.recordOutcome(task, { ...outcome, text }, `${employee.label} consulted colleagues.`);
    await this.store.emit({
      jobId: task.job_id, taskId: task.task_id, runId: task.run_id, agentId: task.agent_id, type: 'activity',
      message: `${employee.label} asked ${requests.map((entry) => officeAgent(entry.employee).label).join(' and ')} for input.`,
      payload: { kind: 'consult_requested', agent: employee.key, consults: requests },
    });
    await this.store.completeTask(task, { ...outcome, text }, `Consulting ${requests.map((entry) => officeAgent(entry.employee).label).join(', ')}.`);
  }

  async executeConsult(task, brief) {
    const employee = officeAgent(brief.agent);
    const asker = officeAgent(brief.from);
    if (!employee || employee.retired || employee.executor === 'chief' || !asker) throw new Error(`Invalid consult ${brief.from} → ${brief.agent}`);
    assertAgent(task, employee.slug);
    const agent = await this.store.getAgent(employee.slug);
    const request = officeRequest(task.goal, this.env);
    // Advice from CODING is analysis, not engineering: route it as research.
    const job = employee.executor === 'coding' ? 'research' : employee.job;
    await this.startStage(task, agent, 'CONSULT_WORKING', `shared-pool:${job}`, `${employee.label} is answering ${asker.label}.`, MODEL_PROVIDER,
      { job, dataClass: request.dataClass, role: employee.key });
    const context = typeof this.store.jobContext === 'function' ? await this.store.jobContext(task.job_id).catch(() => null) : null;
    // A consult is advice only: CODING answers from its expertise and never
    // starts engineering work (no repository or tools here).
    const webTools = employee.executor === 'office' && employee.webTools && hasWebTools(agent.allowed_tools);
    const outcome = await this.withHeartbeat(task, (onActivity) => this.executors.direct({
      agent, role: employee.key, goal: String(brief.question || '').slice(0, 2000), consultFrom: asker.label,
      context: context?.project ? projectLine(context) : '', allowConsult: false, webTools, onActivity,
      execution: this.modelExecution(task, STAGES.CONSULT),
      toolBroker: this.toolSession(task, STAGES.CONSULT),
      ...(this.modelRunner ? { run: this.poolRun(task, STAGES.CONSULT, { job, request, preference: MODEL_PROVIDER }) } : {}),
    }));
    await this.recordOutcome(task, outcome, `${employee.label} answered ${asker.label}.`);
    await this.store.completeTask(task, outcome, summarize(outcome.text));
  }

  // Artifacts (structured outputs the Hub renders) and cited sources (curated
  // knowledge with an expiry) are saved beside the result. Never fatal.
  async persistOutputs(task, employee, text, context) {
    const saved = { artifacts: 0, sources: 0 };
    const base = { project_id: context?.project?.id || task.project_id || null, job_id: task.job_id, task_id: task.task_id, agent_slug: employee.slug };
    const { artifacts } = parseArtifacts(text);
    if (artifacts.length && typeof this.store.saveArtifacts === 'function') {
      saved.artifacts = await this.store.saveArtifacts(artifacts.map((entry) => ({ ...base, conversation_id: context?.conversationId || null, ...entry })))
        .then(() => artifacts.length).catch(() => 0);
    }
    const sources = employee.webTools ? parseSources(text) : [];
    if (sources.length && base.project_id && typeof this.store.saveKnowledge === 'function') {
      const days = KNOWLEDGE_DAYS[employee.key] || 90;
      const expires = new Date(this.now() + days * 86_400_000).toISOString();
      const today = new Date(this.now()).toISOString().slice(0, 10);
      saved.sources = await this.store.saveKnowledge(sources.map((source) => ({
        project_id: base.project_id, agent_slug: employee.slug, job_id: task.job_id, title: source.title, source_url: source.url,
        source_date: today, scope: 'project', expires_at: expires,
      }))).then(() => sources.length).catch(() => 0);
    }
    return saved;
  }

  async knowledgeFor(context, employee) {
    if (!context?.project?.id || typeof this.store.knowledgeFor !== 'function') return [];
    return this.store.knowledgeFor(context.project.id, employee.slug).catch(() => []);
  }

  async startStage(task, agent, stage, model, message, provider = MODEL_PROVIDER, routing = null) {
    await this.store.setRunModel(task.run_id, model);
    await this.store.emit({
      jobId: task.job_id,
      taskId: task.task_id,
      runId: task.run_id,
      agentId: agent.id,
      type: 'status_changed',
      message,
      payload: {
        status: 'WORKING', stage, provider: routing ? 'shared-pool' : provider, model,
        attempt: task.attempt_no, max_attempts: task.max_attempts,
        ...(routing ? { kind: 'model_stage_started', job: routing.job, data_class: routing.dataClass, role: routing.role || null, agent_slug: agent.slug || task.agent_slug } : {}),
      },
    });
  }

  async recordOutcome(task, outcome, message) {
    if (outcome.path) {
      await this.store.emit({
        jobId: task.job_id,
        taskId: task.task_id,
        runId: task.run_id,
        agentId: task.agent_id,
        type: 'activity',
        message: `${task.agent_slug} ran on ${outcome.path.map((step) => `${step.routeId} (${step.billingClass.toUpperCase()})`).join(' → ')}.`,
        payload: {
          kind: 'model_route', agent_slug: task.agent_slug, stage: decodeBrief(task.brief).stage, job: outcome.job, data_class: outcome.dataClass,
          route_id: outcome.routeId, provider: outcome.provider, model: outcome.model, billing_class: outcome.billingClass,
          path: outcome.path, switches: outcome.switches, escalations: outcome.escalations, tools_used: outcome.toolsUsed,
          checkpoints: outcome.checkpoints, tokens_in: outcome.tokensIn, tokens_out: outcome.tokensOut, cost_usd: outcome.costUsd,
          duration_ms: outcome.durationMs, savings: outcome.savings,
        },
      });
    }
    await this.store.setRunModel(
      task.run_id,
      outcome.model || (task.agent_slug === 'research-strategy' ? RESEARCH_MODEL : CHIEF_MODEL),
    );
    await this.store.emit({
      jobId: task.job_id,
      taskId: task.task_id,
      runId: task.run_id,
      agentId: task.agent_id,
      type: 'activity',
      message,
      payload: {
        status: 'COMPLETED',
        provider: outcome.provider || MODEL_PROVIDER,
        model: outcome.model || (task.agent_slug === 'research-strategy' ? RESEARCH_MODEL : CHIEF_MODEL),
        tokens_in: outcome.tokensIn,
        tokens_out: outcome.tokensOut,
        cost_usd: outcome.costUsd,
        duration_ms: outcome.durationMs,
        retry_count: Math.max(0, task.attempt_no - 1),
      },
    });
  }

  async providerPreference(task, stage) {
    if (stage === STAGES.RESEARCH) return MODEL_PROVIDER;
    const job = await this.store.getJob(task.job_id);
    const requested = job.requested_provider || 'auto';
    if (!['auto', 'anthropic', 'deepseek'].includes(requested)) throw new Error('Unsupported job provider preference');
    return requested === 'auto' ? MODEL_PROVIDER : requested;
  }

  // A stage run on the shared Model Pool: the stage names its job type; the
  // shared router chooses the model. Audit, checkpoints and provider switches
  // go to the same durable records as before.
  poolRun(task, stage, { job, request, preference = MODEL_PROVIDER, validate = null, drillFailover = false }) {
    const execution = this.modelExecution(task, stage);
    return async (args) => this.modelRunner.run({
      job,
      systemPrompt: args.systemPrompt,
      prompt: args.prompt,
      useWebTools: (args.allowedTools || []).length > 0,
      maxTurns: args.maxTurns,
      // The Chief's synthesis consolidates every employee: give it room.
      ...(String(stage).startsWith(STAGES.SYNTHESIS) ? { maxOutputTokens: 8000 } : {}),
      dataClass: request.dataClass,
      onlyProvider: preference && preference !== MODEL_PROVIDER ? preference : null,
      context: execution.gatewayContext,
      validate,
      beforeCall: drillFailover ? failoverDrill() : null,
      hooks: {
        onAttempt: execution.onAttempt,
        onCheckpoint: execution.onCheckpoint,
        onProviderSwitch: execution.onProviderSwitch,
        onActivity: args.onActivity,
        onIncident: (incident) => this.store.emit({
          jobId: task.job_id, taskId: task.task_id, runId: task.run_id, agentId: task.agent_id,
          type: 'activity', required: true, level: 'error',
          message: `Free-route guard: ${incident.routeId} ${incident.kind === 'paid_on_free_route' ? `was billed $${Number(incident.costUsd).toFixed(6)}` : 'served a different model'}; the cost was recorded, the route is blocked for 24 h and the step moved to another route.`,
          payload: { kind: 'free_route_incident', route: incident.routeId, incident: incident.kind, cost_usd: incident.costUsd, reported_model: incident.reportedModel },
        }),
        onEscalation: (change) => this.store.emit({
          jobId: task.job_id, taskId: task.task_id, runId: task.run_id, agentId: task.agent_id,
          type: 'activity', required: true, level: 'warning',
          message: `Escalated: ${change.fromRoute} could not complete this ${job} step (${change.reason}); checkpoint ${change.checkpointSequence} saved, choosing the next suitable model.`,
          payload: { kind: 'model_escalation', job, from_route: change.fromRoute, reason: change.reason, checkpoint: change.checkpointSequence },
        }),
      },
    });
  }

  modelExecution(task, stage, provider = MODEL_PROVIDER, model = null) {
    const context = {
      workspaceId: task.project_id || null,
      jobId: task.job_id,
      taskId: task.task_id,
      runId: task.run_id,
      agentId: task.agent_id,
      stage,
      provider: provider === MODEL_PROVIDER ? null : provider,
    };
    return {
      ...(model ? { model } : {}),
      gatewayContext: context,
      workspacePolicyStore: selectWorkspacePolicyStore({
        policyStore: this.workspacePolicyStore,
        workspaceId: task.project_id,
        enforceLegacy: this.enforceLegacyWorkspacePolicy,
      }),
      idempotencyKey: `${task.run_id}:${stage}`,
      onAttempt: (attempt) => this.store.recordModelAttempt(attempt),
      onCheckpoint: (checkpoint) => this.store.emit({
        jobId: task.job_id,
        taskId: task.task_id,
        runId: task.run_id,
        agentId: task.agent_id,
        type: 'activity',
        required: true,
        level: 'warning',
        message: 'Provider-neutral checkpoint saved before model ownership changed.',
        payload: { ...checkpoint, kind: 'model_checkpoint' },
      }),
      onProviderSwitch: (checkpoint) => this.store.emit({
        jobId: task.job_id,
        taskId: task.task_id,
        runId: task.run_id,
        agentId: task.agent_id,
        type: 'activity',
        required: true,
        level: 'warning',
        message: `Model ownership changed from ${checkpoint.fromProvider} to ${checkpoint.toProvider}.`,
        payload: { ...checkpoint, kind: 'provider_switch' },
      }),
      onBudgetThreshold: (threshold) => this.store.emit({
        jobId: task.job_id,
        taskId: task.task_id,
        runId: task.run_id,
        agentId: task.agent_id,
        type: 'activity',
        level: threshold.threshold >= 0.9 ? 'warning' : 'info',
        message: `Model budget reached ${threshold.threshold * 100}%.`,
        payload: { ...threshold, kind: 'cost_threshold' },
      }),
    };
  }

  toolSession(task, stage) {
    if (!this.toolBroker || !task.project_id) return null;
    return new ScopedToolBrokerSession({
      broker: this.toolBroker,
      context: {
        workspaceId: task.project_id,
        jobId: task.job_id,
        taskId: task.task_id,
        runId: task.run_id,
        agentId: task.agent_id,
      },
      idempotencyPrefix: `${task.run_id}:${stage}:tool`,
    });
  }

  async withHeartbeat(task, operation) {
    let progress = 10;
    const heartbeat = setInterval(() => {
      this.store.touchTask(task.task_id, progress).catch(() => {});
    }, 30_000);
    heartbeat.unref?.();
    try {
      return await operation(async ({ turns = 0, hostTool } = {}) => {
        if (hostTool) {
          await this.store.emit({
            jobId: task.job_id,
            taskId: task.task_id,
            runId: task.run_id,
            agentId: task.agent_id,
            type: 'activity',
            required: true,
            level: hostTool.status === 'failed' ? 'warning' : 'info',
            message: `${hostTool.name} ${hostTool.status}.`,
            payload: {
              kind: 'host_tool', tool: hostTool.name, status: hostTool.status,
              tool_use_id: hostTool.id, duration_ms: hostTool.durationMs ?? null, ...(hostTool.error ? { error: hostTool.error } : {}),
            },
          });
        }
        progress = Math.min(90, 20 + turns * 10);
        await this.store.touchTask(task.task_id, progress);
      });
    } finally {
      clearInterval(heartbeat);
    }
  }
}

export function selectWorkspacePolicyStore({ policyStore, workspaceId, enforceLegacy = false }) {
  if (!policyStore) return null;
  // A non-null workspace is an explicit policy boundary and must never bypass
  // enforcement. Legacy jobs remain unchanged unless the global flag is set.
  return workspaceId || enforceLegacy ? policyStore : null;
}

export function encodeBrief(stage, values = {}) {
  return JSON.stringify({ workflow: WORKFLOW, workflow_version: WORKFLOW_VERSION, stage, ...values });
}

export function decodeBrief(value) {
  let brief;
  try {
    brief = JSON.parse(value);
  } catch {
    throw new Error('Task brief is not valid workflow JSON');
  }
  if (brief?.workflow !== WORKFLOW || brief.workflow_version !== WORKFLOW_VERSION ||
      !Object.values(STAGES).includes(brief.stage)) {
    throw new Error('Task does not belong to the supported Step 3C workflow');
  }
  return brief;
}

function hasWebTools(tools = []) {
  const normalized = tools.map((tool) => String(tool).toLowerCase());
  return normalized.includes('web_search') && normalized.includes('web_fetch');
}

function projectLine(context) {
  return String(context.text || '').slice(0, 3000);
}

function parseOutputSummary(text) {
  const match = String(text || '').match(/^##\s*Summary[^\n]*\n([\s\S]*?)(?=^##\s|$(?![\s\S]))/mi);
  const summary = match ? match[1].trim() : summarize(text);
  const decisions = String(text || '').match(/^##\s*Decisions for Fahad[^\n]*\n([\s\S]*?)(?=^##\s|$(?![\s\S]))/mi)?.[1]?.trim() || '';
  return { summary, decisions: /^(none|n\/a|-)\b/i.test(decisions) ? '' : decisions };
}

export function workflowPlanMarkdown(plan) {
  const lines = [`**Plan:** ${plan.plan_summary}`, '', '| Workstream | Employee | Needs |', '|---|---|---|'];
  for (const stream of plan.workstreams) {
    const needs = stream.dependsOn.map((id) => plan.workstreams.find((entry) => entry.id === id)?.title || id).join(', ') || '—';
    lines.push(`| ${stream.title} | ${officeAgent(stream.agent)?.label || stream.agent} | ${needs} |`);
  }
  lines.push('', `**Final result will cover:** ${plan.synthesis_brief}`);
  return lines.join('\n');
}

function assertAgent(task, expected) {
  if (task.agent_slug !== expected) throw new Error(`Stage requires ${expected}`);
}

function assertAuthorizedResearchTools(tools) {
  const normalized = tools.map((tool) => String(tool).toLowerCase());
  for (const required of ['web_search', 'web_fetch']) {
    if (!normalized.includes(required)) throw new Error(`Research agent is not authorized for ${required}`);
  }
}

function summarize(text) {
  const first = String(text || '').split('\n').find((line) => line.trim()) || '';
  return first.trim().slice(0, 300);
}

export function safeError(error) {
  let safe = String(error?.message || error || 'Unknown task failure');
  for (const name of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'DEEPSEEK_API_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'CONTINUITY_GITHUB_TOKEN']) {
    const value = process.env[name];
    if (value && value.length >= 8) safe = safe.replaceAll(value, '[REDACTED]');
  }
  return safe
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk[-_]|ghp_|github_pat_)[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED]')
    .slice(0, 500);
}

// The request as Office sees it: owner drill markers and the confidential
// marker are removed from what models receive; the data class is decided
// once per job (office/pool-runner.js classifyOfficeData).
export function officeRequest(goal, env = process.env) {
  const raw = String(goal || '');
  const drillsEnabled = !/^(0|false|no)$/i.test(String(env.OFFICE_DRILLS_ENABLED || ''));
  const drills = {
    failover: drillsEnabled && /\[drill:failover\]/i.test(raw),
    escalate: drillsEnabled && /\[drill:escalate\]/i.test(raw),
  };
  const { dataClass, reason } = classifyOfficeData(raw, { env });
  const cleaned = raw.replace(/\[drill:(failover|escalate)\]/gi, '').replace(/^\s*\[(confidential|private|سري)\]\s*/i, '').trim();
  return { goal: cleaned || raw, dataClass, dataClassReason: reason, drills };
}

// Controlled failover drill (owner marker [drill:failover]): after the first
// model has completed one real step, ONE simulated rate limit is injected on
// its next call. The gateway treats it like a real 429 (checkpoint, switch)
// but never records it as provider health. Reported as injected.
export function failoverDrill() {
  let firstRoute = null;
  let calls = 0;
  let injected = false;
  return async ({ route }) => {
    firstRoute ||= route.id;
    if (route.id !== firstRoute || injected) return;
    calls += 1;
    if (calls === 2) {
      injected = true;
      throw Object.assign(new Error('DRILL: injected rate limit for the Office failover drill'), { status: 429, type: 'rate_limit_error', retryAfter: '600', injected: true, code: 'DRILL_INJECTED_RATE_LIMIT' });
    }
  };
}

// Controlled escalation drill (owner marker [drill:escalate]): the first
// model's valid plan is treated ONCE as insufficient, so the stage escalates
// to the next suitable model from its checkpoint. Reported as injected.
export function escalationDrill(validate) {
  let used = false;
  return async (text) => {
    if (!used) {
      used = true;
      throw new EscalationRequired('DRILL: first plan treated as insufficient', 'DRILL_INJECTED_INSUFFICIENT');
    }
    return validate(text);
  };
}
