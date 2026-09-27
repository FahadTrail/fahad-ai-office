// Executors for Office employees. Each call goes through the shared Model
// Pool (`run`), routed by the employee's job type; the employee's identity
// and system prompt come from public.agents.
import { RESEARCH_MAX_TURNS, CHIEF_MAX_TURNS } from '../config.js';
import { runModel } from '../model-runner.js';
import { DISPATCHABLE, OUTPUT_CONTRACT, officeAgent } from './agents.js';
import { artifactInstructions } from './artifacts.js';

export function knowledgeBlock(items = []) {
  if (!items.length) return '';
  return ['CURATED KNOWLEDGE (sources the Office validated earlier; re-check anything time-sensitive):',
    ...items.slice(0, 8).map((item) => `- ${item.title}${item.source_url ? ` — ${item.source_url}` : ''}${item.source_date ? ` (${item.source_date})` : ''}`)].join('\n');
}

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
export async function performOfficeWork({ agent, role, goal, brief, title, upstream = [], context = '', knowledge = [], revision = null, previous = null, webTools = false, run = runModel, onActivity, execution = {} }) {
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
      `CHIEF assigned you this workstream: "${title}". Do the work yourself, completely; do not ask for permission.`,
      'Write your whole deliverable in the language of Fahad\'s ORIGINAL OBJECTIVE below, whatever language the other inputs use.',
      webTools ? 'Use the web tools to verify current facts and cite sources.' : 'You have no web access in this task: rely on the inputs and label assumptions.',
      ...OUTPUT_CONTRACT,
      ...employee.contract,
      ...artifactInstructions(employee.artifacts),
      '',
      `ORIGINAL OBJECTIVE FROM FAHAD: ${goal}`,
      `CHIEF'S BRIEF: ${brief}`,
      context ? `PROJECT CONTEXT:\n${context}` : '',
      knowledgeBlock(knowledge),
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
      'You are CHIEF. Your employees have completed the workstreams you dispatched.',
      'Synthesize their persisted outputs into ONE coherent result for Fahad — do not concatenate reports.',
      'Write the whole result in the language of the ORIGINAL OBJECTIVE, whatever language the employee outputs use.',
      'Remove duplicates, surface contradictions between employees and say how you resolved them (or that they remain open).',
      'Credit employees by name (RESEARCH, PRODUCT, FINANCE…) where it helps. Do not pretend you did their work.',
      'Structure: "## Executive summary", the consolidated plan/answer, "## Resolved issues", "## Open issues & risks",',
      '"## Costs" (only if FINANCE contributed; keep KNOWN/ESTIMATED/ASSUMPTION labels), "## Decisions for Fahad" and "## Next actions".',
      ...artifactInstructions(['checklist', 'table']),
      'Use a "checklist" artifact for next actions when there are several.',
      allowRevision ? [
        'If AUDIT reported NEEDS WORK or BLOCKED findings owned by an employee, request those fixes from that employee.',
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
export async function converseDirect({ agent, role, goal, context = '', knowledge = [], consults = [], allowConsult = true, consultFrom = null, webTools = false, run = runModel, onActivity, execution = {} }) {
  const employee = officeAgent(role);
  return run({
    ...execution,
    maxTurns: RESEARCH_MAX_TURNS,
    allowedTools: webTools ? ['WebSearch', 'WebFetch'] : [],
    routingHints: { requiresPrivateData: true, preferQuality: true },
    systemPrompt: agent.system_prompt,
    onActivity,
    specialist: { role: employee.key, job: employee.job },
    prompt: consultFrom ? [
      `You are ${employee.label} in Fahad's AI Office. Your colleague ${consultFrom} needs your expert input. Your scope: ${employee.scope}`,
      'Answer the question precisely and concisely for your colleague, in the language of the question. Label estimates and assumptions;',
      'never invent facts. This is advice only: do not start work, change anything or ask Fahad.',
      context ? `\nPROJECT CONTEXT:\n${context}` : '',
      `\nQUESTION FROM ${consultFrom}: ${goal}`,
    ].filter(Boolean).join('\n') : [
      `You are ${employee.label} in Fahad's AI Office, and Fahad is talking to you directly. Your scope: ${employee.scope}`,
      'Answer as this employee, within your specialty, in the language of his message. If the request is outside',
      'your specialty, say which colleague (or CHIEF) should handle it, and help as far as you can.',
      'Never invent facts; label estimates. Markdown is welcome.',
      ...employee.contract,
      ...artifactInstructions(employee.artifacts),
      allowConsult ? [
        'If you genuinely need a colleague\'s input first (for example FINANCE needing infrastructure estimates from CODING),',
        'reply with ONLY a JSON object {"consult":[{"employee":"<key>","question":"<precise question>"}]} (at most 2).',
        `Colleague keys: ${DISPATCHABLE.filter((key) => key !== employee.key).join(', ')}. Otherwise answer directly.`,
      ].join('\n') : '',
      consults.length ? `\nANSWERS FROM COLLEAGUES YOU CONSULTED:\n${upstreamBlock(consults)}` : '',
      context ? `\nCONTEXT (project and earlier messages in this conversation):\n${context}` : '',
      knowledgeBlock(knowledge),
      `\nFAHAD'S MESSAGE: ${goal}`,
    ].filter(Boolean).join('\n'),
  });
}

// {"consult":[…]} from a direct conversation → colleagues to ask first.
export function parseConsultRequest(text, self, limit = 2) {
  const trimmed = String(text || '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  if (!trimmed.startsWith('{') || !/"consult"/.test(trimmed.slice(0, 200))) return [];
  let parsed;
  try { parsed = JSON.parse(trimmed); } catch { return []; }
  const seen = new Set();
  return (Array.isArray(parsed?.consult) ? parsed.consult : [])
    .map((entry) => ({ employee: officeAgent(entry?.employee), question: String(entry?.question || '').trim().slice(0, 2000) }))
    .filter((entry) => entry.employee && DISPATCHABLE.includes(entry.employee.key) && entry.employee.key !== self && entry.question.length >= 10 && !seen.has(entry.employee.key) && seen.add(entry.employee.key))
    .slice(0, limit)
    .map((entry) => ({ employee: entry.employee.key, question: entry.question }));
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
