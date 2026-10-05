# V5 Product Experience

Status: implementation baseline for `codex/v5-product-experience`.

V5 keeps the Core, Continuity runtime and production activation closed. It is
an owner-facing product layer over the existing authenticated APIs and durable
Supabase state.

## Information architecture

| Area | Owner question | Primary data |
| --- | --- | --- |
| Home | What is happening, waiting, finished and costing money? | Command Center, attention, Office, capacity, health |
| Projects | What is the objective and full state of each project? | Project context, active work, team, artifacts, approvals, timeline and cost |
| Team | Who is available, working, waiting or blocked? | The exact nine Office roles and their real assignments/results |
| Work | What jobs and coding tasks are active, and how do I start one? | Office workflows and Coding Agent sessions |
| Approvals | What exact action needs my decision? | Pending owner approvals plus owner questions |
| Continuity | Is long-running coding safe and what happens next? | Active worker, checkpoint, next action and handoffs; internals stay advanced |
| Models | Is free capacity available and what is the paid exposure? | Capacity pools, routing state, daily/monthly usage and budget |
| Files | Where are completed outputs? | Real project artifacts and results |
| Settings | Is the platform ready and how should it look/behave? | Health, provider/key presence, worker readiness and owner-safe preferences |

## Product rules

- Arabic is the default owner language; English remains selectable.
- Roles are identities and models are execution details. No role is bound to a
  permanent model.
- Every summary is derived from production data. Missing data becomes an honest
  empty or unavailable state, never a demo value.
- The top level uses owner language. Provider routes, leases, worktrees and raw
  payloads live only behind Advanced disclosure.
- Mutations remain behind the existing owner authentication, RLS, service-role
  boundary and approval RPCs.
- Polling is limited to active work. Stable pages rely on the existing live
  stream or manual navigation refreshes.

## Reuse decision

PR #71's V5/V5.1 work is already present in `main`: design tokens, responsive
shell, self-hosted Arabic font, accessible components, light Office fallback,
immersive Office, project Command Center, artifact library and real-state
presenters. V5 Product Experience reuses those pieces. It replaces the old
five-destination navigation and chat-first landing hierarchy; it does not
revive the historical branch or its stale Core snapshot.
