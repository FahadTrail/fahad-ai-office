// Lightweight, evidence-based qualification of FREE (and promo) models.
//
// A provider's claims are not enough for a model to take critical work. Each
// non-paid route runs a tiny standardized suite (two or three short calls,
// $0) that is graded deterministically:
//
//   instruction  exact echo, JSON only (no prose or markdown around it)
//   structured   one JSON object with the five requested keys
//   reasoning    a small word problem
//   coding       read a JS snippet and state what it prints (public code only)
//   writing      a constrained tagline (word limit + required word)
//   reading      answer a question from a short passage (research proxy)
//   tools        call a function tool, then use its result
//
// Results are stored with their date and suite version. Routing uses them
// two ways: a failed skill that a job needs rules the model out for that job,
// critical jobs need a passed qualification, and within the free tier the
// router prefers the model with the best evidence for THAT job (qualified
// skills, then observed reliability), never one universal ranking.

import { assertFreeRouteHonest, FREE_ROUTE_INCIDENTS } from './free-guard.js';
import { isCoolingDown } from './provider-state.js';
import { classifyProviderError } from '../contracts.js';
import { codingCandidates, qualifyCodingRoute, CODING_SUITE_VERSION } from './coding-qualification.js';

export const QUALIFICATION_SUITE_VERSION = 'q1-2026-09';
export const QUALIFICATION_MAX_AGE_MS = 30 * 24 * 3600_000;
export const SKILLS = Object.freeze(['instruction', 'structured', 'reasoning', 'coding', 'writing', 'reading', 'tools']);

// Which skills each job relies on.
export const JOB_SKILLS = Object.freeze({
  research: ['tools', 'reading', 'reasoning'],
  content: ['writing', 'instruction'],
  branding: ['writing', 'instruction'],
  seo: ['writing', 'reading'],
  finance: ['reasoning', 'structured'],
  finance_critical: ['reasoning', 'structured', 'writing'],
  classification: ['structured', 'instruction'],
  orchestration: ['instruction', 'structured', 'reasoning'],
  synthesis: ['reasoning', 'writing', 'instruction'],
  coding: ['coding', 'tools', 'reasoning', 'structured'],
  qa_security: ['coding', 'reasoning', 'tools'],
});

// Jobs a non-paid model may only take after passing its qualification.
export const CRITICAL_JOBS = new Set(['synthesis', 'finance', 'finance_critical', 'coding', 'qa_security']);

const EVAL_SYSTEM = 'You are being evaluated on following instructions precisely. Answer exactly as asked.';
const EVAL_PROMPT = [
  'Reply with ONE JSON object and nothing else (no markdown, no explanation). Keys exactly: echo, total, code, tagline, city.',
  '1. echo: the exact string "BLUE-HARBOR-42".',
  '2. total: pens cost $4 for 3 pens. How many dollars do 27 pens cost? Give a number.',
  '3. code: what does this JavaScript print? const a=[3,1,2]; console.log(a.map(x=>x*2).filter(x=>x>2).reduce((s,x)=>s+x,0)); Give a number.',
  '4. tagline: a tagline for a bakery, at most 10 words, containing the word "morning".',
  '5. city: "The delegates first met in Lyon, but after the storm the summit moved to Porto, where the final agreement was signed. The follow-up review took place online." In which city was the final agreement signed?',
].join('\n');
const TOOL = {
  name: 'lookup_price',
  description: 'Look up the unit price in USD of a catalog item.',
  inputSchema: { type: 'object', properties: { item: { type: 'string', description: 'Item name' } }, required: ['item'] },
};
const TOOL_PROMPT = 'Use the lookup_price tool to get the unit price of "widget". Then reply with the total cost in USD of 4 widgets, as a number only.';

const text = (value) => ({ role: 'user', content: [{ type: 'text', text: value }] });
const replyText = (result) => (result?.message?.content || []).filter((block) => block.type === 'text').map((block) => block.text).join('').trim();

