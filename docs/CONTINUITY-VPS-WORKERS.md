# Continuity VPS workers — install, authentication, and the live Phase N drill

Prepared 2026-10-02 on `codex/continuity-readiness` (PR #106). This runbook
prepares the alternative real worker chain **FAHAD OFFICE → OPENCODE → GEMINI
CLI** on the Fahad AI Office VPS, without waiting for Codex or Claude
subscription resets, and without any dependency on the owner's laptop.

**Status banner:** PREPARED, **not certified**. The adapters, flags, setup
script, isolated drill and evidence collector are implemented and tested in
code; **no live worker has run this chain yet**. Nothing here is merged,
deployed, migrated or enabled in production. `CONTINUITY_SUPERVISOR`,
`CONTINUITY_CODEX_ENABLED` and `CONTINUITY_CLAUDE_ENABLED` stay OFF; the
Phase A migration and the new data-only worker migration stay unapplied.

## 1. Worker registry and expected status

The registry is `public.coding_workers` (Phase A migration
`supabase/migrations/20261004090000_coding_continuity.sql`, seven rows) plus
the data-only migration
`supabase/migrations/20261005090000_continuity_gemini_worker.sql`, which adds
the eighth row (`gemini-cli`, disabled). Data only: no schema object changes,
so `supabase/verify/schema-fingerprint.txt` is untouched. The scenario
`supabase/verify/scenarios/coding_continuity.sql` asserts eight workers, only
`office` enabled, and distinct quota sources.

| Worker | Status after this sprint | Notes |
|---|---|---|
| `office` | **EXECUTABLE** (production-validated Coding Agent V1) | Needs the existing Supabase + model-pool configuration |
| `opencode` | **PREPARED / OFF** until live VPS authentication | Real adapter; `CONTINUITY_OPENCODE_ENABLED` plus the provider-neutral owner gates (free source, auto-reload off, access, privacy — Zen promotion only for provider `zen`), all default OFF |
| `gemini-cli` | **PREPARED / OFF** until live VPS authentication | New real adapter; `CONTINUITY_GEMINI_CLI_ENABLED`, default OFF |
| `codex` | **IMPLEMENTED / CERTIFICATION DEFERRED** | Unchanged; needs CLI `>=0.150.0` + login |
| `claude-code` | **IMPLEMENTED / CERTIFICATION DEFERRED** | Unchanged; needs CLI `>=2.1.268` + login |
| `antigravity`, `kilo`, `freebuff` | Manual / disabled (unchanged) | Not part of this chain |

No unsupported worker is enabled automatically.

## 2. Install (Phase 6): `ops/setup-continuity-workers.sh`

Run on the VPS from a checkout of this branch:

```sh
bash ops/setup-continuity-workers.sh --check      # verify-only: OS/arch, Node >= 20,
                                                  # git, CLI versions, required flags,
                                                  # credential presence (names/counts only),
                                                  # user-namespace + AppArmor report
sudo bash ops/setup-continuity-workers.sh --install  # installs/updates the official npm
                                                  # packages opencode-ai and
                                                  # @google/gemini-cli, then re-checks
```

Guarantees: it never reads, prints or embeds a credential; it never edits
`.env` or any Continuity flag; it never restarts, redeploys or touches a
container or anything Hermes-related. It exits non-zero with `[FAIL]` lines
when a prerequisite is missing.

## 3. Authentication (Phase 7)

Credentials live only in the environment of whoever runs the worker. Never
type, echo, paste, commit or log them; the adapters read variable **names**
and file **existence** only.

### OpenCode

1. Official login once, interactively: `opencode auth login --provider <id>`
   (stores credentials under `~/.local/share/opencode/auth.json`), **or** make
   an existing Fahad Office provider key visible to the drill shell by name
   (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `DEEPSEEK_API_KEY`, …) — reuse the
   server's own key material; do not copy it into code, docs or chat.
2. Verify without printing values: `opencode auth list` (prints counts only)
   or `bash ops/setup-continuity-workers.sh --check`.
3. The adapter refuses to run until the provider-neutral owner gates are
   asserted in the drill/runtime shell (they are pure assertions, default
   closed): `CONTINUITY_OPENCODE_AUTO_RELOAD_OFF`,
   `CONTINUITY_OPENCODE_FREE_VERIFIED` (the legacy
   `CONTINUITY_OPENCODE_ZEN_FREE_VERIFIED` name still works),
   `CONTINUITY_OPENCODE_ACCESS_VERIFIED`, `CONTINUITY_OPENCODE_PRIVACY_VERIFIED`,
   and `CONTINUITY_OPENCODE_MODEL_PROVIDER` naming the model source (default
   `zen`; use `openrouter` for verified OpenRouter Free). The Zen promotion
   assertion `CONTINUITY_OPENCODE_PROMOTION_ACTIVE` (legacy
   `CONTINUITY_OPENCODE_ZEN_PROMOTION_ACTIVE`) is required **only** when the
   provider is `zen` — never for another verified free provider.

### Gemini CLI

Two official paths; the adapter supports both and never handles a token:

* **API key (headless VPS):** set `GEMINI_API_KEY` in the shell that runs the
  drill (Google AI Studio key). The adapter checks presence only.
* **Official OAuth login (browser approval):** on the VPS run `gemini` once
  interactively, choose "Login with Google"; the CLI itself pauses and shows
  only the official Google URL and code — open it from any browser, enter the
  code, and the CLI stores `~/.gemini/oauth_creds.json`. The adapter only
  checks that this file exists. No runtime ever prints or reuses the token;
  Vertex AI / GCA paths are deliberately excluded so billing cannot silently
  change.

Readiness proof: `bash ops/setup-continuity-workers.sh --check` reports
`GEMINI_API_KEY: set (value not shown)` or `OAuth credential file: present`.

## 4. Feature flags (all default OFF)

| Flag | Effect |
|---|---|
| `CONTINUITY_OPENCODE_ENABLED` | Enables the OpenCode adapter (gates must also be asserted) |
| `CONTINUITY_OPENCODE_AUTO_RELOAD_OFF` | Owner asserts OpenCode auto-reload is off (gate) |
| `CONTINUITY_OPENCODE_MODEL_PROVIDER` | Model source for the gates; default `zen` keeps the Zen promotion requirement, e.g. `openrouter` needs none |
| `CONTINUITY_OPENCODE_FREE_VERIFIED` / `_ACCESS_VERIFIED` / `_PRIVACY_VERIFIED` | The three provider-neutral OpenCode owner gates (legacy `CONTINUITY_OPENCODE_ZEN_FREE_VERIFIED` name accepted for the free gate) |
| `CONTINUITY_OPENCODE_PROMOTION_ACTIVE` | Zen promotion assertion; required **only** when the provider is `zen` (legacy `CONTINUITY_OPENCODE_ZEN_PROMOTION_ACTIVE`) |
| `CONTINUITY_GEMINI_CLI_ENABLED` | Enables the Gemini CLI adapter |
| `CONTINUITY_CODEX_ENABLED`, `CONTINUITY_CLAUDE_ENABLED`, `CONTINUITY_SUPERVISOR` | Unchanged; stay OFF in production |

Both external adapters are wired in exactly one place —
`externalAdaptersFromEnv` in `src/continuity/runtime.js` — shared by the
production runtime and the drill, so drill wiring cannot drift from
production wiring. The Hub shows all of them through `PREPARED_ADAPTERS` in
`src/hub-continuity.js` when the Supervisor is off.

## 5. Failure taxonomy (Phase 4)

`FAILURE_TAXONOMY` and `failureCategory()` in `src/continuity/errors.js`
formalise the eight distinguishable categories; existing runtime codes are
unchanged (checkpoints, events and tests keep their values):

| Category | Runtime representation |
|---|---|
| `AUTH_REQUIRED` | error code / probe reason `AUTH_REQUIRED` |
| `UNSUPPORTED_VERSION` | error code / probe reason `UNSUPPORTED_VERSION` |
| `SANDBOX_UNAVAILABLE` | run-time error code / probe reason (isolation layer failed) |
| `HOST_CAPABILITY_REQUIRED` | readiness `authState` (host cannot start the isolation layer) |
| `RATE_LIMITED` | error code `RATE_LIMITED` |
| `PROCESS_FAILED` | `WORKER_CRASHED`, `WORKER_TIMEOUT`, `WORKER_OUTPUT_INVALID` |
| `STOP_UNCONFIRMED` | `WORKER_STOP_UNCONFIRMED` |
| `WORKTREE_UNSAFE` | `WORKTREE_UNSAFE` (and `CONTINUITY_HANDOFF_WORKTREE_UNSAFE`) |

Readiness states win over run-time codes when both are present, so a probe
pair (`SANDBOX_UNAVAILABLE` + `HOST_CAPABILITY_REQUIRED`) is reported as the
host-capability category while the same code from a running worker stays a
run-time sandbox failure. The shared driver itself is unchanged — both new
adapters reuse it; no duplicate worker infrastructure was created.

## 6. The live Phase N drill (Phases 8 + 9)

```sh
node tools/continuity-phase-n-live.mjs --check   # verify-only preflight
node tools/continuity-phase-n-live.mjs --run     # the real drill
node tools/continuity-phase-n-live.mjs --selftest # plumbing only, not worker evidence
```

One-block VPS sequence: pull the latest PR #106 code, load the Office
credentials from the production env file without printing anything, export
**only** the drill flags in this shell, run `--check`, run `--run` only if
the check passes, and print the final verdict:

```sh
set -eo pipefail
trap 'echo "PHASE N FINAL: FAIL (setup)"' ERR
REPO="${PHASE_N_REPO:-$(git rev-parse --show-toplevel 2>/dev/null || true)}"
if [ -z "$REPO" ] || [ "$(git -C "$REPO" branch --show-current 2>/dev/null)" != codex/continuity-readiness ] \
  || ! git -C "$REPO" remote get-url origin 2>/dev/null | grep -qi 'FahadTrail/fahad-ai-office'; then
  REPO="$(find /root /home /opt -maxdepth 4 -type d -name .git 2>/dev/null | while read -r g; do
    d="${g%/.git}"
    [ "$(git -C "$d" branch --show-current 2>/dev/null)" = codex/continuity-readiness ] || continue
    git -C "$d" remote get-url origin 2>/dev/null | grep -qi 'FahadTrail/fahad-ai-office' && printf '%s\n' "$d"
  done | head -1 || true)"
fi
[ -n "$REPO" ] || { echo "PHASE N FINAL: FAIL (no codex/continuity-readiness checkout found)"; exit 1; }
cd "$REPO"
echo "checkout: $REPO ($(git rev-parse --short HEAD))"
git pull --ff-only
ENVFILE="${PHASE_N_OFFICE_ENV:-/opt/fahad-ai-office/.env}"
[ -r "$ENVFILE" ] || { echo "PHASE N FINAL: FAIL (Office env file not found)"; exit 1; }
set -a
if ! . "$ENVFILE"; then set +a; echo "PHASE N FINAL: FAIL (Office env could not be sourced)"; exit 1; fi
set +a   # Supabase + model credentials are now exported; nothing was printed
unset CONTINUITY_SUPERVISOR CONTINUITY_CODEX_ENABLED CONTINUITY_CLAUDE_ENABLED \
      CONTINUITY_OPENCODE_ENABLED CONTINUITY_OPENCODE_AUTO_RELOAD_OFF CONTINUITY_OPENCODE_MODEL_PROVIDER \
      CONTINUITY_OPENCODE_FREE_VERIFIED CONTINUITY_OPENCODE_ZEN_FREE_VERIFIED \
      CONTINUITY_OPENCODE_PROMOTION_ACTIVE CONTINUITY_OPENCODE_ZEN_PROMOTION_ACTIVE \
      CONTINUITY_OPENCODE_ACCESS_VERIFIED CONTINUITY_OPENCODE_PRIVACY_VERIFIED CONTINUITY_GEMINI_CLI_ENABLED
export CONTINUITY_OPENCODE_ENABLED=1 CONTINUITY_OPENCODE_AUTO_RELOAD_OFF=1 \
       CONTINUITY_OPENCODE_MODEL_PROVIDER=openrouter CONTINUITY_OPENCODE_FREE_VERIFIED=1 \
       CONTINUITY_OPENCODE_ACCESS_VERIFIED=1 CONTINUITY_OPENCODE_PRIVACY_VERIFIED=1 \
       CONTINUITY_GEMINI_CLI_ENABLED=1
if node tools/continuity-phase-n-live.mjs --check; then
  if node tools/continuity-phase-n-live.mjs --run; then
    trap - ERR
    echo "PHASE N FINAL: PASS"
  else
    echo "PHASE N FINAL: FAIL (drill)"
    exit 1
  fi
else
  echo "PHASE N FINAL: FAIL (preflight)"
  exit 1
fi
```

The `--run` mode prepares a disposable branch, disposable worktrees and an
isolated file-persisted Continuity store under
`.continuity/phase-n-drill/`, then drives the real chain
**Office → OpenCode → Gemini CLI** through the real `ContinuitySupervisor`:

1. Office (real Coding Agent) creates `phase-n/office.md`, commits and pushes.
2. Confirmed stop **before** transfer (event order `WORKER_STOPPED` before
   `HANDOFF_PROPOSED`), checkpoint, handoff to OpenCode; the destination
   worktree head must equal the exact prior commit.
3. OpenCode runs its real turn, commits `phase-n/opencode.md`; a real
   checkpoint with its commit SHA is persisted.
4. The OpenCode process is really killed (`SIGKILL`), death observed by the
   driver and re-verified by the OS (`ESRCH` or pid-reuse cmdline check); the
   Supervisor state is persisted and "crashed".
5. A restarted Supervisor reloads persisted state. **First recovery attempt
   is deliberately refused** (`WORKER_STOP_UNCONFIRMED`) because no
   termination proof is sealed — the fail-closed gate is exercised, not
   assumed. Only then is the termination proof sealed and the second attempt
   reclaims the frozen lease.
6. Recovery resumes from the exact checkpoint commit on the third worker
   (Gemini CLI — the natural chain continuation), which commits
   `phase-n/gemini.md`; completion gates publish and retire the worktree and
   the session ends `COMPLETED` with zero active leases.

Evidence written to `.continuity/phase-n-drill/report.json` (and printed as
`[evidence]` lines): lease IDs, session IDs, checkpoint IDs, commit SHAs, the
stop-before-transfer event ordering, one-active-writer samples plus an
event-log replay (`maxConcurrentWriters ≤ 1`), destination-starts-from-exact-
commit assertions, the kill/proof/refuse/reclaim chain, linear branch history
with no duplicate commits or subjects, and each worker's marker file. **Any
missing evidence fails the drill with an exact blocker; mocks never count.**

If worker death cannot be proven, recovery refuses and the drill reports
`FAIL_CLOSED_RECOVERY_NOT_ENFORCED` or `WORKER_STOP_UNCONFIRMED` — it never
falls back to a simulated pass.

## 7. Rollback / removal

* Remove the CLIs: `sudo npm rm -g opencode-ai @google/gemini-cli`.
* Unset the drill flags in the shell (production `.env` was never modified).
* Remove worker credentials chosen by the owner:
  `~/.local/share/opencode/auth.json` (OpenCode) and `~/.gemini/` (Gemini
  CLI OAuth file).
* Drill artifacts: on a passing run the tool removes its disposable branch
  (local and origin) and worktrees, keeping `report.json`; on failure it
  prints the exact manual commands. State lives only under
  `.continuity/phase-n-drill/`.
* Migrations: **nothing is applied by this runbook.** Applying
  `20261005090000_continuity_gemini_worker.sql` (a single disabled-row insert)
  happens only with the owner-approved stack migration step; until then the
  registry change exists only in this branch.

## 8. Certification status (truthful)

* **Verified this sprint:** official OpenCode and Gemini CLI interfaces from
  the official docs/source and the installed official packages (no guessed
  flags); both adapters fail closed by default; adapter/taxonomy/registry
  tests and the drill `--selftest` pass; `--check` mode refuses this
  unauthenticated environment with exact blockers.
* **Not verified:** any live model turn, any real handoff, any authenticated
  run. Certification requires the VPS steps above and a passing `--run`
  verdict, followed by Fahad's review.
* **Owner-reported live on the VPS (2026-10-03):** OpenCode 1.18.34
  authenticated with verified OpenRouter Free and Gemini CLI authenticated;
  the owner's probes reported both workers ready. The one-block command in
  section 6 runs `--check` and, only on a pass, the real `--run` drill — the
  resulting `report.json` verdict, not this note, is the certification
  evidence.
* **Production:** untouched — no merge, no deploy, no migration, no flag
  change, no Hermes access.
