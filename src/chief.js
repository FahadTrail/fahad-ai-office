import { CHIEF_MAX_TURNS, CHIEF_MODEL } from './config.js';
import { runModel } from './model-runner.js';
import { DISPATCHABLE, OFFICE_AGENTS, officeAgent } from './office/agents.js';

const SPECIALIST_ROLES = ['research', 'content', 'branding', 'seo', 'finance'];

export async function planJob({ agent, goal, context = '', run = runModel, onActivity, execution = {} }) {
  const outcome = await run({
    ...execution,
    model: execution.model || CHIEF_MODEL,
    maxTurns: CHIEF_MAX_TURNS,
    allowedTools: [],
    routingHints: { requiresPrivateData: true, preferQuality: true },
    systemPrompt: agent.system_prompt,
    onActivity,
    prompt: [
      'You are the Chief of Staff of Fahad AI Office. Decide how to handle Fahad\'s latest message.',
      'Choose exactly ONE route:',
      '- "answer": you reply directly yourself. Use it for greetings, quick questions, clarifications,',
      '  follow-ups that the conversation/project context already answers, short explanations and simple',
      '  drafting. Put the complete reply (Markdown allowed) in "answer". Never invent facts or findings.',
      '- "orchestrate": real specialist work is needed. Split the objective into 1 to 8 workstreams, each',
      '  owned by ONE employee, with dependencies ("depends_on": ids of workstreams whose output it needs).',
      '  Independent workstreams run in parallel. Use only the employees the objective genuinely needs;',
      '  a single-specialist request is one workstream. Do not do specialist work yourself.',
      '  Employees (use the key):',
      ...OFFICE_AGENTS.filter((entry) => entry.executor !== 'chief').map((entry) => `    ${entry.key}: ${entry.label} — ${entry.scope}`),
      '  Put "coding" only for a concrete, fully specified change to the project repository; its brief is',
      '  the complete engineering objective (what to change, acceptance criteria, constraints).',
      '  Put "review" last when the combined work benefits from a quality check before it reaches Fahad.',
      '- "development": the whole message is a request to build, fix, change, test or review code in the',
      '  project repository. Write a complete, self-contained objective in "development_objective" and a title.',
      'Return JSON only, with these keys (unused ones may be empty strings or empty arrays):',
      '{"route":"orchestrate","answer":"","plan_summary":"...","workstreams":[{"id":"market","agent":"research","title":"Market research","brief":"self-contained instructions incl. the goal and output constraints","depends_on":[]},{"id":"model","agent":"strategy","title":"Business model","brief":"...","depends_on":["market"]}],"synthesis_brief":"what the final consolidated answer must cover","development_title":"","development_objective":""}',
      'LANGUAGE: write plan_summary, every workstream title and brief, and synthesis_brief in the language of Fahad\'s current',
      'message (English message → English), and tell each employee in its brief to answer in that language.',
      'Always write plan_summary (one sentence). Each workstream brief must be',
      'self-contained: the employee sees the original objective, your brief and the outputs it depends on — nothing else.',
      'Write the answer in the same language as Fahad\'s current message (English message → English answer; Arabic → Arabic),',
      'regardless of the language of earlier turns or project context.',
      '',
      context ? `CONTEXT (project and earlier messages in this conversation):\n${context}\n` : '',
      `FAHAD'S MESSAGE: ${goal}`,
    ].join('\n'),
  });

  return { ...outcome, plan: validatePlan(outcome.text) };
}

// The plan contract. Also used by the shared-pool runner to decide that a
// model's plan is unusable and the stage must escalate to another model.
// Plans without "route" are the original delegate contract.
export const CHIEF_ROUTES = Object.freeze(['answer', 'delegate', 'orchestrate', 'development']);
export const WORKFLOW_LIMITS = Object.freeze({ maxWorkstreams: 8, maxCoding: 1, maxRevisions: 3, maxRevisionRounds: 1 });
export function validatePlan(text) {
  const plan = parseJsonObject(text);
  const route = CHIEF_ROUTES.includes(String(plan.route || '').toLowerCase()) ? String(plan.route).toLowerCase() : 'delegate';
  plan.route = route;
  if (typeof plan.plan_summary !== 'string' || !plan.plan_summary.trim()) {
    if (route === 'answer' && typeof plan.answer === 'string') plan.plan_summary = plan.answer.slice(0, 200);
    else throw new Error('Chief plan is missing plan_summary');
  }
  if (route === 'answer') {
    if (typeof plan.answer !== 'string' || !plan.answer.trim()) throw new Error('Chief chose to answer but gave no answer');
    return plan;
  }
  if (route === 'orchestrate') return validateOrchestration(plan);
  if (route === 'development') {
    if (typeof plan.development_objective !== 'string' || plan.development_objective.trim().length < 12) {
      throw new Error('Chief chose development but gave no usable objective');
    }
    plan.development_title = String(plan.development_title || plan.plan_summary).trim().slice(0, 120);
    return plan;
  }
  for (const name of ['research_brief', 'review_brief']) {
    if (typeof plan[name] !== 'string' || !plan[name].trim()) {
      throw new Error(`Chief plan is missing ${name}`);
    }
  }
  if (plan.research_required !== true) {
    throw new Error('Chief did not authorize the required Research delegation');
  }
  const specialist = String(plan.specialist || 'research').toLowerCase();
  plan.specialist = SPECIALIST_ROLES.includes(specialist) ? specialist : 'research';
  return plan;
}

