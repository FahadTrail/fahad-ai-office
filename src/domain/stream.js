// Workspace stream for the work API. A reconnect sends the current cursor
// and, when Last-Event-ID is behind, a catch-up event. Clients refetch the
// current-work read model; this stream does not replay history itself.

const HEARTBEAT_MS = 25_000;

export class WorkStream {
  constructor({ db, now = () => Date.now(), watchMs = 2500 } = {}) {
    if (!db) throw new TypeError('WorkStream requires a database');
    this.db = db;
    this.now = now;
    this.watchMs = watchMs;
    this.rooms = new Map();
  }

  async watermark(workspaceId) {
    const [events, sessions, approvals] = await Promise.all([
      this.db.from('events').select('id').order('id', { ascending: false }).limit(1),
      this.db.from('agent_sessions').select('updated_at').eq('workspace_id', workspaceId).order('updated_at', { ascending: false }).limit(1),
      this.db.from('agent_approvals').select('id').eq('workspace_id', workspaceId).eq('status', 'pending'),
    ]);
    return [events.data?.[0]?.id ?? 0, sessions.data?.[0]?.updated_at ?? '', (approvals.data || []).map((row) => row.id).join(',')].join('|');
  }

  subscribe(workspaceId, response, { lastEventId = null } = {}) {
    let room = this.rooms.get(workspaceId);
    if (!room) {
      room = { clients: new Set(), mark: null, timer: null };
      this.rooms.set(workspaceId, room);
      const tick = async () => {
        try {
          const mark = await this.watermark(workspaceId);
          if (room.mark !== null && mark !== room.mark) {
            for (const client of room.clients) client.write(`id: ${mark}\nevent: change\ndata: ${JSON.stringify({ at: new Date(this.now()).toISOString(), refetch: ['/api/work/current', '/api/work/attention'] })}\n\n`);
          }
          room.mark = mark;
        } catch { /* a failed poll does not invent a change */ }
      };
      tick();
      room.timer = setInterval(tick, this.watchMs);
      room.timer.unref?.();
    }
    room.clients.add(response);
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive',
      'x-accel-buffering': 'no', 'x-content-type-options': 'nosniff',
    });
    const hello = async () => {
      let mark = room.mark;
      if (mark == null) {
        try { mark = await this.watermark(workspaceId); } catch { mark = 'unknown'; }
      }
      response.write(`retry: 5000\nid: ${mark}\nevent: ready\ndata: ${JSON.stringify({ cursor: mark, refetch: ['/api/work/current'] })}\n\n`);
      if (lastEventId && lastEventId !== mark) {
        response.write(`id: ${mark}\nevent: catchup\ndata: ${JSON.stringify({ missed: true, since: lastEventId, cursor: mark, refetch: ['/api/work/current', '/api/work/attention', '/api/work/employees'] })}\n\n`);
      }
    };
    hello();
    const heartbeat = setInterval(() => response.write(': keep-alive\n\n'), HEARTBEAT_MS);
    heartbeat.unref?.();
    const close = () => {
      clearInterval(heartbeat);
      room.clients.delete(response);
      if (!room.clients.size) { clearInterval(room.timer); this.rooms.delete(workspaceId); }
    };
    response.on('close', close);
    return close;
  }

  stop() {
    for (const room of this.rooms.values()) {
      clearInterval(room.timer);
      for (const client of room.clients) client.end();
    }
    this.rooms.clear();
  }
}
