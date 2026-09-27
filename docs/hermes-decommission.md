# Hermes decommission plan

**Status (2026-09-27): NOT READY for final decommission.** Hermes keeps
running untouched. The Office does not depend on Hermes, shares no credential
with it, and every path, command and gate policy still blocks Hermes
(`src/coding-agent/policy.js`, workspace policy, Tool Broker).

## Rules

* No Hermes development. No Office feature may depend on Hermes.
* No Hermes change, stop or deletion during normal Office work — a Hermes
  destructive action is **DENY** until Fahad gives the single final approval.
* Hermes permissions and secrets are never copied. Replacements get their own
  new, minimal credentials (e.g. a new Telegram bot token for the Office).

## Step 1 — read-only audit (Fahad runs it)

```sh
sudo bash ops/hermes-audit.sh > hermes-audit.txt
```

It lists containers, images, volumes, networks, systemd units, cron entries,
directories, Traefik host rules, listening ports and the NAMES (never values)
of Hermes environment variables. It changes nothing and makes no network call
(guarded by `test/hermes-audit.test.js`). The audit is required because this
build environment cannot reach the VPS.

Then turn the output into the decision (read-only, prints a plan only):

```sh
node tools/hermes-decision.mjs hermes-audit.txt            # add --telegram-live once Office Telegram works
```

It lists what Hermes runs (containers, env NAMES, routes, volumes, units,
cron), maps each capability to its Office replacement and answers
`NOT READY` or `HERMES READY FOR FINAL DECOMMISSION`; only the latter prints
the reversible-first removal plan, which still needs Fahad's single approval.

## Step 2 — capability map

Fill from the audit; each Hermes capability needs a proven Office replacement.

| Hermes capability (from the audit) | Office replacement | Proven when |
|---|---|---|
| Telegram assistant (if the audit shows a Telegram token name) | `src/channels/telegram.js` → CHIEF, owner-only, alerts, Approve/Reject buttons | A real owner message produced a CHIEF result in Telegram and an approval was decided from Telegram |
| Scheduled jobs (cron / timers) | Office jobs + Routines, or a small Office scheduler (to build only if the audit shows schedules) | Each schedule ran once from the Office |
| Public web routes (Traefik rules) | Hub routes on `HUB_PUBLIC_HOST` | Each route answered from the Office |
| Data volumes | Export plan agreed with Fahad (no automatic migration) | Fahad confirmed the export |
| Anything else in the audit | Mapped here before step 3 | — |

## Step 3 — readiness

When every row is proven, the Office sends Fahad exactly one message:
**"HERMES READY FOR FINAL DECOMMISSION"** with the audit, the proofs and the
exact reversible-first plan (stop → observe 7 days → back up volumes →
remove). Nothing is stopped or deleted before Fahad's single final approval.

## Current blockers

1. `hermes-audit.txt` not yet produced (needs root on the VPS).
2. The Office Telegram channel is built and tested but not live: it needs a
   new BotFather token and Fahad's chat id
   (`sudo bash ops/set-secret.sh TELEGRAM_BOT_TOKEN`, then `… TELEGRAM_OWNER_CHAT_ID`).
