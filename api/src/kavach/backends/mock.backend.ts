/**
 * Offline mock backend for rehearsal and local UI development - no Snowflake, no LLM.
 *
 * - Analyst  -> maps the question to one of the semantic model's verified queries (showing the physical SQL
 *               extracted from semantic_model/kavach.yaml) and evaluates the equivalent logic over data/out/*.csv
 * - Search   -> field-weighted BM25 over the same clause-level chunks loaded into Cortex Search
 * - COMPLETE -> unavailable (the orchestrator uses its deterministic, citation-preserving fallback)
 * - Audit    -> in-memory hash chain using the same formula as KAVACH.GOV.LOG_EVENT
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';

import * as config from '../config';
import type { Alert, AlertsByRule, AuditReceipt, AuditRow, ChainStatus, FindingRow, Kpis } from '../contract';
import { parseCsvRecords } from '../csv';
import { round2 } from '../text';
import type {
  AnalystResponse, Cell, CompletionResult, JsonObject, KavachBackend, Row, SearchHit, Table,
} from './backend.interface';
import { Bm25Index } from './bm25';

const OPEN = new Set(['OPEN', 'IN_REVIEW', 'ESCALATED']);
const DAY_MS = 86_400_000;

// ----------------------------------------------------------------------------- semantic model
/** Pull verified-query SQL out of the semantic model so the mock shows the same SQL Analyst would. */
export function verifiedSql(yamlText: string): Record<string, { question: string; sql: string }> {
  const out: Record<string, { question: string; sql: string }> = {};
  const re = /- name: (\w+)\n\s+question: (.*?)\n(?:\s+use_as_onboarding_question: \w+\n)?\s+sql: \|\n((?:\s{6}.*\n?)+)/g;
  for (const m of yamlText.matchAll(re)) {
    const body = m[3].split('\n').map((l) => l.slice(6)).join('\n');
    const sql = body.replace(/__(\w+)/g, (_x, t: string) => `KAVACH.CORE.${t.toUpperCase()}`).trim();
    out[m[1]] = { question: m[2].trim(), sql };
  }
  return out;
}

const normSql = (sql: string): string => sql.replace(/\s+/g, ' ').replace(/;\s*$/, '').trim();

// ----------------------------------------------------------------------------- date helpers
const dateMs = (d: string): number => Date.parse(`${d.slice(0, 10)}T00:00:00Z`);
const tsMs = (ts: string): number => Date.parse(`${ts.replace(' ', 'T')}Z`);
/** Snowflake TIMESTAMP_NTZ rendered the way the SQL API converter renders it: "YYYY-MM-DDTHH:MM:SS". */
const isoTs = (ms: number): string => new Date(ms).toISOString().slice(0, 19);
/** DATEADD(month, n, d) - clamps to month end like Snowflake. */
function addMonths(ms: number, n: number): number {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + n;
  const target = new Date(Date.UTC(y, m, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  return Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), Math.min(d.getUTCDate(), last));
}

// ----------------------------------------------------------------------------- typed CSV loading
type Kind = 'num' | 'bool';
function load<T>(dir: string, name: string, kinds: Record<string, Kind>): T[] {
  const file = path.join(dir, `${name}.csv`);
  return parseCsvRecords(readFileSync(file, 'utf8')).map((r) => {
    const o: Record<string, Cell> = {};
    for (const [k, v] of Object.entries(r)) {
      if (v === '') o[k] = null;
      else if (kinds[k] === 'num') o[k] = Number(v);
      else if (kinds[k] === 'bool') o[k] = v.toUpperCase() === 'TRUE';
      else o[k] = v;
    }
    return o as T;
  });
}

interface Customer {
  customer_id: string; business_name: string; pan: string; segment: string; city: string; state: string;
  onboarding_date: string; declared_monthly_income: number | null; bank_stmt_avg_monthly_credit: number | null;
  first_time_borrower: boolean; bureau_score: number | null;
}
interface Account {
  account_id: string; customer_id: string; product: string; sourcing_partner: string; sanctioned_amount: number;
  disbursed_amount: number; disbursal_date: string; tenure_months: number; interest_rate: number;
  outstanding_principal: number; dpd: number; asset_classification: string; npa_flag: boolean; account_status: string;
}
interface Txn {
  txn_id: string; account_id: string; customer_id: string; txn_ts: string; amount: number; direction: string;
  channel: string; counterparty: string; counterparty_type: string; geo_city: string; geo_state: string;
}
interface Kyc {
  customer_id: string; doc_type: string; verification_status: string; risk_category: string; pep_flag: boolean;
  sanctions_screening: string; last_kyc_date: string; next_kyc_due: string;
}
interface FraudAlert {
  alert_id: string; account_id: string; customer_id: string; rule_triggered: string; severity: 'LOW' | 'MEDIUM' | 'HIGH';
  status: string; created_at: string; assigned_to: string; alert_amount: number; analyst_notes: string | null;
}

