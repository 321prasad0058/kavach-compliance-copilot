/**
 * Kavach orchestration: route -> gather evidence -> synthesise with citations -> audit.
 *
 * Deliberately explicit rather than a free-running agent loop: every step, input and output is captured
 * so the whole chain can be written to the audit log and replayed. Ported from app/kavach/orchestrator.py.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';

import { KAVACH_BACKEND, type KavachBackend, type Row, type SearchHit } from './backends/backend.interface';
import * as config from './config';
import type {
  AskResult, AuditReceipt, Confidence, ConfidenceLevel, DataEvidence, Finding, FindingType, PipelineStep,
  PolicyChunk, PolicyEvidence, ReviewDecision, Route, StepKey,
} from './contract';
import * as prompts from './prompts';
import { cleanSql, isReadOnlySql } from './sql-guard';
import {
  formatCell, isMoneyColumn, lexicalCoverage, round2, rowsToCsv, rowsToMarkdown, rupees, sentences, terms, utcStamp,
} from './text';

// ----------------------------------------------------------------------------- pure helpers
export { cleanSql, isReadOnlySql };
export interface RouteDecision {
  route: Route;
  reason: string;
  dataQuestion: string;
  policyQueries: string[];
  router: 'llm' | 'heuristic';
}

/** Extract the first {...} JSON object from LLM output. */
export function parseJsonBlock(text: string | null | undefined): Record<string, unknown> {
  const m = /\{[\s\S]*\}/.exec(text ?? '');
  if (!m) throw new Error('no JSON object in LLM output');
  return JSON.parse(m[0]) as Record<string, unknown>;
}

/** "RBI Master Direction ... §3.2 Chief Compliance Officer" (Python chunk_label). */
export function chunkLabel(c: Pick<PolicyChunk, 'docTitle' | 'sectionId' | 'sectionTitle'>): string {
  return `${c.docTitle || '?'} §${c.sectionId || '?'} ${c.sectionTitle || ''}`.trim();
}
/** Short citation name for prose: "SOP-AML §2.2 Escalation to the Principal Officer". */
export const shortLabel = (c: PolicyChunk): string => `${c.docId} §${c.sectionId} ${c.sectionTitle}`.trim();

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Append governed glossary expansions for every glossary key found (prefix match at a word boundary). */
export function expandQuery(query: string): string {
  const ql = query.toLowerCase();
  const extra = Object.entries(config.GLOSSARY)
    .filter(([k]) => new RegExp(`\\b${escapeRe(k)}`).test(ql))
    .map(([, v]) => v);
  return extra.length ? `${query} (${extra.join('; ')})` : query;
}

const POLICY_KW = ['policy', 'require', 'obligation', 'rbi', 'master direction', 'regulation', 'sop', 'guideline',
  'what does', 'disclosure', 'governance', 'clause', 'must we', 'comply', 'compliance', 'rule say',
  'scale based', 'pmla', 'fiu', 'str ', 'deadline', 'timeline', 'audit finding'];
const DATA_KW = ['show', 'which', 'how many', 'list', 'total', 'count', 'accounts', 'disbursement', 'disbursed',
  'transactions', 'exposure', 'dpd', 'npa', 'alerts', 'customers', 'borrowers', 'ratio', 'this week',
  'last 30', 'last 6', 'top ', 'by product', 'by partner'];
const FACETS = ['governance', 'disclosure', 'escalation', 'reporting', 'timeline'];
const FACET_WORDS = new Set(['governance', 'disclosure', 'disclosures', 'escalation', 'reporting', 'timeline',
  'requirements', 'requirement', 'require', 'apply', 'applies']);
const LAYER_RE = /scale based|\blayer\b|asset size|assets of|\bcrore\b/i;
/** Entity-size terms only the layer-classification sub-query needs; kept out of the per-facet sub-queries. */
const LAYER_WORDS = new Set(['scale', 'based', 'regulation', 'assets', 'asset', 'size', 'crore', 'lakh', 'layer']);

