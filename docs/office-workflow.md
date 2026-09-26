# Multi-agent Office workflow (2026-09-28)

The Office runs as one organization on the existing task graph
(`tasks.depends_on`, `claim_next_task` with upstream handoff content,
`complete_task` handoff rows, and `fail_task` downstream blocking). There is
no second orchestrator.

## Three ways to work

| Talk to | For | How it runs |
|---|---|---|
| **Chief of Staff** (New chat) | Any objective | Plans workstreams, dispatches employees, consolidates the result |
| **An employee** (Office → employee → Chat) | A request inside one specialty | A single `direct` task for that employee, with conversation context |
| **Coding Agent** (Tasks → Coding Agent) | A development specification | The engineering controller (plan → edit → test → PR → CI → approval → deploy → verify) |

## Roster (`src/office/agents.js`; identities in `public.agents`)

Employees are job roles, not models. Each one routes by job type on the shared
Model Pool (free-first, failover, privacy and budget rules unchanged).

| Key | Employee | Job type | Web |
|---|---|---|---|
| chief | Chief of Staff | orchestration / synthesis | — |
| research | Research (`research-strategy`) | research | yes |
| strategy | Business Strategy (`business-strategy`, new) | research | yes |
| finance | Finance (`business-finance`) | finance | when authorized |
| brand | Brand & Creative (`brand-creative`, new) | branding | — |
| content | Content & Media (`content-media`, new) | content | yes |
| product | Product & Tech (`product-tech`) | research | when authorized |
| operations | Operations | content | — |
| review | QA & Review (`qa-security`) | orchestration | — |
| coding | Coding Agent | coding (separate controller) | — |

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
