# Office Agents — architecture (readiness)

Office roles are configurations over the infrastructure the Coding Agent
already runs on. No role gets its own model client, tool layer, memory or
budget code. The registry is `src/office-agents/roles.js`.

| Role | Job (routing) | Runtime | Default tools | Approval needed for | Status |
| --- | --- | --- | --- | --- | --- |
| Research | `research` | Office workflow (`src/workflow.js`, `src/research.js`) | web search / fetch | — | ACTIVE |
| Branding | `branding` | office-agent | web search, draft files | publishing | READY — NOT ACTIVE |
| Content | `content` | office-agent | web search, draft files | publishing | READY — NOT ACTIVE |
| SEO | `seo` | office-agent | web search / fetch | publishing | READY — NOT ACTIVE |
| Finance | `finance` | office-agent | read files / sheets | any payment, sending externally | READY — NOT ACTIVE |
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
