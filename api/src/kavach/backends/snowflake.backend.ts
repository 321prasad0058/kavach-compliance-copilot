/**
 * Snowflake backend over pure REST (fetch): SQL API v2, Cortex COMPLETE (via SQL), Cortex Analyst, Cortex Search
 * and the KAVACH.GOV.LOG_EVENT audit procedure. Ported from app/kavach/backend.py.
 */
import { Logger } from '@nestjs/common';

import * as config from '../config';
import type { Alert, AlertsByRule, AuditReceipt, AuditRow, ChainStatus, FindingRow, Kpis } from '../contract';
import { cleanSql, isReadOnlySql } from '../sql-guard';
import type {
  AnalystResponse, CompletionResult, JsonObject, KavachBackend, Row, SearchHit, Table,
} from './backend.interface';
import { MODE_LABELS, type SnowflakeAuth } from './snowflake-auth';
import { SqlApiClient, type SqlApiOptions } from './sql-api';

const ANALYST_PATH = '/api/v2/cortex/analyst/message';
const SEARCH_PATH = `/api/v2/databases/${config.SEARCH_SERVICE_DB}/schemas/${config.SEARCH_SERVICE_SCHEMA}`
  + `/cortex-search-services/${config.SEARCH_SERVICE_NAME}:query`;
const OPEN_STATUSES = "('OPEN', 'IN_REVIEW', 'ESCALATED')";

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
const strOrNull = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : String(v));
const num = (v: unknown): number => (v === null || v === undefined || v === '' ? 0 : Number(v));
const numOrNull = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(v));
const parseMaybeJson = (v: unknown): unknown => {
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return v; }
};

/** Map a VARIANT receipt from LOG_EVENT to the contract's camelCase AuditReceipt. */
export function toAuditReceipt(v: unknown): AuditReceipt {
  const r = (parseMaybeJson(v) ?? {}) as Record<string, unknown>;
  return {
    auditSeq: num(r.audit_seq), eventId: str(r.event_id), rowHash: str(r.row_hash), prevHash: str(r.prev_hash),
    eventTsUtc: str(r.event_ts_utc),
  };
}

/** Map a Cortex Search result (lower-case keys as requested, plus "@scores") to a SearchHit. */
export function toSearchHit(r: Record<string, unknown>): SearchHit {
  const g = (k: string): string => {
    const hit = Object.keys(r).find((x) => x.toLowerCase() === k);
    return hit ? str(r[hit]) : '';
  };
  const scores = (r['@scores'] ?? {}) as { cosine_similarity?: number };
  return {
    chunkId: g('chunk_id'), docId: g('doc_id'), docTitle: g('doc_title'), docType: g('doc_type'), issuer: g('issuer'),
    version: g('version'), sourceRef: g('source_ref'), sectionId: g('section_id'), sectionTitle: g('section_title'),
    sectionPath: g('section_path'), chunkText: g('chunk_text'), disclaimer: g('disclaimer'),
    score: typeof scores.cosine_similarity === 'number' ? scores.cosine_similarity : null,
  };
}

/** Parse a Cortex Analyst /message response. */
export function parseAnalystResponse(resp: Record<string, unknown>): AnalystResponse {
  const out: AnalystResponse = { text: '', sql: null, verifiedQueryUsed: false, suggestions: [], requestId: strOrNull(resp.request_id) };
  const content = ((resp.message as { content?: unknown[] } | undefined)?.content ?? []) as Record<string, unknown>[];
  for (const item of content) {
    if (item.type === 'text') out.text += str(item.text);
    else if (item.type === 'sql') {
      out.sql = strOrNull(item.statement);
      out.verifiedQueryUsed = Boolean((item.confidence as { verified_query_used?: unknown } | undefined)?.verified_query_used);
    } else if (item.type === 'suggestions') out.suggestions = ((item.suggestions as unknown[]) ?? []).map(str);
  }
  return out;
}

export class SnowflakeBackend implements KavachBackend {
  readonly isMock = false;
  readonly mode: string;
  readonly sql: SqlApiClient;
  private model: string | null = null;
  private readonly logger = new Logger('SnowflakeBackend');

  constructor(readonly auth: SnowflakeAuth, opts?: Partial<SqlApiOptions>) {
    this.mode = MODE_LABELS[auth.mode];
    this.sql = new SqlApiClient(auth, {
      database: config.DATABASE, warehouse: config.SNOWFLAKE_WAREHOUSE, role: config.SNOWFLAKE_ROLE,
      timeoutS: config.SQL_TIMEOUT_S, ...opts,
    });
  }

  private async rows(statement: string, binds: (string | number)[] = []): Promise<Row[]> {
    return (await this.sql.execute(statement, binds)).rows;
  }

