// Channel bridge: any messaging channel (Telegram now, WhatsApp later) talks
// to the SAME Office as the Hub — a message becomes a CHIEF job in a
// conversation, results and approval requests flow back. A transport only
// implements { send(text, { buttons }) } and calls the bridge; it never
// touches the database or holds a model/tool credential.
//
// Security: the transport decides who the owner is (a fixed chat id); the
// bridge rate-limits the owner and exposes only chat, status and the
// approve/reject decision that the Hub itself offers.

import { autoTitle } from '../hub-workspace.js';

const CONVERSATION_TITLE = { telegram: 'Telegram · CHIEF', whatsapp: 'WhatsApp · CHIEF' };
const MAX_MESSAGE = 8000;

export class OfficeBridge {
  constructor({ db, store, workspaceId, channel = 'telegram', hubUrl = '', now = () => Date.now(), ratePerMinute = 20 }) {
    if (!db || !store || !workspaceId) throw new TypeError('OfficeBridge needs db, store and workspaceId');
    Object.assign(this, { db, store, workspaceId, channel, hubUrl: String(hubUrl || '').replace(/\/+$/, ''), now, ratePerMinute });
    this.startedAt = new Date(now()).toISOString();
    this.recent = [];
    this.notifiedJobs = new Set();
    this.notifiedApprovals = new Set();
    this.notifiedQuestions = new Set();
    // Anything still waiting for Fahad from the last day is (re)announced
    // after a restart, so nothing is missed while the worker was down.
    this.pendingSince = new Date(now() - 24 * 3600_000).toISOString();
  }

  link(hash) { return this.hubUrl ? `${this.hubUrl}/${hash}` : ''; }

  allow() {
    const cutoff = this.now() - 60_000;
    this.recent = this.recent.filter((at) => at > cutoff);
    if (this.recent.length >= this.ratePerMinute) return false;
    this.recent.push(this.now());
    return true;
  }

  async conversation() {
    const title = CONVERSATION_TITLE[this.channel] || `${this.channel} · CHIEF`;
    const { data: found } = await this.db.from('conversations').select('id').eq('project_id', this.workspaceId).eq('title', title).eq('archived', false).limit(1).maybeSingle();
    if (found?.id) return found.id;
    const { data, error } = await this.db.from('conversations').insert({ project_id: this.workspaceId, title, title_source: 'owner' }).select('id').single();
    if (error) throw new Error(`Could not open the ${this.channel} conversation: ${error.message}`);
    return data.id;
  }

  // Fahad's message → CHIEF, exactly like a Hub chat message.
  async handleMessage(text) {
    const message = String(text || '').trim().slice(0, MAX_MESSAGE);
    if (!message) return { reply: null };
    if (!this.allow()) return { reply: 'Too many messages in a minute — please wait a moment.' };
    if (/^\/(start|help)\b/i.test(message)) return { reply: HELP };
    if (/^\/status\b/i.test(message)) return { reply: await this.status() };
    const conversationId = await this.conversation();
    const job = await this.store.createJob({ title: autoTitle(message), goal: message, projectId: this.workspaceId, requestedProvider: 'auto', conversationId });
    await this.db.from('conversations').update({ last_message_at: new Date(this.now()).toISOString(), updated_at: new Date(this.now()).toISOString() }).eq('id', conversationId);
    const link = this.link(`#/chat/${conversationId}`);
    return { reply: `CHIEF is on it.${link ? `\nFollow it live: ${link}` : ''}`, jobId: job.id };
  }

  async status() {
    const [{ data: running }, { data: approvals }] = await Promise.all([
      this.db.from('jobs').select('id').eq('project_id', this.workspaceId).in('status', ['planning', 'running']),
      this.db.from('agent_approvals').select('id').eq('workspace_id', this.workspaceId).eq('status', 'pending'),
    ]);
    return [`Objectives in progress: ${(running || []).length}`, `Approvals waiting for you: ${(approvals || []).length}`, this.link('#/office') ? `Office: ${this.link('#/office')}` : ''].filter(Boolean).join('\n');
  }

