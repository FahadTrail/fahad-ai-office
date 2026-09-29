# V4.1 — reliability closure

V4.1 closes the reliability gaps found by the V4 Tasleem acceptance run. The
Office must not confidently present business information that is
mathematically inconsistent or unvalidated. The architecture is unchanged;
the fix is code-based gates around the existing employees.

## Source of truth

The order below is fixed:

```
deterministic calculation → validated artifact → AUDIT → CHIEF synthesis
```

Models propose structure, assumptions, interpretation and judgement. Code
decides arithmetic.

## FINANCE — deterministic layer (`src/office/finance.js`)

* **Inputs** (the `financial_model` artifact written by FINANCE):
  * cost lines: `one_time` / `monthly`, the start `month`, and the basis
    KNOWN / ESTIMATED / ASSUMPTION;
  * `revenue` — either a subscription (`price_monthly`, `starting_customers`,
    `new_customers` per month, `churn_rate`, `trial_months`) or an explicit
    `monthly` schedule;
  * `variable_cost_per_customer`, `starting_cash` and `months`;
  * `claims` — the headline figures FINANCE states.
* **Calculated by code:** `calculateFinance()` produces:
  * the monthly schedule: customers, revenue, costs, net and cumulative cash;
  * totals and net;
  * gross margin and contribution per customer;
  * cash break-even (cumulative ≥ 0) and operating break-even;
  * break-even customers and runway;
  * ±20% sensitivities on price and customers.
* **Validation:** `validateFinance()` checks FINANCE's own output for:
  * stated claims against the calculation (sum, subtotal and annual/monthly
    consistency);
  * break-even: a month is accepted only when the schedule reproduces it, and
    "not reached" must be true;
  * charts against the schedule;
  * table total rows against their column sums;
  * monthly tables against the schedule;
  * prose in the summary and body (year-one revenue and costs, break-even
    month). Calculated sensitivities are accepted as scenarios.
* **States:**

  | State | Meaning |
  | --- | --- |
  | VERIFIED | Every stated figure matches the calculation. |
  | INCONSISTENT | At least one stated figure disagrees. |
  | INSUFFICIENT DATA | There is no structured model. This is a failure only when figures are stated. |

* **Automatic correction:** a FINANCE workstream that is not VERIFIED is
  returned to FINANCE with the exact issues and the calculated values, for up
  to 2 rounds. Then the output is published with:
  * the `calculated` values and `validation` state stored in the artifact;
  * a code-drawn schedule chart (a hand-drawn chart that disagrees is
    removed);
  * a "Validated figures (calculated by code)" section.
* **Direct chats:** a direct FINANCE chat is checked only when it carries a
  structured model.

## AUDIT — code first, model second (`src/office/quality.js`)

* **Before the model review:** `numericChecks()` re-validates every upstream
  FINANCE output from its raw artifact. It ignores any embedded validation
  state, and it also checks table totals from the other employees.
* **In the prompt:** the results go into AUDIT's prompt as authoritative CODE
  CHECKS.
* **After the model review:** `enforceAudit()` makes sure every failed check
  is in the `audit_report`. Each finding records:
  * `type: NUMERIC_INCONSISTENCY`;
  * severity `blocked` (for totals, break-even and summary mismatches) or
    `high`;
  * owner, expected, stated, evidence and fix.

  Any blocked finding forces the verdict to BLOCKED. A "Code checks
  (deterministic)" section lists what passed and what failed.

## CHIEF — critical fact gate

* **Before synthesis:** `chiefGate()` re-validates FINANCE and reads AUDIT's
  numeric findings.
* **If anything is unverified in round 1:** CHIEF returns it to its owner
  automatically. This is a revision task and needs no model call.
* **Validated figures:** they are given to CHIEF as
  `validated_year_revenue = …`, `validated_break_even_month = …` and so on,
  and must be used exactly.
* **After synthesis:** `enforceFacts()` removes any line, Markdown table row
  or CHIEF artifact that contradicts a validated figure or repeats a figure
  already proven wrong. It then appends "Validated financial figures
  (calculated by code)".
* **Still unverified after the revision round:** the result starts with
  "Not closed — blocked finding" and presents no FINANCE figures as fact.

## SOCIAL

* **Calendar artifact:** a calendar is a `content_calendar` artifact with
  every post: date, platform, pillar, format, hook, caption or script, CTA,
  status and notes.
* **Tables converted by code:** a calendar written as a Markdown table is
  converted into that artifact.
* **Posting times:** a time is labelled ASSUMPTION unless it is based on
  account data.

## Output cleanup

* **Leading narration:** `cleanOutput()` removes process narration before the
  first heading ("Now I have…", "Let me…").