/** Keyword router used when the LLM router is unavailable. */
export function heuristicRoute(q: string): RouteDecision {
  const ql = q.toLowerCase();
  const p = POLICY_KW.some((k) => ql.includes(k));
  let d = DATA_KW.some((k) => ql.includes(k));
  if (ql.includes('scale based') || (ql.includes('what') && p && !['show', 'which accounts', 'list'].some((k) => ql.includes(k)))) {
    d = false;
  }
  const route: Route = p && d ? 'BOTH' : p ? 'POLICY' : 'DATA';
  let dataQ = q;
  let policyQ = q;
  if (route === 'BOTH') {
    const m = /,?\s+and\s+(?=(?:what|tell|how)\b)/i.exec(q);
    if (m) {
      dataQ = q.slice(0, m.index);
      policyQ = q.slice(m.index + m[0].length);
      // carry the subject into the policy query ("...about them" -> "...about structuring")
      const subject = terms(dataQ).filter((t) => !['accounts', 'flagged', 'week', 'show'].includes(t));
      policyQ = `${policyQ} ${subject.join(' ')}`.trim();
    }
  }
  const facets = FACETS.filter((f) => ql.includes(f));
  const base = terms(policyQ).filter((t) => !FACET_WORDS.has(t)).join(' ');
  let policyQs: string[];
  if (LAYER_RE.test(q) && facets.length > 0) {
    // "Under SBR, what X and Y apply to an NBFC of size Z?" -> classify the entity first, then one query per facet
    const entity = base.split(' ').filter((t) => !LAYER_WORDS.has(t) && !/^\d+$/.test(t)).join(' ');
    policyQs = [`layer classification applicability asset size ${base}`.slice(0, 160),
      ...facets.map((f) => `${f} requirements ${entity}`.slice(0, 120))].slice(0, 3);
  } else {
    policyQs = [policyQ];
    for (const f of facets) {
      if (policyQs.length >= 3) break;
      policyQs.push(`${f} requirements ${terms(policyQ).filter((t) => t !== f).join(' ').slice(0, 80)}`);
    }
  }
  return {
    route, reason: 'Keyword router (LLM router unavailable).', router: 'heuristic',
    dataQuestion: route !== 'POLICY' ? dataQ : '', policyQueries: route !== 'DATA' ? policyQs : [],
  };
}

const citationsIn = (text: string): string[] => [...new Set([...(text ?? '').matchAll(/\[((?:D|P)\d+)\]/g)].map((m) => m[1]))]
  .sort((a, b) => a[0].localeCompare(b[0]) || Number(a.slice(1)) - Number(b.slice(1)));

// ----------------------------------------------------------------------------- deterministic fallback answer
const ID_COLS = ['ACCOUNT_ID', 'CUSTOMER_ID', 'RULE_TRIGGERED', 'SOURCING_PARTNER', 'PRODUCT'];
const NOUNS: Record<string, [string, string]> = {
  ACCOUNT_ID: ['account', 'accounts'], CUSTOMER_ID: ['customer', 'customers'],
  RULE_TRIGGERED: ['alert rule / severity group', 'alert rule / severity groups'],
  SOURCING_PARTNER: ['sourcing partner', 'sourcing partners'], PRODUCT: ['product', 'products'],
};
const SUM_COLS = ['WINDOW_TOTAL_AMOUNT', 'OUTSTANDING_PRINCIPAL', 'DISBURSED_AMOUNT', 'ALERT_AMOUNT', 'AMOUNT_FLAGGED', 'EXPOSURE', 'NPA_EXPOSURE'];
const CATEGORY_COLS = ['SOURCING_PARTNER', 'PRODUCT', 'ASSET_CLASSIFICATION', 'RISK_CATEGORY', 'SEVERITY', 'ALERT_STATUS', 'RULE_TRIGGERED'];
const RANGE_COLS = ['DPD', 'CORROBORATION_RATIO', 'SUB_THRESHOLD_TXN_COUNT', 'DISTINCT_CITIES', 'DAYS_OVERDUE', 'GNPA_PCT', 'EARLY_DELINQUENCY_RATE_PCT'];
const SALIENT_COLS = ['DPD', 'OUTSTANDING_PRINCIPAL', 'SUB_THRESHOLD_TXN_COUNT', 'WINDOW_TOTAL_AMOUNT', 'CITIES', 'CORROBORATION_RATIO',
  'HAS_INCOME_ALERT', 'DAYS_OVERDUE', 'RISK_CATEGORY', 'PEP_FLAG', 'SEVERITY', 'OPEN_ALERTS', 'AMOUNT_FLAGGED', 'EXPOSURE', 'GNPA_PCT',
  'EARLY_DELINQUENT_ACCOUNTS', 'EARLY_DELINQUENCY_RATE_PCT', 'DISBURSED_AMOUNT', 'ALERT_STATUS'];

const human = (col: string): string => (col === 'DPD' ? 'DPD' : col.toLowerCase().replace(/_/g, ' '));
const plural = (n: number, [one, many]: [string, string]): string => (n === 1 ? one : many);
const cellText = (v: unknown, col: string): string =>
  typeof v === 'number' && isMoneyColumn(col) ? rupees(v) : formatCell(v as Row[string], col);

