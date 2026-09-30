import { ChangeDetectionStrategy, Component, OnInit, computed, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

import { ApiService } from '../../core/api.service';
import { AuditReceipt, FindingRow, ReviewDecision } from '../../core/contract';
import { timeAgo } from '../../core/format';
import { MarkdownPipe } from '../../core/markdown';
import { PersonaService } from '../../core/persona.service';
import { DrawerDoc, FindingDrawer } from '../../shared/finding-drawer';

const TYPE_LABEL: Record<string, string> = { CASE_NOTE: 'Case note', EXCEPTION_REPORT: 'Exception report', STR_DRAFT: 'STR draft' };
const STATUS: Record<string, string> = { PENDING_REVIEW: 'warn', APPROVED: 'ok', NEEDS_CHANGES: 'warn', REJECTED: 'bad' };

@Component({
  selector: 'kv-findings',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MarkdownPipe, RouterLink, FindingDrawer],
  template: `
    <section class="wrap page">
      <header class="ph kv-in">
        <div>
          <div class="sec-k">Findings register</div>
          <h1 class="sec-t">Drafted by Kavach.<br><span class="accent-text">Signed by people.</span></h1>
          <p class="lede">Every finding and every sign-off is an event in the immutable audit log. The checker must be a different person from the maker; self-reviews are recorded as maker-checker exceptions.</p>
        </div>
        <div class="stats">
          <div><b class="mono">{{ rows().length }}</b><span>Findings</span></div>
          <div><b class="mono warn">{{ pending() }}</b><span>Awaiting review</span></div>
          <div><b class="mono ok">{{ approved() }}</b><span>Approved</span></div>
        </div>
      </header>

      @if (!loading() && !rows().length) {
        <div class="empty edge kv-in"><div class="edge-in">
          <div class="label-k">Nothing here yet</div>
          <h2>Ask a question, then click <em>Generate finding</em>.</h2>
          <p>Case notes, exception reports and STR drafts land here, pre-filled with their evidence trail and ready for sign-off.</p>
          <a class="btn btn-solid" routerLink="/">Open the copilot <span class="arr">→</span></a>
        </div></div>
      } @else {
        <div class="layout">
          <div class="list kv-in d1">
            @for (f of rows(); track f.findingId) {
              <button type="button" class="item" [class.on]="f.findingId === selectedId()" (click)="selectedId.set(f.findingId)">
                <div class="it-top">
                  <span class="ty">{{ typeLabel(f.findingType) }}</span>
                  <span class="pill" [class]="statusCls(f.status)"><i class="dot"></i>{{ f.status.replace('_', ' ').toLowerCase() }}</span>
                </div>
                <b>{{ f.title }}</b>
                <small class="mono">{{ f.findingId }} · {{ f.createdBy }} · {{ ago(f.createdAtUtc) }}</small>
                @if (!f.makerCheckerOk) { <small class="mc">⚠ maker-checker exception</small> }
              </button>
            }
          </div>

          @if (selected(); as f) {
            <article class="reader edge kv-in d2"><div class="edge-in">
              <div class="r-top">
                <span class="label-k">{{ typeLabel(f.findingType) }} · confidence {{ f.confidence }}</span>
                <button class="btn btn-ghost btn-sm" type="button" (click)="expand(f)">Full screen ⤢</button>
              </div>
              <div class="md doc" [innerHTML]="f.findingMarkdown | markdown"></div>
            </div></article>

            <aside class="sign kv-in d3">
              <div class="edge"><div class="edge-in sg">
                <div class="label-k">Reviewer sign-off</div>
                <div class="who">
                  <span class="av mono">{{ persona.current().initials }}</span>
                  <div><b>{{ persona.current().name }}</b><small>{{ persona.current().role }}</small></div>
                </div>
                <dl>
                  <dt>Prepared by</dt><dd class="mono">{{ f.createdBy }}</dd>
                  <dt>Status</dt><dd><span class="pill" [class]="statusCls(f.status)"><i class="dot"></i>{{ f.status.replace('_', ' ').toLowerCase() }}</span></dd>
                  @if (f.reviewer) {
                    <dt>Reviewed by</dt><dd class="mono">{{ f.reviewer }} · {{ ago(f.reviewedAtUtc) }}</dd>
                    @if (f.reviewComment) { <dt>Comment</dt><dd>{{ f.reviewComment }}</dd> }
                  }
                </dl>

                @if (selfReview()) {
                  <div class="warnbox">You prepared this finding. Switch persona to the checker (top right), or your review will be recorded as a <b>maker-checker exception</b>.</div>
                }

                <div class="label-k" style="margin-top:18px">Decision</div>
                <div class="decisions">
                  @for (d of decisions; track d.id) {
                    <button type="button" [class]="'dec ' + d.cls" [class.on]="decision() === d.id" (click)="decision.set(d.id)">{{ d.label }}</button>
                  }
                </div>
                <textarea rows="3" placeholder="Reviewer comment, e.g. Escalate to Principal Officer; STR clock starts today." [value]="comment()" (input)="comment.set($any($event.target).value)"></textarea>
                <button class="btn btn-solid" type="button" style="width:100%;margin-top:12px" (click)="submit(f)" [disabled]="saving()">
                  {{ saving() ? 'Recording…' : '✍ Record sign-off' }}
                </button>
                @if (receipt(); as r) {
                  <p class="rcpt">Recorded as audit <b class="mono">#{{ r.auditSeq }}</b> · <span class="mono">{{ r.rowHash.slice(0, 16) }}…</span></p>
                }
                @if (error()) { <p class="err">{{ error() }}</p> }
              </div></div>
            </aside>
          }
        </div>
      }
    </section>

    @if (drawer(); as d) { <kv-finding-drawer [doc]="d" [showSignoff]="false" (closed)="drawer.set(null)" /> }
  `,
  styleUrl: './findings.scss',
})
export class FindingsPage implements OnInit {
  private api = inject(ApiService);
  protected persona = inject(PersonaService);
  readonly id = input<string>();

