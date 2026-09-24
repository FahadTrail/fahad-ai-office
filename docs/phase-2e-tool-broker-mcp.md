# Phase 2E Tool Broker + MCP foundation

## Boundary

Phase 2E adds one governed execution path for future agent tools without
changing the Model Gateway or the existing Chief → Research → Chief behavior.
The workflow can receive a lineage-bound `ScopedToolBrokerSession`; when no
broker is configured, runtime behavior is unchanged.

The path is:

`Agent → Scoped session → Tool Broker → workspace/agent policy → MCP client → tool result → audit`

Provider-native Research web tools remain unchanged in this phase. Moving
those proven tools behind the broker is a later, separately reviewed canary.

## Controller-owned catalog

MCP discovery is necessary but never sufficient for authorization. Every tool
must also exist in the controller-owned catalog, which defines its broker,
server, action, scopes, risk, agent permission, secret reference, schemas,
timeout, retry policy, and conservative cost estimate. MCP annotations are
display metadata only and cannot lower controller risk.

The first synthetic canary server is in-process and has no network or secret
access. It exposes only:

- `office.echo`: echoes a bounded non-sensitive message.
- `office.current_time`: returns the broker clock.

Both are low-risk and zero-cost. They prove MCP initialize, `tools/list`,
`tools/call`, input/output schema validation, policy checks, result return,
idempotency, and audit completion without contacting an external service.

## Authorization and risk

Every call requires matching workspace/job/task/run/agent lineage, an active
agent permission, and an exact enabled workspace grant for broker, tool,
action, scopes, risk boundary, and opaque secret reference. A missing or
invalid field fails before MCP execution.

Effective decisions use the stricter of the workspace grant and controller
minimum:

- `AUTO`: eligible for autonomous execution after all checks pass.
- `APPROVAL`: recorded as approval-required and not executed.
- `DENY`: recorded as denied and not executed.

High-risk catalog entries have an irreducible `APPROVAL` floor. Critical
entries have an irreducible `DENY` floor. Destructive production changes,
payments, credential or permission changes, and sensitive publishing must be
cataloged at one of those floors rather than as low-risk tools.

## Credentials, budgets, retries, and idempotency

Only opaque `env://` or `vault://` references can be stored. Phase 2E resolves
allowlisted `env://` values inside the broker and passes the value only to the
broker-owned transport invocation. Credentials are absent from model context,
audit rows, exceptions, returned results, and tool-call metadata.

Costed tools reserve their controller estimate from the existing workspace
budget before execution and settle with measured cost afterward. The phase
sets a conservative per-call catalog ceiling of $0.10.

The execution ledger has a unique `(workspace_id, idempotency_key)` boundary.
A successful duplicate returns a metadata-only replay without another
external call; an active duplicate returns `in_progress`. Retries are limited
to cataloged retry-safe operations, at most three retries, and bounded
timeouts. Invalid output fails closed and is audited.

## Audit and database security

`tool_executions` stores workspace/job/task/run/agent lineage, broker/tool/
action, scopes, risk, decision, server/protocol, idempotency and retry state,
timestamps/duration, success/failure, hashes, output size, and cost. It does
not store arguments, results, prompts, repository content, or credential
values.

The table has RLS enabled, no user policies, and explicit service-role-only
table and RPC grants. A trigger rechecks workspace lineage and run-agent
ownership. `begin_tool_execution` and `finish_tool_execution` use short,
single-row transactions and row locks to serialize duplicate execution.

## Deployment state

This branch only prepares the migration and runtime foundation. It does not
apply the migration, configure an external MCP server, enable a broker in the
production worker, merge, or deploy. Production remains on the protected
Phase 2D baseline until separate approval.

## Verification

- `npm test`: all isolated workflow, gateway, workspace-policy, migration,
  broker, MCP, secret, retry, budget, and audit tests.
- `npm run canary:tool-broker`: zero-network synthetic broker/MCP canary.
- `npm run healthcheck`: after the migration is separately applied, confirms
  the service-role API exposes the two broker RPCs and audit table without
  invoking a tool or performing a write.
