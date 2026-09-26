import { CHIEF_MAX_TURNS, CHIEF_MODEL } from './config.js';
import { runModel } from './model-runner.js';

const SPECIALIST_ROLES = ['research', 'content', 'branding', 'seo', 'finance'];

export async function planJob({ agent, goal, run = runModel, onActivity, execution = {} }) {
  const outcome = await run({
    ...execution,
    model: execution.model || CHIEF_MODEL,
    maxTurns: CHIEF_MAX_TURNS,
    allowedTools: [],
    routingHints: { requiresPrivateData: true, preferQuality: true },
    systemPrompt: agent.system_prompt,
    onActivity,
    prompt: [
      'You are the Chief of Staff planning a constrained Chief → Research → Chief workflow.',
      'Decide whether the goal requires Research & Strategy. For this workflow, delegate factual',
      'research instead of doing it yourself. Do not perform the research and do not claim findings.',
      'Choose the ONE specialist best suited to the goal: "research" (facts, market, options),',
      '"content" (write or rewrite text), "branding" (names, positioning, tone), "seo" (search',
      'visibility) or "finance" (numbers, budgets, scenarios; analysis only).',
      'Return JSON only, with exactly these keys:',
      '{"research_required":true,"specialist":"research","plan_summary":"...","research_brief":"...","review_brief":"..."}',
      'research_required must be true (a specialist always does the work); research_brief is the specialist brief.',
      'The research brief must be self-contained and preserve the user goal and output constraints.',
      '',
      `USER GOAL: ${goal}`,
    ].join('\n'),
  });

  return { ...outcome, plan: validatePlan(outcome.text) };
}

// The plan contract. Also used by the shared-pool runner to decide that a
// model's plan is unusable and the stage must escalate to another model.
export function validatePlan(text) {
  const plan = parseJsonObject(text);
  for (const name of ['plan_summary', 'research_brief', 'review_brief']) {
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
