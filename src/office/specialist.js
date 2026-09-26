// Executors for Office employees. Each call goes through the shared Model
// Pool (`run`), routed by the employee's job type; the employee's identity
// and system prompt come from public.agents.
import { RESEARCH_MAX_TURNS, CHIEF_MAX_TURNS } from '../config.js';
import { runModel } from '../model-runner.js';
import { OUTPUT_CONTRACT, officeAgent } from './agents.js';

const MAX_INPUT_CHARS = 12_000;

export function upstreamBlock(outputs = []) {
  if (!outputs.length) return 'none';
  return outputs.map((output) => {
    const who = officeAgent(output.agent_slug)?.label || output.agent_slug;
    const content = String(output.content || output.summary || '');
    return `### From ${who} — ${output.title}\n${content.length > MAX_INPUT_CHARS ? `${content.slice(0, MAX_INPUT_CHARS)}\n…[truncated]` : content}`;
  }).join('\n\n');
}

// A workstream done by one employee, following the output contract.
export async function performOfficeWork({ agent, role, goal, brief, title, upstream = [], context = '', revision = null, previous = null, webTools = false, run = runModel, onActivity, execution = {} }) {
  const employee = officeAgent(role);
  return run({
    ...execution,
    maxTurns: RESEARCH_MAX_TURNS,
    allowedTools: webTools ? ['WebSearch', 'WebFetch'] : [],
    routingHints: { requiresPrivateData: true, preferQuality: true },
    systemPrompt: agent.system_prompt,
    onActivity,
    specialist: { role: employee.key, job: employee.job },
    prompt: [
      `You are ${employee.label} in Fahad's AI Office. Your scope: ${employee.scope}`,
      `The Chief of Staff assigned you this workstream: "${title}". Do the work yourself, completely; do not ask for permission.`,
      webTools ? 'Use the web tools to verify current facts and cite sources.' : 'You have no web access in this task: rely on the inputs and label assumptions.',
      ...OUTPUT_CONTRACT,
      '',
      `ORIGINAL OBJECTIVE FROM FAHAD: ${goal}`,
      `CHIEF'S BRIEF: ${brief}`,
      context ? `PROJECT CONTEXT:\n${context}` : '',
      `INPUTS FROM OTHER EMPLOYEES:\n${upstreamBlock(upstream)}`,
      revision ? `\nREVISION REQUESTED BY THE CHIEF: ${revision}\nYOUR PREVIOUS VERSION:\n${String(previous || '').slice(0, MAX_INPUT_CHARS)}\nReturn the complete revised deliverable.` : '',
    ].filter(Boolean).join('\n'),
  });
}

// The Chief consolidates every output. In the first round it may instead ask
// for revisions (JSON), bounded by the workflow limits.
export async function synthesizeWorkflow({ agent, goal, synthesisBrief, outputs, allowRevision, workstreams = [], context = '', run = runModel, onActivity, execution = {} }) {
  return run({
    ...execution,
    maxTurns: CHIEF_MAX_TURNS,
    allowedTools: [],
    routingHints: { requiresPrivateData: true, preferQuality: true },
    systemPrompt: agent.system_prompt,
    onActivity,
    prompt: [
      'You are the Chief of Staff. Your employees have completed the workstreams you dispatched.',
      'Consolidate their persisted outputs below into ONE coherent result for Fahad. Do not pretend you did',
      'their work; credit them by role where useful. Resolve conflicts between outputs explicitly.',
      'Structure: a short executive summary first, then the consolidated plan/answer, then',
      '"## Decisions for Fahad" (only what genuinely needs the owner) and "## Next steps".',
      'Use the language of the original objective.',
      allowRevision ? [
        'If — and only if — an output is clearly wrong or missing something essential, you may instead return ONLY',
        'a JSON object {"revise":[{"workstream":"<id>","instruction":"what to fix"}]} (at most 3). Otherwise write the result.',
        `Workstream ids: ${workstreams.map((entry) => `${entry.id} (${officeAgent(entry.agent)?.label || entry.agent})`).join(', ')}`,
      ].join('\n') : 'Revisions are no longer possible: write the final result now.',
      '',
      `ORIGINAL OBJECTIVE: ${goal}`,
      `WHAT THE RESULT MUST COVER: ${synthesisBrief}`,
      context ? `PROJECT CONTEXT:\n${context}` : '',
      '',
      `EMPLOYEE OUTPUTS:\n${upstreamBlock(outputs)}`,
    ].filter(Boolean).join('\n'),
  });
}

// Direct conversation with one employee (no Chief in between).
export async function converseDirect({ agent, role, goal, context = '', webTools = false, run = runModel, onActivity, execution = {} }) {
  const employee = officeAgent(role);
  return run({
    ...execution,
    maxTurns: RESEARCH_MAX_TURNS,
    allowedTools: webTools ? ['WebSearch', 'WebFetch'] : [],
    routingHints: { requiresPrivateData: true, preferQuality: true },
    systemPrompt: agent.system_prompt,
    onActivity,
    specialist: { role: employee.key, job: employee.job },
    prompt: [
      `You are ${employee.label} in Fahad's AI Office, and Fahad is talking to you directly. Your scope: ${employee.scope}`,
      'Answer as this employee, within your specialty, in the language of his message. If the request is outside',
      'your specialty, say which colleague (or the Chief of Staff) should handle it, and help as far as you can.',
      'Never invent facts; label estimates. Markdown is welcome.',
      context ? `\nCONTEXT (project and earlier messages in this conversation):\n${context}` : '',
      `\nFAHAD'S MESSAGE: ${goal}`,
    ].filter(Boolean).join('\n'),
  });
}

// {"revise":[…]} at the start of a synthesis → the requested revisions.
export function parseRevisionRequest(text, workstreams = [], limit = 3) {
  const trimmed = String(text || '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  if (!trimmed.startsWith('{') || !/"revise"/.test(trimmed.slice(0, 200))) return [];
  let parsed;
  try { parsed = JSON.parse(trimmed); } catch { return []; }
  const known = new Map(workstreams.map((entry) => [entry.id, entry]));
  return (Array.isArray(parsed?.revise) ? parsed.revise : [])
    .map((entry) => ({ workstream: String(entry?.workstream || '').toLowerCase(), instruction: String(entry?.instruction || '').trim().slice(0, 2000) }))
    .filter((entry) => known.has(entry.workstream) && entry.instruction.length >= 10 && known.get(entry.workstream).agent !== 'coding')
    .slice(0, limit);
}
