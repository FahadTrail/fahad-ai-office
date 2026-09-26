# Office Agents — on the shared Model Pool

**Status (2026-09-26): Office runs on the shared Model Pool.** Every Office
stage asks for a job type, and the same `AgentTurnGateway` that runs the Coding
Agent picks the model. There is no second router.
Code: `src/office/pool-runner.js`, `src/office/web-tools.js`, `src/workflow.js`.
Rollback: set `OFFICE_MODEL_POOL=false` to return to the legacy Anthropic-first
gateway.

## How an Office job is routed

| Stage | Agent | Job type | Notes |
| --- | --- | --- | --- |
| Plan | Chief of Staff | `orchestration`, or `synthesis` for long or high-stakes goals | Classifies the request and picks the specialist: research, content, branding, SEO or finance. |
| Work | Specialist | `research`, `content`, `branding`, `seo` or `finance` | Research, SEO and finance get the web tools. |
| Review | Chief of Staff | `synthesis` | Final answer to Fahad. Needs reasoning 4 and writing 4; escalates when no free model qualifies. |

**Filters and order.** Routes are filtered first by:
* job capability;
* tool calling;
* context size;
* data class (privacy);
* workspace authorization;
* health and cooldown;
* budget.

The remaining routes are ordered free → included → promo → paid, and then by
cost and job fit.

**Data class.**
* Office requests are `general` by default and may use free providers.
* A request is treated as `confidential` if any of these hold:
  * it starts with `[confidential]`;
  * it contains credential-shaped text, e-mail addresses, phone, card or IBAN
    numbers;
  * `OFFICE_DEFAULT_DATA_CLASS=confidential` is set.
* Confidential requests only reach providers approved for private data, and
  web search is disabled for them.

**Web tools.** Any tool-capable model can use them.
* `web_search` uses Google Search grounding through the existing Gemini key
  (Flash-Lite).
* `web_fetch` performs a public HTTP(S) GET. It refuses private, local and
  metadata addresses (re-checked on every redirect), non-web ports, URLs with
  credentials, and Hermes hosts.

**Continuity.**
* A provider failure (rate limit, 5xx, drill) or an escalation is checkpointed
  (a `model_checkpoint` event) before another model is prompted.
* The next model receives the task plus the tool calls already made and their
  results, so completed work is not redone.
* Escalation happens when a model's output fails the stage contract, is empty,
  or is truncated. The insufficient model is excluded for that stage and the
  router picks the cheapest remaining suitable one. Paid models are reached
  only within the workspace budget.

**Owner drills.** These markers work in Hub chat only and are never shown to
models:
* `[drill:failover]` injects ONE simulated rate limit into the specialist stage
  after its first real step.
* `[drill:escalate]` treats the first plan as insufficient ONCE.

Both are reported as SIMULATED. `OFFICE_DRILLS_ENABLED=false` disables them.

**Audit.**
* `model_attempts` rows record every model attempt.
* `events` carry `model_stage_started`, `model_route` (the full path, tools,
  tokens, cost and estimated saving), `model_checkpoint`, `provider_switch` and
  `model_escalation`.
* Hub → Platform → OFFICE AGENTS shows the live roles, each job's model path
  and the estimated saving.

## Roles

Office roles are configurations over the infrastructure the Coding Agent
already runs on. No role gets its own model client, tool layer, memory or
budget code. The registry is `src/office-agents/roles.js`.

| Role | Job (routing) | Runtime | Default tools | Approval needed for | Status |
| --- | --- | --- | --- | --- | --- |
| Chief of Staff | `orchestration` / `synthesis` | Office workflow (`src/chief.js`) | — | — | ACTIVE |
| Research | `research` | Office workflow (`src/workflow.js`, `src/research.js`) | web_search / web_fetch | — | ACTIVE |
| Branding | `branding` | Office workflow (delegated by Chief) | — | publishing | ACTIVE |
| Content | `content` | Office workflow (delegated by Chief) | — | publishing | ACTIVE |
| SEO | `seo` | Office workflow (delegated by Chief) | web_search / web_fetch | publishing | ACTIVE |
| Finance | `finance` | Office workflow (delegated by Chief; analysis only, never moves money) | web_search / web_fetch | any payment, sending externally | ACTIVE |
| Development | `coding` | Coding Agent (`src/coding-agent/`) | repo, shell, GitHub, Supabase read | merge, SQL writes, migrations | ACTIVE |
| QA / Security | `qa_security` | Coding Agent (read-only mode) | repo read, shell, GitHub read | any write | READY — NOT ACTIVE |

## Shared building blocks (reused, never duplicated)

* **Model choice:** `AgentTurnGateway` plus the Model Pool, called with
  `routing.job = role.job` (`roleRouting()`). Free and included capacity comes
  first, and capability gates stop incapable models from getting the job
  (see `docs/providers.md`).
* **Continuity:** `agent_sessions`, checkpoints and handoffs
  (`src/agent-state/`). A role survives provider switches and restarts exactly
  like the Coding Agent does.
* **Tools:** the Tool Broker (`src/tool-broker/`), with per-workspace grants in
  `workspace_tool_grants` (AUTO / APPROVAL / DENY). Every call is audited in
  `tool_executions`.
* **Usage and budgets:** `model_attempts` audit, workspace budget reservations
  (`workspace_policies`), per-route monthly caps
  (`workspace_routing_policies`), and the platform dashboard's USAGE & LIMITS.
* **Approvals:** `agent_approvals`, decided in Hub → Platform → APPROVALS.

## Activating a role (future work, per role)

1. Add the role's tool definitions to a broker client, or reuse existing ones.
   Grant them per workspace.
2. Run a worker loop on `CodingAgentController`'s pattern with
   `routing.job = role.job`, or extend the Office workflow for text-only roles.
3. Flip the role's `status` in `src/office-agents/roles.js`. Add tests that
   exercise its tools, approvals and routing.
