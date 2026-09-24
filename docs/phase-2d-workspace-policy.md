# Phase 2D workspace policy operations

Phase 2D is a controller-side guard around the existing provider-neutral Model
Gateway. Jobs with a non-null workspace are enforced selectively and fail
closed. Legacy jobs without a workspace remain unchanged while
`WORKSPACE_POLICY_ENFORCEMENT_ENABLED=false`.

## Enforced boundary

- A request must include workspace, job, task and run identifiers that belong
  to one database lineage.
- Every provider and exact model on the primary or fallback route must be
  enabled for that workspace.
- Provider permissions store an opaque `env://` or `vault://` reference. They
  never store, return or log a credential value.
- Every model-host tool requires an exact automatic grant. Future broker calls
  additionally enforce broker, action, scope and risk.
- A request budget is capped by the workspace's remaining monthly budget and
  per-request maximum.
- The database reserves budget under the model idempotency key before a call
  and settles the reservation with measured cost afterward.

## Review and activation order

1. Review and merge the Phase 2D pull request only after separate approval.
2. Apply the migration through the protected database process only after
   separate production-migration approval.
3. Create one disabled workspace policy for each intended project using the
   server-side service role. Add exact Anthropic/DeepSeek model permissions and
   only the minimum tool grants needed by that workspace.
4. Set a current budget period, monthly limit and smaller per-request limit.
5. Run the read-only health check. It always verifies the policy tables and RPC
   visibility without making a model call or database write.
6. Enable the policy row and run an isolated workspace canary. The global
   runtime flag is not required for workspace-scoped jobs and stays disabled
   until legacy jobs have been migrated deliberately.
7. Keep Anthropic as the default route. DeepSeek remains available only where
   both the global route and the workspace policy explicitly allow it.

## Rollback

Disable the affected workspace policy row to stop new model calls for that
workspace. To restore the pre-canary runtime behavior, deploy the protected
baseline SHA. `WORKSPACE_POLICY_ENFORCEMENT_ENABLED=false` continues to keep
legacy jobs outside enforcement. Policy tables and audit records can remain for
forensic evidence and a later corrected rollout.