  // ------------------------------------------------------------------ Cortex COMPLETE
  async complete(prompt: string): Promise<CompletionResult> {
    const messages = JSON.stringify([{ role: 'user', content: prompt }]);
    const options = JSON.stringify({ temperature: config.LLM_TEMPERATURE, max_tokens: config.LLM_MAX_TOKENS });
    const models = this.model ? [this.model] : config.LLM_MODELS;
    let lastErr: unknown = null;
    for (const model of models) {
      try {
        const [row] = await this.rows('SELECT SNOWFLAKE.CORTEX.COMPLETE(?, PARSE_JSON(?), PARSE_JSON(?)) AS R', [model, messages, options]);
        const out = parseMaybeJson(row?.R) as { choices?: { messages?: string; message?: { content?: string } }[] };
        const choice = out?.choices?.[0];
        const text = choice?.messages ?? choice?.message?.content ?? '';
        if (!text) throw new Error('empty completion');
        if (this.model !== model) this.logger.log(`Cortex COMPLETE model in use: ${model}`);
        this.model = model;
        return { text, model };
      } catch (e) {
        lastErr = e; // try the next model
      }
    }
    if (this.model) { // cached model stopped working: retry the full list once
      this.model = null;
      return this.complete(prompt);
    }
    throw new Error(`No Cortex LLM available from ${config.LLM_MODELS.join(', ')}: ${(lastErr as Error)?.message ?? lastErr}`);
  }

  // ------------------------------------------------------------------ Cortex Analyst
  async analyst(question: string): Promise<AnalystResponse> {
    const body = {
      messages: [{ role: 'user', content: [{ type: 'text', text: question }] }],
      semantic_model_file: config.SEMANTIC_MODEL_FILE,
    };
    const { json } = await this.sql.request<Record<string, unknown>>('POST', ANALYST_PATH, body);
    return parseAnalystResponse(json);
  }

  async runSql(sql: string, limit: number): Promise<Table> {
    // Analyst ends its SQL with "-- Generated by Cortex Analyst ...\n;" - drop the terminator before wrapping.
    const body = cleanSql(sql);
    if (!isReadOnlySql(body)) throw new Error('Blocked: not a single read-only SELECT.');
    return this.sql.execute(`SELECT * FROM (\n${body}\n) LIMIT ${Math.max(1, Math.floor(limit))}`);
  }

  // ------------------------------------------------------------------ Cortex Search
  async search(query: string, limit: number): Promise<SearchHit[]> {
    const body = { query, columns: config.SEARCH_COLUMNS, limit };
    let results: Record<string, unknown>[];
    try {
      results = ((await this.sql.request<{ results?: Record<string, unknown>[] }>('POST', SEARCH_PATH, body)).json.results) ?? [];
    } catch (e) {
      // fall back to the SQL preview function (needs literal arguments)
      this.logger.warn(`Cortex Search REST failed (${(e as Error).message}); trying SEARCH_PREVIEW`);
      const lit = (s: string): string => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
      const [row] = await this.rows(`SELECT SNOWFLAKE.CORTEX.SEARCH_PREVIEW(${lit(config.SEARCH_SERVICE_FQN)}, ${lit(JSON.stringify(body))}) AS R`);
      results = ((parseMaybeJson(row?.R) as { results?: Record<string, unknown>[] })?.results) ?? [];
    }
    return results.map(toSearchHit);
  }

  // ------------------------------------------------------------------ audit
  async logEvent(eventType: string, user: string, payload: JsonObject): Promise<AuditReceipt> {
    const t = await this.sql.execute(`CALL ${config.GOV_SCHEMA}.LOG_EVENT(?, ?, ?)`, [eventType, user, JSON.stringify(payload)]);
    const first = t.rows[0];
    if (!first) throw new Error('LOG_EVENT returned no receipt');
    return toAuditReceipt(first[t.columns[0]]);
  }

  // ------------------------------------------------------------------ UI queries
  async kpis(): Promise<Kpis> {
    const [r] = await this.rows(`SELECT * FROM ${config.CORE_SCHEMA}.PORTFOLIO_KPIS`);
    return {
      openAlerts: num(r?.OPEN_ALERTS), highSeverityOpen: num(r?.HIGH_SEVERITY_OPEN), totalExposure: num(r?.TOTAL_EXPOSURE),
      npaExposure: num(r?.NPA_EXPOSURE), sma2Accounts: num(r?.SMA2_ACCOUNTS), highRiskKycOverdue: num(r?.HIGH_RISK_KYC_OVERDUE),
    };
  }

