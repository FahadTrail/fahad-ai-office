import { CHIEF_MAX_TURNS, CHIEF_MODEL } from './config.js';
import { runModel } from './model-runner.js';

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
      '- "delegate": a specialist does real work: "research" (facts, market, options, anything needing',
      '  current information), "content" (write or rewrite text), "branding" (names, positioning, tone),',
      '  "seo" (search visibility) or "finance" (numbers, budgets, scenarios; analysis only).',
      '- "development": build, fix, change, test or review code in the project repository, or check the',
      '  repository/CI. Write a complete, self-contained objective for the Coding Agent in',
      '  "development_objective" (what to change, acceptance criteria, constraints) and a short title.',
      'Return JSON only, with these keys (unused ones may be empty strings):',
      '{"route":"answer","answer":"...","specialist":"research","plan_summary":"...","research_brief":"...","review_brief":"...","development_title":"...","development_objective":"..."}',
      'Always write plan_summary (one sentence, in Fahad\'s language). For "delegate", research_required must be',
      'true and research_brief must be self-contained and preserve the goal and output constraints.',
      'Reply in the language Fahad used.',
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
export const CHIEF_ROUTES = Object.freeze(['answer', 'delegate', 'development']);
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