export function gradeCombined(raw) {
  const output = String(raw || '').trim();
  const unfenced = output.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  let parsed = null;
  try { parsed = JSON.parse(unfenced); } catch {
    const match = unfenced.match(/\{[\s\S]*\}/);
    if (match) { try { parsed = JSON.parse(match[0]); } catch {} }
  }
  const object = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  const keys = ['echo', 'total', 'code', 'tagline', 'city'];
  const tagline = String(object?.tagline || '').trim();
  const words = tagline.split(/\s+/).filter(Boolean);
  return {
    structured: Boolean(object) && keys.every((key) => key in object),
    instruction: Boolean(object) && object.echo === 'BLUE-HARBOR-42' && output.startsWith('{') && output.endsWith('}'),
    reasoning: Boolean(object) && Number(String(object.total).replace(/[$,\s]/g, '')) === 36,
    coding: Boolean(object) && Number(object.code) === 10,
    writing: words.length > 0 && words.length <= 10 && /\bmorning\b/i.test(tagline),
    reading: /^porto\.?$/i.test(String(object?.city || '').trim()),
  };
}

export function gradeToolAnswer(raw) {
  const match = String(raw || '').replace(/[$,]/g, '').match(/-?\d+(?:\.\d+)?/);
  return Boolean(match) && Math.abs(Number(match[0]) - 29) < 0.001;
}

function errorCode(error) {
  const code = String(error?.code || '').replace(/[^A-Z0-9_]/gi, '').slice(0, 60);
  return code || (error?.status ? `HTTP_${error.status}` : 'QUALIFICATION_CALL_FAILED');
}

// Runs the suite against one route. Provider errors (rate limits, outages)
// yield status 'error': the route is simply re-tried in a later cycle.
export async function qualifyRoute(route, { now = () => Date.now(), maxOutputTokens = 2_000 } = {}) {
  const startedAt = now();
  const usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
  const add = (result) => {
    usage.inputTokens += result?.usage?.inputTokens || 0;
    usage.outputTokens += result?.usage?.outputTokens || 0;
    usage.costUsd += result?.usage?.costUsd || 0;
  };
  const call = async (input) => {
    const result = await route.protocolClient.turn({ provider: route.provider, model: route.model, maxOutputTokens, ...input });
    assertFreeRouteHonest(route, result);
    add(result);
    return result;
  };
  const base = { routeId: route.id, provider: route.provider, model: route.model, suiteVersion: QUALIFICATION_SUITE_VERSION, testedAt: new Date(startedAt).toISOString() };
  let skills;
  try {
    const combined = await call({ system: EVAL_SYSTEM, messages: [text(EVAL_PROMPT)], tools: [] });
    skills = { ...gradeCombined(replyText(combined)), tools: false };
    if (route.toolCalling !== false) {
      const first = await call({ system: EVAL_SYSTEM, messages: [text(TOOL_PROMPT)], tools: [TOOL] });
      const toolCall = (first.message?.content || []).find((block) => block.type === 'tool_call' && block.name === 'lookup_price');
      if (toolCall && /widget/i.test(JSON.stringify(toolCall.arguments || {}))) {
        const second = await call({
          system: EVAL_SYSTEM,
          tools: [TOOL],
          messages: [
            text(TOOL_PROMPT),
            first.message,
            { role: 'user', content: [{ type: 'tool_result', callId: toolCall.id, name: toolCall.name, content: JSON.stringify({ item: 'widget', unit_price_usd: 7.25 }) }] },
          ],
        });
        skills.tools = gradeToolAnswer(replyText(second));
      }
    }
  } catch (error) {
    return { ...base, status: 'error', errorCode: errorCode(error), durationMs: now() - startedAt, usage, incident: FREE_ROUTE_INCIDENTS.has(error?.type) ? error.type : null, error };
  }
  const passed = SKILLS.filter((skill) => skills[skill]).length;
  const status = skills.structured && passed >= 5 ? 'qualified' : passed >= 3 ? 'partial' : 'failed';
  return { ...base, status, skills, passed, total: SKILLS.length, durationMs: now() - startedAt, usage };
}

export function qualificationValid(record, now = Date.now()) {
  return Boolean(record) && record.suiteVersion === QUALIFICATION_SUITE_VERSION && record.status !== 'error'
    && now - Date.parse(record.testedAt) < QUALIFICATION_MAX_AGE_MS;
}