function summariseData(d: DataEvidence): { headline: string[]; facts: string[] } {
  const headline: string[] = [];
  const facts: string[] = [];
  if (d.error || !d.columns.length) {
    headline.push(`The data query could not be completed: ${d.error ?? 'no result'} [D1]`);
    return { headline, facts };
  }
  const cols = new Set(d.columns);
  const idCol = ID_COLS.find((c) => cols.has(c));
  const noun = NOUNS[idCol ?? ''] ?? ['matching record', 'matching records'];
  const n = d.rowCount;
  if (n === 0) {
    headline.push(`The governed query returned **no** matching ${noun[1]} [D1].`);
    return { headline, facts };
  }
  const rows = d.rows;
  const nums = (col: string): number[] => rows.map((r) => r[col]).filter((v): v is number => typeof v === 'number');
  let money = '';
  if (cols.has('TOTAL_EXPOSURE') && typeof rows[0].TOTAL_EXPOSURE === 'number') {
    money = `, with a total exposure (outstanding principal) of **${rupees(rows[0].TOTAL_EXPOSURE as number)}**`;
    facts.push(`- Total exposure across these ${noun[1]}: ${rupees(rows[0].TOTAL_EXPOSURE as number)} [D1]`);
  } else {
    const sumCol = SUM_COLS.find((c) => cols.has(c));
    if (sumCol) {
      const total = nums(sumCol).reduce((s, v) => s + v, 0);
      money = `, together accounting for **${rupees(total)}** of ${human(sumCol)}`;
      facts.push(`- Sum of ${human(sumCol)}: ${rupees(total)}${d.truncated || d.rows.length < n ? ' (rows returned to the UI only)' : ''} [D1]`);
    }
  }
  headline.push(`Kavach found **${n}** ${plural(n, noun)}${idCol ? ' matching the question' : ''}${money} [D1].`);

  const conc = CATEGORY_COLS.find((c) => cols.has(c) && c !== idCol);
  if (conc && n >= 5) {
    const counts = new Map<string, number>();
    for (const r of rows) if (r[conc] !== null) counts.set(String(r[conc]), (counts.get(String(r[conc])) ?? 0) + 1);
    const [topKey, topN] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? ['', 0];
    if (topN / rows.length >= 0.4 && counts.size > 1) {
      headline.push(`**${topN}** of the ${rows.length} are concentrated in ${human(conc)} **${topKey}** [D1].`);
    }
  }
  if (cols.has('HAS_INCOME_ALERT')) {
    const missed = rows.filter((r) => r.HAS_INCOME_ALERT === 'NO').length;
    if (missed) {
      const ids = rows.filter((r) => r.HAS_INCOME_ALERT === 'NO').map((r) => `\`${r[idCol ?? 'ACCOUNT_ID']}\``);
      headline.push(`**${missed}** of these (${ids.slice(0, 5).join(', ')}${ids.length > 5 ? ', …' : ''}) ${missed === 1 ? 'has' : 'have'} `
        + 'no INCOME_MISMATCH alert from the rules engine and would otherwise have gone unreviewed [D1].');
    } else {
      headline.push('All of them already have an INCOME_MISMATCH alert [D1].');
    }
  }
  if (cols.has('ALERT_ID')) {
    const noAlert = rows.filter((r) => r.ALERT_ID === null || r.ALERT_ID === '').length;
    headline.push(noAlert
      ? `**${noAlert}** of these ${noAlert === 1 ? 'has' : 'have'} no open alert yet [D1].`
      : `Each of them has an open alert${cols.has('ALERT_STATUS') ? ` (${[...new Set(rows.map((r) => r.ALERT_STATUS))].join(', ')})` : ''} [D1].`);
  }

  // distributions
  let dist = 0;
  for (const c of CATEGORY_COLS) {
    if (!cols.has(c) || c === idCol || dist >= 2 || n < 2) continue;
    const counts = new Map<string, number>();
    for (const r of rows) if (r[c] !== null && r[c] !== '') counts.set(String(r[c]), (counts.get(String(r[c])) ?? 0) + 1);
    if (counts.size < 1 || counts.size === rows.length) continue;
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => `${k} ${v}`).join(', ');
    facts.push(`- By ${human(c)}: ${top} [D1]`);
    dist++;
  }
  // ranges
  let ranges = 0;
  for (const c of RANGE_COLS) {
    if (!cols.has(c) || ranges >= 2) continue;
    const v = nums(c);
    if (!v.length) continue;
    const lo = Math.min(...v);
    const hi = Math.max(...v);
    facts.push(lo === hi ? `- ${human(c)}: ${formatCell(lo, c)} [D1]`
      : `- ${human(c)} ranges from ${formatCell(lo, c)} to ${formatCell(hi, c)} [D1]`);
    ranges++;
  }
  // top records
  const shown = rows.slice(0, n <= 6 ? 6 : 5);
  const salient = SALIENT_COLS.filter((c) => cols.has(c) && c !== idCol).slice(0, 3);
  const label = n > shown.length ? `Top ${shown.length} of ${n} (in query order)` : 'Records';
  facts.push(`- ${label}:`);
  for (const r of shown) {
    const id = idCol ? `\`${formatCell(r[idCol], idCol)}\`` : '';
    const name = cols.has('BUSINESS_NAME') && r.BUSINESS_NAME ? ` · ${r.BUSINESS_NAME}` : '';
    const rest = salient.map((c) => `${human(c)} ${cellText(r[c], c)}`).join(', ');
    facts.push(`  - ${id}${name}${rest ? ` - ${rest}` : ''} [D1]`);
  }
  return { headline, facts };
}

const OBLIGATION_RE = /\b(must|within|required|shall)\b/i;
const STRONG_OBLIGATION_RE = /\b(must|shall)\b/i;
const MAX_ACTIONS = 8;
const boldDeadlines = (s: string): string => s.replace(/\b(within [^,;.()]+)/gi, '**$1**');

