import test from 'node:test';
import assert from 'node:assert/strict';
import { detectLanguage, languageInstruction, officeFacts, routingLanguage } from '../src/office/language.js';
import { ACTIVE_AGENTS, DISPATCHABLE } from '../src/office/agents.js';
import { planJob } from '../src/chief.js';
import { converseDirect, performOfficeWork, synthesizeWorkflow } from '../src/office/specialist.js';
import { OfficeBridge } from '../src/channels/office-bridge.js';
import { capabilityProfile, languageFit, languageGaps } from '../src/model-gateway/agentic/capabilities.js';

const ARABIC = 'مرحبا Chief، أعطني حالة Fahad AI Office الحالية في 3 نقاط فقط.';
const ENGLISH = 'Give me the current status of the office in three points.';
const MIXED = 'Chief، I need the launch plan for the app، بس خل الـ Legal يراجع the terms first.';

test('language detection: Arabic with English terms is Arabic; English is English; a real mix is mixed', () => {
  assert.equal(detectLanguage(ARABIC), 'ar');
  assert.equal(detectLanguage('حولها للفاينانس: كم تكلفة الاستضافة؟'), 'ar');
  assert.equal(detectLanguage('خل الـ Legal يراجع الـ PR قبل الـ deploy'), 'ar');
  assert.equal(detectLanguage(ENGLISH), 'en');
  assert.equal(detectLanguage('Fix the CI on PR 62 ```const x = "مرحبا"```'), 'en', 'code blocks do not count');
  assert.equal(detectLanguage(MIXED), 'mixed');
  assert.equal(routingLanguage(ENGLISH), null);
  assert.equal(routingLanguage(ARABIC), 'ar');
  assert.equal(routingLanguage(MIXED), 'ar');
});

test('Arabic message → polished Emirati instruction (grammar, no literal translation, English terms, MSA only where needed)', () => {
  const rule = languageInstruction(ARABIC);
  assert.match(rule, /Fahad wrote in Arabic — answer in Arabic/);
  assert.match(rule, /polished Emirati \(UAE\) conversational Arabic/);
  assert.match(rule, /Grammar must be correct: noun–adjective and subject–verb agreement/);
  assert.match(rule, /Never translate literally from English/);
  assert.match(rule, /no heavy slang, no exaggerated dialect/);
  assert.match(rule, /Modern Standard Arabic only for legal text, contracts, formal reports, official documents and technical definitions/);
  assert.match(rule, /Do not mix formal Arabic and slang inside one sentence/);
  for (const term of ['Chief', 'Finance', 'Legal', 'Coding', 'PR', 'CI', 'deploy', 'API', 'dashboard', 'workflow']) assert.ok(rule.includes(term), `${term} stays English`);
  assert.match(rule, /«تمام، خلني أرتب لك الموضوع\.»/);
  assert.match(rule, /Clarity first/);
});

test('English message → English; mixed message → the same natural mix', () => {
  const english = languageInstruction(ENGLISH);
  assert.match(english, /Fahad wrote in English — write everything in clear, natural English/);
  assert.doesNotMatch(english, /Emirati/);
  const mixed = languageInstruction(MIXED);
  assert.match(mixed, /Fahad mixes Arabic and English — answer in the same natural mix/);
  assert.match(mixed, /Grammar must be correct/);
});

test('every Office voice gets the rule: CHIEF plan/answer, employees, synthesis, direct chat, consult', async () => {
  const prompts = {};
  const capture = (name) => async (input) => { prompts[name] = input.prompt; return { text: '{"route":"answer","answer":"x","plan_summary":"x"}' }; };
  const agent = { system_prompt: '' };
  await planJob({ agent, goal: ARABIC, run: capture('chief') });
  await performOfficeWork({ agent, role: 'legal', goal: ARABIC, brief: 'Review the launch terms carefully', title: 'Terms', run: capture('employee') });
  await synthesizeWorkflow({ agent, goal: ARABIC, synthesisBrief: 'status', outputs: [], allowRevision: false, run: capture('synthesis') });
  await converseDirect({ agent, role: 'finance', goal: ARABIC, run: capture('direct') });
  await converseDirect({ agent, role: 'coding', goal: 'What infrastructure is needed for 500 users?', consultFrom: 'FINANCE', run: capture('consult') });
  for (const name of ['chief', 'employee', 'synthesis', 'direct']) assert.match(prompts[name], /polished Emirati \(UAE\) conversational Arabic/, name);
  assert.match(prompts.consult, /The request is in English/);
  const english = {};
  await planJob({ agent, goal: ENGLISH, run: async (input) => { english.chief = input.prompt; return { text: '{"route":"answer","answer":"x","plan_summary":"x"}' }; } });
  assert.match(english.chief, /Fahad wrote in English/);
  assert.doesNotMatch(english.chief, /Emirati \(UAE\) conversational/);
});

