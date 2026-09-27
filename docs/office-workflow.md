# Multi-agent Office workflow (2026-09-28)

The Office runs as one organization on the existing task graph
(`tasks.depends_on`, `claim_next_task` with upstream handoff content,
`complete_task` handoff rows, and `fail_task` downstream blocking). There is
no second orchestrator.

## Three ways to work

| Talk to | For | How it runs |
|---|---|---|
| **CHIEF** (Hub home, or Telegram) | Any objective | Plans workstreams, dispatches employees, synthesizes one result |
| **An employee** (Employees → employee → Chat) | A request inside one specialty | A `direct` task; the employee may consult up to two colleagues first (`consult` tasks), then answers |
| **CODING** (Tasks → Coding Agent) | A development specification | The engineering controller (plan → edit → test → PR → CI → approval → deploy → verify) |

## Roster (`src/office/agents.js`; identities in `public.agents`)

Nine visible employees, no human names. Employees are job roles, not models:
each routes by job type on the shared Model Pool (free-first, failover,
privacy and budget rules unchanged). Retired identities (Business Strategy,
Operations) stay in history and route new work to PRODUCT.

| Key | Employee | Job type | Web | Artifacts |
|---|---|---|---|---|
| chief | CHIEF (`chief-of-staff`) | orchestration / synthesis | — | table, checklist, timeline |
| research | RESEARCH (`research-strategy`) | research | yes | evidence (VERIFIED/LIKELY/UNKNOWN), table, risk_matrix |
| creative | CREATIVE (`brand-creative`) | branding | — | moodboard (palette, fonts, concepts), table |
| product | PRODUCT (`product-tech`, absorbs Business Strategy) | research | yes | kanban, timeline, flow, checklist, table |
| finance | FINANCE (`business-finance`) | finance | yes | financial_model (KNOWN/ESTIMATED/ASSUMPTION), chart, table |
| coding | CODING (`coding-agent`) | coding (separate controller) | — | PR, CI, deployment |
| audit | AUDIT (`qa-security`) | orchestration | — | audit_report (PASS/NEEDS WORK/BLOCKED, issue owners), checklist |
| social | SOCIAL (`content-media`, SEO is a skill) | content | yes | content_calendar, table |
| legal | LEGAL (`legal-compliance`, new) | research | yes | compliance_matrix (jurisdiction, source, date, classification) |

**Nicknames.** Fahad can name employees in Gulf Arabic or English capitals —
"حولها للفاينانس", "خل الليغال يراجع", "اسأل الريسيرش", "خل الكرييتف يشتغل
عليها", "حول المشروع للكودينج", "let LEGAL review". `mentionedEmployees()`
detects them (Arabic prefixes لل/بال/و… included) and CHIEF is told to route
to exactly those employees.

**Artifacts.** Employees emit ` ```artifact ` JSON blocks; the workflow
validates them (`src/office/artifacts.js`, 13 types), stores them in
`public.artifacts`, and the Hub draws them (`src/hub-ui/artifacts.js`: SVG
charts, boards, moodboards, matrices). Agents never produce HTML.

**Knowledge.** Links under `## Sources` become `knowledge_items` with an
expiry (LEGAL 180 days, PRODUCT 120, RESEARCH 90, FINANCE 60, SOCIAL 30) and
are given back to that employee on the next task in the project.

**Memory types.** fact, decision, preference, constraint, product/technical/
brand decision, legal requirement, financial assumption.

**Channels.** `src/channels/office-bridge.js` is transport-neutral (Telegram
now, WhatsApp later with the same `handleMessage` / `outbox` / `decide`).
Telegram (`src/channels/telegram.js`) is owner-only, rate limited, sends
results and approval requests with Approve/Reject buttons, and deep-links to
the Hub.

## Chief orchestration (`chief.js` route `orchestrate`, `workflow.js`)

1. **Plan.** The Chief returns 1–8 workstreams, each with an employee, a
   self-contained brief and `depends_on`. `validateOrchestration` rejects:
   - unknown employees,
   - cycles,
   - unknown dependencies,
   - more than 8 workstreams,
   - more than one development workstream.
2. **Dispatch.** There is one durable task per workstream (sequence
   100 + index) and a Chief synthesis task (900) that depends on all of them.
   Independent workstreams run in parallel: the worker claims up to
   `OFFICE_PARALLEL_TASKS` (default 3).
3. **Work.** Each employee receives the objective, the Chief's brief, project
   context and the outputs it depends on. It returns the output contract:
   `## Summary / ## Work / ## Handoff / ## Decisions for Fahad / ## Sources`.
   - The output is a `results` row.
   - `complete_task` writes a handoff row per dependency edge.
   - An `output_ready` event marks the delivery.
4. **Development workstream.**
   - The Coding Agent receives the brief plus the outputs it depends on as its
     own session (`create_coding_session`, created by `chief-of-staff`).
   - With no project repository, the output says so; nothing is pretended.
5. **Synthesis.**
   - The Chief consolidates every output.
   - Round 1 may instead request revisions: at most 3, in one round only.
     Those employees redo their work with the instruction, then a final
     synthesis (sequence 950) runs.
   - A malformed revision request is re-run as a plain synthesis, so it is
     never shown as the answer.
6. **Failure.** A workstream that exhausts its retries fails. Everything
   downstream is blocked and the objective fails visibly; nothing is invented.

## Live Office (`src/hub-office.js`, Hub → Office)

- **Where states come from.** Employee states are derived only from task,
  session and approval rows:
  - THINKING / REVIEWING: the Chief planning or synthesizing.
  - WORKING: a running workstream.
  - TESTING: Coding Agent test, debug or CI phases.
  - WAITING: dependencies not done yet.
  - BLOCKED: failed, or blocked upstream.
  - NEEDS FAHAD: pending approval or a question.
  - COMPLETED: delivered in the last 15 minutes.
  - AVAILABLE: otherwise.
- **APIs:**
  - `/api/office` — states and recent handoffs;
  - `/api/agents/:slug` — employee page;
  - `/api/workflows[/:jobId]` — workflow graph, outputs, decisions, final result;
  - `/api/capabilities` — connectors, reported "Connected" only with evidence
    of a real successful use.

## Schema (`20260928090000_office_multi_agent.sql`, additive)

- New agents: `business-strategy`, `brand-creative` and `content-media`.
- `conversations.agent_slug` for direct conversations.

## Glossary

- **workstream**: A single thread of specialized tasks assigned to one agent.
- **handoff**: The process of passing completed output from one agent to the next or to the Chief of Staff.
- **synthesis**: The consolidation of multiple workstream outputs into a single, coherent final answer.
- **revision**: The process of reviewing and adjusting work to ensure it meets the original goal.
