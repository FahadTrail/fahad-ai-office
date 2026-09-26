// Office Agent roles — architecture registry (not yet executing).
//
// Every role is a configuration over the SAME shared infrastructure the
// Coding Agent already uses; nothing here duplicates it:
//   model choice   → Model Pool + AgentTurnGateway, routed by `job`
//                    (capabilities.js), free/included capacity first
//   tools          → Tool Broker grants per workspace (AUTO / APPROVAL / DENY)
//   continuity     → agent_sessions / checkpoints / handoffs (agent-state)
//   usage + budget → model_attempts audit, workspace budget reservations,
//                    per-route caps (routing-policy.js)
// A role becomes active only when a worker is wired for it; until then the
// dashboard shows it as READY — NOT ACTIVE.

import { JOB_PROFILES } from '../model-gateway/agentic/capabilities.js';

export const OFFICE_ROLES = Object.freeze([
  {
    id: 'chief', label: 'Chief of Staff', job: 'orchestration', runtime: 'office-workflow',
    tools: [], approvals: [], status: 'ACTIVE — plans (orchestration) and reviews (synthesis) on the shared Model Pool',
    purpose: 'Classifies the request, picks the specialist, writes the handoff and reviews the result; escalates high-stakes work.',
  },
  {
    id: 'research', label: 'Research', job: 'research', runtime: 'office-workflow',
    tools: ['web_search', 'web_fetch'], approvals: [], status: 'ACTIVE — delegated by Chief (shared Model Pool)',
    purpose: 'Evidence gathering and analysis with cited sources.',
  },
  {
    id: 'branding', label: 'Branding', job: 'branding', runtime: 'office-agent',
    tools: [], approvals: ['publish'], status: 'ACTIVE — delegated by Chief (shared Model Pool)',
    purpose: 'Names, positioning, tone of voice and brand guidelines.',
  },
  {
    id: 'content', label: 'Content', job: 'content', runtime: 'office-agent',
    tools: [], approvals: ['publish'], status: 'ACTIVE — delegated by Chief (shared Model Pool)',
    purpose: 'Articles, posts and copy drafts; nothing is published without approval.',
  },
  {
    id: 'seo', label: 'SEO', job: 'seo', runtime: 'office-agent',
    tools: ['web_search', 'web_fetch'], approvals: ['publish'], status: 'ACTIVE — delegated by Chief (shared Model Pool)',
    purpose: 'Keyword research, on-page audits and content briefs.',
  },
  {
    id: 'finance', label: 'Finance', job: 'finance', runtime: 'office-agent',
    tools: ['web_search', 'web_fetch'], approvals: ['any_payment', 'external_send'], status: 'ACTIVE — delegated by Chief (shared Model Pool)',
    purpose: 'Budgets, forecasts and cost analysis; never moves money.',
  },
  {
    id: 'development', label: 'Development', job: 'coding', runtime: 'coding-agent',
    tools: ['repo.*', 'shell.run', 'github.*', 'supabase.query_read'], approvals: ['github.pr_merge', 'supabase.query_write', 'supabase.migration_apply'],
    status: 'ACTIVE — Fahad Coding Agent', purpose: 'Autonomous development through PR, CI, merge approval and deployment.',
  },
  {
    id: 'qa_security', label: 'QA / Security', job: 'qa_security', runtime: 'coding-agent',
    tools: ['repo.read', 'shell.run', 'github.read'], approvals: ['any_write'], status: 'READY — NOT ACTIVE',
    purpose: 'Test and security review of changes; read-only by default.',
  },
].map((role) => Object.freeze({ ...role, jobProfile: JOB_PROFILES[role.job] })));

// The routing a role's worker passes to the shared gateway.
export function roleRouting(roleId, overrides = {}) {
  const role = OFFICE_ROLES.find((entry) => entry.id === roleId);
  if (!role) throw new Error(`Unknown Office role: ${roleId}`);
  return { ...overrides, job: role.job };
}
