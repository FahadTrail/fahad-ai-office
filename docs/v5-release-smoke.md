# V5 release smoke (after PR #71 is merged and deployed)

This is a short smoke check, not a quota or endurance test. It takes about 15
minutes and uses one small Office job on normal routing, free routes first.
Run it only after the deploy log shows `DEPLOYMENT SUCCESSFUL — now running
commit <#71 merge sha>`.

Stop at the first failure. Rollback is GitHub **Revert** on PR #71: `main`
redeploys the previous commit, and V5 adds no migrations.

| # | Check | How | Pass |
|---|---|---|---|
| 1 | Production loads | `/healthz` → `version` = the #71 merge sha. Open the Hub `/`. | 200, the new sha, CHIEF home renders, no console errors |
| 2 | Chief chat | In a Hub chat, ask CHIEF one short question (for example "What is on my plate today?"). | An answer arrives, and the job is `completed` in `jobs` |
| 3 | Light Office is the default | Open **Office** with the mode left on AUTO. | The light (2.5D) Office shows. AUTO stays conservative. |
| 4 | 3D Office loads | Settings → enable immersive (or choose **Immersive** in the Office mode switch) on a desktop Chrome, Edge or Safari with WebGL. | "Entering the Office" → Ready; the atrium shows all 9 workspaces; no console errors |
| 5 | Light fallback | Press **Use light Office**, then switch back. Also open Office on a phone. | The light Office shows at once; the phone never downloads the 3D engine |
| 6 | Employee click/focus | Click FINANCE's label, press Esc, then Tab to CODING. | The camera focuses the workspace; Esc returns to the overview; the labels are keyboard-reachable |
| 7 | Real job state and handoff | Start one short objective: "Short check: FINANCE, a 12-month cost-only estimate — setup AED 5,000 in month 1, running AED 1,000 per month; AUDIT (after FINANCE) reviews it. One short answer." Watch the Office. | FINANCE shows working, then done. A FINANCE → AUDIT handoff animates and is listed under Handoffs. Everything comes from this real job; there are no demo objects. |
| 8 | Finance shows verified figures only | Open the job's artifacts and the final answer. | Only VERIFIED figures (total costs AED 17,000). The monthly schedule is the "calculated by code" table/chart. There is no model-written schedule. |
| 9 | Telegram still delivers | Check the Telegram chat, or run the SQL below. | The final answer arrives once; there is one `channel_delivered` event |
| 10 | Capacity endpoint | `GET /api/capacity` from the logged-in Hub session. | 200 with `ok: true`, `headline`, `pools` (needs #76) |

```sql
-- Steps 7 and 9: the smoke job's states, handoff, delivery and cost.
select j.id, j.status,
  (select count(*) from events e where e.job_id = j.id and e.payload->>'kind' = 'channel_delivered') as delivered,
  (select count(*) from events e where e.job_id = j.id and e.payload->>'kind' = 'finance_validation' and e.payload->>'state' = 'VERIFIED') as finance_verified,
  (select coalesce(sum(cost_usd), 0) from model_attempts m where m.job_id = j.id) as cost_usd
from jobs j order by j.created_at desc limit 1;
```

Record the job id, the cost and the provider routes in the release notes.
Fictional preview data exists only in `tools/` and `testing/`, which the
production image does not contain, so nothing fictional can appear in
production.
