// Execution workers are not Office employees. Status comes from measured
// fields. A disabled or manual-only adapter is never an active employee.
// Missing telemetry stays UNKNOWN.

import { workerLiveStatus } from '../coding-agent/presence.js';

// Build facts: which adapters exist in this source tree. Live rows override
// enabled, health and presence. Authentication is never assumed.
export const EXECUTION_WORKER_FACTS = Object.freeze([
  { key: 'office', displayName: 'Fahad Office Coding Agent', kind: 'native', executable: true, manualOnly: false, experimental: false },
  { key: 'claude-code', displayName: 'Claude Code', kind: 'cli', executable: true, manualOnly: false, experimental: false },
  { key: 'codex', displayName: 'OpenAI Codex', kind: 'cli', executable: true, manualOnly: false, experimental: false },
  { key: 'opencode', displayName: 'OpenCode', kind: 'cli', executable: true, manualOnly: false, experimental: false },
  { key: 'gemini-cli', displayName: 'Gemini CLI', kind: 'cli', executable: true, manualOnly: false, experimental: false },
  { key: 'antigravity', displayName: 'Google Antigravity', kind: 'cli', executable: false, manualOnly: true, experimental: false },
  { key: 'kilo', displayName: 'Kilo Code', kind: 'cli', executable: false, manualOnly: true, experimental: false },
  { key: 'freebuff', displayName: 'Freebuff', kind: 'manual', executable: false, manualOnly: true, experimental: false },
]);

const FACTS = new Map(EXECUTION_WORKER_FACTS.map((fact) => [fact.key, fact]));

function tri(value, { yes, no }) {
  if (value == null) return 'UNKNOWN';
  return yes(value) ? true : no(value) ? false : 'UNKNOWN';
}

export function normalizeWorker(row = {}, { activity = null, readiness = null, now = Date.now() } = {}) {
  const fact = FACTS.get(row.key) || {
    key: row.key, displayName: row.display_name || row.displayName || row.key, kind: row.kind || 'cli', executable: false, manualOnly: false, experimental: true,
  };
  const enabled = row.enabled == null ? 'UNKNOWN' : Boolean(row.enabled);
  const executable = fact.executable === true;
  const manualOnly = fact.manualOnly === true || row.kind === 'manual' || fact.kind === 'manual';
  const experimental = fact.experimental === true || (!FACTS.has(row.key) && !executable);
  const authenticated = tri(readiness, {
    yes: (value) => value.authState === 'AUTHENTICATED' || value.ok === true,
    no: (value) => value.authState != null || value.ok === false,
  });
  const healthy = tri(row.health, {
    yes: (value) => value === 'healthy',
    no: (value) => value === 'down' || value === 'degraded',
  });
  let operational;
  if (manualOnly && !executable) operational = 'MANUAL_ONLY';
  else if (experimental && !executable) operational = 'EXPERIMENTAL';
  else if (enabled === false) operational = 'DISABLED';
  else if (enabled === 'UNKNOWN') operational = 'UNKNOWN';
  else {
    const live = workerLiveStatus({
      enabled: true,
      lastSeenAt: row.last_seen_at || row.lastSeenAt || null,
      running: activity?.running || 0,
      blocked: activity?.blocked || 0,
      now,
    });
    operational = live.status === 'ACTIVE' ? 'BUSY' : live.status;
  }
  const countsAsEmployee = false;
  return {
    key: fact.key || row.key,
    displayName: row.display_name || row.displayName || fact.displayName,
    kind: row.kind || fact.kind,
    officeEmployee: false,
    countsAsEmployee,
    enabled,
    enabledBasis: enabled === 'UNKNOWN' ? 'UNKNOWN' : 'MEASURED',
    executable,
    authenticated,
    healthy,
    healthBasis: row.health_basis || row.healthBasis || (row.health ? 'MEASURED' : 'UNKNOWN'),
    operational,
    manualOnly,
    experimental,
    summary: operational === 'DISABLED' ? 'Switched off.'
      : operational === 'MANUAL_ONLY' ? 'Manual only. Not an Office employee.'
        : operational === 'EXPERIMENTAL' ? 'No executable adapter in this build.'
          : operational === 'BUSY' ? 'Executing.'
            : operational === 'IDLE' ? 'Online, no task running.'
              : operational === 'OFFLINE' ? 'No recent heartbeat.'
                : operational === 'BLOCKED' ? 'Waiting on the owner.'
                  : operational === 'UNKNOWN' ? 'Not reported.'
                    : operational,
  };
}

export function workerBoard(rows = [], options = {}) {
  const list = rows || [];
  const measured = options.measured !== false;
  const byKey = new Map(list.map((row) => [row.key, row]));
  const keys = [...new Set([...FACTS.keys(), ...list.map((row) => row.key)])];
  return keys.map((key) => normalizeWorker(byKey.get(key) || { key, enabled: measured && FACTS.has(key) ? false : null }, {
    activity: options.activity?.get?.(key) || options.activity?.[key] || null,
    readiness: options.readiness?.get?.(key) || options.readiness?.[key] || null,
    now: options.now,
  }));
}
