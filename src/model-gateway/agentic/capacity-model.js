// Effective free capacity (Capacity V2, Parts 22–24).
//
// "How much work can the Office do for free?" is answered per JOB CLASS, not
// as a raw token sum, because a pool only counts for work its models are
// allowed and able to do:
//
//   effective tokens/day of a pool for a class =
//       daily allowance            (published/reported; requests × measured
//                                   tokens/request when only requests are
//                                   published — labelled ESTIMATED)
//     × eligibility for the class  (qualification + privacy + coding grade)
//     × health today               (available 1, degraded 0.5, exhausted 0)
//     × measured success rate      (our audited attempts this month)
//
// A pool whose allowance is not published is listed as UNKNOWN and never
// added to a total. Job counts divide effective tokens by MEASURED job sizes
// from production (coding sessions and Office projects, 2026-09).

import { poolFacts, publishedTokenAllowance, routeDataClass, allowsDataClass } from './pool-registry.js';
import { capacityPool } from './capacity-pools.js';
import { qualificationValid, JOB_SKILLS } from './qualification.js';
import { codingQualificationValid, CODING_GRADES, CODING_TIERS } from './coding-qualification.js';

export const JOB_CLASSES = Object.freeze(['general', 'coding', 'strong_reasoning', 'research', 'finance']);

// Measured in production (docs/capacity-v2.md §1): tokens per job, input +
// output, all model calls of the job.
export const MEASURED_JOB_TOKENS = Object.freeze({
  coding: { small: 120_000, medium: 500_000, large: 2_500_000 },
  project: { p50: 65_000, p90: 223_000 },
  answer: { p50: 2_800, p90: 18_000 },
  inputShare: 0.97,
  cachedInputShare: 0.5,
  source: 'model_attempts + agent_sessions, production, 2026-09-22..29',
});
// When a pool publishes only a request limit and we have no measurement yet.
const DEFAULT_TOKENS_PER_REQUEST = 6_000;
// Measured input size of one Coding Agent turn (production sessions, 2026-09).
export const CODING_TURN_TOKENS = 30_000;
const HEALTH_FACTOR = { available: 1, degraded: 0.5, exhausted: 0, not_configured: 0 };

const skillsOk = (record, skills) => skills.every((skill) => record?.skills?.[skill]);

// Which job classes a route may take, from evidence (not claims).
export function routeClasses(route, qualifications, { now = Date.now(), codingDataClass = 'PRIVATE' } = {}) {
  const classes = new Set();
  const general = qualifications?.get?.(route.id);
  const qualified = qualificationValid(general, now) && general.status === 'qualified';
  // Discovered routes need a pass; established routes take general work
  // unless their own qualification failed (the gateway's rule too).
  const failed = qualificationValid(general, now) && general.status === 'failed';
  const usable = route.requiresQualification ? qualified : !failed;
  if (!usable) return classes;
  const capabilities = route.capabilities || {};
  classes.add('general');
  if (qualified && (capabilities.reasoning || 0) >= 4 && skillsOk(general, ['reasoning', 'structured'])) classes.add('strong_reasoning');
  if (skillsOk(general, JOB_SKILLS.research)) classes.add('research');
  if (qualified && skillsOk(general, JOB_SKILLS.finance)) classes.add('finance');
  const coding = qualifications?.coding?.get?.(route.id);
  // A coding turn re-sends the transcript (measured ≈30K input tokens): a
  // route whose per-request/minute token limit is below that cannot run the
  // Coding Agent, whatever its grade on the short suite.
  const fitsCodingTurn = !route.requestTokenLimit || route.requestTokenLimit >= CODING_TURN_TOKENS;
  if (codingQualificationValid(coding, now) && CODING_GRADES.indexOf(coding.grade) >= 1 && allowsDataClass(route, codingDataClass) && fitsCodingTurn) classes.add('coding');
  return classes;
}