// Reasons a non-paid route may not take this job, from its qualification.
export function qualificationGaps(route, job, qualifications, now = Date.now()) {
  // Capacity V2 lifecycle: a discovered route of a new provider (DISCOVERED →
  // CANARY → QUALIFIED → ACTIVE) takes no job at all until it has passed
  // qualification — even without a qualification store (fail closed).
  if (route.requiresQualification) {
    const record = qualifications?.get(route.id);
    if (!qualificationValid(record, now) || record.status !== 'qualified') return ['NOT_YET_QUALIFIED'];
  }
  if (job && typeof job === 'object' && job.baseJob) job = job.baseJob;
  if (typeof job === 'string') job = job.replace(/:relaxed$/, '');
  if (!qualifications || route.billingClass === 'paid' || !job || typeof job !== 'string') return [];
  const record = qualifications.get(route.id);
  const valid = qualificationValid(record, now);
  if (!valid) return CRITICAL_JOBS.has(job) ? ['NOT_YET_QUALIFIED'] : [];
  const gaps = (JOB_SKILLS[job] || []).filter((skill) => record.skills?.[skill] === false).map((skill) => `QUALIFICATION_FAILED_${skill.toUpperCase()}`);
  if (CRITICAL_JOBS.has(job) && record.status !== 'qualified') gaps.push('NOT_QUALIFIED_FOR_CRITICAL_JOB');
  return gaps;
}

// An evidence-gated fallback (capabilities.js EVIDENCE_FALLBACK_JOBS) needs
// every skill of the job PASSED in a valid, qualified record — an untested
// skill is not evidence. Paid routes meet the documented floor without it.
export function evidenceRequiredGaps(route, job, qualifications, now = Date.now()) {
  if (!job?.evidenceRequired || route.billingClass === 'paid') return [];
  const record = qualifications?.get(route.id);
  if (!qualificationValid(record, now) || record.status !== 'qualified') return ['EVIDENCE_REQUIRED'];
  return (JOB_SKILLS[job.baseJob] || []).every((skill) => record.skills?.[skill] === true) ? [] : ['EVIDENCE_REQUIRED'];
}

// Evidence-corrected capabilities. Planning scores are hand-set estimates;
// a valid, passed qualification is measured evidence. A passed skill may
// raise its score by ONE level, never above 4; a failed skill caps it at 2.
// Jobs marked `strictEvidence` (coding, security review, final synthesis,
// high-risk finance) never get a raise — only the safety cap applies.
const SKILL_SCORES = Object.freeze({ reasoning: 'reasoning', writing: 'writing', coding: 'coding', reading: 'research' });
export function evidenceCapabilities(capabilities, record, { strict = false, now = Date.now() } = {}) {
  if (!capabilities || !qualificationValid(record, now) || !record.skills) return capabilities;
  const next = { ...capabilities };
  let changed = false;
  for (const [skill, score] of Object.entries(SKILL_SCORES)) {
    const passed = record.skills[skill];
    const current = Number(next[score] || 0);
    if (passed === false && current > 2) { next[score] = 2; changed = true; }
    else if (passed === true && !strict && record.status === 'qualified' && current < 4) { next[score] = current + 1; changed = true; }
  }
  if (record.skills.structured === true && !next.structuredOutput && !strict) { next.structuredOutput = true; changed = true; }
  if (!changed) return capabilities;
  next.source = `${capabilities.source || 'registry'} + qualification ${String(record.testedAt || '').slice(0, 10)}`;
  return Object.freeze(next);
}

// Job-specific evidence bonus used to order routes within a free class:
// passed job skills first, then observed reliability; recent rate limits
// push a route down so capacity is spread across healthy models.
export function evidenceScore(entry, job, qualifications, now = Date.now()) {
  const { route, state } = entry;
  let score = 0;
  const record = qualifications?.get(route.id);
  if (qualificationValid(record, now)) {
    const skills = JOB_SKILLS[job] || SKILLS;
    score += skills.filter((skill) => record.skills?.[skill]).length / skills.length;
  }
  const requests = Number(state?.requests || 0);
  const failures = Number(state?.failures || 0);
  if (requests + failures >= 3) score += 0.5 * (requests / (requests + failures));
  if (state?.health === 'rate_limited' || state?.health === 'quota_exhausted') score -= 0.25;
  return score;
}

