// Context the Chief receives with each message (project, memory, earlier
// turns, recent tasks). Pure; no database access.

// Bounded, plain-text context (at most ~6k characters) so it never dominates
// the Chief's prompt.
export function buildJobContext({ project, memory = [], turns = [], tasks = [], conversationId = null }) {
  const clip = (value, max) => { const text = String(value || '').replace(/\s+/g, ' ').trim(); return text.length > max ? `${text.slice(0, max - 1)}…` : text; };
  const lines = [];
  if (project) {
    lines.push(`Project: ${project.name}${project.default_repository ? ` (repository ${project.default_repository})` : ''}`);
    if (project.description) lines.push(`About the project: ${clip(project.description, 600)}`);
  }
  if (memory.length) {
    lines.push('Project memory (owner-curated):');
    for (const entry of memory.slice(0, 20)) lines.push(`- [${entry.kind}] ${clip(entry.content, 300)}`);
  }
  if (tasks.length) {
    lines.push('Recent development tasks:');
    for (const task of tasks.slice(0, 5)) lines.push(`- ${clip(task.title, 120)} — ${task.status}${task.result?.summary ? `: ${clip(task.result.summary, 160)}` : ''}`);
  }
  if (turns.length) {
    lines.push('Earlier in this conversation:');
    for (const turn of turns.slice(-6)) {
      lines.push(`Fahad: ${clip(turn.goal, 500)}`);
      if (turn.answer) lines.push(`Office: ${clip(turn.answer, 900)}`);
    }
  }
  const text = lines.join('\n').slice(0, 6000);
  return { text, conversationId, project: project ? { id: project.id, name: project.name, defaultRepository: project.default_repository || null } : null };
}
