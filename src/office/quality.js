// Output reliability gates that run in code around the Office employees:
//   cleanOutput       — no process/preamble leakage in delivered text
//   socialCalendar    — a content calendar is always a real calendar artifact
//   numericChecks     — AUDIT's deterministic checks (before its model review)
//   enforceAudit      — failed code checks always become AUDIT findings
//   chiefGate         — the validated facts CHIEF must preserve
//   enforceFacts      — CHIEF text cannot carry a figure that contradicts them
//   evidenceGate      — degraded web search is recorded, never hidden
import { ARTIFACT_TYPES, realUrl, repairArtifactFences } from './artifacts.js';
import { officeAgent } from './agents.js';
import { FINANCE_STATES, SCHEDULE_TOLERANCE, agrees, artifactBlocks, financialTables, fmt, mapArtifactBlocks, needsCorrection, parseAmount, proseClaims, scheduleTable, validateFinance, validatedFacts } from './finance.js';

const BLOCK = /```artifact\s*\n[\s\S]*?```/g;
const typeOf = (raw) => String(raw?.type || '').toLowerCase();

// ------------------------------------------------------------ preamble

// Sentences that narrate the model's process instead of delivering work.
const PROCESS_LINE = /^\s*(?:now,? (?:that )?i (?:have|will|'ll|can)|let me\b|let's\b|i(?:'ll| will| am going to| need to)\s+(?:now\s+)?(?:research|build|create|start|look|check|search|draft|prepare|put|compile|write|use|fetch|gather|verify|review|begin)|based on (?:the |my )?(?:tool|search|fetch|web)[\w\s]{0,20}(?:output|results?|data)|okay[,.!]|alright[,.!]|great[,.!]|perfect[,.!]|first,? i(?:'ll| will)|i (?:have )?(?:now )?(?:gathered|collected|found) (?:enough|the|all)|here is my (?:analysis|plan) based on)/i;

// Standalone narration lines removed anywhere: only explicit process verbs,
// so content such as "Great, demand is strong." or a caption stays.
const NARRATION_LINE = /^\s*(?:now,? (?:that )?i (?:have|will|'ll|can)\b|let me (?:now )?(?:check|look|build|create|draft|compile|gather|verify|research|search|start|begin|put together|fetch|review|pull|calculate|summari[sz]e|think)|i(?:'ll| will| am going to) (?:now )?(?:research|build|create|start|look|check|search|draft|prepare|compile|write|use|fetch|gather|verify|review|begin)|based on (?:the |my )?(?:tool|search|fetch|web)\b)/i;

export function cleanOutput(markdown) {
  let text = repairArtifactFences(String(markdown || '').replace(/^\uFEFF/, ''));
  // Everything before the first section heading is dropped when it is only
  // process narration (short, no artifact, no table).
  const first = text.search(/^##?\s/m);
  if (first > 0) {
    const prefix = text.slice(0, first);
    const lines = prefix.split('\n').map((line) => line.trim()).filter(Boolean);
    if (prefix.length <= 800 && !/```|\|/.test(prefix) && lines.length && lines.every((line) => PROCESS_LINE.test(line) || line.length < 3)) text = text.slice(first);
  } else if (first < 0) {
    const [head, ...rest] = text.split('\n');
    if (PROCESS_LINE.test(head) && rest.join('\n').trim()) text = rest.join('\n').trimStart();
  }
  // Standalone narration lines anywhere (outside artifact blocks and tables).
  const blocks = [];
  text = text.replace(BLOCK, (match) => { blocks.push(match); return `\u0000${blocks.length - 1}\u0000`; });
  text = text.split('\n').filter((line) => !(line.length <= 220 && NARRATION_LINE.test(line) && /[.:!…]\s*$/.test(line.trim()) && !/^\s*[|#>*-]/.test(line))).join('\n');
  return text.replace(/\u0000(\d+)\u0000/g, (_, index) => blocks[Number(index)]).replace(/\n{3,}/g, '\n\n').trim();
}

// ------------------------------------------------------------ SOCIAL

const CALENDAR_COLUMNS = {
  date: /^(date|day|when|week|التاريخ|اليوم)/i, platform: /^(platform|channel|network|المنصة)/i, pillar: /(pillar|theme|topic|المحور)/i,
  format: /^(format|type|content type|الصيغة|النوع)/i, hook: /(hook|headline|title|idea|الفكرة|العنوان)/i, caption: /(caption|copy|script|text|النص)/i,
  cta: /^(cta|call to action)/i, status: /^status|الحالة/i, notes: /(notes?|visual|ملاحظات)/i, time: /(time|posting time|الوقت)/i,
};

// SOCIAL's calendar must be a content_calendar artifact. A Markdown table that
// is clearly a calendar is converted by code; posting times without evidence
// are labelled as assumptions.
export function socialCalendar(markdown, { timesVerified = false } = {}) {
  let text = String(markdown || '');
  const hasCalendar = artifactBlocks(text).some((block) => typeOf(block.raw) === 'content_calendar');
  let converted = 0;
  if (!hasCalendar) {
    text = text.replace(/((?:^\|[^\n]*\|[ \t]*(?:\n|$(?![\s\S]))){3,})/gm, (table) => {
      if (converted) return table;
      const rows = table.trim().split('\n').map((line) => line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim()));
      const header = rows[0];
      const body = rows.slice(1).filter((row) => !row.every((cell) => /^:?-{2,}:?$/.test(cell)));
      const index = Object.fromEntries(Object.entries(CALENDAR_COLUMNS).map(([key, pattern]) => [key, header.findIndex((cell) => pattern.test(cell))]));
      if (index.date < 0 || index.platform < 0 || (index.hook < 0 && index.caption < 0) || body.length < 2) return table;
      const pick = (row, key) => (index[key] >= 0 ? row[index[key]] || '' : '');
      const entries = body.slice(0, 60).map((row) => ({
        date: pick(row, 'date'), platform: pick(row, 'platform'), pillar: pick(row, 'pillar'), format: pick(row, 'format'), hook: pick(row, 'hook'),
        caption: pick(row, 'caption'), cta: pick(row, 'cta'), status: pick(row, 'status') || 'draft', notes: pick(row, 'notes'),
        ...(pick(row, 'time') ? { time: pick(row, 'time'), time_basis: 'ASSUMPTION' } : {}),
      }));
      converted = entries.length;
      return `\`\`\`artifact\n${JSON.stringify({ type: 'content_calendar', title: 'Content calendar', entries })}\n\`\`\`\n`;
    });
  }
  // Posting times are assumptions unless SOCIAL had account data.
  text = mapArtifactBlocks(text, (raw) => {
    if (typeOf(raw) !== 'content_calendar' || !Array.isArray(raw.entries)) return null;
    return { ...raw, entries: raw.entries.map((entry) => (entry?.time && (!timesVerified || !entry.time_basis) ? { ...entry, time_basis: /data|verified/i.test(entry.time_basis || '') && timesVerified ? entry.time_basis : 'ASSUMPTION' } : entry)) };
  });
  return { text, converted };
}

// ------------------------------------------------------------ AUDIT

const BLOCKING = new Set(['TOTAL_MISMATCH', 'BREAK_EVEN_MISMATCH', 'BREAK_EVEN_NOT_REACHED', 'BREAK_EVEN_UNSUPPORTED', 'SUMMARY_MISMATCH', 'TABLE_TOTAL_MISMATCH', 'CLAIM_UNSUPPORTED',
  'TABLE_SCHEDULE_MISMATCH', 'TABLE_YEAR_TOTAL_MISMATCH', 'TABLE_HEADLINE_MISMATCH', 'CHART_MISMATCH']);

const FIXES = {
  TOTAL_MISMATCH: 'State the calculated figure, or change the assumptions that produce it.',
  SUMMARY_MISMATCH: 'Make the summary use the calculated figure.',
  BREAK_EVEN_MISMATCH: 'Use the break-even month the schedule produces.',
  BREAK_EVEN_NOT_REACHED: 'Say that break-even is not reached within the modelled period, or change the assumptions.',
  BREAK_EVEN_UNSUPPORTED: 'Add the revenue assumptions to the financial_model, or remove the break-even claim.',
  CLAIM_UNSUPPORTED: 'Add the inputs that produce this figure, or remove it.',
  CHART_MISMATCH: 'Remove the hand-drawn chart; the Office draws the calculated schedule.',
  TABLE_TOTAL_MISMATCH: 'Correct the total so it equals the sum of its rows.',
  TABLE_SCHEDULE_MISMATCH: 'Use the calculated monthly schedule, or remove the table.',
  TABLE_YEAR_TOTAL_MISMATCH: 'Use the calculated monthly schedule and its totals, or remove the table.',
  TABLE_HEADLINE_MISMATCH: 'State the validated figure, or remove the row.',
  NO_STRUCTURED_MODEL: 'Provide a financial_model artifact with the cost lines, revenue assumptions and claims.',
  UNSUPPORTED_FIGURES: 'Back every figure with a structured financial_model.',
};

// The calculation of the VERIFIED FINANCE model among these outputs (the
// only source of monthly financial truth), or null.
export function verifiedCalculation(outputs = []) {
  for (const output of outputs) {
    if (officeAgent(output.agent_slug)?.key !== 'finance' || !output.content) continue;
    const validation = validateFinance(output.content);
    if (validation.state === FINANCE_STATES.VERIFIED && validation.calculated) return validation.calculated;
  }
  return null;
}

// Worst issue first: a wrong year total or headline is what a reader acts on.
const ISSUE_RANK = ['BREAK_EVEN_MISMATCH', 'TABLE_YEAR_TOTAL_MISMATCH', 'TABLE_HEADLINE_MISMATCH', 'TABLE_TOTAL_MISMATCH', 'TABLE_SCHEDULE_MISMATCH', 'CHART_MISMATCH'];
const rank = (entry) => { const index = ISSUE_RANK.indexOf(entry.code); return index < 0 ? ISSUE_RANK.length : index; };

// One BLOCKED finding per financial table / chart that contradicts the
// calculator (every monthly row, total and headline was compared).
export function tableFinding(entry, owner, ownerLabel) {
  const sorted = [...entry.issues].sort((a, b) => rank(a) - rank(b));
  const head = sorted[0];
  const months = entry.issues.filter((item) => item.code === 'TABLE_SCHEDULE_MISMATCH' || item.code === 'CHART_MISMATCH').length;
  return {
    type: 'NUMERIC_INCONSISTENCY', code: head.code, title: `${ownerLabel}: financial table contradicts the calculation`, severity: 'blocked',
    area: owner, owner, table: entry.title,
    detail: `${head.detail}${sorted.length > 1 ? ` (${sorted.length} mismatches in "${entry.title}"${months ? `, ${months} monthly value${months === 1 ? '' : 's'}` : ''})` : ''}`,
    expected: fmtMaybe(head.expected), actual: fmtMaybe(head.actual), evidence: entry.title, fix: FIXES[head.code] || FIXES.TABLE_SCHEDULE_MISMATCH,
    mismatches: sorted.slice(0, 12).map((item) => ({ code: item.code, field: item.field, expected: item.expected, actual: item.actual })),
  };
}

// Deterministic checks AUDIT runs on every upstream output before its review.
export function numericChecks(upstream = []) {
  const findings = [];
  const passed = [];
  const calculated = verifiedCalculation(upstream);
  for (const output of upstream) {
    const employee = officeAgent(output.agent_slug);
    if (!employee || !output.content) continue;
    if (employee.key === 'finance') {
      const validation = validateFinance(output.content);
      if (validation.state === FINANCE_STATES.VERIFIED) {
        passed.push(`FINANCE "${output.title}": VERIFIED — ${validatedFacts(validation).slice(0, 4).map((fact) => `${fact.label} ${fact.value}`).join('; ')}.`);
        continue;
      }
      if (!needsCorrection(validation)) { passed.push(`FINANCE "${output.title}": no figures to verify.`); continue; }
      for (const entry of validation.issues) {
        findings.push({
          type: 'NUMERIC_INCONSISTENCY', code: entry.code, title: `Finance: ${label(entry.code)}`,
          severity: validation.state === FINANCE_STATES.INSUFFICIENT ? 'high' : BLOCKING.has(entry.code) ? 'blocked' : 'high',
          area: 'finance', owner: 'finance', detail: entry.detail, expected: entry.expected === null ? '' : String(fmtMaybe(entry.expected)),
          actual: entry.actual === null ? '' : String(fmtMaybe(entry.actual)), evidence: entry.evidence || output.title, fix: FIXES[entry.code] || 'Correct the figure.',
        });
      }
      continue;
    }
    // Other employees, with a VERIFIED calculation: every financial table and
    // chart (artifact or Markdown) is compared row by row with the calculator.
    if (calculated) {
      const tables = financialTables(output.content, calculated);
      for (const entry of tables.filter((item) => item.issues.length)) findings.push(tableFinding(entry, employee.key, employee.label));
      const clean = tables.filter((item) => !item.issues.length);
      if (clean.length) passed.push(`${employee.label} "${output.title}": ${clean.length} financial table${clean.length === 1 ? '' : 's'} match the calculation.`);
      continue;
    }
    // Without a calculation: every table total must equal its rows.
    for (const block of artifactBlocks(output.content).filter((entry) => typeOf(entry.raw) === 'table')) {
      const table = ARTIFACT_TYPES.table.clean(block.raw);
      if (!table) continue;
      const wrapped = `\`\`\`artifact\n${JSON.stringify({ type: 'financial_model', items: [{ item: 'x', one_time: 0 }] })}\n\`\`\`\n\`\`\`artifact\n${JSON.stringify(block.raw)}\n\`\`\``;
      for (const entry of validateFinance(wrapped).issues.filter((item) => item.code === 'TABLE_TOTAL_MISMATCH')) {
        findings.push({ type: 'NUMERIC_INCONSISTENCY', code: entry.code, title: `${employee.label}: table total does not add up`, severity: 'high', area: employee.key, owner: employee.key,
          detail: entry.detail, expected: fmtMaybe(entry.expected), actual: fmtMaybe(entry.actual), evidence: entry.evidence, fix: FIXES.TABLE_TOTAL_MISMATCH });
      }
    }
  }
  return { findings, passed, calculated };
}

// Removes every model-written monthly schedule and every financial table or
// chart that contradicts the calculator; the calculator's own schedule table
// takes the place of the first one removed. Models may explain the numbers,
// never restate a second schedule.
export function sanitizeFinancial(markdown, calculated, { replace = true } = {}) {
  let text = String(markdown || '');
  if (!calculated) return { text, removed: [], issues: [] };
  const tables = financialTables(text, calculated).filter((entry) => entry.issues.length || (entry.schedule && !entry.calculated));
  if (!tables.length) return { text, removed: [], issues: [] };
  const hasCalculator = artifactBlocks(text).some((block) => typeOf(block.raw) === 'table' && block.raw.calculated === true
    && !financialTables(block.source, calculated).some((entry) => entry.issues.length));
  const replacement = replace && !hasCalculator ? scheduleTable(calculated) : null;
  let placed = false;
  for (const entry of tables) {
    const at = text.indexOf(entry.source);
    if (at < 0) continue;
    let insert = '';
    if (replacement && !placed && entry.schedule) {
      insert = `> The monthly figures below are the calculator's schedule (a model-written table ${entry.issues.length ? 'contradicted it' : 'restated it'} and was replaced).\n\n\`\`\`artifact\n${JSON.stringify(replacement)}\n\`\`\`\n`;
      placed = true;
    }
    text = `${text.slice(0, at)}${insert}${text.slice(at + entry.source.length)}`;
  }
  return { text: text.replace(/\n{3,}/g, '\n\n').trim(), removed: tables, issues: tables.flatMap((entry) => entry.issues), replaced: placed };
}

// AUDIT's own draft is held to the same rule: a financial table in AUDIT's
// review that contradicts the calculator is a BLOCKED finding and is removed
// before anyone reads it (resolved: the table no longer exists).
export function auditOwnTables(markdown, checks) {
  const calculated = checks?.calculated;
  if (!calculated) return { text: String(markdown || ''), findings: [] };
  const sanitized = sanitizeFinancial(markdown, calculated);
  const findings = sanitized.removed.filter((entry) => entry.issues.length)
    .map((entry) => ({ ...tableFinding(entry, 'audit', 'AUDIT'), resolved: true, resolution: 'Table removed and replaced by the calculator schedule before delivery.' }));
  return { text: sanitized.text, findings };
}

const fmtMaybe = (value) => (typeof value === 'number' ? fmt(value) : value ?? '');
const label = (code) => ({ TOTAL_MISMATCH: 'stated total does not match the calculation', SUMMARY_MISMATCH: 'summary contradicts the calculation',
  BREAK_EVEN_MISMATCH: 'break-even month is wrong', BREAK_EVEN_NOT_REACHED: 'break-even is claimed but never reached', BREAK_EVEN_UNSUPPORTED: 'break-even cannot be reproduced',
  CLAIM_UNSUPPORTED: 'figure cannot be reproduced', CHART_MISMATCH: 'chart does not match the calculation', TABLE_TOTAL_MISMATCH: 'table total does not add up',
  TABLE_SCHEDULE_MISMATCH: 'monthly table does not match the calculation', NO_STRUCTURED_MODEL: 'no structured model to verify', UNSUPPORTED_FIGURES: 'figures without a structured model' }[code] || code.toLowerCase());

export function codeChecksBlock({ findings, passed }) {
  if (!findings.length && !passed.length) return '';
  return [
    'CODE CHECKS (deterministic, run before your review — authoritative; never contradict them, report every FAILED check as a finding owned by the named employee):',
    ...passed.map((line) => `PASSED: ${line}`),
    ...findings.map((finding) => `FAILED [${finding.severity.toUpperCase()}] ${finding.owner.toUpperCase()}: ${finding.detail}${finding.expected !== '' ? ` (expected ${finding.expected}, stated ${finding.actual || '—'})` : ''}`),
  ].join('\n');
}

// Failed code checks are always in AUDIT's report, whatever the model wrote.
export function enforceAudit(markdown, { findings, passed }) {
  if (!findings.length && !passed.length) return String(markdown || '');
  let text = String(markdown || '');
  let found = false;
  // A resolved finding (its table was removed by code) is reported, not open.
  const verdictFor = (current, list) => (list.some((finding) => finding.severity === 'blocked' && !finding.resolved) ? 'BLOCKED'
    : list.some((finding) => ['high', 'critical'].includes(finding.severity) && !finding.resolved) && current === 'PASS' ? 'NEEDS WORK' : current);
  text = mapArtifactBlocks(text, (raw) => {
    if (typeOf(raw) !== 'audit_report' || found) return null;
    found = true;
    const existing = Array.isArray(raw.findings) ? raw.findings.filter((finding) => finding?.type !== 'NUMERIC_INCONSISTENCY') : [];
    const merged = [...findings, ...existing];
    return { ...raw, verdict: verdictFor(String(raw.verdict || 'PASS').toUpperCase(), merged), findings: merged };
  });
  if (!found && findings.length) {
    text += `\n\n\`\`\`artifact\n${JSON.stringify({ type: 'audit_report', title: 'Numeric validation', verdict: verdictFor('PASS', findings), findings })}\n\`\`\``;
  }
  const section = ['## Code checks (deterministic)', ...passed.map((line) => `- PASSED — ${line}`),
    ...findings.map((finding) => `- FAILED (${finding.severity.toUpperCase()}, owner ${finding.owner.toUpperCase()})${finding.resolved ? ' — RESOLVED BY CODE' : ''} — ${finding.detail}${finding.resolved ? ` ${finding.resolution}` : ''}`)].join('\n');
  return `${text.replace(/\n## Code checks \(deterministic\)[\s\S]*?(?=\n## |$(?![\s\S]))/, '').trim()}\n\n${section}`;
}

// ------------------------------------------------------------ CHIEF

// What CHIEF may state as fact, and what must go back to its owner first.
export function chiefGate(outputs = []) {
  const finance = [];
  const banned = [];
  for (const output of outputs) {
    const employee = officeAgent(output.agent_slug);
    if (employee?.key !== 'finance' || !output.content) continue;
    const validation = validateFinance(output.content);
    finance.push({ taskId: output.task_id, title: output.title, validation });
    for (const entry of validation.issues) if (typeof entry.actual === 'number' && Math.abs(entry.actual) >= 100 && entry.field !== 'text:break_even_month' && entry.field !== 'break_even_month') banned.push(entry.actual);
  }
  const auditBlocked = [];
  for (const output of outputs) {
    if (officeAgent(output.agent_slug)?.key !== 'audit' || !output.content) continue;
    for (const block of artifactBlocks(output.content).filter((entry) => typeOf(entry.raw) === 'audit_report')) {
      for (const finding of Array.isArray(block.raw.findings) ? block.raw.findings : []) {
        if (finding?.type !== 'NUMERIC_INCONSISTENCY') continue;
        if (finding.severity === 'blocked') auditBlocked.push(finding);
        // A table finding bans its wrong totals, headlines and cumulative
        // values (not every monthly value, which may legitimately recur).
        const wrong = Array.isArray(finding.mismatches)
          ? finding.mismatches.filter((entry) => entry.code !== 'BREAK_EVEN_MISMATCH' && (entry.code !== 'TABLE_SCHEDULE_MISMATCH' || /cumulative/.test(entry.field || '')) && entry.code !== 'CHART_MISMATCH').map((entry) => entry.actual)
          : [parseAmount(finding.actual)];
        for (const stated of wrong) if (typeof stated === 'number' && Math.abs(stated) >= 100) banned.push(stated);
      }
    }
  }
  const unverified = finance.filter((entry) => needsCorrection(entry.validation));
  const verified = finance.filter((entry) => entry.validation.state === FINANCE_STATES.VERIFIED);
  const calculated = verified[0]?.validation.calculated || null;
  // An employee's financial tables are clean when its latest output has no
  // table contradicting the calculator.
  const tablesClean = (owner) => {
    const latest = outputs.filter((output) => officeAgent(output.agent_slug)?.key === owner && output.content).at(-1);
    return Boolean(calculated && latest && !financialTables(latest.content, calculated).some((entry) => entry.issues.length));
  };
  // An AUDIT numeric finding is resolved once the owner's current output
  // re-validates as VERIFIED, when code already removed the table (resolved),
  // or when the owner's current tables match the calculator.
  const openAudit = auditBlocked.filter((finding) => {
    if (finding.resolved === true) return false;
    if (finding.owner === 'finance') return !finance.length || unverified.length > 0;
    if (Array.isArray(finding.mismatches) && finding.owner !== 'audit') return !tablesClean(finding.owner);
    return true;
  });
  return {
    finance, verified, unverified, openAudit, banned: [...new Set(banned)], calculated,
    facts: verified.flatMap((entry) => validatedFacts(entry.validation)),
    blocked: unverified.length > 0 || openAudit.length > 0,
  };
}

export function factsBlock(gate) {
  if (!gate.facts.length && !gate.unverified.length && !gate.openAudit.length) return '';
  const lines = ['VALIDATED FACTS (calculated by code from FINANCE\'s assumptions — the source of truth):'];
  if (gate.facts.length) {
    lines.push(...gate.facts.map((fact) => `${fact.key} = ${fact.value}  (${fact.label})`));
    lines.push('Use these exact values wherever you mention them. Never compute, round differently or restate a different total, revenue, cost, margin or break-even.',
      'Never write your own monthly schedule table or chart (revenue, costs, net or cumulative by month): the Office attaches the calculator\'s schedule; any other schedule is removed. Explain the numbers, do not recalculate them.');
  }
  for (const entry of gate.unverified) {
    lines.push(`FINANCE "${entry.title}" is ${entry.validation.state}: its figures are NOT verified. Do not present any of its numbers as fact; report it under "Open issues & risks".`,
      ...entry.validation.issues.slice(0, 5).map((issue) => `  - ${issue.detail}`));
  }
  if (gate.openAudit.length) lines.push(`AUDIT has ${gate.openAudit.length} unresolved BLOCKED numeric finding(s); the project cannot be presented as complete.`);
  return lines.join('\n');
}

const FINANCE_WORDS = /revenue|sales|cost|expense|spend|net|profit|loss|margin|cash|break[\s-]?even|إيراد|تكاليف|مصاريف|صافي|ربح|التعادل/i;
const PERIOD_WORDS = /first[\s-]year|year[\s-]?(?:one|1)\b|12[\s-]?month|annual|total (?:revenue|costs?|expenses)|net (?:result|profit|loss)|السنة الأولى|سنوي|إجمالي/i;
// Lines about other companies or the market are not our figures.
const OTHER_PARTY = /competitor|market size|industry|\b(?:tam|sam|som)\b|منافس|السوق/i;

// Figures written in text, with the token as written (for its precision).
const FIGURE = /-?\d[\d,]*(?:\.\d+)?\s*(?:k|m|mn|million|thousand|ألف|مليون)?\b(?!\s*%)/gi;
const figures = (line) => [...String(line).matchAll(FIGURE)].map((match) => ({ token: match[0], value: parseAmount(match[0]) }))
  .filter((entry) => entry.value !== null && !/^(?:19|20)\d\d$/.test(entry.token.trim()));

// A written figure states a validated value when it equals it at the
// precision it is written with ("112,236", "112K", "AED 0.11M"); a nearby
// but different figure ("111,489") does not.
export function statesValue(token, value, good) {
  if (typeof good !== 'number' || value === null) return false;
  if (agrees(value, good, SCHEDULE_TOLERANCE)) return true;
  const raw = String(token).trim().toLowerCase();
  const decimals = (raw.match(/\.(\d+)/) || [, ''])[1].length;
  let unit = 1;
  if (/(k|thousand|ألف)$/.test(raw)) unit = 1000 / 10 ** decimals;
  else if (/(m|mn|million|مليون)$/.test(raw)) unit = 1_000_000 / 10 ** decimals;
  else if (!decimals) unit = 10 ** Math.min(((raw.replace(/[^\d]/g, '').match(/0+$/) || [''])[0]).length, 6);
  return unit > 1 && Math.abs(Math.abs(value) - Math.abs(good)) <= unit / 2;
}

const MONTH_REF = /\bmonth\s*(\d{1,2})\b|\bM(\d{1,2})\b|الشهر\s*(\d{1,2})/g;
const SCHEDULE_WORDS = [['cumulative', /cumulative|running (?:cash|total)|cash (?:balance|position)|تراكمي/i], ['net', /\bnet\b|profit|loss|cash[\s-]?flow|صافي|ربح/i],
  ['revenue', /revenue|mrr|sales|income|إيراد/i], ['costs', /costs?|expenses?|spend|burn|تكاليف|مصاريف/i]];

// Removes any line of CHIEF's text (prose, Markdown table rows, artifact
// tables) that carries a figure contradicting the validated calculation or a
// figure already proven wrong; replaces every model-written monthly schedule
// with the calculator's; then appends the validated figures. `remaining`
// counts contradictions still present afterwards (must be 0).
export function enforceFacts(markdown, gate) {
  if (!gate.facts.length && !gate.unverified.length && !gate.banned.length) return { text: String(markdown || ''), removed: 0, tables: 0, remaining: 0 };
  const calc = gate.calculated || gate.verified[0]?.validation.calculated || null;
  let removed = 0;
  // 1. Financial tables and charts: only the calculator's schedule survives.
  const sanitized = sanitizeFinancial(markdown, calc);
  removed += sanitized.removed.length;
  const monthConflict = (line, values) => {
    if (!calc?.schedule) return false;
    const months = [...line.matchAll(MONTH_REF)].map((match) => Number(match[1] || match[2] || match[3])).filter((month) => month >= 1 && month <= calc.months);
    const keys = SCHEDULE_WORDS.filter(([key, pattern]) => pattern.test(line) && (key === 'costs' || calc.model !== 'costs_only')).map(([key]) => key);
    if (!months.length || !keys.length) return false;
    const candidates = [...keys.flatMap((key) => months.map((month) => calc.schedule[key]?.[month - 1])),
      calc.year_revenue, calc.year_costs, calc.net, calc.total_one_time, calc.monthly_run_rate, calc.ending_mrr, calc.ending_cash, calc.starting_cash].filter((value) => typeof value === 'number');
    return values.some(({ token, value }) => Math.abs(value) >= 100 && !candidates.some((good) => statesValue(token, value, good)));
  };
  const conflicts = (line) => {
    const values = figures(line);
    if (!values.length) return false;
    if (gate.banned.some((bad) => values.some(({ value }) => Math.abs(value) >= 100 && agrees(value, bad, { relative: 0.005 })))) return true;
    if (!FINANCE_WORDS.test(line) || OTHER_PARTY.test(line)) return false;
    // Unverified FINANCE: no money figure from it may be stated as fact.
    if (!calc) return gate.unverified.length > 0 && values.some(({ value }) => Math.abs(value) >= 1000) && /AED|USD|\$|€|درهم|revenue|cost|إيراد|تكاليف/i.test(line);
    const beMatch = line.match(/break[\s-]?even[^|\n]{0,60}?month\s*(\d{1,2})|month\s*(\d{1,2})[^|\n]{0,30}break[\s-]?even|التعادل[^|\n]{0,40}?الشهر\s*(\d{1,2})/i);
    if (beMatch) {
      const month = Number(beMatch[1] || beMatch[2] || beMatch[3]);
      const negated = /\b(not|never|no|beyond)\b|لن|لا/i.test(beMatch[0]);
      if (!negated && month !== calc.break_even_month && month !== calc.operating_break_even_month) return true;
      if (negated && calc.break_even_month !== null && calc.break_even_month <= month) return true;
    }
    // A figure for a named month must be that month's calculated value.
    if (monthConflict(line, values)) return true;
    if (!PERIOD_WORDS.test(line)) return false;
    const big = values.filter(({ value }) => Math.abs(value) >= 1000);
    if (!big.length) return false;
    const known = [calc.year_revenue, calc.year_costs, calc.net, calc.total_one_time, calc.total_fixed, calc.total_variable, calc.ending_mrr, calc.monthly_run_rate, calc.starting_cash, calc.ending_cash,
      calc.schedule?.cumulative?.[calc.months - 1], ...(calc.sensitivity || []).flatMap((entry) => [entry.year_revenue, entry.net])].filter((value) => typeof value === 'number');
    const kind = /revenue|sales|إيراد/i.test(line) ? calc.year_revenue : /cost|expense|spend|تكاليف|مصاريف/i.test(line) ? calc.year_costs : /\bnet\b|profit|loss|صافي|ربح/i.test(line) ? calc.net : null;
    if (kind === null || kind === undefined) return false;
    // Every large figure on the line must state a validated value at its
    // written precision (a near miss such as 111,489 for 112,236 is wrong).
    return big.some(({ token, value }) => !known.some((good) => statesValue(token, value, good)));
  };
  const blocks = [];
  let text = sanitized.text.replace(BLOCK, (match) => {
    // Artifact tables written by CHIEF are checked row by row; a table with a
    // contradicting row is dropped (the validated table below replaces it).
    // The calculator's own schedule (checked above) is kept as is.
    try {
      const raw = JSON.parse(match.replace(/^```artifact\s*\n|```$/g, ''));
      const calculatorOwn = raw.calculated === true && calc && !financialTables(match, calc).some((entry) => entry.issues.length);
      if (['table', 'chart'].includes(typeOf(raw)) && !calculatorOwn) {
        const rows = typeOf(raw) === 'table' ? (raw.rows || []).map((row) => `${(raw.columns || []).join(' ')} ${(row || []).join(' ')}`)
          : (raw.series || []).map((series) => `${raw.title} ${series.name} ${(series.values || []).join(' ')}`);
        if (rows.some((row) => conflicts(`${raw.title || ''} ${row}`))) { removed += 1; blocks.push(''); return `\u0000${blocks.length - 1}\u0000`; }
      }
    } catch { /* keep as is */ }
    blocks.push(match);
    return `\u0000${blocks.length - 1}\u0000`;
  });
  const kept = [];
  let noted = false;
  for (const line of text.split('\n')) {
    if (!line.includes('\u0000') && conflicts(line)) {
      removed += 1;
      if (!noted && !/^\s*\|/.test(line)) { kept.push('> A figure here disagreed with FINANCE\'s validated calculation and was removed — see "Validated financial figures".'); noted = true; }
      continue;
    }
    kept.push(line);
  }
  text = kept.join('\n').replace(/\u0000(\d+)\u0000/g, (_, index) => blocks[Number(index)]).replace(/\n{3,}/g, '\n\n').trim();
  text = text.replace(/\n## Validated financial figures \(calculated by code\)[\s\S]*?(?=\n## |$(?![\s\S]))/, '');
  const section = ['## Validated financial figures (calculated by code)'];
  if (gate.facts.length) section.push('| Figure | Value |', '| --- | --- |', ...gate.facts.map((fact) => `| ${fact.label} | ${fact.value} |`));
  for (const entry of gate.unverified) section.push(`FINANCE "${entry.title}" did not pass validation (${entry.validation.state}); its figures are not presented as fact.`);
  const final = `${text}\n\n${section.join('\n')}`;
  return { text: final, removed, tables: sanitized.removed.length, remaining: remainingContradictions(final, gate) };
}

// Final check on the text CHIEF delivers: model-written schedules, tables or
// charts contradicting the calculator, and prose lines with a banned figure
// or a near miss of a validated one. Anything > 0 means the answer cannot be
// presented as verified.
export function remainingContradictions(markdown, gate) {
  const calc = gate.calculated || gate.verified?.[0]?.validation.calculated || null;
  if (!calc) return 0;
  const tables = financialTables(markdown, calc).filter((entry) => entry.issues.length || (entry.schedule && !entry.calculated)).length;
  const prose = String(markdown || '').replace(BLOCK, '').split('\n').filter((line) => !/^\s*\|/.test(line))
    .filter((line) => figures(line).some(({ value }) => Math.abs(value) >= 100 && gate.banned.some((bad) => agrees(value, bad, { relative: 0.005 })))).length;
  const claims = proseClaims(String(markdown || '').replace(BLOCK, '')).filter((claim) => {
    if (claim.kind === 'break_even') return claim.value !== calc.break_even_month && claim.value !== calc.operating_break_even_month;
    if (claim.kind === 'break_even_not') return false;
    const good = calc[claim.kind];
    return typeof good === 'number' && !statesValue(claim.raw, claim.value, good) && !(calc.sensitivity || []).some((entry) => statesValue(claim.raw, claim.value, entry[claim.kind]));
  }).length;
  return tables + prose + claims;
}

// ------------------------------------------------------------ evidence

// Web search degraded (quota, rate limit, outage): claims marked VERIFIED
// must come from a page actually fetched in this step; with too little
// fetched evidence the output says so.
export function evidenceGate(markdown, evidence) {
  if (!evidence?.searchDegraded) return { text: String(markdown || ''), insufficient: false };
  const fetched = new Set((evidence.fetchedUrls || []).map((url) => url.replace(/\/$/, '')));
  const insufficient = (evidence.fetchOk || 0) < 2;
  let downgraded = 0;
  let text = mapArtifactBlocks(markdown, (raw) => {
    if (typeOf(raw) !== 'evidence' || !Array.isArray(raw.claims)) return null;
    return { ...raw, claims: raw.claims.map((claim) => {
      const source = realUrl(claim?.source).replace(/\/$/, '');
      if (String(claim?.status).toUpperCase() !== 'VERIFIED' || (source && fetched.has(source))) return claim;
      downgraded += 1;
      return { ...claim, status: insufficient ? 'UNKNOWN' : 'LIKELY' };
    }) };
  });
  const note = ['## Evidence quality',
    `Web search was unavailable during this step (${evidence.searchError || 'provider quota or outage'}); evidence comes from ${evidence.fetchOk || 0} page${evidence.fetchOk === 1 ? '' : 's'} fetched directly.`,
    insufficient ? 'INSUFFICIENT EVIDENCE: too few sources could be checked. Treat the claims above as unverified until re-checked.' : 'Claims without a fetched source are marked LIKELY, not VERIFIED.',
    downgraded ? `${downgraded} claim${downgraded === 1 ? '' : 's'} were downgraded because their source was not actually retrieved.` : ''].filter(Boolean).join('\n');
  text = `${String(text).replace(/\n## Evidence quality[\s\S]*?(?=\n## |$(?![\s\S]))/, '').trim()}\n\n${note}`;
  return { text, insufficient, downgraded };
}

export { proseClaims };
