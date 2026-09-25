// Security policy shared by the Coding Agent controller and its tools.
// Ported from the retired development/ escape route and extended for a
// shell-capable agent: protected paths, secret detection, redaction,
// command hygiene and scrubbed child-process environments.

export const HERMES_PATTERN = /(^|\/)hermes(?:\/|$)/i;

// Paths the agent may never change without explicit human approval. Hermes
// is never writable at all.
export const PROTECTED_CHANGE_PATTERNS = Object.freeze([
  /(^|\/)\.env(?:\.|$)/i,
  /(^|\/)(?:secrets?|credentials?)(?:\/|$)/i,
  /^\.github\/workflows\//i,
  /^ops\//i,
  /^supabase\/migrations\//i,
  /^(?:Dockerfile|docker-compose\.ya?ml)$/i,
  /^(?:\.gitattributes|\.gitmodules)$/i,
  /(^|\/)[^/]*\.(?:pem|key|p12|pfx)$/i,
]);

const SECRET_ENV_NAMES = Object.freeze([
  'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SECRET_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY',
  'DEEPSEEK_API_KEY', 'QWEN_API_KEY', 'KIMI_API_KEY', 'ZHIPU_API_KEY', 'MINIMAX_API_KEY', 'GEMINI_API_KEY',
  'OPENROUTER_API_KEY', 'GROQ_API_KEY', 'CONTINUITY_GITHUB_TOKEN', 'CODING_GITHUB_TOKEN',
  'CODING_SUPABASE_ACCESS_TOKEN', 'HUB_ACCESS_TOKEN', 'VPS_SSH_KEY_B64',
]);

