// Supabase development operations through the official Management API with a
// dedicated access token (never the Office service-role key). Target project
// references come from the session configuration and are allowlisted.

import { redact } from './policy.js';

const WRITE_KEYWORDS = /\b(insert|update|delete|merge|upsert|drop|alter|create|grant|revoke|truncate|copy|call|do|vacuum|analyze|refresh|lock|comment|security|reindex|cluster|listen|notify|prepare|execute|set|reset|discard|import|load)\b/i;

export function assertReadOnlySql(sql) {
  const value = stripSqlLiterals(String(sql || '')).trim().replace(/;\s*$/, '');
  if (!value) throw supabaseError('SQL_EMPTY', 'SQL is empty');
  if (value.length > 20_000) throw supabaseError('SQL_TOO_LONG', 'SQL exceeds 20000 characters');
  if (value.includes(';')) throw supabaseError('SQL_MULTI_STATEMENT', 'Read-only queries must be a single statement');
  if (!/^(select|with|values|table)\b/i.test(value)) throw supabaseError('SQL_NOT_READ_ONLY', 'Read-only queries must start with SELECT, WITH, VALUES or TABLE');
  if (WRITE_KEYWORDS.test(value)) throw supabaseError('SQL_NOT_READ_ONLY', 'The query contains a data-modifying keyword; use the approval-gated write tool');
  return String(sql).trim().replace(/;\s*$/, '');
}

function stripSqlLiterals(sql) {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""');
}

export class SupabaseManagementClient {
  constructor({ token, allowedProjects = [], fetchFn = fetch, apiBase = 'https://api.supabase.com', env = process.env }) {
    this.token = token;
    this.allowedProjects = new Set(allowedProjects);
    this.fetchFn = fetchFn;
    this.apiBase = apiBase.replace(/\/$/, '');
    this.env = env;
  }

  project(ref) {
    if (!/^[a-z0-9]{20}$/.test(ref || '')) throw supabaseError('SUPABASE_PROJECT_INVALID', 'A Supabase project reference is required');
    if (!this.allowedProjects.has(ref)) throw supabaseError('SUPABASE_PROJECT_NOT_ALLOWED', `Project ${ref} is not in this session's allowlist`);
    return ref;
  }

  async post(path, body) {
    if (!this.token) throw supabaseError('SUPABASE_TOKEN_UNAVAILABLE', 'No Supabase access token is configured for the Coding Agent');
    const response = await this.fetchFn(`${this.apiBase}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    const text = await response.text();
    if (!response.ok) {
      throw supabaseError(`SUPABASE_HTTP_${response.status}`, `Supabase request failed (HTTP ${response.status}): ${redact(text, this.env, 600)}`);
    }
    try { return JSON.parse(text); } catch { return text; }
  }

  async queryReadOnly(projectRef, sql, { maxRows = 200 } = {}) {
    const statement = assertReadOnlySql(sql);
    // Wrapping as a subquery also rejects data-modifying CTEs at the database.
    const wrapped = `select coalesce(json_agg(t), '[]'::json) as rows from (select * from (${statement}) q limit ${Math.max(1, Math.min(1000, maxRows))}) t`;
    const result = await this.post(`/v1/projects/${this.project(projectRef)}/database/query`, { query: wrapped });
    const rows = Array.isArray(result) ? result[0]?.rows ?? [] : [];
    return { rows, rowCount: Array.isArray(rows) ? rows.length : 0 };
  }

  async execute(projectRef, sql) {
    const result = await this.post(`/v1/projects/${this.project(projectRef)}/database/query`, { query: String(sql) });
    return { result: Array.isArray(result) ? result.slice(0, 50) : result };
  }

  async applyMigration(projectRef, name, sql) {
    if (!/^[a-z0-9_]{3,100}$/.test(name || '')) throw supabaseError('MIGRATION_NAME_INVALID', 'Migration names use lowercase letters, digits and underscores');
    await this.post(`/v1/projects/${this.project(projectRef)}/database/migrations`, { name, query: String(sql) });
    return { applied: true, name };
  }
}

function supabaseError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