/** One entry in the in-memory audit chain. `canon` is the canonical payload JSON that was hashed. */
export interface MockAuditEntry {
  auditSeq: number;
  eventId: string;
  eventTs: Date;
  eventTsMicros: string; // "YYYY-MM-DD HH:MM:SS.ffffff" as hashed
  eventType: string;
  appUser: string;
  payload: JsonObject;
  canon: string;
  prevHash: string;
  rowHash: string;
}

/** JSON with object keys sorted recursively and no whitespace (the canonical form hashed into the chain). */
export function canonicalJson(value: unknown): string {
  const norm = (v: unknown): unknown => {
    if (v === undefined) return null;
    if (v instanceof Date) return v.toISOString();
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === 'object') {
      const o: Record<string, unknown> = {};
      for (const k of Object.keys(v as object).sort()) {
        const x = (v as Record<string, unknown>)[k];
        if (x !== undefined) o[k] = norm(x);
      }
      return o;
    }
    if (typeof v === 'number' && !Number.isFinite(v)) return null;
    return v;
  };
  return JSON.stringify(norm(value));
}

export function chainHash(prev: string, seq: number, tsMicros: string, type: string, user: string, canon: string): string {
  return createHash('sha256').update(`${prev}|${seq}|${tsMicros}|${type}|${user}|${canon}`, 'utf8').digest('hex');
}

const tsMicros = (d: Date): string => `${d.toISOString().replace('T', ' ').slice(0, 19)}.${String(d.getUTCMilliseconds() * 1000).padStart(6, '0')}`;

type QueryName =
  | 'early_delinquency_exposure' | 'early_delinquency_by_partner' | 'structuring_this_week'
  | 'ntc_income_mismatch_30d' | 'open_alerts_by_rule' | 'gnpa_by_product' | 'high_risk_kyc_overdue';

export class MockBackend implements KavachBackend {
  readonly mode = 'Offline mock';
  readonly isMock = true;

  readonly customers: Customer[];
  readonly accounts: Account[];
  readonly txns: Txn[];
  readonly kyc: Kyc[];
  readonly alerts: FraudAlert[];
  readonly chunks: SearchHit[];
  readonly today: string;       // anchor date, YYYY-MM-DD
  readonly todayMs: number;
  readonly nowMs: number;       // anchor date 18:00
  readonly sql: Record<string, { question: string; sql: string }>;
  /** The audit chain. Public so tests (and demo tamper drills) can edit it and watch verification fail. */
  readonly log: MockAuditEntry[] = [];

  private readonly bySql = new Map<string, QueryName>();
  private readonly index: Bm25Index;
  private readonly customerById = new Map<string, Customer>();
  private readonly kycById = new Map<string, Kyc>();
  private readonly accountById = new Map<string, Account>();

  /** Artificial per-call latency so the UI's pipeline animation is visible during rehearsal (KAVACH_MOCK_LATENCY_MS). */
  latencyMs: number;