const SECRET_PATTERNS = Object.freeze([
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{16,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bsb_secret_[A-Za-z0-9_-]{16,}\b/,
  /\bsbp_[A-Za-z0-9]{20,}\b/,
  /\bAIza[0-9A-Za-z_-]{30,}\b/,
  /\bxox[abp]-[A-Za-z0-9-]{10,}\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/,
  new RegExp(`\\b(?:${SECRET_ENV_NAMES.join('|')})\\s*[=:]\\s*['"]?[A-Za-z0-9_./+-]{12,}`, 'i'),
]);

export function secretValues(env = process.env) {
  return SECRET_ENV_NAMES.map((name) => env[name]).filter((value) => typeof value === 'string' && value.length >= 8);
}

export function findSecretMaterial(text, env = process.env) {
  const value = String(text || '');
  for (const secret of secretValues(env)) if (value.includes(secret)) return 'configured credential value';
  const match = SECRET_PATTERNS.find((pattern) => pattern.test(value));
  return match ? 'credential-shaped token' : null;
}

export function redact(value, env = process.env, maxLength = 20_000) {
  let safe = String(value ?? '');
  for (const secret of secretValues(env)) safe = safe.split(secret).join('[REDACTED]');
  for (const pattern of SECRET_PATTERNS) safe = safe.replace(new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`), '[REDACTED]');
  safe = safe.replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [REDACTED]');
  return safe.length > maxLength ? safe.slice(-maxLength) : safe;
}

export function normalizeRepoPath(path) {
  const value = String(path ?? '').replaceAll('\\', '/').trim().replace(/^\.\/+/, '');
  if (!value || value === '.') return '.';
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) throw policyError('PATH_ABSOLUTE', 'Use a path relative to the repository root');
  const parts = [];
  for (const part of value.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') throw policyError('PATH_ESCAPE', 'Paths may not leave the repository');
    parts.push(part);
  }
  if (parts[0] === '.git') throw policyError('PATH_GIT_METADATA', 'Git metadata is controller-owned');
  return parts.join('/') || '.';
}

export function classifyChangedPaths(paths) {
  const normalized = paths.map((path) => String(path).replaceAll('\\', '/').replace(/^\.\//, ''));
  return {
    hermes: normalized.filter((path) => HERMES_PATTERN.test(path)),
    protected: normalized.filter((path) => PROTECTED_CHANGE_PATTERNS.some((pattern) => pattern.test(path))),
  };
}

export function assertWritablePath(path, { allowProtected = false } = {}) {
  const normalized = normalizeRepoPath(path);
  if (HERMES_PATTERN.test(normalized)) throw policyError('HERMES_PROTECTED', 'Hermes paths are isolated and may not be modified');
  if (!allowProtected && PROTECTED_CHANGE_PATTERNS.some((pattern) => pattern.test(normalized))) {
    throw policyError('PROTECTED_PATH', `${normalized} is protected; changing it requires explicit approval in the session configuration`);
  }
  return normalized;
}

// Commands run inside an unprivileged sandbox; this is hygiene on top of the
// OS boundary, blocking actions that belong to controller-owned tools or that
// could never be legitimate from inside the sandbox.
const DENIED_COMMANDS = Object.freeze([
  [/(^|[;&|`(\s])sudo(\s|$)/, 'sudo is not available in the sandbox'],
  [/(^|[;&|`(\s])su(\s|$)/, 'su is not available in the sandbox'],
  [/(^|[;&|`(\s])(?:ssh|scp|sftp)(\s|$)/, 'remote shells are not available; use controller tools'],
  [/(^|[;&|`(\s])(?:docker|podman|kubectl|nsenter|chroot)(\s|$)/, 'container and host control is not available'],
  [/\bgit\s+(?:-[^\s]+\s+)*push\b/, 'publishing is controller-owned; call finish and the controller pushes'],
  [/\bgit\s+(?:-[^\s]+\s+)*(?:remote\s+(?:add|set-url)|config\s+(?:--global|--system))/, 'git remotes and global config are controller-owned'],
  [/(^|[\s;&|])rm\s+-[a-z]*r[a-z]*f?[a-z]*\s+(?:--no-preserve-root\s+)?\/(?:\s|$|\*)/i, 'refusing to remove the filesystem root'],
  [/\/proc\/\d+\/environ|\/proc\/self\/environ/, 'process environments are not readable from the sandbox'],
  [/(^|[;&|`(\s])(?:shutdown|reboot|halt|poweroff|mkfs(?:\.\w+)?)(\s|$)/, 'system control is not available'],
  [/:\(\)\s*\{\s*:\|:&\s*\};:/, 'fork bombs are not allowed'],
]);

export function checkCommand(command) {
  const value = String(command || '');
  if (!value.trim()) throw policyError('COMMAND_EMPTY', 'Command is empty');
  if (value.length > 8000) throw policyError('COMMAND_TOO_LONG', 'Command exceeds 8000 characters');
  if (HERMES_PATTERN.test(value.replace(/\s+/g, '/'))) throw policyError('HERMES_PROTECTED', 'Commands may not touch Hermes paths');
  for (const [pattern, reason] of DENIED_COMMANDS) if (pattern.test(value)) throw policyError('COMMAND_DENIED', reason);
  return value;
}

export function sandboxEnvironment({ home, path = process.env.PATH, extra = {} } = {}) {
  const env = {
    PATH: path,
    HOME: home,
    USER: 'sandbox',
    LANG: 'C.UTF-8',
    CI: 'true',
    NO_COLOR: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    NPM_CONFIG_UPDATE_NOTIFIER: 'false',
    NPM_CONFIG_FUND: 'false',
    NPM_CONFIG_AUDIT: 'false',
    TMPDIR: `${home}/tmp`,
    ...extra,
  };
  if (process.env.HTTPS_PROXY) env.HTTPS_PROXY = process.env.HTTPS_PROXY;
  if (process.env.HTTP_PROXY) env.HTTP_PROXY = process.env.HTTP_PROXY;
  if (process.env.NO_PROXY) env.NO_PROXY = process.env.NO_PROXY;
  if (process.env.NODE_EXTRA_CA_CERTS) env.NODE_EXTRA_CA_CERTS = process.env.NODE_EXTRA_CA_CERTS;
  for (const name of SECRET_ENV_NAMES) delete env[name];
  return Object.fromEntries(Object.entries(env).filter(([, value]) => typeof value === 'string' && value));
}

export function safeSlug(value, maximum = 40) {
  const slug = String(value || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, maximum);
  return slug.replace(/-+$/g, '') || 'task';
}

export class PolicyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PolicyError';
    this.code = code;
  }
}

export function policyError(code, message) {
  return new PolicyError(code, message);
}