test('CHIEF knows the roster: 8 specialists plus CHIEF, LEGAL never omitted', async () => {
  const specialists = ACTIVE_AGENTS.filter((agent) => agent.executor !== 'chief').map((agent) => agent.label);
  assert.deepEqual(specialists, ['RESEARCH', 'CREATIVE', 'PRODUCT', 'FINANCE', 'CODING', 'AUDIT', 'SOCIAL', 'LEGAL']);
  assert.equal(DISPATCHABLE.length, 8);
  assert.ok(DISPATCHABLE.includes('legal'));
  const facts = officeFacts(ACTIVE_AGENTS);
  assert.match(facts, /has 9 roles/);
  assert.match(facts, /CHIEF \(you: the head[^)]*\) and 8 specialists: RESEARCH, CREATIVE, PRODUCT, FINANCE, CODING, AUDIT, SOCIAL, LEGAL\./);
  assert.match(facts, /Never invent people, members, organizations/);
  let prompt = '';
  await planJob({ agent: { system_prompt: '' }, goal: 'كم موظف عندك في المكتب؟', run: async (input) => { prompt = input.prompt; return { text: '{"route":"answer","answer":"x","plan_summary":"x"}' }; } });
  assert.match(prompt, /8 specialists: RESEARCH, CREATIVE, PRODUCT, FINANCE, CODING, AUDIT, SOCIAL, LEGAL/);
  assert.match(prompt, /legal: LEGAL/, 'LEGAL is dispatchable in the plan prompt');
  assert.doesNotMatch(prompt, /7 specialists|seven specialists/i);
});

test('the stored CHIEF prompt no longer lists the retired team (migration)', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const dir = new URL('../supabase/migrations/', import.meta.url);
  const latest = readdirSync(dir).filter((name) => /chief_roster_language/.test(name));
  assert.equal(latest.length, 1);
  const sql = readFileSync(new URL(latest[0], dir), 'utf8');
  for (const label of ['RESEARCH', 'CREATIVE', 'PRODUCT', 'FINANCE', 'CODING', 'AUDIT', 'SOCIAL', 'LEGAL']) assert.ok(sql.includes(`- ${label}:`), `${label} in the team`);
  assert.match(sql, /8 specialists/);
  assert.doesNotMatch(sql.split('$prompt$')[1], /research-strategy:|qa-security:|operations:/);
});

test('Arabic answers prefer models that write Arabic well; weak ones are not offered Arabic work', () => {
  const profile = (model) => capabilityProfile({ model, qualityTier: 3, contextWindow: 128_000, billingClass: 'free' });
  assert.equal(profile('gemini-flash-latest').arabic, 5);
  assert.equal(profile('qwen/qwen3.8-27b').arabic, 2);
  assert.deepEqual(languageGaps(profile('qwen/qwen3.8-27b'), 'ar'), ['CAPABILITY_ARABIC_BELOW_3']);
  assert.deepEqual(languageGaps(profile('qwen/qwen3.8-27b'), null), [], 'English work is unaffected');
  assert.deepEqual(languageGaps(profile('openai/gpt-oss-120b'), 'ar'), []);
  assert.ok(profile('some-unknown-model').arabic <= 3, 'unknown models never outrank known Arabic writers');
  const route = (model) => ({ capabilities: profile(model) });
  assert.ok(languageFit(route('gemini-flash-latest'), 'ar') > languageFit(route('openai/gpt-oss-120b'), 'ar'));
  assert.equal(languageFit(route('gemini-flash-latest'), null), 0);
});

test('Telegram replies follow the message language', async () => {
  const tables = { conversations: [], jobs: [] };
  const db = { from: (name) => {
    const api = { select: () => api, eq: () => api, limit: () => api, order: () => api, in: () => api, gte: () => api,
      maybeSingle: async () => ({ data: tables[name]?.[0] || null }), single: async () => ({ data: { id: 'c1' } }),
      insert: (row) => { (tables[name] ||= []).push({ id: 'c1', ...row }); return api; }, update: () => api, then: (resolve) => resolve({ data: null, error: null }) };
    return api;
  } };
  const bridge = new OfficeBridge({ db, store: { createJob: async () => ({ id: 'j1' }) }, workspaceId: 'ws', hubUrl: 'https://office.example' });
  assert.match((await bridge.handleMessage(ARABIC)).reply, /^تمام، الـ Chief استلم الطلب وشغال عليه\./);
  assert.match((await bridge.handleMessage(ENGLISH)).reply, /^CHIEF is on it\./);
});
