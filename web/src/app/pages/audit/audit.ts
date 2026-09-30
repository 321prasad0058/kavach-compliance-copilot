import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';

import { ApiService } from '../../core/api.service';
import { AuditRow, ChainStatus } from '../../core/contract';
import { timeAgo } from '../../core/format';
import { CountUp } from '../../shared/effects';

const EVENT: Record<string, { icon: string; label: string }> = {
  QUESTION_ANSWERED: { icon: '◈', label: 'Question answered' },
  FINDING_GENERATED: { icon: '📄', label: 'Finding generated' },
  FINDING_REVIEWED: { icon: '✍', label: 'Finding reviewed' },
  SYSTEM_INIT: { icon: '⚙', label: 'Log initialised' },
};

function jsonHtml(v: unknown): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return esc(JSON.stringify(v, null, 2)).replace(
    /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)/g,
    (m, str, colon, lit, num) =>
      str ? (colon ? `<span class="jk">${str}</span>${colon}` : `<span class="js">${str}</span>`)
        : lit ? `<span class="jl">${lit}</span>` : num ? `<span class="jn">${num}</span>` : m,
  );
}

@Component({
  selector: 'kv-audit',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CountUp],
  template: `
    <section class="wrap page">
      <div class="top">
        <div class="copy kv-in">
          <div class="sec-k">Immutable audit log</div>
          <h1 class="sec-t">“How did we decide this?”<br><span class="accent-text">Replay every step.</span></h1>
          <p class="lede">Each question, generated SQL, retrieved clause, answer, finding and sign-off is appended to <code class="mono">KAVACH.GOV.AUDIT_LOG</code>.
            The app role can only append through an owner's-rights procedure, and every row's SHA-256 covers the row before it, so any edit, deletion or reordering breaks the chain.</p>
          <div class="facts">
            <div><b class="mono">SHA-256</b><span>hash chain</span></div>
            <div><b class="mono">SELECT</b><span>only for app role</span></div>
            <div><b class="mono">1 proc</b><span>single write path</span></div>
          </div>
        </div>

        <div class="ring-wrap kv-in d1" [class.bad]="broken()">
          <svg class="ring" viewBox="0 0 200 200" aria-hidden="true">
            <g class="ticks">@for (t of ticks; track $index) { <line [attr.x1]="t.x1" [attr.y1]="t.y1" [attr.x2]="t.x2" [attr.y2]="t.y2" /> }</g>
            <circle class="track" cx="100" cy="100" r="84" />
            <circle class="prog" cx="100" cy="100" r="84" transform="rotate(-90 100 100)" [attr.stroke-dasharray]="C" [attr.stroke-dashoffset]="offset()" />
          </svg>
          <div class="center">
            <div class="n mono"><kv-count [value]="status()?.valid" /></div>
            <div class="of mono">of {{ status()?.rows ?? '—' }} records verify</div>
            <div class="band">{{ broken() ? 'Chain broken' : status() ? 'Chain intact' : 'Verifying' }}</div>
            <button class="btn btn-ghost btn-sm" type="button" (click)="load()" [disabled]="loading()">{{ loading() ? 'Verifying…' : '↻ Re-verify now' }}</button>
          </div>
        </div>
      </div>

      <div class="layout">
        <ol class="ledger kv-in d2">
          @for (r of rows(); track r.auditSeq; let i = $index) {
            <li [class.sel]="r.auditSeq === selSeq()" [class.invalid]="!r.isValid">
              <button type="button" (click)="open(r)">
                <span class="seq mono">#{{ r.auditSeq }}</span>
                <span class="ev">
                  <b>{{ ev(r.eventType).icon }} {{ ev(r.eventType).label }}</b>
                  <small>{{ r.question || '—' }}</small>
                </span>
                <span class="tags">
                  @if (r.route) { <span class="pill">{{ r.route }}</span> }
                  @if (r.confidence) { <span class="pill" [class.ok]="r.confidence === 'HIGH'" [class.warn]="r.confidence === 'MEDIUM'" [class.bad]="r.confidence === 'LOW'">{{ r.confidence }}</span> }
                </span>
                <span class="hash mono" [title]="r.rowHash">{{ r.rowHash.slice(0, 12) }}<i>← {{ r.prevHash.slice(0, 6) }}</i></span>
                <span class="when"><b class="mono">{{ r.appUser }}</b><small>{{ ago(r.eventTsUtc) }}</small></span>
                <span class="ok-dot" [title]="r.isValid ? 'hash verifies' : 'hash mismatch'">{{ r.isValid ? '✓' : '✕' }}</span>
              </button>
            </li>
          } @empty {
            <li class="empty">No audit events yet.</li>
          }
        </ol>

        <aside class="inspect kv-in d3">
          <div class="edge"><div class="edge-in ins">
            <div class="label-k">Evidence payload {{ selSeq() ? '· #' + selSeq() : '' }}</div>
            @if (payloadHtml(); as h) {
              <pre class="json"><code [innerHTML]="h"></code></pre>
            } @else {
              <p class="hint">Select a record to see exactly what was stored: the SQL, sample rows, retrieved clauses, answer, confidence and model.</p>
            }
          </div></div>
          <div class="sqlcard card">
            <div class="label-k">Verify it yourself in Snowflake</div>
            <pre class="mono">SELECT * FROM KAVACH.GOV.V_AUDIT_CHAIN_CHECK
WHERE NOT is_valid;</pre>
          </div>
        </aside>
      </div>
    </section>
  `,
  styleUrl: './audit.scss',
})
export class AuditPage implements OnInit {
  private api = inject(ApiService);
  private sanitizer = inject(DomSanitizer);

  protected rows = signal<AuditRow[]>([]);
  protected status = signal<ChainStatus | null>(null);
  protected loading = signal(false);
  protected selSeq = signal<number | null>(null);
  protected payloadHtml = signal<SafeHtml | null>(null);

  protected C = 2 * Math.PI * 84;
  protected ticks = Array.from({ length: 60 }, (_, i) => {
    const a = (i / 60) * Math.PI * 2;
    const r1 = 94, r2 = i % 5 === 0 ? 99 : 97;
    return { x1: 100 + r1 * Math.cos(a), y1: 100 + r1 * Math.sin(a), x2: 100 + r2 * Math.cos(a), y2: 100 + r2 * Math.sin(a) };
  });
  protected broken = computed(() => !!this.status() && this.status()!.valid !== this.status()!.rows);
  protected offset = computed(() => {
    const s = this.status();
    const k = s && s.rows ? s.valid / s.rows : 0;
    return this.C * (1 - k);
  });

  ngOnInit(): void {
    this.load();
  }

  async load(): Promise<void> {
    this.loading.set(true);
    try {
      const [rows, status] = await Promise.all([this.api.audit(100), this.api.chainStatus()]);
      this.rows.set(rows);
      this.status.set(status);
      if (!this.selSeq() && rows.length) this.open(rows[0]);
    } finally {
      this.loading.set(false);
    }
  }

  protected async open(r: AuditRow): Promise<void> {
    this.selSeq.set(r.auditSeq);
    const p = await this.api.auditPayload(r.auditSeq);
    this.payloadHtml.set(this.sanitizer.bypassSecurityTrustHtml(jsonHtml(p)));
  }

  protected ev = (t: string) => EVENT[t] ?? { icon: '•', label: t };
  protected ago = timeAgo;
}