function codingGradeOf(route, qualifications, now) {
  const record = qualifications?.coding?.get?.(route.id);
  return codingQualificationValid(record, now) ? record.grade : 'NOT_CODING_APPROVED';
}

// Daily token allowance of one pool, with its basis.
export function poolDailyTokens(facts, { measuredTokensPerRequest = null } = {}) {
  const published = publishedTokenAllowance(facts);
  if (facts.kind === 'one-time' || facts.kind === 'paid') return { perDay: 0, perMonth: 0, basis: facts.kind };
  if (published.perDay) return { perDay: published.perDay, perMonth: published.perMonth, basis: published.basis };
  const requestsPerDay = facts.limits?.requestsPerDay;
  if (requestsPerDay) {
    const perRequest = measuredTokensPerRequest || DEFAULT_TOKENS_PER_REQUEST;
    return {
      perDay: Math.round(requestsPerDay * perRequest), perMonth: Math.round(requestsPerDay * perRequest * 30),
      basis: `ESTIMATED — ${requestsPerDay} requests/day (${facts.confidence}) × ${measuredTokensPerRequest ? 'measured' : 'assumed'} ${Math.round(perRequest)} tokens/request`,
    };
  }
  return { perDay: null, perMonth: null, basis: 'UNKNOWN — no published allowance' };
}

