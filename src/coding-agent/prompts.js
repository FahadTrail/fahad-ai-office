import { renderRecentActivity, truncate } from '../model-gateway/agentic/conversation.js';

export function systemPrompt({ repository, baseBranch, workBranch, testCommand, supabaseProjects = [], verifyHosts = [] }) {
  return [
    'You are the Fahad AI Office Coding Agent, an autonomous software engineer working inside an isolated sandbox',
    `that contains a clone of ${repository} on branch ${workBranch} (based on ${baseBranch}).`,
    '',
    'Work loop: understand the objective, inspect the code, record a plan with update_plan, implement, run the',
    'relevant tests/builds with run_command, debug failures, and repeat until the objective is met. Then call finish.',
    'The controller runs the test gate after finish; if it fails you will receive the failures and must fix them.',
    'After a successful gate the controller commits, pushes, opens a pull request and watches CI. If CI fails you',
    'will receive the logs and continue. You never push, merge or deploy yourself.',
    '',
    'Rules:',
    '- Make the smallest correct change that fully satisfies the objective; match the existing code style.',
    '- Add or update tests for behavior you change.',
    '- Use edit_file for targeted edits and write_file for new files; read a file before editing it.',
    '- Record important findings with record_note so they survive restarts and model switches.',
    '- Keep the plan current with update_plan, including next_action.',
    '- Never read or print secrets, .env files or credentials. Never modify anything related to Hermes.',
    '- Workflows, deployment files, migrations and credential files are protected unless the task configuration allows them.',
    '- Decide routine engineering questions yourself. Use request_human only when genuinely blocked.',
    `- Test gate command: ${testCommand || 'none configured — choose and run appropriate checks yourself'}.`,
    supabaseProjects.length ? `- Allowlisted Supabase projects: ${supabaseProjects.join(', ')} (reads are automatic; writes and migrations need owner approval).` : '',
    verifyHosts.length ? `- Allowlisted verification hosts: ${verifyHosts.join(', ')}.` : '',
  ].filter((line) => line !== '').join('\n');
}

export function initialMessage(session) {
  return [
    'OBJECTIVE (from the owner, verbatim):',
    session.objective,
    '',
    'Start by inspecting the repository structure and the code relevant to the objective, then record your plan.',
  ].join('\n');
}

// Rendered when a different model takes over (provider switch, restart on a
// new route) or when a long transcript is compacted. It carries the durable
// task state so the next model continues the same task instead of restarting.
export function continuationMessage({ session, state, plan, nextAction, recentMessages, reason, fromRoute, toRoute }) {
  const files = state.filesChanged?.length ? state.filesChanged.join(', ') : 'none yet';
  const inspected = state.filesInspected?.length ? state.filesInspected.slice(-40).join(', ') : 'none recorded';
  const steps = plan?.length ? plan.map((step, index) => `${index + 1}. [${step.status}] ${step.title}`).join('\n') : 'No plan recorded yet.';
  const notes = state.notes?.length ? state.notes.map((note) => `- ${note}`).join('\n') : '- none';
  const lastTest = state.lastTest
    ? `${state.lastTest.command} → exit ${state.lastTest.exitCode} at ${state.lastTest.at}\n${truncate(state.lastTest.output || '', 3000)}`
    : 'No test run recorded yet.';
  return [
    `CONTINUATION OF AN IN-PROGRESS TASK (${reason}${fromRoute ? `: previously handled by ${fromRoute}` : ''}${toRoute ? `, now ${toRoute}` : ''}).`,
    'You are continuing the SAME task. Do not restart from scratch: the working tree already contains the changes',
    'listed below. Re-read files before editing them, then carry on from the next action.',
    '',
    'OBJECTIVE (verbatim):',
    session.objective,
    '',
    `PHASE: ${session.phase}    ITERATION: ${session.iteration}`,
    `WORK BRANCH: ${session.workBranch || state.git?.branch || 'unknown'}    HEAD: ${state.git?.head || 'unknown'}`,
    '',
    'PLAN:',
    steps,
    '',
    `NEXT ACTION: ${nextAction || 'Re-check the working tree and continue with the first unfinished plan step.'}`,
    '',
    `FILES CHANGED: ${files}`,
    `FILES INSPECTED (recent): ${inspected}`,
    '',
    'IMPORTANT DISCOVERIES:',
    notes,
    '',
    'LAST TEST RUN:',
    lastTest,
    state.lastGateFailure ? `\nLAST GATE/CI FAILURE:\n${truncate(state.lastGateFailure, 4000)}` : '',
    state.pr ? `\nPULL REQUEST: #${state.pr.number} ${state.pr.url}` : '',
    '',
    'RECENT ACTIVITY (most recent last):',
    recentMessages?.length ? renderRecentActivity(recentMessages, { maxChars: 20_000 }) : 'none',
  ].filter((line) => line !== '').join('\n');
}

export function finalReport({ session, state, status, summary }) {
  const lines = [
    `# Coding Agent report — ${session.title}`,
    '',
    `**Status:** ${status}`,
    `**Repository:** ${session.repository} (${state.git?.branch || session.workBranch || 'n/a'})`,
    state.pr ? `**Pull request:** [#${state.pr.number}](${state.pr.url})` : null,
    state.ci ? `**CI:** ${state.ci.state}${state.ci.sha ? ` on \`${state.ci.sha.slice(0, 7)}\`` : ''}` : null,
    state.deploy ? `**Deploy:** ${state.deploy.status}${state.deploy.url ? ` ([run](${state.deploy.url}))` : ''}` : null,
    state.verify ? `**Verification:** ${state.verify.ok ? 'passed' : 'failed'} — ${state.verify.detail}` : null,
    `**Iterations:** ${session.iteration}    **Model switches:** ${session.providerSwitches}    **Cost:** $${Number(session.spentUsd || 0).toFixed(4)}`,
    `**Models used:** ${(state.routesUsed || []).join(', ') || 'n/a'}`,
    '',
    '## Summary',
    summary || state.finishSummary || 'No summary provided.',
    '',
    '## Files changed',
    state.filesChanged?.length ? state.filesChanged.map((file) => `- \`${file}\``).join('\n') : '- none',
    '',
    '## Tests',
    state.lastTest ? `\`${state.lastTest.command}\` → exit ${state.lastTest.exitCode}` : 'No test run recorded.',
    state.notes?.length ? `\n## Notes\n${state.notes.map((note) => `- ${note}`).join('\n')}` : null,
  ];
  return lines.filter((line) => line !== null).join('\n');
}
