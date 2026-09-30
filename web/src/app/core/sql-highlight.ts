const KW = new Set(
  (
    'select from where and or not in is null as on join left right inner outer full cross group by order having ' +
    'limit with union all distinct case when then else end asc desc between like ilike exists over partition ' +
    'qualify row_number sum count count_if avg min max round iff coalesce nullif dateadd datediff current_date ' +
    'current_timestamp listagg true false interval day month week year'
  ).split(' '),
);

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Tiny, dependency-free SQL highlighter that returns escaped HTML. */
export function highlightSql(sql: string): string {
  const re = /(--[^\n]*)|('(?:[^']|'')*')|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][A-Za-z0-9_$.]*)|(\s+)|([^\sA-Za-z0-9_'])/g;
  let out = '';
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql))) {
    const [tok, com, str, num, word] = m;
    if (com) out += `<span class="c">${esc(com)}</span>`;
    else if (str) out += `<span class="s">${esc(str)}</span>`;
    else if (num) out += `<span class="n">${num}</span>`;
    else if (word) {
      const lower = word.toLowerCase();
      if (KW.has(lower)) out += `<span class="k">${esc(word)}</span>`;
      else if (word.includes('.')) out += `<span class="t">${esc(word)}</span>`;
      else out += esc(word);
    } else out += esc(tok);
  }
  return out;
}
