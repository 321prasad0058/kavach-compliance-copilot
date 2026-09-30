/** Read-only SQL guard applied to every Cortex Analyst statement before it is executed. */

/** True only for a single read-only SELECT / WITH statement (comments stripped). */
export function isReadOnlySql(sql: string | null | undefined): boolean {
  let body = (sql ?? '').replace(/--[^\n]*/g, '');
  body = body.replace(/\/\*[\s\S]*?\*\//g, '').trim().replace(/;+\s*$/, '').trim();
  if (body.includes(';')) return false;
  return /^(with|select)\b/i.test(body);
}

/** Trim and drop trailing semicolons. */
export function cleanSql(sql: string | null | undefined): string {
  return (sql ?? '').trim().replace(/;+\s*$/, '').trim();
}
