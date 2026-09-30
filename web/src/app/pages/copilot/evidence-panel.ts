import { ChangeDetectionStrategy, Component, ElementRef, computed, effect, inject, input, signal } from '@angular/core';
import { DomSanitizer } from '@angular/platform-browser';
import { RouterLink } from '@angular/router';

import { AskResult } from '../../core/contract';
import { cell, humanize, isNumericCol } from '../../core/format';
import { STEP_ORDER } from '../../core/kavach.store';
import { highlightSql } from '../../core/sql-highlight';
import { TiltDirective } from '../../shared/effects';

type Tab = 'data' | 'policy' | 'trace';

const DOC_TYPE: Record<string, string> = {
  REGULATION: 'RBI regulation',
  INTERNAL_POLICY: 'Internal policy',
  SOP: 'SOP',
  AUDIT_FINDING: 'Audit finding',
  TEMPLATE: 'Template',
};

@Component({
  selector: 'kv-evidence-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TiltDirective, RouterLink],
  template: `
    @let r = result();
    <aside class="panel edge kv-in d1"><div class="edge-in">
      <div class="top">
        <div>
          <div class="label-k">Evidence panel</div>
          <h3>Every fact, traceable</h3>
        </div>
        <div class="seg" role="tablist">
          @if (r.data) {
            <button role="tab" [class.on]="tab() === 'data'" (click)="tab.set('data')">Data · SQL <span class="c d mono">D1</span></button>
          }
          @if (r.policy) {
            <button role="tab" [class.on]="tab() === 'policy'" (click)="tab.set('policy')">Citations <span class="c mono">{{ r.policy.chunks.length }}</span></button>
          }
          <button role="tab" [class.on]="tab() === 'trace'" (click)="tab.set('trace')">Trace</button>
        </div>
      </div>

      <div class="body">
        @switch (tab()) {
          @case ('data') {
            @if (r.data; as d) {
              <div class="tiles">
                <div class="tile"><b class="mono">{{ d.rowCount }}</b><span>rows returned</span></div>
                <div class="tile" [class.good]="d.verifiedQueryUsed"><b>{{ d.verifiedQueryUsed ? 'Verified' : 'Generated' }}</b><span>{{ d.verifiedQueryUsed ? 'pre-approved query' : 'review the SQL' }}</span></div>
                <div class="tile" [class.good]="!!d.sql && !blocked()"><b>{{ d.sql && !blocked() ? 'Read-only' : '—' }}</b><span>SQL guard</span></div>
              </div>
              <p class="asked"><span class="label-k">Sent to Cortex Analyst</span>{{ d.question }}</p>
              @if (d.error) { <p class="err">⚠ {{ d.error }}</p> }
              @if (d.analystText) { <p class="analyst">“{{ d.analystText }}”</p> }
              @if (d.sql) {
                <div class="code">
                  <div class="code-h"><span class="mono">generated.sql</span>
                    <button type="button" (click)="copy(d.sql)">{{ copied() ? 'Copied ✓' : 'Copy' }}</button></div>
                  <pre><code [innerHTML]="sqlHtml()"></code></pre>
                </div>
              }
              @if (d.rows.length) {
                <div class="tbl">
                  <table>
                    <thead><tr>@for (c of d.columns; track c) { <th [class.num]="isNum(c)">{{ human(c) }}</th> }</tr></thead>
                    <tbody>
                      @for (row of visibleRows(); track $index) {
                        <tr>@for (c of d.columns; track c) { <td [class.num]="isNum(c)" [class.mono]="isNum(c)">{{ fmt(c, row[c]) }}</td> }</tr>
                      }
                    </tbody>
                  </table>
                </div>
                @if (d.rows.length > 12) {
                  <button class="more" type="button" (click)="allRows.set(!allRows())">{{ allRows() ? 'Show fewer' : 'Show all ' + d.rows.length + ' rows' }}</button>
                }
              }
              @if (d.suggestions.length) {
                <div class="sugg"><span class="label-k">Analyst suggests</span>@for (s of d.suggestions; track s) { <span class="pill">{{ s }}</span> }</div>
              }
            }
          }
          @case ('policy') {
            @if (r.policy; as p) {
              @if (p.error) { <p class="err">⚠ {{ p.error }}</p> }
              <p class="asked searched" [title]="p.queries.join('\n')"><span class="label-k">Searched for</span><span class="qs">{{ p.queries.join('  ·  ') }}</span></p>
              <div class="cites">
                @for (c of p.chunks; track c.chunkId) {
                  <div class="cite-card" [kvTilt]="6" [attr.id]="'ev-' + c.label" [class.flash]="flash() === c.label" [class.used]="used().has(c.label)">
                    <i class="shine"></i>
                    <div class="ch">
                      <span class="tag mono">{{ c.label }}</span>
                      <span class="dt" [attr.data-t]="c.docType">{{ docType(c.docType) }}</span>
                      @if (used().has(c.label)) { <span class="usedp">✓ cited</span> }
                    </div>
                    <h4>{{ c.docTitle }}</h4>
                    <div class="path mono">§ {{ c.sectionPath }}</div>
                    <p>{{ c.chunkText }}</p>
                    <div class="cf">
                      <span class="meter" [title]="'Query term coverage ' + pct(c.lexicalCoverage)"><i [style.width.%]="c.lexicalCoverage * 100"></i></span>
                      <span class="mono">{{ c.score !== null ? 'sim ' + c.score.toFixed(2) : 'coverage ' + pct(c.lexicalCoverage) }}</span>
                      <span class="src mono">{{ c.sourceRef }}</span>
                    </div>
                    @if (c.disclaimer) { <small class="disc">{{ c.disclaimer }}</small> }
                  </div>
                }
              </div>
            }
          }
          @case ('trace') {
            <ol class="timeline">
              @for (s of trace(); track s.key) {
                <li [class]="s.status">
                  <i></i>
                  <div><b>{{ s.label }}</b><span>{{ s.detail || s.status }}</span></div>
                  <em class="mono">{{ s.ms }}ms</em>
                </li>
              }
            </ol>
            <div class="receipt">
              <div class="label-k">Audit receipt · hash-chained</div>
              <div class="blocks">
                <div class="blk prev"><span>prev</span><code class="mono">{{ r.audit.prevHash.slice(0, 20) }}…</code></div>
                <div class="link">→</div>
                <div class="blk this"><span>#{{ r.audit.auditSeq }}</span><code class="mono">{{ r.audit.rowHash.slice(0, 20) }}…</code></div>
              </div>
              <dl>
                <dt>Event</dt><dd class="mono">{{ r.audit.eventId }}</dd>
                <dt>Written</dt><dd class="mono">{{ r.audit.eventTsUtc }} UTC</dd>
                <dt>Model</dt><dd class="mono">{{ r.model }} · temperature 0</dd>
                <dt>Citations</dt><dd class="mono">{{ r.citationsUsed.join(', ') || 'none' }}</dd>
              </dl>
              <a class="btn btn-ghost btn-sm" routerLink="/audit">Open audit log →</a>
            </div>
          }
        }
      </div>
    </div></aside>
  `,
  styles: [`
    :host { display: block; min-width: 0; }
    .panel { position: sticky; top: 88px; }
    .edge-in { display: flex; flex-direction: column; max-height: calc(100vh - 108px); }
    .top { display: flex; align-items: flex-end; justify-content: space-between; gap: 12px; flex-wrap: wrap; padding: 22px 22px 16px; border-bottom: 1px solid var(--line);
      h3 { margin-top: 6px; font-size: 16px; font-weight: 700; } }
    .seg .c { margin-left: 4px; padding: 0 5px; border-radius: 5px; font-size: 10px; background: rgba(var(--accent-rgb), .15); color: var(--accent-ink); }
    .seg .c.d { background: color-mix(in srgb, var(--ok) 15%, transparent); color: var(--ok-ink); }
    .body { overflow: auto; padding: 18px 22px 22px; }
    .tiles { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
    .tile { display: flex; flex-direction: column; align-items: center; gap: 3px; padding: 12px 6px; border-radius: 14px; border: 1px solid var(--line); background: var(--glass); text-align: center;
      b { font-size: 17px; font-weight: 600; letter-spacing: -.01em; color: var(--ink); }
      span { font-size: 10px; letter-spacing: .08em; text-transform: uppercase; color: var(--ink-3); }
      &.good b { color: var(--ok-ink); } }
    .asked { margin-top: 16px; font-size: 13px; color: var(--ink-2); .label-k { display: block; margin-bottom: 4px; } }
    .searched .qs { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; font-size: 12px; color: var(--ink-3); }
    .analyst { margin-top: 8px; font-size: 12.5px; font-style: italic; color: var(--ink-3); }
    .err { margin-top: 12px; padding: 10px 14px; border-radius: 12px; font-size: 12.5px; color: var(--bad); background: color-mix(in srgb, var(--bad) 8%, transparent); }
    .code { margin-top: 14px; border-radius: 14px; border: 1px solid var(--line); background: #0000003d; overflow: hidden; }
    :host-context([data-theme='daylight']) .code { background: #0a32540a; }
    .code-h { display: flex; justify-content: space-between; align-items: center; padding: 8px 14px; border-bottom: 1px solid var(--line); font-size: 11px; color: var(--ink-3);
      button { font-size: 11px; font-weight: 600; color: var(--accent-ink); } }
    pre { margin: 0; padding: 14px; max-height: 260px; overflow: auto; font-family: var(--mono); font-size: 12px; line-height: 1.65; color: var(--ink-2); }
    pre ::ng-deep .k { color: var(--accent-ink); font-weight: 500; }
    pre ::ng-deep .s { color: var(--ok-ink); }
    pre ::ng-deep .n { color: var(--warn); }
    pre ::ng-deep .t { color: var(--ink); }
    pre ::ng-deep .c { color: var(--ink-3); font-style: italic; }
    .tbl { margin-top: 14px; max-height: 360px; overflow: auto; border-radius: 14px; border: 1px solid var(--line); }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th { position: sticky; top: 0; z-index: 1; padding: 9px 12px; text-align: left; white-space: nowrap; font-size: 10px; font-weight: 600; letter-spacing: .1em; text-transform: uppercase;
      color: var(--ink-3); background: var(--surface-flat); border-bottom: 1px solid var(--line); }
    td { padding: 9px 12px; white-space: nowrap; border-bottom: 1px solid var(--line); color: var(--ink-2); }
    tr:hover td { background: rgba(var(--accent-rgb), .05); color: var(--ink); }
    .num { text-align: right; }
    .more { margin-top: 10px; font-size: 12px; font-weight: 600; color: var(--accent-ink); }
    .sugg { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 14px; align-items: center; }
    .cites { display: grid; gap: 12px; margin-top: 14px; }
    .cite-card { position: relative; overflow: hidden; padding: 16px 18px 14px; border-radius: 18px; border: 1px solid var(--line); background: var(--glass);
      transition: border-color .3s, transform .5s var(--ease);
      .shine { position: absolute; inset: 0; pointer-events: none; opacity: 0; transition: opacity .3s;
        background: radial-gradient(360px circle at var(--mx, 50%) var(--my, 50%), rgba(var(--accent-rgb), .13), transparent 45%); }
      &:hover .shine { opacity: 1; }
      &.used { border-color: rgba(var(--accent-rgb), .35); }
      &.flash { animation: kv-flash 1s var(--ease) 2; border-color: var(--accent); } }
    .ch { display: flex; align-items: center; gap: 8px; }
    .tag { padding: 2px 7px; border-radius: 6px; font-size: 11px; background: rgba(var(--accent-rgb), .14); color: var(--accent-ink); border: 1px solid rgba(var(--accent-rgb), .4); }
    .dt { font-size: 10px; font-weight: 700; letter-spacing: .18em; text-transform: uppercase; color: var(--ink-3);
      &[data-t='REGULATION'] { color: var(--warn); } &[data-t='SOP'], &[data-t='INTERNAL_POLICY'] { color: var(--accent-ink); } &[data-t='AUDIT_FINDING'] { color: var(--bad); } }
    .usedp { margin-left: auto; font-size: 11px; font-weight: 600; color: var(--ok-ink); }
    h4 { margin-top: 10px; font-size: 13px; font-weight: 650; color: var(--ink); line-height: 1.35; }
    .path { margin-top: 3px; font-size: 11px; color: var(--accent-ink); }
    .cite-card p { margin-top: 8px; font-size: 13px; line-height: 1.65; color: var(--ink-2); }
    .cf { display: flex; align-items: center; gap: 10px; margin-top: 12px; font-size: 10.5px; color: var(--ink-3); }
    .meter { width: 56px; height: 3px; border-radius: 99px; background: var(--line); overflow: hidden; i { display: block; height: 100%; background: var(--accent); } }
    .src { margin-left: auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 45%; }
    .disc { display: block; margin-top: 8px; font-size: 10.5px; line-height: 1.5; color: var(--ink-3); font-style: italic; }
    .timeline { list-style: none; position: relative; padding-left: 4px;
      li { position: relative; display: grid; grid-template-columns: 18px 1fr auto; gap: 12px; padding: 0 0 18px; }
      li::before { content: ''; position: absolute; left: 5px; top: 14px; bottom: 0; width: 1px; background: var(--line-2); }
      li:last-child::before { display: none; }
      i { width: 11px; height: 11px; margin-top: 3px; border-radius: 50%; border: 2px solid var(--accent); background: var(--bg); }
      li.done i { background: var(--accent); box-shadow: 0 0 12px rgba(var(--accent-rgb), .7); }
      li.skipped { opacity: .5; } li.skipped i { border-color: var(--line-2); }
      li.error i { border-color: var(--bad); background: var(--bad); }
      b { display: block; font-size: 13px; font-weight: 600; color: var(--ink); }
      span { font-size: 12px; color: var(--ink-3); }
      em { font-style: normal; font-size: 11px; color: var(--ink-3); } }
    .receipt { margin-top: 8px; padding: 16px 18px; border-radius: 18px; border: 1px solid var(--line); background: var(--glass); }
    .blocks { display: flex; align-items: center; gap: 10px; margin: 12px 0 14px; }
    .blk { flex: 1; min-width: 0; padding: 10px 12px; border-radius: 12px; border: 1px solid var(--line-2);
      span { display: block; font-size: 10px; letter-spacing: .16em; text-transform: uppercase; color: var(--ink-3); }
      code { display: block; margin-top: 3px; font-size: 11px; color: var(--ink-2); overflow: hidden; text-overflow: ellipsis; }
      &.this { border-color: rgba(var(--accent-rgb), .6); background: rgba(var(--accent-rgb), .07); code { color: var(--accent-ink); } } }
    .link { color: var(--accent-ink); }
    dl { display: grid; grid-template-columns: auto 1fr; gap: 6px 14px; font-size: 12px; margin-bottom: 14px;
      dt { color: var(--ink-3); } dd { color: var(--ink-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } }
    @media (max-width: 1100px) { .panel { position: static; } .edge-in { max-height: none; } }
  `],
})
export class EvidencePanel {
  private sanitizer = inject(DomSanitizer);
  private host = inject(ElementRef<HTMLElement>);
  readonly result = input.required<AskResult>();
  readonly focusCite = input<{ tag: string; n: number } | null>(null);