  constructor(dataDir = config.DATA_DIR, semanticModelPath = config.SEMANTIC_MODEL_PATH, latencyMs = config.MOCK_LATENCY_MS) {
    this.latencyMs = latencyMs;
    if (!existsSync(path.join(dataDir, 'accounts.csv'))) {
      throw new Error(`Run \`python3 data/generate_synthetic.py\` first (${dataDir} has no accounts.csv).`);
    }
    this.customers = load<Customer>(dataDir, 'customers', {
      declared_monthly_income: 'num', bank_stmt_avg_monthly_credit: 'num', first_time_borrower: 'bool', bureau_score: 'num',
    });
    this.accounts = load<Account>(dataDir, 'accounts', {
      sanctioned_amount: 'num', disbursed_amount: 'num', tenure_months: 'num', interest_rate: 'num',
      outstanding_principal: 'num', dpd: 'num', npa_flag: 'bool',
    });
    this.txns = load<Txn>(dataDir, 'transactions', { amount: 'num' });
    this.kyc = load<Kyc>(dataDir, 'kyc_records', { pep_flag: 'bool' });
    this.alerts = load<FraudAlert>(dataDir, 'fraud_alerts', { alert_amount: 'num' });
    this.chunks = parseCsvRecords(readFileSync(path.join(dataDir, 'policy_chunks.csv'), 'utf8')).map((r) => ({
      chunkId: r.chunk_id, docId: r.doc_id, docTitle: r.doc_title, docType: r.doc_type, issuer: r.issuer,
      version: r.version, sourceRef: r.source_ref, sectionId: r.section_id, sectionTitle: r.section_title,
      sectionPath: r.section_path, chunkText: r.chunk_text, disclaimer: r.disclaimer, score: null,
    }));
    const meta = parseCsvRecords(readFileSync(path.join(dataDir, 'data_meta.csv'), 'utf8'))[0];
    this.today = meta?.anchor_date || new Date().toISOString().slice(0, 10);
    this.todayMs = dateMs(this.today);
    this.nowMs = this.todayMs + 18 * 3_600_000;

    this.sql = verifiedSql(readFileSync(semanticModelPath, 'utf8'));
    for (const [name, v] of Object.entries(this.sql)) this.bySql.set(normSql(v.sql), name as QueryName);
    for (const c of this.customers) this.customerById.set(c.customer_id, c);
    for (const k of this.kyc) this.kycById.set(k.customer_id, k);
    for (const a of this.accounts) this.accountById.set(a.account_id, a);
    this.index = new Bm25Index(this.chunks);
  }

  // ------------------------------------------------------------------ LLM
  private async delay(factor = 1): Promise<void> {
    if (this.latencyMs > 0) await new Promise((r) => setTimeout(r, Math.round(this.latencyMs * factor)));
  }

  async complete(_prompt: string): Promise<CompletionResult> {
    await this.delay(0.5);
    return { text: null, model: null };
  }

  // ------------------------------------------------------------------ Analyst
  async analyst(question: string): Promise<AnalystResponse> {
    await this.delay(2);
    const q = question.toLowerCase();
    let name: QueryName | null = null;
    if (q.includes('partner') && q.includes('delinq')) name = 'early_delinquency_by_partner';
    else if (q.includes('dpd') || q.includes('delinq')) name = 'early_delinquency_exposure';
    else if (q.includes('structur')) name = 'structuring_this_week';
    else if (q.includes('income')) name = 'ntc_income_mismatch_30d';
    else if (q.includes('kyc')) name = 'high_risk_kyc_overdue';
    else if (q.includes('npa') || q.includes('product')) name = 'gnpa_by_product';
    else if (q.includes('alert')) name = 'open_alerts_by_rule';
    if (!name || !this.sql[name]) {
      return {
        text: 'Offline mock supports the semantic model\'s verified questions only. Connect to Snowflake for open-ended text-to-SQL.',
        sql: null, verifiedQueryUsed: false,
        suggestions: [
          'Which accounts disbursed in the last 6 months now show DPD over 60?',
          'Show me accounts flagged for structuring this week',
          'Which high-risk or PEP customers have overdue periodic KYC updation?',
        ],
      };
    }
    return {
      text: `This is our interpretation of your question: "${this.sql[name].question}" (verified query: ${name}).`,
      sql: this.sql[name].sql, verifiedQueryUsed: true, suggestions: [], requestId: `mock-${randomUUID()}`,
    };
  }

  async runSql(sql: string, limit: number): Promise<Table> {
    await this.delay();
    const name = this.bySql.get(normSql(sql));
    if (!name) throw new Error('Mock backend can only run verified queries.');
    const t = this.runVerified(name);
    return { columns: t.columns, rows: t.rows.slice(0, limit) };
  }

