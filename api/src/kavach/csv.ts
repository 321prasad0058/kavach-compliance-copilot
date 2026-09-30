/** Minimal RFC 4180 CSV parser: quoted fields, embedded commas/newlines, "" escapes, CRLF or LF. No dependencies. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const n = text.length;
  if (text.charCodeAt(0) === 0xfeff) i = 1; // BOM

  while (i < n) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"' && field === '') { inQuotes = true; i++; continue; }
    if (ch === ',') { row.push(field); field = ''; i++; continue; }
    if (ch === '\r') { i++; continue; }
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += ch; i++;
  }
  if (inQuotes) throw new Error('CSV parse error: unterminated quoted field');
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/** Parse CSV text with a header row into objects keyed by header name. */
export function parseCsvRecords(text: string): Record<string, string>[] {
  const [header, ...body] = parseCsv(text);
  if (!header) return [];
  return body
    .filter((r) => !(r.length === 1 && r[0] === ''))
    .map((r) => Object.fromEntries(header.map((h, j) => [h, r[j] ?? ''])));
}
