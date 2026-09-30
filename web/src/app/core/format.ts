/** ₹ in lakh / crore, the way Indian credit teams read exposure. */
export function inr(value: unknown, digits = 2): string {
  const x = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(x)) return '—';
  if (Math.abs(x) >= 1e7) return `₹${(x / 1e7).toFixed(digits)} Cr`;
  if (Math.abs(x) >= 1e5) return `₹${(x / 1e5).toFixed(digits)} L`;
  return `₹${x.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}

export function inrFull(value: unknown): string {
  const x = Number(value);
  return Number.isFinite(x) ? `₹${x.toLocaleString('en-IN', { maximumFractionDigits: 0 })}` : '—';
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '';
  const t = new Date(iso.includes('T') || iso.endsWith('Z') ? iso : iso.replace(' ', 'T') + 'Z').getTime();
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

const MONEY = /(AMOUNT|EXPOSURE|PRINCIPAL|INCOME|CREDIT$|FLAGGED)/;

/** Format a result-table cell by column name. */
export function cell(col: string, v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'number') {
    if (MONEY.test(col)) return inrFull(v);
    if (col.endsWith('_PCT')) return `${v.toFixed(2)}%`;
    if (col.includes('RATIO')) return v.toFixed(2);
    return Number.isInteger(v) ? v.toLocaleString('en-IN') : v.toFixed(2);
  }
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) return s.slice(0, 16).replace('T', ' ');
  return s;
}

export function isNumericCol(rows: Record<string, unknown>[], col: string): boolean {
  return rows.length > 0 && typeof rows[0][col] === 'number';
}

export function humanize(col: string): string {
  return col.toLowerCase().replace(/_/g, ' ');
}
