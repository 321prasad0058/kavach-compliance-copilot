/**
 * Minimal Snowflake SQL API v2 client over fetch: POST /api/v2/statements with `?` bindings, 202 polling,
 * multi-partition results and typed value conversion from resultSetMetaData.rowType.
 */
import { randomUUID } from 'node:crypto';

import type { Cell, Row, Table } from './backend.interface';
import type { SnowflakeAuth } from './snowflake-auth';

export interface RowTypeField {
  name: string;
  type: string;
  scale?: number | null;
  precision?: number | null;
  nullable?: boolean;
}

export interface StatementResponse {
  code?: string;
  message?: string;
  statementHandle?: string;
  statementStatusUrl?: string;
  sqlState?: string;
  resultSetMetaData?: {
    numRows?: number;
    rowType: RowTypeField[];
    partitionInfo?: { rowCount: number; uncompressedSize?: number }[];
  };
  data?: (string | null)[][];
}

export class SnowflakeHttpError extends Error {
  constructor(readonly status: number, message: string, readonly body?: unknown) {
    super(message);
  }
}

// ----------------------------------------------------------------------------- value conversion
const pad = (n: number, w = 2): string => String(Math.trunc(Math.abs(n))).padStart(w, '0');
const epochMs = (v: string): number => Math.round(parseFloat(v) * 1000);
/** ISO string without the trailing "Z" and without ".000". */
const isoLocal = (ms: number): string => new Date(ms).toISOString().replace('Z', '').replace(/\.000$/, '');

/** Convert one SQL API cell (always a string or null on the wire) using its rowType entry. */
export function convertValue(raw: unknown, field: RowTypeField): Cell | Record<string, unknown> | unknown[] {
  if (raw === null || raw === undefined) return null;
  const v = String(raw);
  switch ((field.type || 'text').toLowerCase()) {
    case 'fixed':
    case 'real':
    case 'number':
    case 'float':
      return v === 'inf' ? Infinity : v === '-inf' ? -Infinity : Number(v);
    case 'boolean':
      return typeof raw === 'boolean' ? raw : v.toLowerCase() === 'true' || v === '1';
    case 'date':
      return new Date(Number(v) * 86_400_000).toISOString().slice(0, 10);
    case 'time': {
      const secs = parseFloat(v);
      const h = Math.floor(secs / 3600);
      const m = Math.floor((secs % 3600) / 60);
      const s = secs % 60;
      const frac = Math.round((s % 1) * 1000);
      return `${pad(h)}:${pad(m)}:${pad(Math.floor(s))}${frac ? `.${pad(frac, 3)}` : ''}`;
    }
    case 'timestamp_ntz':
      return isoLocal(epochMs(v.split(' ')[0]));
    case 'timestamp_ltz':
      return new Date(epochMs(v.split(' ')[0])).toISOString();
    case 'timestamp_tz': {
      // "seconds.fraction offset" where offset is minutes + 1440 (e.g. "1700000000.000000000 1770" = +05:30)
      const [secs, off] = v.split(' ');
      const ms = epochMs(secs);
      if (off === undefined) return new Date(ms).toISOString();
      const offsetMin = Number(off) - 1440;
      const sign = offsetMin < 0 ? '-' : '+';
      return `${isoLocal(ms + offsetMin * 60_000)}${sign}${pad(Math.abs(offsetMin) / 60)}:${pad(Math.abs(offsetMin) % 60)}`;
    }
    case 'variant':
    case 'object':
    case 'array':
      try { return JSON.parse(v) as Record<string, unknown>; } catch { return v; }
    default:
      return v;
  }
}

/** Build a Table from rowType + data. Semi-structured values are kept as parsed JSON. */
export function toTable(rowType: RowTypeField[], data: (string | null)[][]): Table {
  const columns = rowType.map((f) => f.name);
  const rows = data.map((r) => {
    const o: Record<string, unknown> = {};
    rowType.forEach((f, i) => { o[f.name] = convertValue(r[i], f); });
    return o as Row;
  });
  return { columns, rows };
}

export type Bind = string | number | boolean | null;

export function toBindings(binds: Bind[]): Record<string, { type: string; value: string | null }> {
  const out: Record<string, { type: string; value: string | null }> = {};
  binds.forEach((b, i) => {
    const type = typeof b === 'number' ? (Number.isInteger(b) ? 'FIXED' : 'REAL') : typeof b === 'boolean' ? 'BOOLEAN' : 'TEXT';
    out[String(i + 1)] = { type, value: b === null ? null : String(b) };
  });
  return out;
}

// ----------------------------------------------------------------------------- client
export interface SqlApiOptions {
  database: string;
  warehouse: string;
  role: string;
  timeoutS: number;
  fetchImpl?: typeof fetch;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class SqlApiClient {
  private readonly fetchImpl: typeof fetch;

  constructor(readonly auth: SnowflakeAuth, private readonly opts: SqlApiOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** Authenticated JSON request against https://<host><path>. Retries 429/503 twice. */
  async request<T = unknown>(method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs = this.opts.timeoutS * 1000 + 15_000): Promise<{ status: number; json: T }> {
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetchImpl(`https://${this.auth.host}${path}`, {
        method,
        headers: await this.auth.headers(),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      let json: unknown = {};
      try { json = text ? JSON.parse(text) : {}; } catch { json = { message: text }; }
      if ((res.status === 429 || res.status === 503) && attempt < 2) {
        await sleep(500 * 2 ** attempt);
        continue;
      }
      if (res.status >= 400) {
        const msg = (json as { message?: string }).message ?? text.slice(0, 300);
        throw new SnowflakeHttpError(res.status, `Snowflake HTTP ${res.status}: ${msg}`, json);
      }
      return { status: res.status, json: json as T };
    }
  }

  /** Execute one statement and return every partition as a Table. */
  async execute(statement: string, binds: Bind[] = [], timeoutS = this.opts.timeoutS): Promise<Table> {
    const body: Record<string, unknown> = {
      statement, timeout: timeoutS, database: this.opts.database, warehouse: this.opts.warehouse, role: this.opts.role,
    };
    if (binds.length) body.bindings = toBindings(binds);
    let { status, json } = await this.request<StatementResponse>('POST', `/api/v2/statements?requestId=${randomUUID()}`, body);
    const deadline = Date.now() + timeoutS * 1000 + 30_000;
    let wait = 250;
    while (status === 202) {
      if (Date.now() > deadline) throw new Error(`Statement ${json.statementHandle} did not finish in ${timeoutS}s`);
      await sleep(wait);
      wait = Math.min(wait * 2, 2000);
      const url = json.statementStatusUrl ?? `/api/v2/statements/${json.statementHandle}`;
      ({ status, json } = await this.request<StatementResponse>('GET', url));
    }
    const meta = json.resultSetMetaData;
    if (!meta) return { columns: [], rows: [] };
    const data = [...(json.data ?? [])];
    const partitions = meta.partitionInfo?.length ?? 1;
    for (let p = 1; p < partitions; p++) {
      const part = await this.request<StatementResponse>('GET', `/api/v2/statements/${json.statementHandle}?partition=${p}`);
      data.push(...(part.json.data ?? []));
    }
    return toTable(meta.rowType, data);
  }
}
