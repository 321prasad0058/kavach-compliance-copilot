/**
 * Kavach HTTP contract, shared by the NestJS API and the Angular web app.
 * The web app keeps an identical copy at web/src/app/core/contract.ts - change both together.
 *
 * All endpoints are served under /api. The caller's identity is resolved from
 * `Sf-Context-Current-User` (injected by Snowpark Container Services ingress) or,
 * outside SPCS, the `X-Kavach-User` header sent by the web app's persona switcher.
 */

export type Route = 'DATA' | 'POLICY' | 'BOTH';
export type ConfidenceLevel = 'HIGH' | 'MEDIUM' | 'LOW';
export type FindingType = 'CASE_NOTE' | 'EXCEPTION_REPORT' | 'STR_DRAFT';
export type ReviewDecision = 'APPROVED' | 'NEEDS_CHANGES' | 'REJECTED';
export type StepKey = 'route' | 'analyst' | 'search' | 'synthesis' | 'audit';

/** GET /api/meta */
export interface Meta {
  version: string;
  mode: string;                                   // "Snowflake · SPCS", "Snowflake · PAT", "Offline mock"
  user: string;
  models: string[];
  semanticModel: string;
  searchService: string;
  demoQuestions: { label: string; question: string; hint: string }[];
  findingTypes: Record<FindingType, string>;
}

/** GET /api/kpis */
export interface Kpis {
  openAlerts: number;
  highSeverityOpen: number;
  totalExposure: number;
  npaExposure: number;
  sma2Accounts: number;
  highRiskKycOverdue: number;
}

export interface DataEvidence {
  question: string;                 // question actually sent to Cortex Analyst
  analystText: string;
  sql: string | null;
  verifiedQueryUsed: boolean;
  columns: string[];                // UPPERCASE, in result order
  rows: Record<string, string | number | boolean | null>[];   // at most 500 rows returned to the UI
  rowCount: number;                 // true row count (<= MAX_RESULT_ROWS)
  truncated: boolean;
  error: string | null;
  suggestions: string[];
}

export interface PolicyChunk {
  label: string;                    // "P1".."Pn" - the citation tag used in the answer
  chunkId: string;
  docId: string;
  docTitle: string;
  docType: string;                  // REGULATION / INTERNAL_POLICY / SOP / AUDIT_FINDING / TEMPLATE
  issuer: string;
  version: string;
  sourceRef: string;
  sectionId: string;
  sectionTitle: string;
  sectionPath: string;
  chunkText: string;
  disclaimer: string;
  score: number | null;             // Cortex Search cosine similarity when available
  lexicalCoverage: number;          // 0..1 share of query terms present in the clause
}

export interface PolicyEvidence {
  queries: string[];                // (expanded) sub-queries sent to Cortex Search
  chunks: PolicyChunk[];
  error: string | null;
}

export interface Confidence {
  level: ConfidenceLevel;
  reasons: string[];
}

export interface AuditReceipt {
  auditSeq: number;
  eventId: string;
  rowHash: string;
  prevHash: string;
  eventTsUtc: string;               // "YYYY-MM-DD HH:MM:SS"
}

export interface PipelineStep {
  key: StepKey;
  label: string;                    // e.g. "Cortex Analyst · governed SQL"
  status: 'running' | 'done' | 'skipped' | 'error';
  ms: number;
  detail?: string;                  // e.g. "BOTH - needs records and policy", "3 rows · verified query"
}

/** POST /api/ask {question} -> AskResult. GET /api/ask/stream?q=... emits SSE `AskEvent`s. */
export interface AskResult {
  id: string;                       // server-side id used to generate findings
  question: string;
  route: Route;
  routeReason: string;
  data: DataEvidence | null;
  policy: PolicyEvidence | null;
  answer: string;                   // Markdown with [D1] / [P1].. citation tags
  citationsUsed: string[];
  confidence: Confidence;
  model: string;
  latencyMs: number;
  createdAtUtc: string;
  audit: AuditReceipt;
  steps: PipelineStep[];
}

export type AskEvent =
  | { type: 'step'; step: PipelineStep }
  | { type: 'result'; result: AskResult }
  | { type: 'error'; message: string };

/** POST /api/findings {resultId, findingType} -> Finding */
export interface Finding {
  findingId: string;                // KVF-YYYYMMDD-XXXXXX
  findingType: FindingType;
  label: string;
  title: string;
  markdown: string;
  audit: AuditReceipt;
  createdBy: string;
  status: 'PENDING_REVIEW' | ReviewDecision;
  sourceAuditSeq: number;
}

/** GET /api/findings */
export interface FindingRow {
  findingId: string;
  createdAtUtc: string;
  createdBy: string;
  findingType: FindingType;
  title: string;
  confidence: ConfidenceLevel;
  status: 'PENDING_REVIEW' | ReviewDecision;
  reviewer: string | null;
  reviewedAtUtc: string | null;
  reviewComment: string | null;
  makerCheckerOk: boolean;
  findingMarkdown: string;
}

/** POST /api/findings/:id/review {decision, comment} -> AuditReceipt */
export interface ReviewRequest {
  decision: ReviewDecision;
  comment: string;
}

/** GET /api/alerts?limit=25 */
export interface Alert {
  alertId: string;
  createdAt: string;                // ISO
  ruleTriggered: string;
  severity: 'LOW' | 'MEDIUM' | 'HIGH';
  status: string;
  accountId: string;
  businessName: string | null;
  alertAmount: number;
  assignedTo: string;
  analystNotes: string | null;
}

/** GET /api/alerts/by-rule */
export interface AlertsByRule {
  ruleTriggered: string;
  severity: 'LOW' | 'MEDIUM' | 'HIGH';
  n: number;
}

/** GET /api/audit?limit=100 */
export interface AuditRow {
  auditSeq: number;
  eventTsUtc: string;
  eventType: string;
  appUser: string;
  route: string | null;
  confidence: string | null;
  rowCount: number | null;
  question: string | null;
  rowHash: string;
  prevHash: string;
  isValid: boolean;
}

/** GET /api/audit/status */
export interface ChainStatus {
  rows: number;
  valid: number;
}
/** GET /api/audit/:seq -> the full JSON payload stored for that event */