* **Standalone lines:** it also removes standalone narration lines with an
  explicit process verb, from every employee's output and CHIEF's.

## Dependency-aware scheduling

* **Workflow pool:** `OfficeWorkflow.runOnce()` is a pool rather than a batch.
  * A task starts as soon as its own dependencies are done and a slot is free.
  * The loop returns when any task finishes, or after a short poll, and claims
    newly ready work.
* **Synthesis:** CHIEF's synthesis still waits for its workstreams.
* **Shutdown:** the worker drains the tasks already in flight.

## `[free-only]`

* **Stored as metadata:** `[free-only]` / `[مجاني فقط]` is stored as
  `jobs.free_only` (migration `20261002090000_job_free_only`). It is removed
  from the goal and title when a job is created, so chat, project views and
  Telegram never show it.
* **Enforced on every step:** the flag is applied to every stage of that
  objective, and to any Coding Agent task it starts.
* **Privacy still wins:** `[confidential]` keeps its private-provider-only
  routing.

## Search fallback

* **Degraded search:** when the search provider fails (quota, rate limit or
  outage), the run is marked search-degraded once.
  * Later `web_search` calls return the same degraded result without calling
    the provider.
  * The model is told to continue with `web_fetch`.
* **Evidence checks:** `evidenceGate()` records an event, downgrades VERIFIED
  claims whose source was not actually fetched, and marks the evidence
  INSUFFICIENT when fewer than 2 pages were retrieved.

## Financial table gate (V4.1 final blocker)

Found live in job `abaccdad` (Sanad Desk). FINANCE was VERIFIED (revenue
112,236, costs 102,000, net 10,236, break-even month 12), but AUDIT wrote its
own "12-Month Financial Snapshot" with revenue 111,489 and net 9,489, and
CHIEF copied it. Only headline figures were checked. Monthly tables were
checked only inside FINANCE's output, with a 2% tolerance. AUDIT's own output
was never checked, and CHIEF's row check needed words such as "annual".

The FINANCE calculator is now the only source of monthly financial truth:

* **Strict comparison** (`finance.js`): `financialTables()` finds every
  financial table (artifact or Markdown) and chart. `tableScheduleIssues()`
  compares each one with the calculation (whole-unit rounding only):
  * every monthly revenue, cost, net and cumulative value;
  * every Total/Year row;
  * labelled headline rows (totals, net, break-even).

  Non-financial tables are not touched. That covers tables with no month
  column and no labelled financial row, as well as competitor/market tables.
* **AUDIT** (`numericChecks`): with a VERIFIED calculation, every financial
  table or chart from another employee that contradicts it becomes one
  BLOCKED finding. The finding records the worst mismatch and lists all of
  them. AUDIT's own draft is checked too (`auditOwnTables`): a contradictory
  table is removed and replaced by the calculator's schedule, and it is
  reported as a BLOCKED finding with `resolved: true` ("RESOLVED BY CODE").
  AUDIT workstreams always depend on the FINANCE workstreams planned before
  them, so AUDIT always has the calculator.
* **CHIEF** (`enforceFacts`):
  * `sanitizeFinancial()` removes every model-written monthly schedule and
    every contradictory financial table or chart, and puts the calculator's
    `scheduleTable()` in the place of the first schedule it removes.
  * Prose is still checked. Headline lines must state a validated value at
    their written precision: "112K" passes, "111,489" does not. A figure for
    a named month must be that month's calculated value, and figures AUDIT
    proved wrong are banned.
  * `remainingContradictions()` re-checks the final text. If anything is
    left, the result is NOT CLOSED, so VERIFIED never ships next to a
    contradiction.
* **Owners:** a table finding against another employee returns that
  employee's workstream in round 1. It is resolved when their revised output
  has no contradictory table.
* **Models explain, code calculates:** CHIEF is told never to write its own
  monthly schedule.

## Owner drills (live proof)

* `[drill:finance-error]` writes a deliberately wrong headline total into
  FINANCE's first output **before** validation. FINANCE's gate must catch it
  and return it to FINANCE.
* `[drill:finance-error-audit]` writes it **after** FINANCE's validation.
  AUDIT and CHIEF must catch it, and CHIEF returns it to FINANCE.
* In both cases the wrong figure must never reach the final answer.
* `[drill:finance-table]` writes the live failure's table into AUDIT's draft
  and into CHIEF's draft. The table's monthly revenue drifts from the
  calculator by 747 over the year (Sanad Desk: 111,489 / net 9,489). AUDIT
  must block and remove it, and CHIEF must replace it with the calculator
  schedule. Events: `finance_table_drill`, `audit_table_gate` and
  `fact_gate_enforced` (with `tables`, `remaining` and `blocked`).
