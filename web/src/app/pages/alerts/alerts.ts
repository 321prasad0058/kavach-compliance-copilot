import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';

import { ApiService } from '../../core/api.service';
import { Alert, AlertsByRule } from '../../core/contract';
import { inr, timeAgo } from '../../core/format';
import { TiltDirective } from '../../shared/effects';

const RULE_COPY: Record<string, string> = {
  STRUCTURING: 'Sub-₹50k cash / wallet credits split across days and cities',
  VELOCITY: 'Credit spike or same-day pass-through',
  GEO_ANOMALY: 'Cash deposits across distant cities',
  INCOME_MISMATCH: 'Bank credits far below declared income',
  EARLY_DELINQUENCY: 'DPD > 60 within six months of disbursal',
  PEP_EXPOSURE: 'Politically exposed person on the account',
};

const INVESTIGATE: Record<string, string> = {
  STRUCTURING: 'Show me accounts flagged for structuring this week, and what does our AML policy require us to do about them?',
  INCOME_MISMATCH: 'Which disbursements to first-time borrowers in the last 30 days show a mismatch between declared income and bank statement credits?',
  EARLY_DELINQUENCY: "Which accounts disbursed in the last 6 months now show DPD over 60, and what's our total exposure there?",
};

type Sev = 'ALL' | 'HIGH' | 'MEDIUM' | 'LOW';

@Component({
  selector: 'kv-alerts',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TiltDirective],
  template: `
    <section class="wrap page">
      <header class="ph kv-in">
        <div>
          <div class="sec-k">Live alert queue</div>
          <h1 class="sec-t">Signals, as they land.</h1>
          <p class="lede">Rule-engine alerts from the monitoring tables, refreshed every 15 seconds. Pick one and Kavach assembles the evidence and the obligations for you.</p>
        </div>
        <div class="live">
          <span class="pill ok"><i class="dot live"></i>Live · {{ lastSync() }}</span>
          <button class="btn btn-ghost btn-sm" type="button" (click)="load()">Refresh</button>
        </div>
      </header>

      <div class="layout">
        <div class="queue">
          <div class="filters kv-in d1">
            <div class="seg">
              @for (s of sevs; track s) {
                <button type="button" [class.on]="sev() === s" (click)="sev.set(s)">{{ s === 'ALL' ? 'All' : s[0] + s.slice(1).toLowerCase() }}</button>
              }
            </div>
            <div class="rules">
              <button type="button" class="chip" [class.on]="!rule()" (click)="rule.set(null)">All rules</button>
              @for (r of rules(); track r) {
                <button type="button" class="chip" [class.on]="rule() === r" (click)="rule.set(rule() === r ? null : r)">{{ r.replace('_', ' ') }}</button>
              }
            </div>
          </div>

          @if (loading() && !alerts().length) {
            @for (_ of [1, 2, 3, 4]; track $index) { <div class="skeleton" style="height:96px;margin-top:10px;border-radius:18px"></div> }
          }
          @for (a of filtered(); track a.alertId; let i = $index) {
            <article class="alert kv-in" [style.animation-delay.ms]="Math.min(i, 10) * 35" [attr.data-sev]="a.severity" [class.fresh]="fresh().has(a.alertId)" [kvTilt]="3">
              <i class="sev-bar"></i>
              <div class="a-main">
                <div class="a-top">
                  <span class="sev mono">{{ a.severity }}</span>
                  <b>{{ a.ruleTriggered.replace('_', ' ') }}</b>
                  <span class="id mono">{{ a.alertId }}</span>
                  @if (fresh().has(a.alertId)) { <span class="pill accent">new</span> }
                </div>
                <p class="biz">{{ a.businessName || 'Unknown borrower' }} <span class="mono">· {{ a.accountId }}</span></p>
                <p class="note">{{ a.analystNotes || ruleCopy(a.ruleTriggered) }}</p>
              </div>
              <div class="a-side">
                <b class="mono amt">{{ money(a.alertAmount) }}</b>
                <span class="meta">{{ a.status.replace('_', ' ') }} · {{ ago(a.createdAt) }}</span>
                <span class="meta who mono">{{ a.assignedTo }}</span>
                <button class="btn btn-solid btn-sm" type="button" (click)="investigate(a)">Investigate <span class="arr">→</span></button>
              </div>
            </article>
          } @empty {
            @if (!loading()) { <div class="empty card">No open alerts match these filters.</div> }
          }
        </div>

        <aside class="side kv-in d2">
          <div class="edge"><div class="edge-in sum">
            <div class="label-k">Open alerts by rule</div>
            <div class="big mono">{{ alerts().length }}<small>open</small></div>
            <div class="bars">
              @for (r of summary(); track r.rule) {
                <button type="button" class="bar-row" [class.on]="rule() === r.rule" (click)="rule.set(rule() === r.rule ? null : r.rule)">
                  <span class="nm">{{ r.rule.replace('_', ' ') }}</span>
                  <span class="track">
                    <i class="h" [style.width.%]="(r.HIGH / maxRule()) * 100"></i>
                    <i class="m" [style.width.%]="(r.MEDIUM / maxRule()) * 100"></i>
                    <i class="l" [style.width.%]="(r.LOW / maxRule()) * 100"></i>
                  </span>
                  <span class="n mono">{{ r.total }}</span>
                </button>
              }
            </div>
            <div class="legend"><span><i class="h"></i>High</span><span><i class="m"></i>Medium</span><span><i class="l"></i>Low</span></div>
          </div></div>
          <div class="tip card">
            <b>How investigating works</b>
            <p>Kavach asks Cortex Analyst for the governed records behind the alert, retrieves the SOP and RBI clauses that apply, and gives you a cited answer you can turn into a case note or STR draft in one click.</p>
          </div>
        </aside>
      </div>
    </section>
  `,
  styleUrl: './alerts.scss',
})
export class AlertsPage implements OnInit, OnDestroy {
  private api = inject(ApiService);
  private router = inject(Router);
  protected Math = Math;