  /** Evaluate a verified query by name. Columns are UPPERCASE, in the SQL's select order. */
  runVerified(name: QueryName): Table {
    const rows: Record<string, Cell>[] = (() => {
      switch (name) {
        case 'early_delinquency_exposure': return this.qEarlyDelinquencyExposure();
        case 'early_delinquency_by_partner': return this.qEarlyDelinquencyByPartner();
        case 'structuring_this_week': return this.qStructuringThisWeek();
        case 'ntc_income_mismatch_30d': return this.qNtcIncomeMismatch();
        case 'open_alerts_by_rule': return this.qOpenAlertsByRule();
        case 'gnpa_by_product': return this.qGnpaByProduct();
        case 'high_risk_kyc_overdue': return this.qHighRiskKycOverdue();
      }
    })();
    const columns = COLUMNS[name].map((c) => c.toUpperCase());
    return {
      columns,
      rows: rows.map((r) => Object.fromEntries(COLUMNS[name].map((c) => [c.toUpperCase(), r[c] ?? null])) as Row),
    };
  }

  private qEarlyDelinquencyExposure(): Record<string, Cell>[] {
    const since = addMonths(this.todayMs, -6);
    const rows = this.accounts
      .filter((a) => a.account_status === 'ACTIVE' && a.dpd > 60 && dateMs(a.disbursal_date) >= since && this.customerById.has(a.customer_id))
      .sort((a, b) => b.dpd - a.dpd);
    const total = round2(rows.reduce((s, a) => s + a.outstanding_principal, 0));
    return rows.map((a) => ({
      account_id: a.account_id, business_name: this.customerById.get(a.customer_id)!.business_name, product: a.product,
      sourcing_partner: a.sourcing_partner, disbursal_date: a.disbursal_date, dpd: a.dpd,
      asset_classification: a.asset_classification, outstanding_principal: a.outstanding_principal, total_exposure: total,
    }));
  }

  private qEarlyDelinquencyByPartner(): Record<string, Cell>[] {
    const since = addMonths(this.todayMs, -6);
    const g = new Map<string, { n: number; bad: number }>();
    for (const a of this.accounts) {
      if (dateMs(a.disbursal_date) < since) continue;
      const e = g.get(a.sourcing_partner) ?? { n: 0, bad: 0 };
      e.n++; if (a.dpd > 60) e.bad++;
      g.set(a.sourcing_partner, e);
    }
    return [...g.entries()]
      .map(([p, e]) => ({
        sourcing_partner: p, accounts_disbursed_6m: e.n, early_delinquent_accounts: e.bad,
        early_delinquency_rate_pct: round2((e.bad / e.n) * 100),
      }))
      .sort((a, b) => b.early_delinquent_accounts - a.early_delinquent_accounts);
  }

  /** KAVACH.CORE.STRUCTURING_SIGNALS: each account's densest 7-day window of sub-threshold cash/wallet credits. */
  structuringSignals(): Record<string, Cell>[] {
    const byAcc = new Map<string, Txn[]>();
    for (const t of this.txns) {
      if (t.direction === 'CREDIT' && (t.channel === 'CASH_DEPOSIT' || t.channel === 'WALLET_TOPUP') && t.amount >= 40000 && t.amount <= 49999.99) {
        const l = byAcc.get(t.account_id) ?? [];
        l.push(t);
        byAcc.set(t.account_id, l);
      }
    }
    const out: Record<string, Cell>[] = [];
    for (const [acc, list] of byAcc) {
      const g = list.map((t) => ({ ...t, ms: tsMs(t.txn_ts) })).sort((a, b) => a.ms - b.ms);
      let best: { n: number; total: number; start: number; w: typeof g } | null = null;
      for (const t0 of g) {
        const w = g.filter((t) => t.ms >= t0.ms && t.ms < t0.ms + 7 * DAY_MS);
        const total = round2(w.reduce((s, t) => s + t.amount, 0));
        if (!best || w.length > best.n || (w.length === best.n && total > best.total)) best = { n: w.length, total, start: t0.ms, w };
      }
      if (best && best.n >= 3) {
        const cities = [...new Set(best.w.map((t) => t.geo_city))].sort();
        const channels = [...new Set(best.w.map((t) => t.channel))].sort();
        out.push({
          account_id: acc, customer_id: best.w[0].customer_id, sub_threshold_txn_count: best.n, window_total_amount: best.total,
          distinct_cities: cities.length, cities: cities.join(', '), channels: channels.join(', '),
          window_start_ts: isoTs(best.start), window_end_ts: isoTs(Math.max(...best.w.map((t) => t.ms))),
        });
      }
    }
    return out;
  }

