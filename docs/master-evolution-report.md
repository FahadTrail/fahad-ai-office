# Fahad AI Office — Master Evolution report (2026-09-27, final)

Evidence labels: **VERIFIED** (seen in production data or a real run),
**TESTED** (automated tests only), **NOT VERIFIED** (with the reason).
Budget rule for this phase: free routes only; the workspace routing policy was
set to `allow_paid=false` for the live validation and nothing paid was spent
(live run cost: **$0.0000**).

## 1. Baseline
Production runs `main` at `149d9b8` (PR #57 roster/UI, PR #58 live-run fixes); 311 tests pass;
CI green on every merged PR. Schema fingerprint in production equals
`supabase/verify/schema-fingerprint.txt` (945 objects, digest `a7fb7bb7…`). VERIFIED.

## 2. Chief → Coding live test
CHIEF handed a small docs change to CODING → session `898a5c1e` → PR #56 →
test gate `npm test` exit 0 → CI green → merged by the Office autonomously as
routine (docs-only; the deploy workflow correctly skips docs). Cost $0.0054
(DeepSeek, before the free-only policy). VERIFIED.

## 3. Supabase tools for CODING
`CODING_SUPABASE_ACCESS_TOKEN` is not configured; no `supabase.*` tool
execution exists in production, so the read test could not run. The tools are
hidden and fail closed. OWNER ACTION.

## 4. Roster
CHIEF, RESEARCH, CREATIVE, PRODUCT, FINANCE, CODING, AUDIT, SOCIAL, LEGAL are
the active identities in `public.agents`; Business Strategy and Operations are
inactive with history kept. VERIFIED (production rows).

## 5. Nicknames
Arabic nicknames with prefixes (لل/بال/و…) and English capitals resolve
(`mentionedEmployees`). CHIEF is told which employees Fahad named. TESTED;
a live direct chat in Arabic ("اسأل الكودينج") showed the model ignoring the
request → fixed: named colleagues are now consulted deterministically (PR #58).

## 6. RESEARCH
Live: delivered a competitor table and an evidence artifact, labelling every
claim **LIKELY** because web search was rate-limited — the honesty rule held.
Placeholder links it wrote were stored as sources → fixed (PR #58) and the 5
bad rows removed. VERIFIED.

## 7. CREATIVE
Live: moodboard artifact with a 5-colour hex palette, Cairo/Fraunces/Inter
typography, three logo concepts. AUDIT later flagged a WCAG contrast issue in
it. VERIFIED.

## 8. PRODUCT
Live (second run, free only): MVP kanban board, main user-journey flow,
3-month roadmap timeline and an acceptance-criteria checklist. VERIFIED.

## 9. FINANCE
Live: financial model with KNOWN/ESTIMATED/ASSUMPTION per line, two charts
(scenario bar, break-even line), 5 real pricing sources saved as knowledge.
AUDIT caught an arithmetic error in its payment-fee line. VERIFIED.

## 10. CODING
Engineering lifecycle unchanged and live-validated (section 2).
As a consultant (advice only, routed as research): TESTED; live re-run
pending PR #58 deploy (see section 34).

## 11. AUDIT
Live: verdict **NEEDS WORK**, six findings with severity and owner
(FINANCE ×2, LEGAL, PRODUCT, RESEARCH, CREATIVE) plus a remediation checklist.
VERIFIED.

## 12. SOCIAL
Live (second run, free only): a 14-day Instagram/TikTok launch content
calendar; 3 complete source links (later.com) saved as SOCIAL knowledge
with a 30-day expiry — the post-fix source parser accepted only complete
URLs. VERIFIED.

## 13. LEGAL
Live: compliance matrix (jurisdiction, source, date, status, classification,
uncertainty) for UAE PDPL phone-number collection plus a launch checklist; a
real `u.ae` source saved as knowledge; RISK FLAG / PROFESSIONAL REVIEW items
appear in the Command Center. VERIFIED.

## 14. CHIEF orchestration and synthesis
Live: CHIEF planned 5 workstreams + synthesis, independent ones ran in
parallel, AUDIT ran last with every output as input, and CHIEF produced one
consolidated result (executive summary, resolved issues, open risks, costs,
decisions). VERIFIED. Findings: the synthesis hit its 4,000-token cap and was
saved cut off → fixed (continuation + 8K budget, PR #58); CHIEF corrected
FINANCE's number itself instead of sending a revision (behaviour noted); the
summary total (~AED 4,000) disagrees with its own table (~AED 5,552).

## 15. Direct chats and consults
Direct chat with FINANCE in Arabic answered in Arabic with KNOWN/ESTIMATED
labels. First run: the model ignored "اسأل الكودينج" → fixed (PR #58). Second
run after the fix: FINANCE immediately created the consult task "FINANCE asks
CODING", and CODING answered in Arabic with an infrastructure table on a free
route. VERIFIED. FINANCE's final answer using that input: NOT VERIFIED DUE TO
BUDGET (see section 34).

## 16. Models are roles, not fixed models
Every stage routed by job type. Live paths: CHIEF plan on Gemini flash (free)
after an OpenRouter attempt; specialists and synthesis on OpenRouter
Nemotron-3 Ultra (free); AUDIT on Gemini flash (free). VERIFIED.

## 17. Free-first routing and qualification
With `allow_paid=false` the whole objective (7 tasks) ran on
free routes at $0 (32 model calls, every one billed as FREE, total $0.00000000); FINANCE (reasoning-4 job) found a qualifying free model.
VERIFIED.

## 18. Provider re-audit
See section 19 and `src/model-gateway/agentic/provider-facts.js` (each
provider now has an `evidence` line). Official pages could not be read
directly (build-environment egress blocks them); official-domain search
results + production evidence were used and labelled as such.

## 19. Free model / provider status (2026-09-27)
| Provider | Status | Evidence |
|---|---|---|
| OpenRouter :free | ACTIVE | Nemotron-3 Ultra served the live run; 20 RPM / 50 req/day (official docs); several Gemma/Qwen :free rate-limited upstream; inkling-small rejects the key |
| Gemini (AI Studio free) | ACTIVE | flash-latest used up its daily quota (resets midnight Pacific); flash-lite + gemma-4-26b serving; search grounding rate-limited → fallback added |
| Groq free | ACTIVE | gpt-oss-120b/20b healthy at $0; qwen3.8-27b rate-limited (8K TPM) |
| Z.ai GLM flash | ACTIVE (LIKELY free) | glm-4.5-flash $0 on 2026-09-26; glm-4.7-flash 1-concurrency limit; official pricing not re-readable |
| Cerebras | BLOCKED — trial used/expired | 46 consecutive HTTP 400; now auto-cooldown; buying credits = paid, not done |
| Mistral | NOT CONFIGURED | docs say a free mode exists; no key |
| Qwen | ACCOUNT ACTION | Model Studio not activated |
| Kimi, MiniMax, GLM-5.3 | PAID, no credits | not purchased |
| GitHub Models | RETIRED | 2026-07-30 |
| Anthropic, OpenAI, DeepSeek | PAID, healthy | not used this phase (budget) |

## 20. Dead / retired routes
GitHub Models retired (never called). Cerebras routes now cool down after 3
invalid requests instead of being probed forever. OpenRouter free models are
discovered from the live catalog (dead ones drop automatically).

## 21. Privacy classification
Unchanged and enforced: free routes are "public/non-private data only"; only
DeepSeek, Anthropic and OpenAI are approved for private code; confidential
Office requests never reach unapproved providers and web search is disabled
for them. TESTED.

## 22. Canaries
The built-in live canary re-probes paid routes not verified in 24 h
(Anthropic, OpenAI) → **NOT RUN DUE TO BUDGET**. Free routes were verified by
real production traffic instead (section 16–17).

## 23. OmniRoute
MIT, very active; optional single route only, never in the default path
(ToS-risk free tiers, opaque rerouting). Not integrated. `docs/open-source-capability-audit.md`.

## 24. OpenCode
MIT, very active; optional CODING backend only behind the Tool Broker.
Deferred — the current Coding Agent is live-validated.

## 25. JEV
Optional, measurable, removable decision layer; never an employee. Not integrated.

## 26. Open-source first and license gate
`test/license-gate.test.js` fails CI if any installed package lacks a
permissive license or a LEGAL decision (`legal/license-decisions.json`).
Claude Agent SDK: APPROVED WITH CONDITIONS. VERIFIED in CI.

## 27. Skills vs tools vs employees
SEO, content calendars and license review are skills of SOCIAL/LEGAL; tools
are the Tool Broker/web tools; employees are the nine roles.

## 28. Work graph statuses
AVAILABLE, QUEUED, THINKING, WORKING, TESTING, WAITING, REVIEWING, NEEDS
FAHAD, BLOCKED, COMPLETED, FAILED — derived only from real task/session rows.
TESTED; live states observed during the run.

## 29. Structured handoffs and token efficiency
Handoff rows per dependency edge (live: 13 handoffs in the run); upstream
outputs truncated at 12K chars per input; context budget from V2 kept.

## 30. Artifact system
13 validated types stored in `public.artifacts`. Live: 11 artifacts from 5
employees in one objective. VERIFIED.

## 31. Visual output engine
Hub renders tables, SVG bar/line/pie charts, timelines, checklists, kanban,
flows, moodboards, financial models, compliance matrices, audit reports,
calendars, evidence and risk matrices; everything escaped. TESTED + screenshots.

## 32. Project Command Center
Computed with the production code on real production rows: latest audit
NEEDS WORK, 10 open high/review risks with owners (AUDIT, LEGAL), 6 current
knowledge sources, 10 artifacts, 30-day spend, objectives. VERIFIED.

## 33. Living Office UI, employees, design tokens, mobile
Office floor from real state with handoff animation, Employees, Artifacts,
Integrations, light/dark/system theme, reduced motion, mobile layout.
TESTED + screenshots; not re-screenshotted on production (the Hub domain is
not reachable from the build environment).

## 34. Post-fix live re-verification
PR #58 merged (`149d9b8`), deployed ("DEPLOYMENT SUCCESSFUL — now running
commit 149d9b8"). Second free-only run:
* Named consult → VERIFIED (section 15).
* PRODUCT, SOCIAL, LEGAL workstreams → VERIFIED (7 artifacts, clean sources).
* FINANCE follow-up and CHIEF synthesis → **NOT VERIFIED DUE TO BUDGET**: both
  failed fast with "No model route satisfies the task policy". Root cause: the
  first run used today's free capacity for high-tier jobs — OpenRouter's key-
  level free allowance (both Nemotron routes quota-exhausted until 00:00 UTC)
  and Gemini flash cooling down — and the remaining free models are below the
  reasoning-4/writing-4 bar those stages need; paid routes were disabled by
  the free-only policy, as instructed. The synthesis-continuation fix is
  therefore verified by tests only.
* Finding: an Office task fails immediately when no route is eligible, even
  when free capacity returns at a known time. Recommended next change: park the
  task as WAITING until the earliest cooldown ends instead of failing.
* Spend for the whole phase: $0.00 (workspace spend unchanged at $1.9167).
* The temporary `allow_paid=false` routing row was removed afterwards.

## 35. Telegram → CHIEF
Built and tested (owner-only, rate limited, results + Approve/Reject, deep
links, token redacted). Not live: needs `TELEGRAM_BOT_TOKEN` and
`TELEGRAM_OWNER_CHAT_ID`. WhatsApp-ready bridge. OWNER ACTION.

## 36. Hermes
Untouched. Read-only audit script and decommission plan ready. **Not ready
for final decommission** (audit output and proven replacements missing).

## 37. Remaining blockers and owner actions
Telegram credentials; Hermes audit output; `CODING_SUPABASE_ACCESS_TOKEN`;
budget ($1.917 of $2 used until 2026-10-01 — paid work refused soon);
Qwen activation; Cerebras credits (paid, not recommended now).

## 38. Closure sprint (2026-09-27)

* **Capacity wait** (`20260930090000_office_capacity_wait`, applied; schema
  fingerprint 955 objects): a step with no free route but a recoverable one is
  checkpointed and deferred (`WAITING_FOR_CAPACITY`), then resumes on its own;
  permanent/account blockers fail clearly; waits are bounded (48, backoff up to
  60 min, 24 h cap).
* **Live, free-only, $0:** FINANCE → CODING consult — CODING answered, the
  FINANCE follow-up waited for capacity (Gemini cooldown, OpenRouter free quota
  exhausted), auto-resumed at 08:15:50 and delivered the AED estimate with
  KNOWN/ESTIMATED/ASSUMPTION labels. CHIEF long synthesis — 7,637 chars, six
  distinct sections, closed artifact blocks, stored once.
* **Supabase Coding tools:** VERIFIED by the worker's start-up self-check
  (`supabase_read_only_user`, scope enforced, write blocked, no secret exposed).
* **Telegram:** code-complete; needs only `TELEGRAM_BOT_TOKEN` and
  `TELEGRAM_OWNER_CHAT_ID`.
* **Hermes:** untouched; separation guarded by `test/hermes-separation.test.js`;
  `tools/hermes-decision.mjs` turns the audit into the single decision.