// Qualification evidence is stored as metadata-only rows of
// provider_canary_runs (report.kind = 'qualification'): no prompts or model
// output, only per-skill pass/fail, date, duration and token counts.
export class QualificationStore {
  constructor(db, { now = () => Date.now(), cacheMs = 5 * 60_000 } = {}) {
    this.db = db;
    this.now = now;
    this.cacheMs = cacheMs;
    this.cache = null;
  }

  async snapshot() {
    if (this.cache && this.now() - this.cache.at < this.cacheMs) return this.cache.map;
    const since = new Date(this.now() - QUALIFICATION_MAX_AGE_MS).toISOString();
    const { data, error } = await this.db.from('provider_canary_runs').select('report,completed_at')
      .eq('requested_by', 'auto-qualifier').eq('status', 'completed').gte('completed_at', since)
      .order('completed_at', { ascending: false }).limit(300);
    if (error) return this.cache?.map || new Map();
    const map = new Map();
    const errors = new Map();
    const coding = new Map();
    const codingErrors = new Map();
    for (const row of data || []) {
      if (row.report?.kind === 'coding_qualification') {
        for (const result of row.report.results || []) {
          if (!coding.has(result.routeId) && result.status !== 'error') coding.set(result.routeId, result);
          if (result.status === 'error' && !coding.has(result.routeId) && !codingErrors.has(result.routeId)) codingErrors.set(result.routeId, { errorCode: result.errorCode || null, testedAt: result.testedAt });
        }
        continue;
      }
      for (const result of row.report?.results || []) {
        // Newest first: a later error never hides an earlier valid result.
        if (!map.has(result.routeId) && result.status !== 'error') map.set(result.routeId, result);
        // The newest error of a route with no newer valid result drives the
        // qualifier's back-off (a dead route is not re-probed every cycle);
        // `count` is how many errors in a row it has had since its last pass.
        if (result.status === 'error' && !map.has(result.routeId)) {
          const known = errors.get(result.routeId);
          if (known) known.count += 1;
          else errors.set(result.routeId, { errorCode: result.errorCode || null, testedAt: result.testedAt, count: 1 });
        }
      }
    }
    map.errors = errors;
    map.coding = Object.assign(coding, { errors: codingErrors });
    this.cache = { at: this.now(), map };
    return map;
  }

  async save(results, { kind = 'qualification', suiteVersion = QUALIFICATION_SUITE_VERSION } = {}) {
    const at = new Date(this.now()).toISOString();
    const clean = results.map(({ error, ...rest }) => rest);
    const { error } = await this.db.from('provider_canary_runs').insert({
      requested_by: 'auto-qualifier', status: 'completed', started_at: at, completed_at: at,
      report: { kind, suiteVersion, results: clean },
    });
    this.cache = null;
    if (error) throw Object.assign(new Error('qualification write failed'), { code: 'QUALIFICATION_WRITE_FAILED' });
  }
}

export class MemoryQualificationStore {
  constructor() { this.map = new Map(); this.errors = new Map(); this.coding = new Map(); this.codingErrors = new Map(); }
  async snapshot() {
    return Object.assign(new Map(this.map), { errors: new Map(this.errors), coding: Object.assign(new Map(this.coding), { errors: new Map(this.codingErrors) }) });
  }
  async save(results, { kind = 'qualification' } = {}) {
    const [map, errors] = kind === 'coding_qualification' ? [this.coding, this.codingErrors] : [this.map, this.errors];
    for (const result of results) {
      if (result.status !== 'error') { map.set(result.routeId, result); errors.delete(result.routeId); }
      else errors.set(result.routeId, { errorCode: result.errorCode || null, testedAt: result.testedAt, count: (errors.get(result.routeId)?.count || 0) + 1 });
    }
  }
}