  private qStructuringThisWeek(): Record<string, Cell>[] {
    const since = this.nowMs - 7 * DAY_MS;
    const out: Record<string, Cell>[] = [];
    for (const s of this.structuringSignals()) {
      if (tsMs(String(s.window_end_ts).replace('T', ' ')) < since) continue;
      const a = this.accountById.get(String(s.account_id));
      const c = a && this.customerById.get(a.customer_id);
      if (!a || !c) continue;
      const k = this.kycById.get(a.customer_id);
      const alerts = this.alerts.filter((f) => f.account_id === a.account_id && f.rule_triggered === 'STRUCTURING' && OPEN.has(f.status));
      for (const f of alerts.length ? alerts : [null]) {
        out.push({
          account_id: a.account_id, business_name: c.business_name, disbursal_date: a.disbursal_date, disbursed_amount: a.disbursed_amount,
          sub_threshold_txn_count: s.sub_threshold_txn_count, window_total_amount: s.window_total_amount,
          distinct_cities: s.distinct_cities, cities: s.cities, channels: s.channels,
          window_start_ts: s.window_start_ts, window_end_ts: s.window_end_ts, risk_category: k?.risk_category ?? null,
          alert_id: f?.alert_id ?? null, alert_status: f?.status ?? null, severity: f?.severity ?? null,
        });
      }
    }
    return out.sort((x, y) => Number(y.window_total_amount) - Number(x.window_total_amount));
  }

  private qNtcIncomeMismatch(): Record<string, Cell>[] {
    const since = this.todayMs - 30 * DAY_MS;
    const flagged = new Set(this.alerts.filter((f) => f.rule_triggered === 'INCOME_MISMATCH').map((f) => f.account_id));
    const out: Record<string, Cell>[] = [];
    for (const a of this.accounts) {
      const c = this.customerById.get(a.customer_id);
      if (!c || !c.first_time_borrower || dateMs(a.disbursal_date) < since) continue;
      if (!c.declared_monthly_income || c.bank_stmt_avg_monthly_credit === null) continue;
      const ratio = c.bank_stmt_avg_monthly_credit / c.declared_monthly_income;
      if (!(ratio < 0.6)) continue;
      out.push({
        account_id: a.account_id, business_name: c.business_name, disbursal_date: a.disbursal_date, disbursed_amount: a.disbursed_amount,
        sourcing_partner: a.sourcing_partner, declared_monthly_income: c.declared_monthly_income,
        bank_stmt_avg_monthly_credit: c.bank_stmt_avg_monthly_credit, corroboration_ratio: round2(ratio),
        has_income_alert: flagged.has(a.account_id) ? 'YES' : 'NO',
      });
    }
    return out.sort((x, y) => Number(x.corroboration_ratio) - Number(y.corroboration_ratio));
  }

  private qOpenAlertsByRule(): Record<string, Cell>[] {
    const g = new Map<string, { rule: string; sev: string; n: number; amt: number }>();
    for (const a of this.alerts) {
      if (!OPEN.has(a.status)) continue;
      const key = `${a.rule_triggered}|${a.severity}`;
      const e = g.get(key) ?? { rule: a.rule_triggered, sev: a.severity, n: 0, amt: 0 };
      e.n++; e.amt += a.alert_amount;
      g.set(key, e);
    }
    return [...g.values()]
      .map((e) => ({ rule_triggered: e.rule, severity: e.sev, open_alerts: e.n, amount_flagged: round2(e.amt) }))
      .sort((a, b) => b.open_alerts - a.open_alerts);
  }

  private qGnpaByProduct(): Record<string, Cell>[] {
    const g = new Map<string, { exp: number; npa: number }>();
    for (const a of this.accounts) {
      if (a.account_status !== 'ACTIVE') continue;
      const e = g.get(a.product) ?? { exp: 0, npa: 0 };
      e.exp += a.outstanding_principal;
      if (a.npa_flag) e.npa += a.outstanding_principal;
      g.set(a.product, e);
    }
    return [...g.entries()]
      .map(([p, e]) => ({ product: p, exposure: round2(e.exp), npa_exposure: round2(e.npa), gnpa_pct: e.exp ? round2((e.npa / e.exp) * 100) : null }))
      .sort((a, b) => b.exposure - a.exposure);
  }