// The capacity model over the configured pool.
//   pools:        poolSummary() entries (state, usage today/month)
//   attempts:     this month's model_attempts rows (for success rate and
//                 tokens per request per pool), already grouped by pool id
export function capacityModel({ routes, pools, qualifications = null, attemptsByPool = new Map(), now = Date.now(), codingDataClass = 'PRIVATE', paid = null }) {
  const poolById = new Map(pools.map((entry) => [entry.id, entry]));
  const members = new Map();
  for (const route of routes) {
    if (route.billingClass === 'paid' || route.retired || route.unavailableReasons?.length) continue;
    const id = (route.capacityPool || capacityPool(route)).id;
    members.set(id, [...(members.get(id) || []), route]);
  }
  const rows = [];
  for (const [id, poolRoutes] of members) {
    const facts = poolFacts(poolRoutes[0]);
    const attempts = attemptsByPool.get(id) || [];
    const succeeded = attempts.filter((row) => row.status === 'succeeded');
    const tokensOf = (row) => Number(row.input_tokens || 0) + Number(row.output_tokens || 0);
    const measuredTokensPerRequest = succeeded.length >= 5 ? succeeded.reduce((sum, row) => sum + tokensOf(row), 0) / succeeded.length : null;
    const successRate = attempts.length >= 5 ? succeeded.length / attempts.length : null;
    const allowance = poolDailyTokens(facts, { measuredTokensPerRequest });
    const state = poolById.get(id)?.state || 'available';
    const classes = new Set(poolRoutes.flatMap((route) => [...routeClasses(route, qualifications, { now, codingDataClass })]));
    const bestCoding = poolRoutes.map((route) => codingGradeOf(route, qualifications, now))
      .reduce((best, grade) => (CODING_GRADES.indexOf(grade) > CODING_GRADES.indexOf(best) ? grade : best), 'NOT_CODING_APPROVED');
    const factor = (HEALTH_FACTOR[state] ?? 1) * (successRate ?? 1);
    const effective = allowance.perDay == null ? null : Math.round(allowance.perDay * (successRate ?? 1));
    rows.push({
      id, provider: facts.account, kind: facts.kind, state, dataClass: poolRoutes.map(routeDataClass).toSorted().at(-1),
      allowance, successRate, measuredTokensPerRequest: measuredTokensPerRequest && Math.round(measuredTokensPerRequest),
      classes: [...classes].toSorted(), codingGrade: bestCoding,
      effectivePerDay: effective, effectiveToday: allowance.perDay == null ? null : Math.round(allowance.perDay * factor),
      resetTimeZone: facts.resetTimeZone || null, confidence: facts.confidence,
    });
  }
  rows.sort((left, right) => (right.effectivePerDay || 0) - (left.effectivePerDay || 0) || left.id.localeCompare(right.id));

  const sumFor = (filter, field = 'effectivePerDay') => {
    const matching = rows.filter(filter);
    const known = matching.filter((row) => row[field] != null);
    return { tokens: known.reduce((sum, row) => sum + row[field], 0), pools: matching.length, unknownPools: matching.length - known.length };
  };
  const perClass = Object.fromEntries(JOB_CLASSES.map((jobClass) => {
    const day = sumFor((row) => row.classes.includes(jobClass));
    const today = sumFor((row) => row.classes.includes(jobClass), 'effectiveToday');
    return [jobClass, { tokensPerDay: day.tokens, tokensPerMonth: day.tokens * 30, tokensToday: today.tokens, pools: day.pools, unknownPools: day.unknownPools }];
  }));

  // Coding jobs/day per size: only pools whose best grade meets the tier.
  const codingJobs = Object.fromEntries(Object.entries(MEASURED_JOB_TOKENS.coding).map(([size, tokens]) => {
    const needed = CODING_TIERS[size];
    const capacity = sumFor((row) => row.classes.includes('coding') && CODING_GRADES.indexOf(row.codingGrade) >= CODING_GRADES.indexOf(needed));
    return [size, { jobsPerDay: Math.floor(capacity.tokens / tokens), tokensPerJob: tokens, minimumGrade: needed, pools: capacity.pools }];
  }));

  // Mixed Office projects/day: free-only, and free-first with paid fallback.
  const general = perClass.general.tokensPerDay;
  const projects = {
    freeOnly: { p50: Math.floor(general / MEASURED_JOB_TOKENS.project.p50), p90: Math.floor(general / MEASURED_JOB_TOKENS.project.p90) },
    freeFirstWithPaidFallback: null,
  };
  if (paid?.pricing) {
    const cost = (tokens) => {
      const input = tokens * MEASURED_JOB_TOKENS.inputShare;
      const cached = input * MEASURED_JOB_TOKENS.cachedInputShare;
      const pricing = paid.pricing;
      return ((input - cached) * pricing.inputPerMillion + cached * (pricing.cachedInputPerMillion ?? pricing.inputPerMillion)
        + tokens * (1 - MEASURED_JOB_TOKENS.inputShare) * pricing.outputPerMillion) / 1e6;
    };
    const dailyPaidUsd = Math.max(0, paid.remainingUsd || 0) / Math.max(1, paid.daysLeftInMonth || 1);
    const paidP50 = cost(MEASURED_JOB_TOKENS.project.p50);
    const paidP90 = cost(MEASURED_JOB_TOKENS.project.p90);
    projects.freeFirstWithPaidFallback = {
      p50: projects.freeOnly.p50 + Math.floor(dailyPaidUsd / paidP50),
      p90: projects.freeOnly.p90 + Math.floor(dailyPaidUsd / paidP90),
      paidRoute: paid.routeId, paidUsdPerDay: Number(dailyPaidUsd.toFixed(4)),
      paidCostPerProjectUsd: { p50: Number(paidP50.toFixed(4)), p90: Number(paidP90.toFixed(4)) },
      basis: 'ESTIMATED — remaining monthly budget spread over the days left, measured project sizes, list prices with 50% cached input',
    };
  }

  return {
    pools: rows,
    perClass,
    codingJobsPerDay: codingJobs,
    codingDataClass,
    projectsPerDay: projects,
    independentFreePools: rows.length,
    unknownAllowancePools: rows.filter((row) => row.allowance.perDay == null).map((row) => row.id),
    jobSizes: MEASURED_JOB_TOKENS,
    method: 'Effective = allowance × class eligibility (qualification, privacy, coding grade) × measured success rate; "today" also × health. UNKNOWN allowances are never summed.',
  };
}