/** Deterministic, citation-preserving answer used when no LLM is available. */
export function fallbackAnswer(question: string, data: DataEvidence | null, policy: PolicyEvidence | null): string {
  const answer: string[] = [];
  const facts: string[] = [];
  const actions: string[] = [];
  const gaps: string[] = [];

  if (data) {
    const s = summariseData(data);
    answer.push(...s.headline);
    facts.push(...s.facts);
    if (data.error && data.suggestions.length) gaps.push(`- Questions the governed model can answer: ${data.suggestions.map((x) => `_${x}_`).join('; ')}`);
    if (data.truncated) gaps.push(`- The data result was truncated at ${config.MAX_RESULT_ROWS} rows.`);
  }
  if (policy) {
    const chunks = policy.chunks;
    if (!chunks.length) {
      answer.push('No policy or regulatory passages were retrieved for this question.');
      gaps.push(`- Policy: ${policy.error ?? 'no supporting passages retrieved'}.`);
    } else {
      const top = chunks.slice(0, 3).map((c) => `${shortLabel(c)} [${c.label}]`);
      const list = top.length > 1 ? `${top.slice(0, -1).join(', ')} and ${top[top.length - 1]}` : top[0];
      answer.push(`The most relevant clauses retrieved are ${list}; the obligations they state are listed under Required actions.`);
      for (const c of chunks.slice(0, 4)) {
        const first = sentences(c.chunkText)[0] ?? c.chunkText;
        facts.push(`- **${shortLabel(c)}**: "${first}" [${c.label}]`);
      }
      // Obligation sentences (must / within / required / shall), modal "must/shall" first, then in citation order.
      const seen = new Set<string>();
      const candidates: { text: string; strong: boolean; order: number }[] = [];
      for (const c of chunks) {
        if (c.docType === 'TEMPLATE' || c.docType === 'AUDIT_FINDING') continue;
        for (const s of sentences(c.chunkText)) {
          if (!OBLIGATION_RE.test(s) || seen.has(s)) continue;
          seen.add(s);
          candidates.push({
            text: `${boldDeadlines(s)} _(${c.docId} §${c.sectionId})_ [${c.label}]`,
            strong: STRONG_OBLIGATION_RE.test(s), order: candidates.length,
          });
        }
      }
      candidates
        .sort((a, b) => Number(b.strong) - Number(a.strong) || a.order - b.order)
        .slice(0, MAX_ACTIONS)
        .sort((a, b) => a.order - b.order)
        .forEach((a, i) => actions.push(`${i + 1}. ${a.text}`));
      const past = chunks.filter((c) => c.docType === 'AUDIT_FINDING');
      for (const c of past) facts.push(`- Past audit finding on record: **${c.sectionTitle}** [${c.label}]`);
    }
  }
  gaps.unshift('- Generated without an LLM (Cortex COMPLETE unavailable): this is a structured summary of the evidence, '
    + 'not a reasoned answer. A reviewer must confirm how each obligation applies to these facts.');

  const out = ['**Answer**', answer.join(' ') || `No evidence could be gathered for: ${question}`, '', '**Key facts**',
    ...(facts.length ? facts : ['- None established.'])];
  if (actions.length) out.push('', '**Required actions**', ...actions);
  out.push('', '**Evidence gaps**', ...gaps);
  return out.join('\n');
}

/** Split a "**Heading**"-sectioned answer into {heading: body}. */
function answerSections(answer: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /^\*\*(Answer|Key facts|Required actions|Evidence gaps)\*\*[^\n]*$/gim;
  const marks = [...answer.matchAll(re)];
  marks.forEach((m, i) => {
    const start = (m.index ?? 0) + m[0].length;
    const end = i + 1 < marks.length ? marks[i + 1].index : answer.length;
    out[m[1].toLowerCase()] = answer.slice(start, end).trim();
  });
  return out;
}

const FINDING_SECTION_SOURCE: Record<string, keyof typeof SOURCE_KEYS> = {
  'Facts established': 'facts', 'Population affected': 'facts', 'Summary of suspicious transactions': 'facts',
  'Applicable obligations': 'actions', 'Requirement not met': 'actions', 'Recommended actions and deadlines': 'actions',
  'Remediation, owner and due date': 'actions', 'Action taken and statutory timeline': 'actions',
  'Open questions and evidence gaps': 'gaps',
};
const SOURCE_KEYS = { facts: 'key facts', actions: 'required actions', gaps: 'evidence gaps' } as const;

// ----------------------------------------------------------------------------- orchestrator
interface StoredFinding { finding: Finding; createdBy: string }

const STEP_LABELS: Record<StepKey, string> = {
  route: 'Router · question decomposition',
  analyst: 'Cortex Analyst · governed SQL',
  search: 'Cortex Search · policy clauses',
  synthesis: 'Cortex COMPLETE · cited answer',
  audit: 'Audit log · hash-chained record',
};
const STEP_ORDER: StepKey[] = ['route', 'analyst', 'search', 'synthesis', 'audit'];

export type StepListener = (step: PipelineStep) => void;