  private qHighRiskKycOverdue(): Record<string, Cell>[] {
    return this.kyc
      .filter((k) => (k.risk_category === 'HIGH' || k.pep_flag) && dateMs(k.next_kyc_due) < this.todayMs && this.customerById.has(k.customer_id))
      .map((k) => ({
        customer_id: k.customer_id, business_name: this.customerById.get(k.customer_id)!.business_name,
        risk_category: k.risk_category, pep_flag: k.pep_flag, last_kyc_date: k.last_kyc_date, next_kyc_due: k.next_kyc_due,
        days_overdue: Math.round((this.todayMs - dateMs(k.next_kyc_due)) / DAY_MS),
      }))
      .sort((a, b) => b.days_overdue - a.days_overdue);
  }

  // ------------------------------------------------------------------ Search
  async search(query: string, limit: number): Promise<SearchHit[]> {
    await this.delay(1.5);
    return this.index.search(query, limit).map(({ hit }) => ({ ...hit, score: null }));
  }

  /** Raw BM25 scores (for tuning / debugging). */
  searchScored(query: string, limit: number): { chunkId: string; score: number }[] {
    return this.index.search(query, limit).map(({ hit, score }) => ({ chunkId: hit.chunkId, score: round2(score) }));
  }

  // ------------------------------------------------------------------ audit (same hash formula as LOG_EVENT)
  async logEvent(eventType: string, user: string, payload: JsonObject): Promise<AuditReceipt> {
    const seq = this.log.length + 1;
    const prev = this.log.length ? this.log[this.log.length - 1].rowHash : 'GENESIS';
    const ts = new Date();
    const micros = tsMicros(ts);
    const canon = canonicalJson(payload);
    const rowHash = chainHash(prev, seq, micros, eventType, user, canon);
    const entry: MockAuditEntry = {
      auditSeq: seq, eventId: randomUUID(), eventTs: ts, eventTsMicros: micros, eventType, appUser: user,
      payload: JSON.parse(canon) as JsonObject, canon, prevHash: prev, rowHash,
    };
    this.log.push(entry);
    return { auditSeq: seq, eventId: entry.eventId, rowHash, prevHash: prev, eventTsUtc: micros.slice(0, 19) };
  }

  /** Recompute every hash and check linkage (V_AUDIT_CHAIN_CHECK). */
  verify(): { entry: MockAuditEntry; ok: boolean }[] {
    let expectedPrev = 'GENESIS';
    return this.log.map((e) => {
      const h = chainHash(e.prevHash, e.auditSeq, e.eventTsMicros, e.eventType, e.appUser, e.canon);
      const ok = e.prevHash === expectedPrev && h === e.rowHash;
      expectedPrev = e.rowHash;
      return { entry: e, ok };
    });
  }

  // ------------------------------------------------------------------ UI queries
  async kpis(): Promise<Kpis> {
    const open = this.alerts.filter((a) => OPEN.has(a.status));
    const act = this.accounts.filter((a) => a.account_status === 'ACTIVE');
    return {
      openAlerts: open.length,
      highSeverityOpen: open.filter((a) => a.severity === 'HIGH').length,
      totalExposure: round2(act.reduce((s, a) => s + a.outstanding_principal, 0)),
      npaExposure: round2(act.filter((a) => a.npa_flag).reduce((s, a) => s + a.outstanding_principal, 0)),
      sma2Accounts: act.filter((a) => a.asset_classification === 'SMA-2').length,
      highRiskKycOverdue: this.kyc.filter((k) => k.risk_category === 'HIGH' && dateMs(k.next_kyc_due) < this.todayMs).length,
    };
  }

