# Open-source capability audit (2026-09-27)

Policy: **open-source first, never silently.** Before building a capability
the Office checks for a maintained open-source project; adoption passes the
LEGAL license gate (`src/office/license-gate.js`, decisions in
`legal/license-decisions.json`, enforced by `test/license-gate.test.js`):

* MIT / Apache-2.0 / BSD / ISC / 0BSD → pass automatically.
* Copyleft (GPL, AGPL, LGPL, MPL…), source-available (BUSL, Elastic, SSPL,
  Commons Clause), proprietary or unclear → LEGAL records one of
  **APPROVED / APPROVED WITH CONDITIONS / REVIEW REQUIRED / DO NOT USE**.
  CI fails while any installed package has no decision.

Evidence labels: **VERIFIED** (read on the project's own page this pass),
**LIKELY** (known, not re-read this pass), **UNKNOWN**.

## Installed dependencies (lockfile, 119 packages)

| Package | License | Gate |
|---|---|---|
| `@supabase/supabase-js` and its tree | MIT / ISC / BSD | PASS |
| `@anthropic-ai/sdk` | MIT | PASS |
| `@anthropic-ai/claude-agent-sdk` (+ 8 platform binaries) | Proprietary — "© Anthropic PBC … subject to the Legal Agreements" (VERIFIED, `LICENSE.md` in the package) | APPROVED WITH CONDITIONS — used unmodified as a client under the account's Anthropic terms; not redistributed outside the runtime image |
| `fast-sha256` | Unlicense | APPROVED (public-domain dedication) |

## Candidates evaluated

### OmniRoute — optional multi-provider gateway

* **PROJECT:** [diegosouzapw/OmniRoute](https://github.com/diegosouzapw/OmniRoute)
* **PURPOSE:** OpenAI-compatible `/v1` gateway across hundreds of providers
  with quota-aware fallback, circuit breakers and token compression.
* **LICENSE:** MIT (VERIFIED on the repository page).
* **MAINTENANCE:** very active — v3.8.x releases, ~9.3k commits, ~70k stars (VERIFIED).
* **SECURITY:** local-first, keys encrypted at rest (AES-256-GCM, per its
  docs). Risks: it aggregates **free tiers of 150+ providers and itself marks
  13 providers "avoid" for terms-of-service risk**; it advertises "TLS
  fingerprint stealth". Silent rerouting between providers would defeat our
  free-route guarantee (`free-guard.js`: a billed call on a free route is
  charged, blocked 24 h and failed over) and our per-provider privacy flags.
* **REUSE:** its provider catalog and quota notes are useful research input.
* **INTEGRATION COST:** low technically (one OpenAI-compatible adapter),
  high in governance (another secret store, another router whose choices we
  cannot audit per call).
* **RECOMMENDATION:** **Do not put it in the default path.** If Fahad wants
  it, add it as ONE optional Model Pool route (`omniroute:<model>`) with
  billing class `UNKNOWN → treated as PAID`, privacy flag off, pinned to an
  explicit upstream model, no automatic fallback inside OmniRoute, and only
  after a live `canary:agentic` proves the upstream and the billing. Providers
  it marks "avoid" stay excluded. Not integrated in this build.

### OpenCode — optional CODING backend

* **PROJECT:** [anomalyco/opencode](https://github.com/anomalyco/opencode) (by the SST team)
* **PURPOSE:** model-agnostic open-source coding agent; client/server design
  with `opencode serve` (headless HTTP server) and an SDK.
* **LICENSE:** MIT (VERIFIED).
* **MAINTENANCE:** very active — ~15.8k commits, ~210k stars (VERIFIED).
* **SECURITY:** its default "build" agent has full shell/file access; our
  Coding Agent's safety comes from the Tool Broker (AUTO / APPROVAL / DENY,
  protected paths, Hermes and secret isolation, audited `tool_executions`),
  the sandbox uid isolation and the test/PR/CI gate. OpenCode would have to
  run **inside the same sandbox, with its tools replaced or wrapped by the
  Tool Broker**, or it bypasses every one of those controls.
* **REUSE:** its prompts, edit strategies and LSP integration are good
  references for our agent loop.
* **INTEGRATION COST:** medium–high: a new worker backend, broker-mediated
  tools (via MCP), mapping its sessions to `agent_sessions`/checkpoints, and
  re-running the security suite.
* **RECOMMENDATION:** **Evaluate later as an optional backend behind a
  feature flag**, only with Tool-Broker-mediated tools. The current Coding
  Agent is live-validated end to end (including today's Chief → Coding test,
  PR #56, CI green), so there is no reason to switch now.

### JEV — decision layer (not an employee)

Decision recorded in `docs/providers.md`: JEV stays an **optional,
measurable, removable** decision layer and is never shown as an employee.
Not integrated in this build; it needs a measured benefit (routing quality
or cost) on real Office jobs before it can be enabled.

### Built in-house on purpose (no dependency added)

| Need | Choice | Why |
|---|---|---|
| Charts, timelines, boards, moodboards | Own SVG/HTML renderers (`src/hub-ui/artifacts.js`) | ~250 lines, no bundle step, escapes every value; chart libraries (e.g. Chart.js, MIT — LIKELY) would add a build pipeline for little gain |
| Telegram channel | Plain Bot API over `fetch` (`src/channels/telegram.js`) | A handful of endpoints; libraries such as grammY (MIT — LIKELY) are not needed |
| Model gateway | Own Model Pool | Needs per-call billing truth, free-route guarantee and privacy flags that general gateways do not enforce |