  protected alerts = signal<Alert[]>([]);
  protected byRule = signal<AlertsByRule[]>([]);
  protected loading = signal(true);
  protected fresh = signal<Set<string>>(new Set());
  protected synced = signal<number | null>(null);
  protected sev = signal<Sev>('ALL');
  protected rule = signal<string | null>(null);
  protected sevs: Sev[] = ['ALL', 'HIGH', 'MEDIUM', 'LOW'];
  private seen = new Set<string>();
  private timer?: ReturnType<typeof setInterval>;
  private tick = signal(0);

  protected rules = computed(() => [...new Set(this.alerts().map((a) => a.ruleTriggered))].sort());
  protected filtered = computed(() =>
    this.alerts().filter((a) => (this.sev() === 'ALL' || a.severity === this.sev()) && (!this.rule() || a.ruleTriggered === this.rule())),
  );
  protected summary = computed(() => {
    const m = new Map<string, { rule: string; HIGH: number; MEDIUM: number; LOW: number; total: number }>();
    for (const r of this.byRule()) {
      const e = m.get(r.ruleTriggered) ?? { rule: r.ruleTriggered, HIGH: 0, MEDIUM: 0, LOW: 0, total: 0 };
      e[r.severity] += r.n;
      e.total += r.n;
      m.set(r.ruleTriggered, e);
    }
    return [...m.values()].sort((a, b) => b.total - a.total);
  });
  protected maxRule = computed(() => Math.max(1, ...this.summary().map((s) => s.total)));
  protected lastSync = computed(() => {
    this.tick();
    const s = this.synced();
    return s ? (Date.now() - s < 5000 ? 'just synced' : `synced ${Math.round((Date.now() - s) / 1000)}s ago`) : 'connecting';
  });

  ngOnInit(): void {
    this.load();
    this.timer = setInterval(() => {
      this.tick.update((x) => x + 1);
      if (this.tick() % 3 === 0) this.load();
    }, 5000);
  }

  ngOnDestroy(): void {
    clearInterval(this.timer);
  }

  async load(): Promise<void> {
    try {
      const [alerts, byRule] = await Promise.all([this.api.alerts(200), this.api.alertsByRule()]);
      const first = this.seen.size === 0;
      const fresh = new Set<string>();
      alerts.forEach((a) => {
        if (!first && !this.seen.has(a.alertId)) fresh.add(a.alertId);
        this.seen.add(a.alertId);
      });
      if (fresh.size) this.fresh.set(fresh);
      this.alerts.set(alerts);
      this.byRule.set(byRule);
      this.synced.set(Date.now());
    } finally {
      this.loading.set(false);
    }
  }

  protected investigate(a: Alert): void {
    const rule = a.ruleTriggered.replace('_', ' ').toLowerCase();
    const q = INVESTIGATE[a.ruleTriggered] ??
      `How many open ${rule} alerts do we have by severity, and what does our policy require us to do about ${rule} alerts?`;
    this.router.navigate(['/'], { queryParams: { q } });
  }

  protected money = (n: number) => inr(n);
  protected ago = timeAgo;
  protected ruleCopy = (r: string) => RULE_COPY[r] ?? '';
}
