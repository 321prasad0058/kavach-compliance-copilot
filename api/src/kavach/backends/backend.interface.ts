import type {
  Alert, AlertsByRule, AuditReceipt, AuditRow, ChainStatus, FindingRow, Kpis,
} from '../contract';

export type Cell = string | number | boolean | null;
export type Row = Record<string, Cell>;

/** A tabular result. Column names are UPPERCASE (as Snowflake returns them). */
export interface Table {
  columns: string[];
  rows: Row[];
}

export interface AnalystResponse {
  text: string;
  sql: string | null;
  verifiedQueryUsed: boolean;
  suggestions: string[];
  requestId?: string | null;
  error?: string | null;
}

/** A Cortex Search hit, before the orchestrator assigns its citation label and lexical coverage. */
export interface SearchHit {
  chunkId: string;
  docId: string;
  docTitle: string;
  docType: string;
  issuer: string;
  version: string;
  sourceRef: string;
  sectionId: string;
  sectionTitle: string;
  sectionPath: string;
  chunkText: string;
  disclaimer: string;
  score: number | null;
}

export interface CompletionResult {
  text: string | null;
  model: string | null;
}

export type JsonObject = Record<string, unknown>;

/** Everything the orchestrator and controller need from a data platform. */
export interface KavachBackend {
  /** Human-readable mode for /api/meta, e.g. "Snowflake · PAT" or "Offline mock". */
  readonly mode: string;
  readonly isMock: boolean;

  /** Cortex COMPLETE. Returns {text: null} when no LLM is available (callers fall back deterministically). */
  complete(prompt: string): Promise<CompletionResult>;
  /** Cortex Analyst: natural language -> governed SQL. */
  analyst(question: string): Promise<AnalystResponse>;
  /** Run an already-guarded read-only SELECT, returning at most `limit` rows. */
  runSql(sql: string, limit: number): Promise<Table>;
  /** Cortex Search over the policy corpus. */
  search(query: string, limit: number): Promise<SearchHit[]>;

  /** Append to the hash-chained audit log (KAVACH.GOV.LOG_EVENT). */
  logEvent(eventType: string, user: string, payload: JsonObject): Promise<AuditReceipt>;

  kpis(): Promise<Kpis>;
  alertQueue(limit: number): Promise<Alert[]>;
  alertsByRule(): Promise<AlertsByRule[]>;
  auditLog(limit: number): Promise<AuditRow[]>;
  chainStatus(): Promise<ChainStatus>;
  auditPayload(auditSeq: number): Promise<JsonObject | null>;
  findings(): Promise<FindingRow[]>;
}

export const KAVACH_BACKEND = Symbol('KAVACH_BACKEND');
