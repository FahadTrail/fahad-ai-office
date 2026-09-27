// Starts the Telegram channel when TELEGRAM_BOT_TOKEN is configured. The
// project is TELEGRAM_WORKSPACE_ID or the "Fahad AI Office" project.
import { OfficeBridge } from './office-bridge.js';
import { TelegramChannel } from './telegram.js';

export async function startTelegramChannel({ db, store, log, env = process.env }) {
  const token = String(env.TELEGRAM_BOT_TOKEN || '').trim();
  if (!token) return null;
  let workspaceId = String(env.TELEGRAM_WORKSPACE_ID || '').trim();
  if (!workspaceId) {
    const { data } = await db.from('projects').select('id').eq('name', 'Fahad AI Office').limit(1).maybeSingle();
    workspaceId = data?.id;
  }
  if (!workspaceId) throw new Error('no project for the Telegram channel');
  const host = String(env.HUB_PUBLIC_HOST || '').trim();
  const bridge = new OfficeBridge({ db, store, workspaceId, channel: 'telegram', hubUrl: /^[a-z0-9.-]+$/i.test(host) ? `https://${host}` : '' });
  let channel;
  try {
    channel = new TelegramChannel({ token, ownerChatId: env.TELEGRAM_OWNER_CHAT_ID, bridge, log: (...parts) => log(...parts), pollSeconds: 20 });
  } catch (error) {
    await recordStatus(db, { ok: false, error_code: 'TELEGRAM_TOKEN_INVALID', owner_paired: false });
    throw error;
  }
  // Start-up evidence for the Hub's Integrations page and for go-live checks:
  // the token works (getMe), the bot's public name, whether the owner is paired.
  const verified = await channel.verify();
  await recordStatus(db, { ...verified, owner_paired: Boolean(channel.owner) });
  if (verified.ok) log(`Telegram bot @${verified.bot_username || '?'} verified.`);
  channel.start();
  return channel;
}

async function recordStatus(db, status) {
  const payload = { kind: 'telegram_channel', ...status, checked_at: new Date().toISOString() };
  const message = !status.ok ? `Telegram channel not working: ${status.error_code}.`
    : status.owner_paired ? `Telegram channel live (@${status.bot_username || 'bot'}, owner paired).` : `Telegram bot @${status.bot_username || 'bot'} verified; waiting for TELEGRAM_OWNER_CHAT_ID.`;
  try {
    await db.from('events').insert({ type: 'activity', level: status.ok ? 'success' : 'warning', message, payload });
  } catch {}
}