@Injectable()
export class KavachOrchestrator {
  private readonly logger = new Logger('Kavach');
  private readonly results = new Map<string, AskResult>();
  private readonly findingsById = new Map<string, StoredFinding>();
  lastLlmError: string | null = null;

  constructor(@Inject(KAVACH_BACKEND) readonly backend: KavachBackend) {}

  /** Cortex COMPLETE, or {text: null} so callers fall back deterministically. */
  private async llm(prompt: string): Promise<{ text: string | null; model: string | null }> {
    try {
      const r = await this.backend.complete(prompt);
      return r.text ? r : { text: null, model: null };
    } catch (e) {
      this.lastLlmError = (e as Error).message;
      this.logger.warn(`LLM unavailable: ${this.lastLlmError}`);
      return { text: null, model: null };
    }
  }

  // ---- step 1: routing
  async route(question: string): Promise<RouteDecision> {
    try {
      const { text } = await this.llm(prompts.fill(prompts.ROUTER, { question }));
      if (!text) throw new Error('LLM unavailable');
      const r = parseJsonBlock(text);
      const route = String(r.route ?? '').toUpperCase() as Route;
      if (!['DATA', 'POLICY', 'BOTH'].includes(route)) throw new Error(`bad route ${route}`);
      let pq: unknown = r.policy_queries ?? r.policy_query ?? [];
      pq = typeof pq === 'string' ? [pq] : Array.isArray(pq) ? pq.map(String).filter((x) => x.trim()).slice(0, 3) : [];
      const policyQueries = pq as string[];
      return {
        route, reason: String(r.reason ?? ''), router: 'llm',
        dataQuestion: (typeof r.data_question === 'string' && r.data_question) || (route !== 'POLICY' ? question : ''),
        policyQueries: policyQueries.length ? policyQueries : route !== 'DATA' ? [question] : [],
      };
    } catch {
      return heuristicRoute(question);
    }
  }

  // ---- step 2a: governed text-to-SQL
  async gatherData(question: string): Promise<DataEvidence> {
    const ev: DataEvidence = {
      question, analystText: '', sql: null, verifiedQueryUsed: false, columns: [], rows: [], rowCount: 0,
      truncated: false, error: null, suggestions: [],
    };
    let resp;
    try {
      resp = await this.backend.analyst(question);
    } catch (e) {
      ev.error = `Cortex Analyst call failed: ${(e as Error).message}`;
      return ev;
    }
    ev.analystText = resp.text ?? '';
    ev.suggestions = resp.suggestions ?? [];
    ev.verifiedQueryUsed = Boolean(resp.verifiedQueryUsed);
    ev.error = resp.error ?? null;
    if (!resp.sql) {
      ev.error = ev.error || 'Cortex Analyst did not generate SQL (question may be ambiguous).';
      return ev;
    }
    ev.sql = cleanSql(resp.sql);
    if (!isReadOnlySql(ev.sql)) {
      ev.error = 'Blocked: generated SQL is not a single read-only SELECT.';
      return ev;
    }
    try {
      const t = await this.backend.runSql(ev.sql, config.MAX_RESULT_ROWS + 1);
      ev.truncated = t.rows.length > config.MAX_RESULT_ROWS;
      const rows = t.rows.slice(0, config.MAX_RESULT_ROWS);
      ev.columns = t.columns;
      ev.rowCount = rows.length;
      ev.rows = rows.slice(0, config.UI_ROWS);
    } catch (e) {
      ev.error = `SQL execution failed: ${(e as Error).message}`;
    }
    return ev;
  }

  // ---- step 2b: retrieval (one or more sub-queries, merged round-robin, de-duplicated)
  async gatherPolicy(rawQueries: string[]): Promise<PolicyEvidence> {
    const queries = rawQueries.map(expandQuery);
    const ev: PolicyEvidence = { queries, chunks: [], error: null };
    // Each sub-query fetches a full page so the round-robin merge can still fill SEARCH_LIMIT after de-duplication.
    const perQuery = config.SEARCH_LIMIT;
    let lists: SearchHit[][];
    try {
      lists = await Promise.all(queries.map((q) => this.backend.search(q, perQuery)));
    } catch (e) {
      ev.error = `Cortex Search call failed: ${(e as Error).message}`;
      return ev;
    }
    const merged: SearchHit[] = [];
    const seen = new Set<string>();
    const depth = Math.max(0, ...lists.map((l) => l.length));
    for (let rank = 0; rank < depth; rank++) {
      for (const l of lists) {
        const h = l[rank];
        if (h && !seen.has(h.chunkId)) { seen.add(h.chunkId); merged.push(h); }
      }
    }
    // Coverage is measured against the analyst's own wording (not the glossary expansion): the best share of any
    // sub-query's terms that appear in the clause.
    const originals = rawQueries.length ? rawQueries : queries;
    ev.chunks = merged.slice(0, config.SEARCH_LIMIT).map((h, i) => ({
      ...h,
      label: `P${i + 1}`,
      lexicalCoverage: round2(Math.max(...originals.map((q) => lexicalCoverage(q, `${h.sectionPath} ${h.chunkText}`)))),
    }));
    return ev;
  }

