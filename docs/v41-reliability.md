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

## Owner drills (live proof)

* `[drill:finance-error]` writes a deliberately wrong headline total into
  FINANCE's first output **before** validation. FINANCE's gate must catch it
  and return it to FINANCE.
* `[drill:finance-error-audit]` writes it **after** FINANCE's validation.
  AUDIT and CHIEF must catch it, and CHIEF returns it to FINANCE.
* In both cases the wrong figure must never reach the final answer.
