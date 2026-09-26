// Global free-routing guarantee, shared by the turn gateway, the canary and
// the qualifier: a route classified FREE/PROMO/INCLUDED never silently becomes
// paid or silently serves another model.

// Incidents the free-route guard raises. Each is recorded with its real cost,
// charged to the budget ledger, quarantines the route for a day and fails the
// turn over (with a checkpoint) to the next eligible route.
export const FREE_ROUTE_INCIDENTS = new Set(['paid_on_free_route', 'free_route_model_mismatch']);

export function assertFreeRouteHonest(route, result) {
  if (route.billingClass === 'paid') return;
  const reported = Number(result.usage?.reportedCostUsd || 0);
  if (reported > 0) {
    throw Object.assign(new Error(`${route.provider} billed a free route`), {
      status: 402, type: 'paid_on_free_route', usage: { ...result.usage, costUsd: reported },
    });
  }
  if (result.model && !sameModelFamily(route.model, result.model)) {
    throw Object.assign(new Error(`${route.provider} served a different model on a free route`), {
      status: 422, type: 'free_route_model_mismatch', usage: { ...result.usage, costUsd: 0 },
      reportedModel: String(result.model).replace(/[^A-Za-z0-9._:/-]/g, '').slice(0, 120),
    });
  }
}

// Providers answer with dated or canonical ids (gemini-flash-latest →
// gemini-3.8-flash, …:free → without the suffix). Only a different vendor or
// model family counts as a silent reroute.
export function sameModelFamily(requested, returned) {
  const norm = (value) => String(value || '').toLowerCase().replace(/^models\//, '').replace(/:free$/, '').replace(/^[a-z0-9-]+:(?=.)/, '');
  const left = norm(requested);
  const right = norm(returned);
  if (!left || !right || left === right) return true;
  if (left.includes('/') && right.includes('/')) return left.split('/')[0] === right.split('/')[0] && family(left.split('/').slice(1).join('/')) === family(right.split('/').slice(1).join('/'));
  return family(left.split('/').pop()) === family(right.split('/').pop());
}

function family(id) {
  return String(id).split(/[-_.]/).find((part) => /[a-z]/.test(part)) || id;
}
