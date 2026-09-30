/**
 * Central configuration. Every value can be overridden with the environment variable noted next to it.
 * Mirrors the original app/kavach/config.py.
 */
import * as path from 'node:path';
import type { FindingType } from './contract';

const env = (name: string, fallback: string): string => {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
};
const envNum = (name: string, fallback: number): number => {
  const n = Number(env(name, String(fallback)));
  return Number.isFinite(n) ? n : fallback;
};

export const APP_VERSION = '0.1.0';

/** Repository root (…/kavach). Works from both api/src/kavach and api/dist/kavach. */
export const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

export const DATABASE = env('KAVACH_DATABASE', 'KAVACH');
export const CORE_SCHEMA = `${DATABASE}.CORE`;
export const GOV_SCHEMA = `${DATABASE}.GOV`;
export const KNOWLEDGE_SCHEMA = `${DATABASE}.KNOWLEDGE`;

export const SEMANTIC_MODEL_FILE = env('KAVACH_SEMANTIC_MODEL', `@${DATABASE}.APP.SEMANTIC_MODELS/kavach.yaml`);
export const SEARCH_SERVICE_DB = DATABASE;
export const SEARCH_SERVICE_SCHEMA = 'KNOWLEDGE';
export const SEARCH_SERVICE_NAME = 'POLICY_SEARCH';
export const SEARCH_SERVICE_FQN = `${SEARCH_SERVICE_DB}.${SEARCH_SERVICE_SCHEMA}.${SEARCH_SERVICE_NAME}`;
export const SEARCH_COLUMNS = [
  'chunk_id', 'doc_id', 'doc_title', 'doc_type', 'issuer', 'version', 'source_ref',
  'section_id', 'section_title', 'section_path', 'chunk_text', 'disclaimer',
];
export const SEARCH_LIMIT = envNum('KAVACH_SEARCH_LIMIT', 6);

/** Tried in order; the first model available in the account's region wins and is cached. */
export const LLM_MODELS = env('KAVACH_LLM_MODELS', 'claude-sonnet-4-5,llama3.1-70b')
  .split(',').map((m) => m.trim()).filter(Boolean);
export const LLM_TEMPERATURE = 0;
export const LLM_MAX_TOKENS = 4096;

export const MAX_RESULT_ROWS = 5000; // rows fetched from Analyst SQL
export const UI_ROWS = 500;          // rows returned to the web app
export const PROMPT_ROWS = 25;       // rows shown to the LLM
export const FINDING_ROWS = 20;      // rows embedded in a finding's evidence appendix
export const RESULT_CACHE_SIZE = 200;

// Confidence thresholds
export const SEARCH_MIN_COSINE = envNum('KAVACH_SEARCH_MIN_COSINE', 0.35);
export const LEXICAL_LOW = 0.25;
export const LEXICAL_MEDIUM = 0.45;

// Backend selection: auto | snowflake | mock
export const BACKEND = env('KAVACH_BACKEND', 'auto').toLowerCase();

// Snowflake connection (REST)
export const SNOWFLAKE_WAREHOUSE = env('SNOWFLAKE_WAREHOUSE', 'KAVACH_WH');
export const SNOWFLAKE_ROLE = env('SNOWFLAKE_ROLE', 'KAVACH_APP');
export const SQL_TIMEOUT_S = envNum('KAVACH_SQL_TIMEOUT_S', 60);
export const SPCS_TOKEN_PATH = env('SNOWFLAKE_SPCS_TOKEN_PATH', '/snowflake/session/token');

// Offline mock inputs
export const DATA_DIR = path.resolve(env('KAVACH_DATA_DIR', path.join(REPO_ROOT, 'data', 'out')));
export const SEMANTIC_MODEL_PATH = path.resolve(env('KAVACH_SEMANTIC_MODEL_PATH', path.join(REPO_ROOT, 'semantic_model', 'kavach.yaml')));

export const MOCK_LATENCY_MS = envNum('KAVACH_MOCK_LATENCY_MS', 0);

export const DEFAULT_USER = 'demo.analyst';
export const MAX_QUESTION_CHARS = 2000;

export interface DemoQuestion { label: string; question: string; hint: string }

export const DEMO_QUESTIONS: DemoQuestion[] = [
  {
    label: '1 · Early delinquency',
    question: "Which accounts disbursed in the last 6 months now show DPD over 60, and what's our total exposure there?",
    hint: 'DATA route · Cortex Analyst answers from a verified query over loan accounts',
  },
  {
    label: '2 · Structuring + AML policy',
    question: 'Show me accounts flagged for structuring this week, and what does our AML policy require us to do about them?',
    hint: 'BOTH routes · flagged accounts from governed SQL, obligations from the AML SOP and RBI KYC direction',
  },
  {
    label: '3 · Income mismatch (NTC)',
    question: 'Which disbursements to first-time borrowers in the last 30 days show a mismatch between declared income and bank statement credits?',
    hint: 'DATA route · surfaces two mismatches the rules engine did not alert on',
  },
  {
    label: '4 · SBR governance (RAG only)',
    question: 'Under Scale Based Regulation, what governance and disclosure requirements apply to a non-deposit taking NBFC with assets of Rs 1,500 crore?',
    hint: 'POLICY route · multi-query retrieval over RBI Scale Based Regulation (layer, governance, disclosures)',
  },
];

export const FINDING_TYPES: Record<FindingType, string> = {
  CASE_NOTE: 'Case note',
  EXCEPTION_REPORT: 'Exception report',
  STR_DRAFT: 'STR draft extract (for Principal Officer)',
};

/**
 * Governed query-expansion glossary: applied to every Cortex Search query so domain shorthand
 * retrieves the clauses compliance staff mean by it. Review and extend like any other policy artefact.
 */
export const GLOSSARY: Record<string, string> = {
  structuring: 'structuring smurfing split cash deposits wallet top-ups below threshold escalation Principal Officer STR',
  aml: 'anti-money laundering PMLA transaction monitoring suspicious transaction report',
  str: 'suspicious transaction report FIU-IND seven working days tipping-off',
  'scale based': 'Base Middle Upper layer classification asset size',
  governance: 'Chief Compliance Officer compliance function Risk Management Committee board-approved policies ICAAP',
  disclosure: 'disclosures in annual financial statements corporate governance report',
  dpd: 'early delinquency early warning signal red flagged account SMA',
  delinquen: 'early delinquency trigger early warning signal red flagged account sourcing partner',
  income: 'income corroboration ratio bank statement declared income variance thresholds new-to-credit',
  kyc: 'periodic updation risk categorisation customer due diligence',
  pep: 'politically exposed persons enhanced due diligence senior management approval',
  fraud: 'fraud risk management red flagged account show-cause notice reporting to RBI',
};
