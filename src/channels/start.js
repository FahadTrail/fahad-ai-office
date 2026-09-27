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
  const channel = new TelegramChannel({ token, ownerChatId: env.TELEGRAM_OWNER_CHAT_ID, bridge, log: (...parts) => log(...parts), pollSeconds: 20 });
  channel.start();
  return channel;
}