// Workstreams: known employees, unique ids, dependencies on known ids only,
// no cycles, bounded size. Returned in dependency order.
export function validateOrchestration(plan) {
  const raw = Array.isArray(plan.workstreams) ? plan.workstreams : [];
  if (!raw.length) throw new Error('Chief chose to orchestrate but gave no workstreams');
  if (raw.length > WORKFLOW_LIMITS.maxWorkstreams) throw new Error(`Chief planned ${raw.length} workstreams; the limit is ${WORKFLOW_LIMITS.maxWorkstreams}`);
  const used = new Set();
  const workstreams = raw.map((entry, index) => {
    const agent = officeAgent(entry?.agent);
    if (!agent || !DISPATCHABLE.includes(agent.key)) throw new Error(`Workstream ${index + 1} names an unknown employee "${entry?.agent}"`);
    let id = String(entry.id || `${agent.key}-${index + 1}`).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || `ws-${index + 1}`;
    while (used.has(id)) id = `${id}-${index + 1}`;
    used.add(id);
    const brief = String(entry.brief || '').trim();
    if (brief.length < 20) throw new Error(`Workstream "${id}" has no usable brief`);
    return {
      id, agent: agent.key, title: String(entry.title || agent.deliverable).trim().slice(0, 120) || agent.deliverable,
      brief: brief.slice(0, 6000), dependsOn: (Array.isArray(entry.depends_on) ? entry.depends_on : []).map((dep) => String(dep).toLowerCase()),
    };
  });
  const ids = new Set(workstreams.map((entry) => entry.id));
  for (const entry of workstreams) {
    entry.dependsOn = [...new Set(entry.dependsOn.filter((dep) => dep !== entry.id))];
    const unknown = entry.dependsOn.filter((dep) => !ids.has(dep));
    if (unknown.length) throw new Error(`Workstream "${entry.id}" depends on unknown workstream(s): ${unknown.join(', ')}`);
  }
  if (workstreams.filter((entry) => entry.agent === 'coding').length > WORKFLOW_LIMITS.maxCoding) throw new Error('Only one development workstream per objective');
  plan.workstreams = topologicalOrder(workstreams);
  plan.synthesis_brief = String(plan.synthesis_brief || plan.review_brief || 'Consolidate the employees\' outputs into one clear answer for Fahad.').trim().slice(0, 4000);
  return plan;
}

function topologicalOrder(workstreams) {
  const byId = new Map(workstreams.map((entry) => [entry.id, entry]));
  const ordered = [];
  const state = new Map();
  const visit = (entry, path) => {
    if (state.get(entry.id) === 'done') return;
    if (state.get(entry.id) === 'visiting') throw new Error(`Workstream dependencies form a cycle: ${[...path, entry.id].join(' → ')}`);
    state.set(entry.id, 'visiting');
    for (const dep of entry.dependsOn) visit(byId.get(dep), [...path, entry.id]);
    state.set(entry.id, 'done');
    ordered.push(entry);
  };
  for (const entry of workstreams) visit(entry, []);
  return ordered;
}

// Chief work is classified by difficulty. Routine orchestration (classify the
// request, choose the agent, write the handoff) can run on capable free
// models; long or high-stakes requests need stronger reasoning ("synthesis")
// and escalate automatically when no free model qualifies.
const HIGH_STAKES = /\b(legal|lawsuit|contract|compliance|regulat|tax|invest|acquisition|merger|medical|diagnos|safety|security incident|board|final decision|critical|high[- ]stakes)\b/i;
export function chiefJob(goal, { stage = 'plan' } = {}) {
  if (stage === 'review') return 'synthesis';
  const value = String(goal || '');
  return value.length > 1500 || HIGH_STAKES.test(value) ? 'synthesis' : 'orchestration';
}

export async function reviewResearch({ agent, goal, reviewBrief, research, run = runModel, onActivity, execution = {} }) {
  if (!research?.content?.trim()) throw new Error('Chief review requires a durable Research result');
  return run({
    ...execution,
    model: execution.model || CHIEF_MODEL,
    maxTurns: CHIEF_MAX_TURNS,
    allowedTools: [],
    routingHints: { requiresPrivateData: true, preferQuality: true },
    systemPrompt: agent.system_prompt,
    onActivity,
    prompt: [
      'You are the Chief of Staff performing final review. Research & Strategy has completed',
      'the delegated task. Review its persisted result below, resolve any ambiguity conservatively,',
      'and answer Fahad directly. Do not pretend that you performed the research yourself.',
      'Use the language of the original goal. Lead with the concise recommendation.',
      '',
      `ORIGINAL GOAL: ${goal}`,
      `REVIEW BRIEF: ${reviewBrief}`,
      '',
      'PERSISTED RESEARCH RESULT:',
      research.content,
    ].join('\n'),
  });
}

function parseJsonObject(value) {
  const trimmed = String(value || '').trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidate = fenced ? fenced[1] : trimmed;
  let parsed;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('Chief plan was not valid JSON');
    try {
      parsed = JSON.parse(candidate.slice(start, end + 1));
    } catch {
      throw new Error('Chief plan was not valid JSON');
    }
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error('Chief plan must be a JSON object');
  }
  return parsed;
}
