# Development Continuity POC

This Phase 1 proof is a one-shot, logically isolated controller. It does not change `src/index.js`, `src/chief.js`, the healthcheck, Docker Compose, or the deployment workflow. It does not start Fahad AI Office Step 3C.

## Scope

- Primary provider: `gpt-5.3-codex`
- Backup provider: `claude-sonnet-5`
- Repository: `FahadTrail/fahad-ai-office`
- Base branch: `main`
- Allowed change during the proof: `continuity-poc-proof.md`
- State namespace: Supabase tables and RPCs prefixed with `continuity_`
- Runtime entry point: `node src/continuity-poc.js`

The models never receive API keys, database keys, GitHub credentials, shell access, or direct infrastructure access. They return structured proposals. The controller validates those proposals and performs only the explicitly allowed operations.

## Secure server settings

The existing VPS `.env` remains the runtime secret store. The POC reads:

- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`
- `CONTINUITY_GITHUB_TOKEN`
- `SUPABASE_URL`
- `SUPABASE_SECRET_KEY` or the existing `SUPABASE_SERVICE_ROLE_KEY`
- Optional: `CONTINUITY_POC_BUDGET_USD` (default `1.5`, maximum `5`)

Do not commit these values, add them to prompts, or store them in Supabase events/checkpoints.

## State and ownership

`ops/continuity-schema.sql` creates isolated task, checkpoint, event, usage, and handoff records. Row Level Security is enabled; anonymous and authenticated roles receive no access. The server-side Supabase role is the only application role granted access.

The lease RPC guarantees one writer. The handoff RPC changes ownership and records the handoff in one transaction. A stale writer cannot finalize a task because finalization requires the current lease token.

## Controlled proof flow

1. Resolve and pin the exact current `main` SHA.
2. Acquire an exclusive task lease.
3. GPT-5.3-Codex creates the initial Markdown proof and a handoff marker.
4. The controller writes only the approved file and runs repository tests.
5. The controller stores a durable structured checkpoint.
6. The adapter simulates two HTTP 429 responses during verification.
7. The controller stores the failover checkpoint, verifies Git/checkpoint consistency, and atomically transfers ownership.
8. Claude Sonnet 5 receives the verified handoff, preserves GPT's content, and completes the marker.
9. The controller writes Claude's continuation and reruns tests.
10. The controller creates one idempotent commit and pull request and records the result.

The production runtime never invokes this entry point automatically. Run it only after the schema and server-side credentials are present:

```sh
cd /opt/fahad-ai-office
docker compose run --rm --no-deps runtime node src/continuity-poc.js
```

Generated proof files remain in their evidence pull requests and are not part of the controller source merged into `main`. The simulated failure adapter is confined to this manual POC entry point; the reusable provider adapters do not simulate failures.

## Failure behavior

- HTTP 429, 5xx, and temporary network failures receive at most two attempts per provider, then fail over.
- Billing or spend-limit failures fail over immediately.
- Authentication or permission failures stop as `NEEDS HUMAN APPROVAL`.
- If every configured provider is unavailable, the durable checkpoint remains and the controller returns `ALL PROVIDERS UNAVAILABLE`.
- Budget events are emitted at 70% and 90%; 100% is a hard stop.
- Repeated identical progress triggers a loop guard.

## Verification

The repository test suite covers failure classification, budget thresholds, no-progress protection, envelope/tool restrictions, checkpoint/Git mismatch rejection, transfer-before-Claude ordering, actual Claude continuation of GPT content, persistence-failure billing protection, and idempotent GitHub publication.
