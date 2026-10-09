// Compact spend and capacity. Unknown stays UNKNOWN. A zero-cost attempt is
// not labelled free unless its billing class says so.

function billingClass(attempt) {
  const route = attempt?.route;
  const declared = Array.isArray(route) ? route[0]?.billingClass || route[0]?.billing_class : route?.billingClass || route?.billing_class;
  if (!declared) return null;
  const text = String(declared).toLowerCase();
  if (text.includes('free') || text === 'included' || text === 'promo') return 'free';
  if (text.includes('paid')) return 'paid';
  return null;
}

export function attemptBilling(attempt) {
  const declared = billingClass(attempt);
  if (declared) return { billing: declared, basis: 'BILLING_CLASS' };
  const cost = attempt?.cost_usd;
  if (cost == null || cost === '') return { billing: 'UNKNOWN', basis: 'UNKNOWN' };
  if (Number(cost) > 0) return { billing: 'paid', basis: 'CHARGED' };
  if (/:free$/.test(String(attempt?.model || ''))) return { billing: 'free', basis: 'MODEL_NAME' };
  return { billing: 'UNKNOWN', basis: 'ZERO_WITHOUT_CLASS' };
}

export function spendOf(attempts) {
  if (attempts == null) return { amountUsd: null, basis: 'UNKNOWN' };
  let amount = 0;
  let unknown = false;
  for (const attempt of attempts) {
    if (attempt.status === 'started' && !attempt.ended_at) { unknown = true; continue; }
    if (attempt.cost_usd == null || attempt.cost_usd === '') { unknown = true; continue; }
    amount += Number(attempt.cost_usd);
  }
  if (unknown && !attempts.length) return { amountUsd: null, basis: 'UNKNOWN' };
  if (unknown) return { amountUsd: Number(amount.toFixed(8)), basis: 'PARTIAL' };
  return { amountUsd: Number(amount.toFixed(8)), basis: 'RECORDED' };
}

export function costSummary({ attempts = null, activeJobIds = [], capacity = null, ownerActions = [] } = {}) {
  const spend = spendOf(attempts);
  const activeAttempts = Array.isArray(attempts) ? attempts.filter((attempt) => activeJobIds.includes(attempt.job_id)) : null;
  const active = spendOf(activeAttempts);
  const billing = Array.isArray(attempts) ? attempts.map(attemptBilling) : [];
  const free = billing.filter((entry) => entry.billing === 'free').length;
  const paid = billing.filter((entry) => entry.billing === 'paid').length;
  const unknownBilling = billing.filter((entry) => entry.billing === 'UNKNOWN').length;
  return {
    totalSpendUsd: spend.basis === 'UNKNOWN' ? 'UNKNOWN' : spend.amountUsd,
    totalSpendBasis: spend.basis,
    activeObjectiveCostUsd: active.basis === 'UNKNOWN' ? 'UNKNOWN' : active.amountUsd,
    activeObjectiveCostBasis: active.basis,
    billing: attempts == null ? 'UNKNOWN' : { free, paid, unknown: unknownBilling },
    capacity: capacity || { free: 'UNKNOWN', paid: 'UNKNOWN', blockers: [] },
    ownerActions,
  };
}