// Back-off after a failed qualification (Capacity V2, Part 21): a provider
// that refuses the model (400/403/404: not served to this key, invalid, no
// access) is re-tested after a day; a transient failure (429, 5xx, network)
// after an hour. Before this, dead routes were re-probed every 20 minutes
// (production 2026-09-29: ~74 HTTP 404 calls/day each for two Gemini ids).
//
// The back-off grows with consecutive failures (2026-10-09 audit: two Gemini
// 2.5 ids answered 404 every day for 10 days, and never-working OpenRouter
// `:free` routes were probed several times a day on the shared daily
// allowance): permanent errors 1 → 2 → 4 → 7 days; transient errors move from
// hourly to daily after RETIRE_AFTER failures in a row. One pass resets it.
export const QUALIFICATION_BACKOFF_MS = Object.freeze({ permanent: 24 * 3600_000, transient: 3600_000, max: 7 * 24 * 3600_000 });
export const RETIRE_AFTER = 6;
const PERMANENT_ERROR = /^HTTP_(400|401|403|404|405|410|422)$|NOT_FOUND|UNSUITABLE|INVALID_REQUEST|AUTH|NO_CREDITS|NOT_ACTIVATED/i;
export function qualificationBackoffMs(error) {
  const count = Math.max(1, Number(error?.count || 1));
  if (PERMANENT_ERROR.test(String(error?.errorCode || ''))) return Math.min(QUALIFICATION_BACKOFF_MS.max, QUALIFICATION_BACKOFF_MS.permanent * 2 ** Math.min(count - 1, 3));
  return count >= RETIRE_AFTER ? QUALIFICATION_BACKOFF_MS.permanent : QUALIFICATION_BACKOFF_MS.transient;
}
export function qualificationBackoffUntil(error, now = Date.now()) {
  if (!error?.testedAt) return null;
  const until = Date.parse(error.testedAt) + qualificationBackoffMs(error);
  return until > now ? new Date(until).toISOString() : null;
}

// Picks which routes to qualify this cycle: configured non-paid routes that
// are not cooling down and have no valid result, never-tested first. OpenRouter
// free models share one small daily allowance, so few are taken per cycle.
export function qualificationCandidates(pool, { qualifications, state, now = Date.now(), maxRoutes = 4, maxPerProvider = { openrouter: 2 } } = {}) {
  const perProvider = {};
  return pool
    .filter((route) => route.billingClass !== 'paid' && route.protocolClient && !route.unavailableReasons?.length)
    .filter((route) => !qualificationValid(qualifications?.get(route.id), now))
    .filter((route) => !isCoolingDown(state?.get(route.id), now))
    .filter((route) => !qualificationBackoffUntil(qualifications?.errors?.get(route.id), now))
    // Never-tested first, then the most capable (the likeliest to take
    // critical work), so the first cycles cover what matters most.
    .toSorted((left, right) => Number(Boolean(qualifications?.get(left.id))) - Number(Boolean(qualifications?.get(right.id)))
      || strength(right) - strength(left) || left.id.localeCompare(right.id))
    .filter((route) => {
      if (maxPerProvider === null) return true;
      const limit = maxPerProvider[route.provider] ?? 2;
      perProvider[route.provider] = (perProvider[route.provider] || 0) + 1;
      return perProvider[route.provider] <= limit;
    })
    .slice(0, maxRoutes);
}

function strength(route) {
  const capabilities = route.capabilities || {};
  return (capabilities.reasoning || 0) + (capabilities.writing || 0) + (capabilities.research || 0);
}

// Background qualifier for the Office runtime: every cycle it qualifies a few
// untested free routes (new credentials and newly discovered models are
// absorbed automatically) and records their health like real traffic.
export class AutoQualifier {
  constructor({ createPool, stateStore, store, log = () => {}, intervalMs = 6 * 3600_000, backlogIntervalMs = 20 * 60_000, firstRunDelayMs = 2 * 60_000, now = () => Date.now(), maxRoutes = 5, maxCodingRoutes = 3, dailyProviderCap = { openrouter: 6 } }) {
    this.backlogIntervalMs = backlogIntervalMs;
    this.dailyProviderCap = dailyProviderCap;
    this.dailyCount = { day: null, counts: {} };
    this.createPool = createPool;
    this.stateStore = stateStore;
    this.store = store;
    this.log = log;
    this.intervalMs = intervalMs;
    this.now = now;
    this.maxRoutes = maxRoutes;
    this.maxCodingRoutes = maxCodingRoutes;
    this.nextAt = now() + firstRunDelayMs;
    this.active = null;
  }

  maybeRun() {
    if (this.active || this.now() < this.nextAt) return false;
    this.nextAt = this.now() + this.intervalMs;
    this.active = this.runOnce()
      // While untested routes remain, come back sooner.
      .then((results) => { if (results.backlog > 0) this.nextAt = Math.min(this.nextAt, this.now() + this.backlogIntervalMs); })
      .catch((error) => this.log('WARN  qualification cycle failed:', error?.code || error?.message))
      .finally(() => { this.active = null; });
    return true;
  }