  protected tab = signal<Tab>('data');
  protected allRows = signal(false);
  protected copied = signal(false);
  protected flash = signal<string | null>(null);

  protected used = computed(() => new Set(this.result().citationsUsed));
  protected blocked = computed(() => (this.result().data?.error ?? '').startsWith('Blocked'));
  protected sqlHtml = computed(() => this.sanitizer.bypassSecurityTrustHtml(highlightSql(this.result().data?.sql ?? '')));
  protected visibleRows = computed(() => {
    const rows = this.result().data?.rows ?? [];
    return this.allRows() ? rows : rows.slice(0, 12);
  });
  protected trace = computed(() =>
    STEP_ORDER.map((d) => this.result().steps.find((s) => s.key === d.key) ?? { key: d.key, label: d.label, status: 'skipped', ms: 0, detail: '' }),
  );

  constructor() {
    // New result: open the most relevant tab.
    effect(() => {
      const r = this.result();
      this.tab.set(r.data ? 'data' : r.policy ? 'policy' : 'trace');
      this.allRows.set(false);
    });
    // A citation chip was clicked in the answer.
    effect(() => {
      const f = this.focusCite();
      if (!f) return;
      if (f.tag === 'D1') {
        this.tab.set('data');
        return;
      }
      this.tab.set('policy');
      this.flash.set(null);
      setTimeout(() => {
        this.flash.set(f.tag);
        this.host.nativeElement.querySelector(`#ev-${f.tag}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 60);
    });
  }

  protected isNum(c: string): boolean {
    return isNumericCol(this.result().data?.rows ?? [], c);
  }
  protected fmt = cell;
  protected human = humanize;
  protected docType = (t: string) => DOC_TYPE[t] ?? t;
  protected pct = (x: number) => `${Math.round(x * 100)}%`;

  protected async copy(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 1600);
    } catch {
      /* clipboard blocked */
    }
  }
}
