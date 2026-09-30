import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from '@angular/core';

import { AskResult, Finding, FindingType } from '../../core/contract';
import { KavachStore } from '../../core/kavach.store';
import { MarkdownPipe } from '../../core/markdown';
import { VoiceService } from '../../core/voice.service';

export const ROUTE_LABEL: Record<string, string> = {
  DATA: 'Data · Cortex Analyst',
  POLICY: 'Policy · Cortex Search',
  BOTH: 'Data + Policy',
};
export const CONF: Record<string, { cls: string; text: string }> = {
  HIGH: { cls: 'ok', text: 'High evidence' },
  MEDIUM: { cls: 'warn', text: 'Medium evidence' },
  LOW: { cls: 'bad', text: 'Low evidence · review' },
};

const FINDING_CARDS: { type: FindingType; icon: string; blurb: string }[] = [
  { type: 'CASE_NOTE', icon: '◎', blurb: 'Signal, facts, obligations and next steps for a case file.' },
  { type: 'EXCEPTION_REPORT', icon: '△', blurb: 'Policy breach, population, root cause and remediation.' },
  { type: 'STR_DRAFT', icon: '⚑', blurb: 'Grounds of suspicion drafted for the Principal Officer.' },
];

@Component({
  selector: 'kv-answer-card',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MarkdownPipe],
  template: `
    @let r = result();
    <article class="edge kv-in"><div class="edge-in">
      <header>
        <div class="pills">
          <span class="pill accent"><i class="dot"></i>{{ route[r.route] }}</span>
          <span class="pill" [class]="conf[r.confidence.level].cls" [title]="r.confidence.reasons.join('\\n')">
            <i class="dot"></i>{{ conf[r.confidence.level].text }}
          </span>
          <span class="pill mono" [title]="'row hash ' + r.audit.rowHash">🔒 audit #{{ r.audit.auditSeq }} · {{ r.audit.rowHash.slice(0, 8) }}</span>
          <span class="pill mono">{{ (r.latencyMs / 1000).toFixed(1) }}s · {{ r.model }}</span>
          @if (voice.ttsSupported) {
            <button type="button" class="pill listen" [class.accent]="voice.speaking()" (click)="voice.speaking() ? voice.stopSpeaking() : voice.speak(r.answer)"
                    [attr.aria-label]="voice.speaking() ? 'Stop reading' : 'Read the answer aloud'">
              @if (voice.speaking()) { <span class="eq"><i></i><i></i><i></i></span> Stop } @else { 🔊 Listen }
            </button>
          }
        </div>
        <h2>{{ r.question }}</h2>
        @if (r.routeReason) { <p class="why">{{ r.routeReason }}</p> }
      </header>

      <div class="md answer" [innerHTML]="r.answer | markdown: valid()" (click)="onCite($event)" (keydown.enter)="onCite($event)"></div>

      @if (r.confidence.level !== 'HIGH' || showReasons()) {
        <div class="reasons" [class]="conf[r.confidence.level].cls">
          <b>{{ r.confidence.level === 'LOW' ? 'Treat with caution' : 'Why this confidence' }}</b>
          <ul>@for (x of r.confidence.reasons; track x) { <li>{{ x }}</li> }</ul>
        </div>
      } @else {
        <button class="linkish" type="button" (click)="showReasons.set(true)">Why is this high evidence?</button>
      }

      <section class="gen">
        <div class="gen-h">
          <div>
            <div class="label-k">Signal → evidence → documented finding</div>
            <h3>Turn this into an audit-ready artifact</h3>
          </div>
          <button class="btn btn-solid" type="button" (click)="generate()" [disabled]="busy()">
            @if (busy()) { <i class="spin"></i> Drafting… } @else { ⚡ Generate finding <span class="arr">→</span> }
          </button>
        </div>
        <div class="types" role="radiogroup" aria-label="Finding type">
          @for (c of cards; track c.type) {
            <button type="button" role="radio" class="type" [class.on]="type() === c.type" [attr.aria-checked]="type() === c.type" (click)="type.set(c.type)">
              <span class="ic">{{ c.icon }}</span>
              <b>{{ store.meta()?.findingTypes?.[c.type] ?? c.type }}</b>
              <small>{{ c.blurb }}</small>
            </button>
          }
        </div>
        @if (error()) { <p class="err">{{ error() }}</p> }
        @for (f of findings(); track f.findingId) {
          <button type="button" class="made kv-in" (click)="open.emit(f)">
            <span class="doc">📄</span>
            <span class="tx"><b>{{ f.label }}</b><small class="mono">{{ f.findingId }} · audit #{{ f.audit.auditSeq }} · pending review</small></span>
            <span class="arr">Open →</span>
          </button>
        }
      </section>
    </div></article>
  `,
  styles: [`
    :host { display: block; min-width: 0; }
    .edge-in { padding: 26px 28px 24px; }
    .pills { display: flex; flex-wrap: wrap; gap: 8px; }
    .listen { cursor: pointer; transition: border-color .2s, color .2s; &:hover { color: var(--ink); border-color: rgba(var(--accent-rgb), .5); } }
    .eq { display: inline-flex; align-items: flex-end; gap: 2px; height: 11px;
      i { width: 2px; background: currentColor; border-radius: 2px; animation: eq .8s ease-in-out infinite; }
      i:nth-child(2) { animation-delay: .15s; } i:nth-child(3) { animation-delay: .3s; } }
    @keyframes eq { 0%, 100% { height: 3px; } 50% { height: 11px; } }
    h2 { margin-top: 16px; font-size: clamp(19px, 1.8vw, 24px); font-weight: 750; line-height: 1.25; letter-spacing: -.02em; }
    .why { margin-top: 6px; font-size: 12.5px; color: var(--ink-3); }
    .answer { margin-top: 18px; }
    .reasons { margin-top: 18px; padding: 12px 16px; border-radius: 14px; border: 1px solid var(--line); font-size: 12.5px; color: var(--ink-2);
      b { display: block; margin-bottom: 4px; font-size: 11px; letter-spacing: .2em; text-transform: uppercase; }
      ul { padding-left: 18px; } li + li { margin-top: 3px; }
      &.warn { border-color: color-mix(in srgb, var(--warn) 40%, transparent); background: color-mix(in srgb, var(--warn) 7%, transparent); b { color: var(--warn); } }
      &.bad { border-color: color-mix(in srgb, var(--bad) 45%, transparent); background: color-mix(in srgb, var(--bad) 8%, transparent); b { color: var(--bad); } }
      &.ok { border-color: color-mix(in srgb, var(--ok) 35%, transparent); b { color: var(--ok-ink); } } }
    .linkish { margin-top: 14px; font-size: 12px; font-weight: 600; color: var(--accent-ink); }
    .gen { margin-top: 26px; padding-top: 22px; border-top: 1px solid var(--line); }
    .gen-h { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; flex-wrap: wrap;
      h3 { margin-top: 6px; font-size: 17px; font-weight: 700; letter-spacing: -.01em; } }
    .types { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-top: 16px; }
    .type { display: flex; flex-direction: column; gap: 4px; padding: 14px 14px 13px; border-radius: 16px; text-align: left;
      border: 1px solid var(--line); background: var(--glass); transition: border-color .25s, background-color .25s, transform .25s var(--ease);
      .ic { font-size: 16px; color: var(--ink-3); }
      b { font-size: 13px; font-weight: 650; color: var(--ink); }
      small { font-size: 11.5px; line-height: 1.5; color: var(--ink-3); }
      &:hover { transform: translateY(-2px); border-color: var(--line-2); }
      &.on { border-color: rgba(var(--accent-rgb), .6); background: rgba(var(--accent-rgb), .08); box-shadow: 0 10px 30px -18px rgba(var(--accent-rgb), .8); .ic { color: var(--accent-ink); } } }
    .spin { width: 12px; height: 12px; border-radius: 50%; border: 2px solid currentColor; border-right-color: transparent; animation: kv-spin .7s linear infinite; }
    .err { margin-top: 12px; font-size: 12.5px; color: var(--bad); }
    .made { display: flex; align-items: center; gap: 12px; width: 100%; margin-top: 12px; padding: 12px 16px; border-radius: 14px; text-align: left;
      border: 1px solid color-mix(in srgb, var(--ok) 40%, transparent); background: color-mix(in srgb, var(--ok) 8%, transparent);
      .tx { flex: 1; display: flex; flex-direction: column; b { font-size: 13px; color: var(--ink); } small { font-size: 11px; color: var(--ink-3); } }
      .arr { font-size: 12px; font-weight: 600; color: var(--ok-ink); } }
    @media (max-width: 720px) { .types { grid-template-columns: 1fr; } }
  `],
})
export class AnswerCard {
  protected store = inject(KavachStore);
  protected voice = inject(VoiceService);
  readonly result = input.required<AskResult>();
  readonly cite = output<string>();
  readonly open = output<Finding>();

  protected route = ROUTE_LABEL;
  protected conf = CONF;
  protected cards = FINDING_CARDS;
  protected type = signal<FindingType>('CASE_NOTE');
  protected showReasons = signal(false);
  protected error = signal<string | null>(null);

  protected valid = computed(() => {
    const r = this.result();
    const s = new Set<string>();
    if (r.data) s.add('D1');
    r.policy?.chunks.forEach((c) => s.add(c.label));
    return s;
  });
  protected busy = computed(() => this.store.generating() === this.result().id);
  protected findings = computed(() => this.store.findings()[this.result().id] ?? []);

  protected onCite(e: Event): void {
    const tag = (e.target as HTMLElement).closest<HTMLElement>('[data-cite]')?.dataset['cite'];
    if (tag) this.cite.emit(tag);
  }

  protected async generate(): Promise<void> {
    this.error.set(null);
    try {
      const f = await this.store.generateFinding(this.result(), this.type());
      this.open.emit(f);
    } catch (e: any) {
      this.error.set(e?.error?.message ?? e?.message ?? 'Could not generate the finding');
    }
  }
}