  // Providers whose free allowance is shared and small (OpenRouter: 50
  // requests/day for the whole key) get a daily cap on qualification calls.
  underDailyCap(route) {
    const day = new Date(this.now()).toISOString().slice(0, 10);
    if (this.dailyCount.day !== day) this.dailyCount = { day, counts: {} };
    const cap = this.dailyProviderCap[route.provider];
    return cap == null || (this.dailyCount.counts[route.provider] || 0) < cap;
  }

  async runOnce() {
    // The owner canary and the background cycle never qualify concurrently.
    if (this.running) return Object.assign([], { backlog: 0 });
    this.running = true;
    try {
      return await this.cycle();
    } finally {
      this.running = false;
    }
  }

  async cycle() {
    const pool = this.createPool();
    const [qualifications, state] = await Promise.all([this.store.snapshot(), this.stateStore.snapshot()]);
    const pending = qualificationCandidates(pool, { qualifications, state, now: this.now(), maxRoutes: Infinity, maxPerProvider: null });
    const candidates = qualificationCandidates(pool, { qualifications, state, now: this.now(), maxRoutes: this.maxRoutes })
      .filter((route) => {
        if (!this.underDailyCap(route)) return false;
        this.dailyCount.counts[route.provider] = (this.dailyCount.counts[route.provider] || 0) + 1;
        return true;
      });
    const results = Object.assign([], { backlog: Math.max(0, pending.length - candidates.length) });
    for (const route of candidates) {
      const result = await qualifyRoute(route, { now: this.now });
      if (result.status === 'error') await this.stateStore.recordFailure(route, classifyProviderError(result.error || { code: result.errorCode })).catch(() => {});
      else await this.stateStore.recordSuccess(route, { usage: result.usage }).catch(() => {});
      results.push(result);
    }
    if (results.length) {
      await this.store.save(results);
      this.log('Qualified free models:', JSON.stringify(results.map((result) => ({ route: result.routeId, status: result.status, passed: result.passed ?? null, error: result.errorCode || null }))));
    }
    // Coding grades are the top capacity need: every cycle also grades coding
    // candidates on providers this cycle's general runs did not touch.
    return this.codingCycle(pool, qualifications, results, { excludeProviders: new Set(candidates.map((route) => route.provider)) });
  }

  // Coding suite (coding-qualification.js): routes that passed the general
  // suite with coding and tools are graded for coding work. Up to
  // `maxCodingRoutes` per cycle, at most one per provider (never two runs on
  // one provider's quota in a cycle), skipping providers already used by this
  // cycle's general qualification. The daily caps are applied BEFORE picking,
  // so a capped provider never blocks the others. Same back-off applies.
  async codingCycle(pool, qualifications, results, { excludeProviders = new Set() } = {}) {
    const all = codingCandidates(pool, { qualifications, now: this.now(), backoffUntil: qualificationBackoffUntil, maxRoutes: Infinity });
    const picked = [];
    const providers = new Set(excludeProviders);
    for (const candidate of all) {
      if (picked.length >= this.maxCodingRoutes) break;
      if (providers.has(candidate.provider) || !this.underDailyCap(candidate)) continue;
      providers.add(candidate.provider);
      picked.push(candidate);
    }
    for (const route of picked) {
      this.dailyCount.counts[route.provider] = (this.dailyCount.counts[route.provider] || 0) + 1;
      const result = await qualifyCodingRoute(route, { now: this.now });
      if (result.status === 'error') await this.stateStore.recordFailure(route, classifyProviderError(result.error || { code: result.errorCode })).catch(() => {});
      else await this.stateStore.recordSuccess(route, { usage: result.usage }).catch(() => {});
      await this.store.save([result], { kind: 'coding_qualification', suiteVersion: CODING_SUITE_VERSION });
      this.log('Coding qualification:', JSON.stringify({ route: result.routeId, grade: result.grade || null, passed: result.passed ?? null, error: result.errorCode || null }));
      results.push(result);
    }
    // More coding candidates remain: keep the short backlog interval.
    results.backlog = (results.backlog || 0) + Math.max(0, all.length - picked.length);
    return results;
  }
}