  async alertQueue(limit: number): Promise<Alert[]> {
    const rows = await this.rows(`
      SELECT a.alert_id, a.created_at, a.rule_triggered, a.severity, a.status, a.account_id,
             c.business_name, a.alert_amount, a.assigned_to, a.analyst_notes
      FROM ${config.CORE_SCHEMA}.FRAUD_ALERTS a
      LEFT JOIN ${config.CORE_SCHEMA}.CUSTOMERS c ON a.customer_id = c.customer_id
      WHERE a.status IN ${OPEN_STATUSES}
      ORDER BY a.created_at DESC LIMIT ${Math.floor(limit)}`);
    return rows.map((r) => ({
      alertId: str(r.ALERT_ID), createdAt: str(r.CREATED_AT), ruleTriggered: str(r.RULE_TRIGGERED),
      severity: str(r.SEVERITY) as Alert['severity'], status: str(r.STATUS), accountId: str(r.ACCOUNT_ID),
      businessName: strOrNull(r.BUSINESS_NAME), alertAmount: num(r.ALERT_AMOUNT), assignedTo: str(r.ASSIGNED_TO),
      analystNotes: strOrNull(r.ANALYST_NOTES),
    }));
  }

  async alertsByRule(): Promise<AlertsByRule[]> {
    const rows = await this.rows(`
      SELECT rule_triggered, severity, COUNT(*) AS n FROM ${config.CORE_SCHEMA}.FRAUD_ALERTS
      WHERE status IN ${OPEN_STATUSES} GROUP BY 1, 2 ORDER BY n DESC, 1`);
    return rows.map((r) => ({ ruleTriggered: str(r.RULE_TRIGGERED), severity: str(r.SEVERITY) as AlertsByRule['severity'], n: num(r.N) }));
  }

  async auditLog(limit: number): Promise<AuditRow[]> {
    const rows = await this.rows(`
      SELECT audit_seq, TO_VARCHAR(event_ts_utc, 'YYYY-MM-DD HH24:MI:SS') AS event_ts_utc, event_type, app_user,
             route, confidence, row_count, question, row_hash, prev_hash, is_valid
      FROM ${config.GOV_SCHEMA}.V_AUDIT_CHAIN_CHECK ORDER BY audit_seq DESC LIMIT ${Math.floor(limit)}`);
    return rows.map((r) => ({
      auditSeq: num(r.AUDIT_SEQ), eventTsUtc: str(r.EVENT_TS_UTC), eventType: str(r.EVENT_TYPE), appUser: str(r.APP_USER),
      route: strOrNull(r.ROUTE), confidence: strOrNull(r.CONFIDENCE), rowCount: numOrNull(r.ROW_COUNT),
      question: strOrNull(r.QUESTION), rowHash: str(r.ROW_HASH), prevHash: str(r.PREV_HASH), isValid: r.IS_VALID === true,
    }));
  }

  async chainStatus(): Promise<ChainStatus> {
    const [r] = await this.rows(`SELECT COUNT(*) AS N, COUNT_IF(is_valid) AS V FROM ${config.GOV_SCHEMA}.V_AUDIT_CHAIN_CHECK`);
    return { rows: num(r?.N), valid: num(r?.V) };
  }

  async auditPayload(auditSeq: number): Promise<JsonObject | null> {
    const rows = await this.rows(`SELECT payload FROM ${config.GOV_SCHEMA}.AUDIT_LOG WHERE audit_seq = ?`, [Math.floor(auditSeq)]);
    if (!rows.length) return null;
    const p = parseMaybeJson(rows[0].PAYLOAD);
    return p && typeof p === 'object' ? (p as JsonObject) : { value: p };
  }

  async findings(): Promise<FindingRow[]> {
    const rows = await this.rows(`
      SELECT finding_id, TO_VARCHAR(created_at_utc, 'YYYY-MM-DD HH24:MI:SS') AS created_at_utc, created_by, finding_type,
             title, confidence, status, reviewer, TO_VARCHAR(reviewed_at_utc, 'YYYY-MM-DD HH24:MI:SS') AS reviewed_at_utc,
             review_comment, maker_checker_ok, finding_markdown
      FROM ${config.GOV_SCHEMA}.V_FINDINGS ORDER BY finding_audit_seq DESC`);
    return rows.map((r) => ({
      findingId: str(r.FINDING_ID), createdAtUtc: str(r.CREATED_AT_UTC), createdBy: str(r.CREATED_BY),
      findingType: str(r.FINDING_TYPE) as FindingRow['findingType'], title: str(r.TITLE),
      confidence: (str(r.CONFIDENCE) || 'LOW') as FindingRow['confidence'], status: (str(r.STATUS) || 'PENDING_REVIEW') as FindingRow['status'],
      reviewer: strOrNull(r.REVIEWER), reviewedAtUtc: strOrNull(r.REVIEWED_AT_UTC), reviewComment: strOrNull(r.REVIEW_COMMENT),
      makerCheckerOk: r.MAKER_CHECKER_OK !== false, findingMarkdown: str(r.FINDING_MARKDOWN),
    }));
  }
}