  // Results of this channel's conversation and new approval requests, each
  // delivered once (only what happened after the bridge started).
  async outbox() {
    const out = [];
    const conversationId = await this.conversation();
    const { data: done } = await this.db.from('jobs').select('id,status,completed_at').eq('conversation_id', conversationId)
      .in('status', ['completed', 'failed']).gte('completed_at', this.startedAt).order('completed_at', { ascending: true }).limit(10);
    for (const job of done || []) {
      if (this.notifiedJobs.has(job.id)) continue;
      this.notifiedJobs.add(job.id);
      const { data: final } = await this.db.from('results').select('content').eq('job_id', job.id).eq('kind', 'final').limit(1).maybeSingle();
      const body = job.status === 'failed' ? 'CHIEF could not finish this request. Details are in the Hub.' : plain(final?.content || 'Done.');
      const link = this.link(`#/chat/${conversationId}`);
      out.push({ text: `${clip(body, 3500)}${link ? `\n\nOpen in the Hub: ${link}` : ''}` });
    }
    const { data: approvals } = await this.db.from('agent_approvals').select('id,session_id,tool_name,summary,risk,requested_at')
      .eq('workspace_id', this.workspaceId).eq('status', 'pending').gte('requested_at', this.pendingSince).order('requested_at', { ascending: true }).limit(10);
    for (const approval of approvals || []) {
      if (this.notifiedApprovals.has(approval.id)) continue;
      this.notifiedApprovals.add(approval.id);
      const link = this.link(`#/task/${approval.session_id}`);
      out.push({
        text: `Approval needed (${approval.risk || 'review'}): ${clip(approval.summary || approval.tool_name, 600)}${link ? `\nDetails: ${link}` : ''}`,
        buttons: [{ label: 'Approve', data: `ap:${approval.id}:approved` }, { label: 'Reject', data: `ap:${approval.id}:rejected` }],
      });
    }
    // Needs Fahad: a Coding task paused with a question for the owner.
    const { data: questions } = await this.db.from('agent_sessions').select('id,title,blocker,updated_at')
      .eq('workspace_id', this.workspaceId).eq('status', 'blocked').eq('error_code', 'HUMAN_INPUT_REQUIRED').gte('updated_at', this.pendingSince).limit(10);
    for (const session of questions || []) {
      const key = `${session.id}@${session.updated_at}`;
      if (this.notifiedQuestions.has(key)) continue;
      this.notifiedQuestions.add(key);
      const link = this.link(`#/task/${session.id}`);
      out.push({ text: `Needs you — ${clip(session.title || 'Coding task', 120)}: ${clip(plain(session.blocker || 'The task has a question for you.'), 600)}${link ? `\nReply in the Hub: ${link}` : ''}` });
    }
    return out;
  }

  // An approve/reject button press, recorded exactly as the Hub records it.
  async decide(data, actor) {
    const match = String(data || '').match(/^ap:([0-9a-f-]{36}):(approved|rejected)$/i);
    if (!match) return 'Unknown action.';
    if (!this.allow()) return 'Too many actions in a minute — please wait a moment.';
    const { data: approval } = await this.db.from('agent_approvals').select('id,status').eq('id', match[1]).eq('workspace_id', this.workspaceId).maybeSingle();
    if (!approval) return 'That approval does not belong to this project.';
    if (approval.status !== 'pending') return `Already ${approval.status}.`;
    const { error } = await this.db.rpc('decide_agent_approval', { p_approval: match[1], p_decision: match[2], p_decided_by: actor, p_note: null });
    if (error) return /NOT_PENDING/.test(error.message) ? 'Already decided.' : 'Could not record the decision; please use the Hub.';
    return match[2] === 'approved' ? 'Approved — the task continues.' : 'Rejected — the agent will adapt.';
  }
}

const HELP = [
  'This is CHIEF of Fahad AI Office.',
  'Send any objective or question — in Arabic or English — and CHIEF assigns the right employees (e.g. "حولها للفاينانس", "خل الليغال يراجع").',
  'Results arrive here; approvals come with Approve / Reject buttons.',
  '/status — what is in progress and waiting for you.',
].join('\n');

// Telegram shows plain text reliably; artifacts stay in the Hub.
export function plain(markdown) {
  return String(markdown || '')
    .replace(/```artifact[\s\S]*?```/g, '[visual in the Hub]')
    .replace(/```[a-z]*\n?/gi, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '$1 ($2)')
    .trim();
}
const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
