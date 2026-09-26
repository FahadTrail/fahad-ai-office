import { RESEARCH_MAX_TURNS, RESEARCH_MODEL } from './config.js';
import { runModel } from './model-runner.js';

// Specialist roles the Chief can delegate to. Each one names the job type the
// shared Model Pool routes by (capabilities.js JOB_PROFILES) and whether it
// gets the provider-neutral web tools.
export const SPECIALISTS = Object.freeze({
  research: { job: 'research', agentSlug: 'research-strategy', webTools: true, label: 'Research & Strategy',
    instructions: [
      'You are Research & Strategy. This is a real delegated research task.',
      'Use the authorized web tools to verify current facts. Return structured Markdown with:',
      'findings, three practical options, a concise recommendation, and source links.',
      'Distinguish sourced facts from your analysis. Do not expose hidden reasoning.',
    ] },
  content: { job: 'content', agentSlug: 'research-strategy', webTools: false, label: 'Content',
    instructions: [
      'You are the Content specialist. Write the requested content directly: clear structure,',
      'the audience and tone the brief asks for, and nothing invented presented as fact.',
      'Return Markdown ready to use. Do not expose hidden reasoning.',
    ] },
  branding: { job: 'branding', agentSlug: 'research-strategy', webTools: false, label: 'Branding',
    instructions: [
      'You are the Branding specialist. Work on positioning, naming, tone of voice and messaging as the brief asks.',
      'Give concrete options with a short rationale each and a recommendation. Return Markdown.',
    ] },
  seo: { job: 'seo', agentSlug: 'research-strategy', webTools: true, label: 'SEO',
    instructions: [
      'You are the SEO specialist. Use the web tools for current search facts where useful.',
      'Return structured Markdown: target queries and intent, on-page recommendations, content brief, and sources.',
    ] },
  finance: { job: 'finance', agentSlug: 'business-finance', webTools: true, label: 'Finance',
    instructions: [
      'You are the Finance specialist. Provide numerical analysis, assumptions and scenarios in structured Markdown.',
      'Show the arithmetic. Never move money, make payments, trade, or perform any financial transaction; analysis only.',
    ] },
});

export function specialistFor(role) {
  return SPECIALISTS[role] || SPECIALISTS.research;
}

export async function performSpecialist({ agent, goal, brief, role = 'research', run = runModel, onActivity, execution = {} }) {
  const specialist = specialistFor(role);
  return run({
    ...execution,
    model: RESEARCH_MODEL,
    maxTurns: RESEARCH_MAX_TURNS,
    allowedTools: specialist.webTools ? ['WebSearch', 'WebFetch'] : [],
    routingHints: { requiresPrivateData: true, preferQuality: true },
    systemPrompt: agent.system_prompt,
    onActivity,
    specialist: { role, job: specialist.job },
    prompt: [
      ...specialist.instructions,
      '',
      `ORIGINAL GOAL: ${goal}`,
      `CHIEF BRIEF: ${brief}`,
    ].join('\n'),
  });
}

export async function performResearch(input) {
  return performSpecialist({ ...input, role: 'research' });
}
