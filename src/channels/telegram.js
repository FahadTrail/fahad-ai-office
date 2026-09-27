// Telegram → CHIEF. Long polling over the Bot API (no webhook, so no new
// public endpoint), plain `fetch`, no dependency.
//
// Owner-only: updates from any chat other than TELEGRAM_OWNER_CHAT_ID are
// ignored. A stranger's /start only learns that the bot is private; the owner
// finds their own chat id by sending /start before the id is configured (the
// bot answers every chat with its id only while no owner is set).
// The bot token is never logged or echoed: errors are reported by method name
// and HTTP status only.

const API = 'https://api.telegram.org';

export class TelegramChannel {
  constructor({ token, ownerChatId, bridge, fetchImpl = fetch, log = () => {}, pollSeconds = 25 }) {
    if (!/^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(String(token || ''))) throw new TypeError('TELEGRAM_BOT_TOKEN is not a valid bot token');
    this.token = token;
    this.owner = /^-?\d{3,20}$/.test(String(ownerChatId || '')) ? String(ownerChatId) : null;
    Object.assign(this, { bridge, fetchImpl, log, pollSeconds });
    this.offset = 0;
    this.seen = new Set();
    this.running = false;
    this.ignored = 0;
  }

  async call(method, body) {
    const response = await this.fetchImpl(`${API}/bot${this.token}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
    });
    let data = {};
    try { data = await response.json(); } catch {}
    if (!response.ok || data.ok === false) throw new Error(`Telegram ${method} failed (HTTP ${response.status})`);
    return data.result;
  }

  async send(chatId, text, buttons = null) {
    return this.call('sendMessage', {
      chat_id: chatId, text: String(text).slice(0, 4000), disable_web_page_preview: true,
      ...(buttons?.length ? { reply_markup: { inline_keyboard: [buttons.map((button) => ({ text: button.label, callback_data: button.data }))] } } : {}),
    });
  }

  // One update → at most one reply. Exported for tests.
  async handleUpdate(update) {
    if (!update || this.seen.has(update.update_id)) return;
    this.seen.add(update.update_id);
    if (this.seen.size > 2000) this.seen = new Set([...this.seen].slice(-1000));
    const message = update.message;
    const callback = update.callback_query;
    const chatId = String(message?.chat?.id ?? callback?.message?.chat?.id ?? '');
    if (!chatId) return;
    if (!this.owner) {
      if (message?.text?.startsWith('/start')) await this.send(chatId, `This Office bot is not paired yet. Your chat id is ${chatId}.\nTo pair it, the owner runs on the server:\nsudo bash ops/set-secret.sh TELEGRAM_OWNER_CHAT_ID`);
      return;
    }
    if (chatId !== this.owner || (message && message.chat?.type !== 'private')) {
      this.ignored += 1;
      if (message?.text?.startsWith('/start') && message.chat?.type === 'private') await this.send(chatId, 'This is a private office assistant.');
      return;
    }
    if (callback) {
      const text = await this.bridge.decide(callback.data, `telegram:${chatId}`);
      await this.call('answerCallbackQuery', { callback_query_id: callback.id, text: text.slice(0, 190) }).catch(() => {});
      await this.send(chatId, text);
      return;
    }
    if (typeof message?.text !== 'string') {
      await this.send(chatId, 'Text messages only for now — send your request as text.');
      return;
    }
    const { reply } = await this.bridge.handleMessage(message.text);
    if (reply) await this.send(chatId, reply);
  }

  async flushOutbox() {
    if (!this.owner) return;
    for (const item of await this.bridge.outbox()) await this.send(this.owner, item.text, item.buttons);
  }

  async start() {
    this.running = true;
    this.log(`Telegram channel started (${this.owner ? 'owner paired' : 'waiting for pairing'}).`);
    let lastOutbox = 0;
    while (this.running) {
      try {
        const updates = await this.call('getUpdates', { offset: this.offset, timeout: this.pollSeconds, allowed_updates: ['message', 'callback_query'] });
        for (const update of updates || []) {
          this.offset = Math.max(this.offset, update.update_id + 1);
          await this.handleUpdate(update).catch((error) => this.log(`WARN  telegram update: ${error.message}`));
        }
        if (Date.now() - lastOutbox > 5000) { lastOutbox = Date.now(); await this.flushOutbox(); }
      } catch (error) {
        this.log(`WARN  telegram: ${error.message}`);
        await new Promise((resolve) => { this.backoff = setTimeout(resolve, 10_000); this.backoff.unref?.(); });
      }
    }
  }

  stop() {
    this.running = false;
    if (this.backoff) clearTimeout(this.backoff);
  }
}
