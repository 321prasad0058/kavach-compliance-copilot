/** Small text utilities shared by the orchestrator and the offline mock (tokenising, stemming, formatting). */
import type { Cell, Row } from './backends/backend.interface';

export const STOPWORDS = new Set(`a an the and or of to in on for with by at from is are was were be been what which who how
does do did our we us me show tell give list any all there their this that these those under about as it its
into than then them they have has had can could should would must may might last days day week month months
now also only just over below above more less`.split(/\s+/).filter(Boolean));

/** Lower-cased alphanumeric tokens, stopwords and tokens of <= 2 chars removed (as in the Python reference). */
export function terms(text: string | null | undefined): string[] {
  const out: string[] = [];
  for (const t of (text ?? '').toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    if (t.length > 2 && !STOPWORDS.has(t)) out.push(t);
  }
  return out;
}

/**
 * Light suffix stemmer (a pragmatic subset of Porter step 1/2) so "structured", "structuring" and
 * "structure" collide, as do "deposits"/"deposit" and "requires"/"required"/"requirements".
 */
const SUFFIXES = [
  'ational', 'ations', 'ation', 'ments', 'ment', 'ities', 'ity', 'ances', 'ance', 'ences', 'ence',
  'ings', 'ing', 'ies', 'ied', 'ers', 'ed', 'es', 'er', 's', 'e',
];
export function stem(token: string): string {
  let t = token;
  if (/^\d+$/.test(t) || t.length <= 3) return t;
  for (const suf of SUFFIXES) {
    if (t.endsWith(suf) && t.length - suf.length >= (suf === 's' ? 3 : 4)) {
      if (suf === 's' && (t.endsWith('ss') || t.endsWith('us') || t.endsWith('is'))) continue;
      t = t.slice(0, -suf.length);
      if (suf === 'ies' || suf === 'ied') t += 'y';
      break;
    }
  }
  // second pass for chains like "requirements" -> "requirement" -> "require" -> "requir"
  for (const suf of ['ment', 'e']) {
    if (t.endsWith(suf) && t.length - suf.length >= 4) { t = t.slice(0, -suf.length); break; }
  }
  return t;
}

export function stemmedTerms(text: string | null | undefined): string[] {
  return terms(text).map(stem);
}

/** Share of query terms present in the text; 5-char prefix match as light stemming (same as the Python). */
export function lexicalCoverage(query: string, text: string): number {
  const q = new Set(terms(query));
  if (q.size === 0) return 0;
  const body = new Set(terms(text));
  const prefixes = new Set([...body].map((b) => b.slice(0, 5)));
  let hits = 0;
  for (const t of q) if (body.has(t) || prefixes.has(t.slice(0, 5))) hits++;
  return hits / q.size;
}

export const round2 = (n: number): number => Math.round(n * 100) / 100;

const INR = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const INR2 = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 });

/** "Rs 1,23,45,678" (Indian digit grouping, no decimals). */
export function rupees(n: number): string {
  return `Rs ${INR.format(Math.round(n))}`;
}

const MONEY_COL = /(AMOUNT|EXPOSURE|PRINCIPAL|INCOME|CREDIT|FLAGGED)$/;
export const isMoneyColumn = (col: string): boolean => MONEY_COL.test(col.toUpperCase());

/** Human formatting of one cell for Markdown tables and prose. */
export function formatCell(v: Cell | undefined, col = ''): string {
  if (v === null || v === undefined || v === '') return '-';
  if (typeof v === 'number') {
    if (isMoneyColumn(col)) return INR2.format(v);
    if (Number.isInteger(v)) return Math.abs(v) >= 10000 ? INR.format(v) : String(v);
    return INR2.format(v);
  }
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return String(v).replace(/\|/g, '/').replace(/\s*\n\s*/g, ' ');
}

/** Markdown table of the first `maxRows` rows (Python df_to_markdown). */
export function rowsToMarkdown(columns: string[], rows: Row[], maxRows: number, totalRows = rows.length): string {
  if (!columns.length || !rows.length) return '_No rows._';
  const lines = [`| ${columns.join(' | ')} |`, `|${'---|'.repeat(columns.length)}`];
  for (const r of rows.slice(0, maxRows)) lines.push(`| ${columns.map((c) => formatCell(r[c], c)).join(' | ')} |`);
  if (totalRows > maxRows) lines.push(`\n_Showing ${maxRows} of ${totalRows} rows._`);
  return lines.join('\n');
}

/** CSV (RFC 4180) of the given rows, for the LLM evidence block. */
export function rowsToCsv(columns: string[], rows: Row[]): string {
  const esc = (v: Cell | undefined): string => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.join(','), ...rows.map((r) => columns.map((c) => esc(r[c])).join(','))].join('\n') + '\n';
}

/** Split a clause into sentences on ". " / "; " boundaries, keeping the punctuation. */
export function sentences(text: string): string[] {
  return (text ?? '').split(/(?<=[.;])\s+(?=[A-Z(])/).map((s) => s.trim()).filter(Boolean);
}

/** "YYYY-MM-DD HH:MM:SS" in UTC. */
export function utcStamp(d = new Date()): string {
  return d.toISOString().replace('T', ' ').slice(0, 19);
}
