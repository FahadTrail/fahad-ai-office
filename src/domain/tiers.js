// Three information tiers. List endpoints default to executive. Technical
// detail is opt-in so a normal response does not carry routing internals.

export const TIERS = Object.freeze(['executive', 'operational', 'technical']);

export function normalizeTier(value, fallback = 'executive') {
  const tier = String(value || fallback);
  if (!TIERS.includes(tier)) throw Object.assign(new Error('INVALID_TIER'), { statusCode: 400 });
  return tier;
}

export function projectTier(record, tier) {
  if (!record || tier === 'technical') return record;
  if (tier === 'operational') {
    const { technical, attempts, events, routing, ...rest } = record;
    return rest;
  }
  const { orchestration, counts, ownerAttention, nextAction, lifecycle, lane, current, history, classification, id, projectId, title, goal, conversationId, finalDeliverableId, openedAt, closedAt } = record;
  return { id, projectId, title, goal, lifecycle, lane, current, history, classification, nextAction, ownerAttention, conversationId, finalDeliverableId, openedAt, closedAt, participants: orchestration?.participants || [], revisionRound: orchestration?.revisionRound || 0 };
}
