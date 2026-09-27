// Office Agent roles — the Platform dashboard's view of the roster.
// The executable roster (who runs what, and how) is src/office/agents.js.
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
import { ACTIVE_AGENTS } from '../office/agents.js';

// Per-employee tools and approvals. Skills (e.g. SEO for SOCIAL) are part of
// an employee's scope, never separate employees.
const PROFILE = {
  chief: { tools: [], approvals: [], status: 'ACTIVE — plans, dispatches and synthesizes on the shared Model Pool' },
  research: { tools: ['web_search', 'web_fetch'], approvals: [] },
  creative: { tools: [], approvals: ['publish'] },
  product: { tools: ['web_search', 'web_fetch'], approvals: [] },
  finance: { tools: ['web_search', 'web_fetch'], approvals: ['any_payment', 'external_send'] },
  coding: {
    runtime: 'coding-agent', tools: ['repo.*', 'shell.run', 'github.*', 'supabase.query_read'],
    approvals: ['github.pr_merge', 'supabase.query_write', 'supabase.migration_apply'],
    status: 'ACTIVE — Fahad Coding Agent (PR, CI, merge approval, deployment)',
  },
  audit: { tools: [], approvals: [] },
  social: { tools: ['web_search', 'web_fetch'], approvals: ['publish'], skills: ['SEO', 'content calendar', 'trend research'] },
  legal: { tools: ['web_search', 'web_fetch'], approvals: [], skills: ['open-source license review', 'UAE compliance'] },
};

export const OFFICE_ROLES = Object.freeze(ACTIVE_AGENTS.map((agent) => {
  const profile = PROFILE[agent.key] || {};
  return Object.freeze({
    id: agent.key, label: agent.label, job: agent.job, runtime: profile.runtime || 'office-workflow',
    tools: profile.tools || [], approvals: profile.approvals || [], skills: profile.skills || [],
    status: profile.status || 'ACTIVE — dispatched by CHIEF or chatted with directly (shared Model Pool)',
    purpose: agent.scope, jobProfile: JOB_PROFILES[agent.job],
  });
}));

// The routing a role's worker passes to the shared gateway.
export function roleRouting(roleId, overrides = {}) {
  const role = OFFICE_ROLES.find((entry) => entry.id === roleId);
  if (!role) throw new Error(`Unknown Office role: ${roleId}`);
  return { ...overrides, job: role.job };
}