  protected rows = signal<FindingRow[]>([]);
  protected loading = signal(true);
  protected selectedId = signal<string | null>(null);
  protected decision = signal<ReviewDecision>('APPROVED');
  protected comment = signal('');
  protected saving = signal(false);
  protected receipt = signal<AuditReceipt | null>(null);
  protected error = signal<string | null>(null);
  protected drawer = signal<DrawerDoc | null>(null);

  protected decisions: { id: ReviewDecision; label: string; cls: string }[] = [
    { id: 'APPROVED', label: 'Approve', cls: 'ok' },
    { id: 'NEEDS_CHANGES', label: 'Needs changes', cls: 'warn' },
    { id: 'REJECTED', label: 'Reject', cls: 'bad' },
  ];

  protected selected = computed(() => this.rows().find((r) => r.findingId === this.selectedId()) ?? null);
  protected pending = computed(() => this.rows().filter((r) => r.status === 'PENDING_REVIEW').length);
  protected approved = computed(() => this.rows().filter((r) => r.status === 'APPROVED').length);
  protected selfReview = computed(() => this.selected()?.createdBy === this.persona.current().id);

  ngOnInit(): void {
    this.load(this.id());
  }

  async load(prefer?: string): Promise<void> {
    try {
      const rows = await this.api.findings();
      this.rows.set(rows);
      const keep = prefer ?? this.selectedId();
      this.selectedId.set(rows.find((r) => r.findingId === keep)?.findingId ?? rows[0]?.findingId ?? null);
    } finally {
      this.loading.set(false);
    }
  }

  protected async submit(f: FindingRow): Promise<void> {
    this.saving.set(true);
    this.error.set(null);
    try {
      this.receipt.set(await this.api.review(f.findingId, this.decision(), this.comment()));
      this.comment.set('');
      await this.load(f.findingId);
    } catch (e: any) {
      this.error.set(e?.error?.message ?? e?.message ?? 'Could not record the sign-off');
    } finally {
      this.saving.set(false);
    }
  }

  protected expand(f: FindingRow): void {
    this.drawer.set({ findingId: f.findingId, label: this.typeLabel(f.findingType), markdown: f.findingMarkdown, status: f.status });
  }

  protected typeLabel = (t: string) => TYPE_LABEL[t] ?? t;
  protected statusCls = (s: string) => STATUS[s] ?? '';
  protected ago = timeAgo;
}