  async alertQueue(limit: number): Promise<Alert[]> {
    return this.alerts
      .filter((a) => OPEN.has(a.status))
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, limit)
      .map((a) => ({
        alertId: a.alert_id, createdAt: isoTs(tsMs(a.created_at)), ruleTriggered: a.rule_triggered, severity: a.severity,
        status: a.status, accountId: a.account_id, businessName: this.customerById.get(a.customer_id)?.business_name ?? null,
        alertAmount: a.alert_amount, assignedTo: a.assigned_to, analystNotes: a.analyst_notes || null,
      }));
  }

  async alertsByRule(): Promise<AlertsByRule[]> {
    const g = new Map<string, AlertsByRule>();
    for (const a of this.alerts) {
      if (!OPEN.has(a.status)) continue;
      const key = `${a.rule_triggered}|${a.severity}`;
      const e = g.get(key) ?? { ruleTriggered: a.rule_triggered, severity: a.severity, n: 0 };
      e.n++;
      g.set(key, e);
    }
    return [...g.values()].sort((a, b) => b.n - a.n || a.ruleTriggered.localeCompare(b.ruleTriggered));
  }

  async auditLog(limit: number): Promise<AuditRow[]> {
    return this.verify().reverse().slice(0, limit).map(({ entry: e, ok }) => {
      const p = e.payload as Record<string, unknown>;
      const conf = p.confidence as { level?: string } | undefined;
      const data = p.data as { row_count?: number } | null | undefined;
      return {
        auditSeq: e.auditSeq, eventTsUtc: e.eventTsMicros.slice(0, 19), eventType: e.eventType, appUser: e.appUser,
        route: typeof p.route === 'string' ? p.route : null,
        confidence: conf?.level ?? null,
        rowCount: typeof data?.row_count === 'number' ? data.row_count : null,
        question: typeof p.question === 'string' ? p.question : null,
        rowHash: e.rowHash, prevHash: e.prevHash, isValid: ok,
      };
    });
  }

  async chainStatus(): Promise<ChainStatus> {
    const checks = this.verify();
    return { rows: checks.length, valid: checks.filter((c) => c.ok).length };
  }

  async auditPayload(auditSeq: number): Promise<JsonObject | null> {
    return this.log.find((e) => e.auditSeq === auditSeq)?.payload ?? null;
  }

  async findings(): Promise<FindingRow[]> {
    const reviews = new Map<string, MockAuditEntry>();
    for (const e of this.log) if (e.eventType === 'FINDING_REVIEWED') reviews.set(String(e.payload.finding_id), e);
    const rows: FindingRow[] = [];
    for (const e of this.log) {
      if (e.eventType !== 'FINDING_GENERATED') continue;
      const p = e.payload as Record<string, unknown>;
      const rv = reviews.get(String(p.finding_id));
      rows.push({
        findingId: String(p.finding_id), createdAtUtc: e.eventTsMicros.slice(0, 19), createdBy: e.appUser,
        findingType: p.finding_type as FindingRow['findingType'], title: String(p.title ?? ''),
        confidence: ((p.confidence as { level?: string })?.level ?? 'LOW') as FindingRow['confidence'],
        status: rv ? (rv.payload.decision as FindingRow['status']) : 'PENDING_REVIEW',
        reviewer: rv?.appUser ?? null, reviewedAtUtc: rv ? rv.eventTsMicros.slice(0, 19) : null,
        reviewComment: rv ? ((rv.payload.comment as string | undefined) ?? null) : null,
        makerCheckerOk: rv ? rv.appUser !== e.appUser : true,
        findingMarkdown: String(p.finding_markdown ?? ''),
      });
    }
    return rows.reverse();
  }
}

/** Select-list order of each verified query (lower case, as written in the SQL). */
const COLUMNS: Record<QueryName, string[]> = {
  early_delinquency_exposure: ['account_id', 'business_name', 'product', 'sourcing_partner', 'disbursal_date', 'dpd',
    'asset_classification', 'outstanding_principal', 'total_exposure'],
  early_delinquency_by_partner: ['sourcing_partner', 'accounts_disbursed_6m', 'early_delinquent_accounts', 'early_delinquency_rate_pct'],
  structuring_this_week: ['account_id', 'business_name', 'disbursal_date', 'disbursed_amount', 'sub_threshold_txn_count',
    'window_total_amount', 'distinct_cities', 'cities', 'channels', 'window_start_ts', 'window_end_ts', 'risk_category',
    'alert_id', 'alert_status', 'severity'],
  ntc_income_mismatch_30d: ['account_id', 'business_name', 'disbursal_date', 'disbursed_amount', 'sourcing_partner',
    'declared_monthly_income', 'bank_stmt_avg_monthly_credit', 'corroboration_ratio', 'has_income_alert'],
  open_alerts_by_rule: ['rule_triggered', 'severity', 'open_alerts', 'amount_flagged'],
  gnpa_by_product: ['product', 'exposure', 'npa_exposure', 'gnpa_pct'],
  high_risk_kyc_overdue: ['customer_id', 'business_name', 'risk_category', 'pep_flag', 'last_kyc_date', 'next_kyc_due', 'days_overdue'],
};