  // ---- evidence block given to the LLM
  static evidenceBlock(data: DataEvidence | null, policy: PolicyEvidence | null): string {
    const parts: string[] = [];
    if (data) {
      parts.push("[D1] DATA RESULT (from the lender's governed tables via Cortex Analyst)");
      parts.push(`Question sent to Cortex Analyst: ${data.question}`);
      if (data.error) parts.push(`ERROR: ${data.error}`);
      if (data.sql) parts.push(`SQL:\n${data.sql}`);
      if (data.columns.length) {
        parts.push(`Rows returned: ${data.rowCount}${data.truncated ? ' (truncated)' : ''}`);
        parts.push(`Rows (CSV, first ${config.PROMPT_ROWS}):\n${rowsToCsv(data.columns, data.rows.slice(0, config.PROMPT_ROWS))}`);
      }
    }
    if (policy) {
      parts.push('POLICY AND REGULATION PASSAGES (from Cortex Search):');
      if (policy.error) parts.push(`ERROR: ${policy.error}`);
      if (!policy.chunks.length) parts.push('No passages retrieved.');
      for (const c of policy.chunks) {
        parts.push(`[${c.label}] ${chunkLabel(c)} (${c.docType}, ${c.issuer})\n"${c.chunkText}"`);
      }
    }
    return parts.join('\n\n');
  }

