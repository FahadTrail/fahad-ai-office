# Fahad AI Office: production-ready summary

Status (2026-10-01): **complete and in daily use.** Development is stopped. New work happens only when Fahad asks for a feature.

## What runs

| | |
|---|---|
| Production commit | `main` after #99 (V5 merged at `90142a9`). `/healthz` reports the running `version`. |
| Host | Hostinger VPS, container `fahad-office-runtime` (Office worker + Hub on :2132 behind Traefik) plus `fahad-office-coding-worker` |
| Data | Supabase `zkzibipinjeswhdxnfgf`; every object is service-role only with RLS on |
| Deploy | push to `main` → CI → `ops/deploy.sh`: build, read-only healthcheck, switch, 3 healthy observations, automatic rollback |

## Product
* **Hub:** five places — **Chief** (chat), **Employees**, **Projects**, **Needs Fahad**, **Office**. Everything else (Tasks, Artifacts, Models, Integrations, Settings) is under *More*.
* **Office:** the light Office by default. The immersive 3D Office is opt-in (Settings or the *Immersive* button). AUTO stays light; phones, tablets, missing WebGL, low frame rate or render errors fall back to light. Every state shown comes from real jobs; no demo data reaches production.
* **Employees (9):**
  * CHIEF plans, delegates and writes the final answer.
  * RESEARCH, PRODUCT, CREATIVE, SOCIAL and LEGAL are specialists.
  * FINANCE does arithmetic in code (VERIFIED / INCONSISTENT / INSUFFICIENT DATA, automatic correction round).
  * AUDIT checks numbers and tables against FINANCE.
  * CODING is the autonomous Coding Agent.
  * CHIEF's fact gate keeps only validated figures.
* **Telegram:** @FahadAIofficeBot talks to CHIEF, owner only.

## Models, capacity, cost
* **Free first**, with no silent paid fallback. Paid models are used only within the $2/month workspace budget.
* **Free pools:** Gemini/Gemma, Z.ai GLM Flash, Groq, OpenRouter `:free`.
* **Capacity (ESTIMATED from the 2026-09-30 snapshot):** about 3.1M free tokens/day and about 47 mixed projects/day (p50).
* **Measured in the 24 h burn-in:** 100 % free calls, $0.
* **Strong-reasoning capacity is thin:** OpenRouter allows 50 requests/day, and Gemini Flash is unreliable. When it runs out, CHIEF's final synthesis **waits** and resumes automatically (00:00 UTC for OpenRouter).
* **Coding:** small and medium PUBLIC jobs are proven free (≈90–375K tokens, 4–40 min, $0, automatic failover between models). Large jobs are UNKNOWN on free models.
* **Privacy:** free models never get PRIVATE code (`docs/private-coding-policy.md`). Private coding uses paid, verified routes only.

## Watchdog
The runtime checks every 15 minutes (`src/ops/ops-watch.js`). It sends each NEW finding once to Telegram:
* paid calls;
* free-route incidents;
* provider account blockers;
* capacity starvation;
* blocked coding sessions.

It is quiet otherwise. `OPS_WATCH=false` turns it off.

## Rollback
* **UI (V5):** GitHub **Revert** on PR #71. That redeploys the core UI; no database change is needed.
* **Last known good core:** `ab2f26f`.
* **Any other PR:** Revert it; the deploy pipeline does the rest.
* **Provider kill switch:** `workspace_routing_policies.excluded_routes`, or remove the key with `ops/set-secret.sh`.

## Optional owner actions (none blocks daily use)
Set each with `sudo bash ops/set-secret.sh NAME` (hidden prompt). Never paste a key into a chat.
1. **Mistral:** `MISTRAL_API_KEY` **and**, on the free Experiment plan, `MISTRAL_BILLING_CLASS=free`. Biggest gain (≈1B tokens/month REPORTED; helps CHIEF synthesis and large coding).
2. **LLM7:** `LLM7_API_KEY` (1M tokens/day, public data only).
3. **Cloudflare:** `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` (no training; a path to free private work later).
4. **Ollama:** `OLLAMA_API_KEY`.
5. **OpenCode Zen:** `OPENCODE_ZEN_API_KEY`. **Disable auto-reload first.**

Details: `docs/provider-readiness.md`, `docs/HANDOVER.md`. Daily use: `docs/HOW-TO-USE.md`.
