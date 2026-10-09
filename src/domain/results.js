// Result summaries. The executive summary is only a real summary. Missing
// text stays missing. Full content and technical detail are separate views.

import { officeAgent } from '../office/agents.js';

function section(text, name) {
  const match = String(text || '').replace(/```artifact[\s\S]*?```/g, '').match(new RegExp(`^##\\s*${name}[^\\n]*\\n([\\s\\S]*?)(?=^##\\s|$(?![\\s\\S]))`, 'mi'));
  return match ? match[1].trim() : '';
}

export function executiveSummaryOf(result) {
  if (!result) return { text: null, status: 'MISSING', source: null };
  const fromContent = section(result.content, 'Executive summary') || section(result.content, 'Summary');
  if (fromContent) return { text: fromContent, status: 'PRESENT', source: 'content' };
  const stored = String(result.summary || '').trim();
  if (stored) return { text: stored, status: 'PRESENT', source: 'summary' };
  return { text: null, status: 'MISSING', source: null };
}

function verificationOf(artifacts = []) {
  const audit = artifacts.find((artifact) => artifact.type === 'audit_report' && artifact.data?.verdict);
  if (audit) return { status: String(audit.data.verdict), basis: 'audit_report' };
  const finance = artifacts.find((artifact) => artifact.type === 'financial_model' && (artifact.data?.validation?.state || artifact.data?.state));
  if (finance) return { status: String(finance.data.validation?.state || finance.data.state), basis: 'financial_model' };
  return { status: 'UNKNOWN', basis: 'UNMEASURED' };
}

function employeeOf(agents, result) {
  const agent = agents.find((row) => row.id === result.agent_id);
  const known = officeAgent(agent?.slug || result.agent_slug);
  if (!known) return agent ? { slug: agent.slug, key: agent.slug, label: agent.name || agent.slug } : null;
  return { slug: known.slug, key: known.key, label: known.label };
}

export function resultSummary({ result, job = null, task = null, agents = [], artifacts = [], files = [] } = {}) {
  if (!result) return null;
  const summary = executiveSummaryOf(result);
  const relatedArtifacts = artifacts.filter((artifact) => !result.task_id || artifact.task_id === result.task_id || artifact.id === result.id);
  const relatedFiles = files.filter((file) => !result.task_id || file.task_id === result.task_id);
  return {
    id: result.id,
    objectiveId: result.job_id || job?.id || null,
    projectId: job?.project_id || result.project_id || null,
    taskId: result.task_id || null,
    employee: employeeOf(agents, result.agent_id ? result : { ...result, agent_slug: task?.agent_slug }),
    title: task?.title || job?.title || result.title || null,
    executiveSummary: summary.text,
    summaryStatus: summary.status,
    summarySource: summary.source,
    type: result.kind || 'task',
    completionStatus: result.kind === 'final' ? 'final' : (task?.status || job?.status || 'UNKNOWN'),
    verification: verificationOf(relatedArtifacts),
    createdAt: result.created_at || null,
    completedAt: task?.completed_at || job?.completed_at || null,
    artifacts: relatedArtifacts.map((artifact) => ({ id: artifact.id, type: artifact.type, title: artifact.title || null })),
    files: relatedFiles.map((file) => ({ id: file.id, name: file.name, mimeType: file.mime_type || null })),
    audit: { resultId: result.id, taskId: result.task_id || null, jobId: result.job_id || null },
  };
}

export function resultDetail(input, { view = 'summary' } = {}) {
  const summary = resultSummary(input);
  if (!summary) return null;
  if (view === 'summary') return summary;
  const content = String(input.result?.content || '');
  if (view === 'full') return { ...summary, fullContent: content || null, fullStatus: content ? 'PRESENT' : 'MISSING' };
  return {
    ...summary,
    fullContent: content || null,
    technical: {
      format: input.result?.format || null,
      modelAttempts: input.attempts || null,
      events: input.events || null,
      tokens: input.usage?.tokens ?? 'UNKNOWN',
      costUsd: input.usage?.costUsd ?? 'UNKNOWN',
      costBasis: input.usage ? input.usage.basis : 'UNKNOWN',
    },
  };
}
