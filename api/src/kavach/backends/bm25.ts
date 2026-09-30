/**
 * Field-weighted BM25 (BM25F-style) over clause-level policy chunks, used by the offline mock in place of
 * Cortex Search. Section path / title is boosted over the clause body; tokens are lightly stemmed.
 */
import { stemmedTerms } from '../text';
import type { SearchHit } from './backend.interface';

interface FieldSpec { weight: number; b: number }

const FIELDS = {
  path: { weight: 2.5, b: 0.3 } as FieldSpec,  // "3. Governance requirements > 3.2 Chief Compliance Officer ..."
  doc: { weight: 0.6, b: 0.2 } as FieldSpec,   // document title (shared by every clause in the document)
  body: { weight: 1.0, b: 0.75 } as FieldSpec, // clause text
};
type FieldName = keyof typeof FIELDS;
const FIELD_NAMES = Object.keys(FIELDS) as FieldName[];

const K1 = 1.2;
const EXPANSION_WEIGHT = 0.5;

interface IndexedDoc {
  hit: SearchHit;
  tf: Record<FieldName, Map<string, number>>;
  len: Record<FieldName, number>;
}

const countTerms = (tokens: string[]): Map<string, number> => {
  const m = new Map<string, number>();
  for (const t of tokens) m.set(t, (m.get(t) ?? 0) + 1);
  return m;
};

export class Bm25Index {
  private readonly docs: IndexedDoc[];
  private readonly idf = new Map<string, number>();
  private readonly avgLen: Record<FieldName, number>;

  constructor(hits: SearchHit[]) {
    this.docs = hits.map((hit) => {
      const tokens: Record<FieldName, string[]> = {
        path: stemmedTerms(`${hit.sectionPath} ${hit.sectionTitle}`),
        doc: stemmedTerms(hit.docTitle),
        body: stemmedTerms(hit.chunkText),
      };
      return {
        hit,
        tf: { path: countTerms(tokens.path), doc: countTerms(tokens.doc), body: countTerms(tokens.body) },
        len: { path: tokens.path.length, doc: tokens.doc.length, body: tokens.body.length },
      };
    });
    const n = this.docs.length || 1;
    this.avgLen = { path: 0, doc: 0, body: 0 };
    for (const f of FIELD_NAMES) this.avgLen[f] = this.docs.reduce((s, d) => s + d.len[f], 0) / n || 1;
    const df = new Map<string, number>();
    for (const d of this.docs) {
      const seen = new Set<string>();
      for (const f of FIELD_NAMES) for (const t of d.tf[f].keys()) seen.add(t);
      for (const t of seen) df.set(t, (df.get(t) ?? 0) + 1);
    }
    for (const [t, v] of df) this.idf.set(t, Math.log(1 + (n - v + 0.5) / (v + 0.5)));
  }

  /**
   * Query weighting: terms before the glossary expansion "(...)" weigh 1.0, expansion terms 0.5.
   * Repeated query terms get a mild boost (1 + ln qtf).
   */
  private queryWeights(query: string): Map<string, number> {
    const open = query.indexOf(' (');
    const primary = open >= 0 ? query.slice(0, open) : query;
    const expansion = open >= 0 ? query.slice(open) : '';
    const weights = new Map<string, number>();
    const add = (tokens: string[], w: number): void => {
      for (const [t, c] of countTerms(tokens)) weights.set(t, (weights.get(t) ?? 0) + w * c);
    };
    add(stemmedTerms(primary), 1.0);
    add(stemmedTerms(expansion), EXPANSION_WEIGHT);
    for (const [t, w] of weights) weights.set(t, w <= 1 ? w : 1 + Math.log(w));
    return weights;
  }

  score(query: string): { hit: SearchHit; score: number }[] {
    const qw = this.queryWeights(query);
    return this.docs.map((d) => {
      let score = 0;
      for (const [t, w] of qw) {
        const idf = this.idf.get(t);
        if (!idf) continue;
        let tf = 0;
        for (const f of FIELD_NAMES) {
          const raw = d.tf[f].get(t);
          if (!raw) continue;
          const spec = FIELDS[f];
          tf += (spec.weight * raw) / (1 - spec.b + (spec.b * d.len[f]) / this.avgLen[f]);
        }
        if (tf > 0) score += w * idf * ((tf * (K1 + 1)) / (tf + K1));
      }
      return { hit: d.hit, score };
    });
  }

  search(query: string, limit: number): { hit: SearchHit; score: number }[] {
    return this.score(query)
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score || a.hit.chunkId.localeCompare(b.hit.chunkId))
      .slice(0, limit);
  }
}
