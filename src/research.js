import { RESEARCH_MAX_TURNS, RESEARCH_MODEL } from './config.js';
import { runModel } from './model-runner.js';

export async function performResearch({ agent, goal, brief, run = runModel, onActivity, execution = {} }) {
  return run({
    ...execution,
    model: RESEARCH_MODEL,
    maxTurns: RESEARCH_MAX_TURNS,
    allowedTools: ['WebSearch', 'WebFetch'],
    systemPrompt: agent.system_prompt,
    onActivity,
    prompt: [
      'You are Research & Strategy. This is a real delegated research task.',
      'Use the authorized web tools to verify current facts. Return structured Markdown with:',
      'findings, three practical options, a concise recommendation, and source links.',
      'Distinguish sourced facts from your analysis. Do not expose hidden reasoning.',
      '',
      `ORIGINAL GOAL: ${goal}`,
      `CHIEF BRIEF: ${brief}`,
    ].join('\n'),
  });
}