  // ---- confidence
  static assess(data: DataEvidence | null, policy: PolicyEvidence | null, answer: string): Confidence {
    const order: Record<ConfidenceLevel, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };
    const levels: ConfidenceLevel[] = [];
    const reasons: string[] = [];
    if (data) {
      if (data.error) { levels.push('LOW'); reasons.push(`Data: ${data.error}`); }
      else if (data.rowCount === 0) { levels.push('LOW'); reasons.push('Data: query returned 0 rows - nothing to base the answer on.'); }
      else if (data.verifiedQueryUsed) { levels.push('HIGH'); reasons.push(`Data: ${data.rowCount} rows from a verified (pre-approved) query.`); }
      else { levels.push('MEDIUM'); reasons.push(`Data: ${data.rowCount} rows; SQL was generated, not a verified query - review the SQL.`); }
    }
    if (policy) {
      if (policy.error || !policy.chunks.length) {
        levels.push('LOW'); reasons.push('Policy: no supporting passages retrieved.');
      } else {
        const cos = policy.chunks[0].score;
        const cov = Math.max(...policy.chunks.map((c) => c.lexicalCoverage ?? 0));
        const pct = `${Math.round(cov * 100)}%`;
        if (cos !== null && cos !== undefined && cos < config.SEARCH_MIN_COSINE) {
          levels.push('LOW'); reasons.push(`Policy: weak retrieval match (similarity ${cos.toFixed(2)}).`);
        } else if (cov < config.LEXICAL_LOW) {
          levels.push('LOW'); reasons.push(`Policy: retrieved passages barely overlap the question (coverage ${pct}).`);
        } else if (cov < config.LEXICAL_MEDIUM) {
          levels.push('MEDIUM'); reasons.push(`Policy: partial match between question and passages (coverage ${pct}).`);
        } else {
          levels.push('HIGH'); reasons.push(`Policy: ${policy.chunks.length} relevant passages (best coverage ${pct}).`);
        }
      }
    }
    const cited = new Set(citationsIn(answer));
    const valid = new Set<string>([...(data ? ['D1'] : []), ...(policy?.chunks ?? []).map((c) => c.label)]);
    const bogus = [...cited].filter((c) => !valid.has(c)).sort();
    if (bogus.length) { levels.push('LOW'); reasons.push(`Answer cites evidence that does not exist: ${bogus.join(', ')}.`); }
    if (valid.size && !cited.size) { levels.push('LOW'); reasons.push('Answer is not tied to any citation.'); }
    const level = levels.length ? levels.reduce((a, b) => (order[b] < order[a] ? b : a)) : 'LOW';
    return { level, reasons };
  }

  // ---- full question flow
  async ask(question: string, user: string, onStep?: StepListener): Promise<AskResult> {
    const t0 = Date.now();
    const steps = new Map<StepKey, PipelineStep>();
    const started = new Map<StepKey, number>();
    const emit = (s: PipelineStep): void => {
      steps.set(s.key, s);
      try { onStep?.({ ...s }); } catch { /* listener errors never break the pipeline */ }
    };
    const start = (key: StepKey): void => { started.set(key, Date.now()); emit({ key, label: STEP_LABELS[key], status: 'running', ms: 0 }); };
    const finish = (key: StepKey, status: PipelineStep['status'], detail?: string): void =>
      emit({ key, label: STEP_LABELS[key], status, ms: Date.now() - (started.get(key) ?? Date.now()), ...(detail ? { detail } : {}) });
    const skip = (key: StepKey, detail: string): void => emit({ key, label: STEP_LABELS[key], status: 'skipped', ms: 0, detail });

    start('route');
    const r = await this.route(question);
    const why = { DATA: 'needs records', POLICY: 'needs policy text', BOTH: 'needs records and policy' }[r.route];
    finish('route', 'done', `${r.route} - ${why}${r.router === 'heuristic' ? ' (keyword router)' : ''}`);

    const wantData = r.route === 'DATA' || r.route === 'BOTH';
    const wantPolicy = r.route === 'POLICY' || r.route === 'BOTH';
    if (wantData) start('analyst'); else skip('analyst', 'not needed for a POLICY question');
    if (wantPolicy) start('search'); else skip('search', 'not needed for a DATA question');
    const [data, policy] = await Promise.all([
      wantData
        ? this.gatherData(r.dataQuestion || question).then((d) => {
          finish('analyst', d.error ? 'error' : 'done', d.error
            ? d.error.slice(0, 140)
            : `${d.rowCount} row${d.rowCount === 1 ? '' : 's'} · ${d.verifiedQueryUsed ? 'verified query' : 'generated SQL'}`);
          return d;
        })
        : Promise.resolve(null),
      wantPolicy
        ? this.gatherPolicy(r.policyQueries.length ? r.policyQueries : [question]).then((p) => {
          finish('search', p.error ? 'error' : 'done', p.error
            ? p.error.slice(0, 140)
            : `${p.chunks.length} clause${p.chunks.length === 1 ? '' : 's'} · ${p.queries.length} quer${p.queries.length === 1 ? 'y' : 'ies'}`);
          return p;
        })
        : Promise.resolve(null),
    ]);

    start('synthesis');
    const evidence = KavachOrchestrator.evidenceBlock(data, policy);
    let { text: answer, model } = await this.llm(prompts.fill(prompts.SYNTHESIS, { question, evidence }));
    if (!answer) {
      answer = fallbackAnswer(question, data, policy);
      model = 'deterministic-fallback';
      finish('synthesis', 'done', 'deterministic fallback (LLM unavailable)');
    } else {
      finish('synthesis', 'done', model ?? undefined);
    }
    answer = answer.trim();
    const confidence = KavachOrchestrator.assess(data, policy, answer);

    const result: AskResult = {
      id: randomUUID(), question, route: r.route, routeReason: r.reason, data, policy, answer,
      citationsUsed: citationsIn(answer), confidence, model: model ?? 'unknown', latencyMs: 0,
      createdAtUtc: utcStamp(), audit: null as unknown as AuditReceipt, steps: [],
    };
    start('audit');
    result.latencyMs = Date.now() - t0;
    try {
      result.audit = await this.backend.logEvent('QUESTION_ANSWERED', user, KavachOrchestrator.auditPayload(result));
    } catch (e) {
      finish('audit', 'error', (e as Error).message.slice(0, 140));
      throw e;
    }
    finish('audit', 'done', `#${result.audit.auditSeq} · ${result.audit.rowHash.slice(0, 12)}…`);
    result.latencyMs = Date.now() - t0;
    result.steps = STEP_ORDER.map((k) => steps.get(k)!).filter(Boolean);
    this.remember(result);
    return result;
  }

  private remember(result: AskResult): void {
    this.results.set(result.id, result);
    while (this.results.size > config.RESULT_CACHE_SIZE) {
      const oldest = this.results.keys().next().value as string;
      this.results.delete(oldest);
    }
  }

  getResult(id: string): AskResult | undefined {
    return this.results.get(id);
  }

  static auditPayload(res: AskResult): Record<string, unknown> {
    const d = res.data;
    const p = res.policy;
    return {
      question: res.question, route: res.route, route_reason: res.routeReason,
      data: d === null ? null : {
        analyst_question: d.question, sql: d.sql, row_count: d.rowCount, truncated: d.truncated,
        verified_query_used: d.verifiedQueryUsed, error: d.error, analyst_text: d.analystText,
        sample_rows: d.rows.slice(0, 10),
      },
      policy: p === null ? null : {
        query: p.queries.join(' | '), error: p.error,
        sources: p.chunks.map((c) => ({
          label: c.label, chunk_id: c.chunkId, doc_title: c.docTitle, section_id: c.sectionId, section_title: c.sectionTitle,
          source_ref: c.sourceRef, score: c.score, lexical_coverage: c.lexicalCoverage,
        })),
      },
      answer: res.answer, citations_used: res.citationsUsed,
      confidence: { level: res.confidence.level, reasons: res.confidence.reasons },
      model: res.model, latency_ms: res.latencyMs, app_version: config.APP_VERSION,
    };
  }

  // ---- Generate Finding
  async generateFinding(res: AskResult, findingType: FindingType, user: string): Promise<Finding> {
    const label = config.FINDING_TYPES[findingType];
    const sections = prompts.FINDING_SECTIONS[findingType];
    const evidence = KavachOrchestrator.evidenceBlock(res.data, res.policy);
    let { text: narrative, model } = await this.llm(prompts.fill(prompts.FINDING, {
      finding_label: label, sections: sections.map((s) => `### ${s}`).join('\n'),
      extra: prompts.FINDING_EXTRA[findingType] ?? '', question: res.question, answer: res.answer, evidence,
    }));
    if (!narrative) {
      model = 'deterministic-fallback';
      narrative = KavachOrchestrator.fallbackNarrative(res.answer, sections);
    }
    const now = new Date();
    const stamp = utcStamp(now);
    const findingId = `KVF-${stamp.slice(0, 10).replace(/-/g, '')}-${randomBytes(3).toString('hex').toUpperCase()}`;
    const title = res.question.length <= 90 ? res.question : `${res.question.slice(0, 87)}…`;
    const src = res.audit;
    const header = [
      `# ${label}: ${title}`, '',
      '| Field | Value |', '|---|---|',
      `| Finding ID | \`${findingId}\` |`,
      '| Status | **DRAFT - pending human review** |',
      `| Prepared by | Kavach copilot, on behalf of \`${user}\` |`,
      `| Generated (UTC) | ${stamp} |`,
      `| Source audit record | #${src?.auditSeq ?? '?'} · hash \`${String(src?.rowHash ?? '').slice(0, 16)}…\` |`,
      `| Evidence confidence | ${res.confidence.level} - ${res.confidence.reasons.join('; ').replace(/\|/g, '/')} |`,
      `| Model | ${model} |`, '',
      '> Draft generated by Kavach strictly from the cited evidence in the appendix. '
        + 'It must be reviewed, corrected where needed and signed off by an authorised officer before use.', '',
    ].join('\n');
    const appendix = ['', '---', '## Evidence appendix'];
    if (res.data) {
      const d = res.data;
      appendix.push('### [D1] Data evidence (Cortex Analyst)',
        `- Question sent to Cortex Analyst: _${d.question}_`,
        `- Verified query used: **${d.verifiedQueryUsed ? 'yes' : 'no'}**`,
        `- Rows returned: **${d.rowCount}**${d.truncated ? ' (truncated)' : ''}`);
      if (d.error) appendix.push(`- Error: ${d.error}`);
      if (d.sql) appendix.push('', '```sql', d.sql, '```');
      if (d.columns.length) appendix.push('', rowsToMarkdown(d.columns, d.rows, config.FINDING_ROWS, d.rowCount));
    }
    if (res.policy) {
      appendix.push('### Policy and regulatory citations (Cortex Search)');
      for (const c of res.policy.chunks) {
        appendix.push(`- **[${c.label}] ${chunkLabel(c)}** - _${c.issuer}_, ${c.version} (${c.sourceRef})\n  > ${c.chunkText}`);
        if (c.disclaimer) appendix.push(`  <sub>${c.disclaimer}</sub>`);
      }
    }
    appendix.push('', '## Reviewer sign-off', '| Reviewer | Decision | Date | Comments |', '|---|---|---|---|', '|  |  |  |  |');
    const markdown = `${header}\n${narrative.trim()}\n${appendix.join('\n')}\n`;
    const payload = {
      finding_id: findingId, finding_type: findingType, title,
      source_audit_seq: src?.auditSeq ?? null, source_row_hash: src?.rowHash ?? null,
      question: res.question, confidence: { level: res.confidence.level, reasons: res.confidence.reasons },
      model, finding_markdown: markdown,
    };
    const audit = await this.backend.logEvent('FINDING_GENERATED', user, payload);
    const finding: Finding = {
      findingId, findingType, label, title, markdown, audit, createdBy: user, status: 'PENDING_REVIEW',
      sourceAuditSeq: src?.auditSeq ?? 0,
    };
    this.findingsById.set(findingId, { finding, createdBy: user });
    return finding;
  }

  /** Offline finding narrative: map the answer's sections onto the template headings. */
  static fallbackNarrative(answer: string, sections: string[]): string {
    const parts = answerSections(answer);
    const body = (s: string, i: number): string => {
      if (i === 0) return parts.answer || answer;
      const srcKey = FINDING_SECTION_SOURCE[s];
      const text = srcKey ? parts[SOURCE_KEYS[srcKey]] : undefined;
      return text ? `${text}\n\n_Carried over from the cited answer - reviewer to confirm._` : 'Not established - reviewer to complete.';
    };
    return sections.map((s, i) => `### ${s}\n${body(s, i)}`).join('\n\n');
  }

  // ---- maker-checker review
  async reviewFinding(findingId: string, decision: ReviewDecision, comment: string, user: string): Promise<AuditReceipt> {
    let createdBy = this.findingsById.get(findingId)?.createdBy;
    if (!createdBy) createdBy = (await this.backend.findings()).find((f) => f.findingId === findingId)?.createdBy;
    if (!createdBy) throw new NotFoundException(`Unknown finding ${findingId}`);
    const payload = {
      finding_id: findingId, decision, comment, maker_checker_ok: user !== createdBy,
      title: `Review of ${findingId}: ${decision}`,
    };
    const receipt = await this.backend.logEvent('FINDING_REVIEWED', user, payload);
    const stored = this.findingsById.get(findingId);
    if (stored) stored.finding.status = decision;
    return receipt;
  }
}
