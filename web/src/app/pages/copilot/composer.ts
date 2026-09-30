import {
  ChangeDetectionStrategy, Component, ElementRef, HostListener, computed, effect, inject, input, output, viewChild,
} from '@angular/core';

import { KavachStore } from '../../core/kavach.store';
import { VoiceService } from '../../core/voice.service';

/** The "console" (CJP) where users ask. Big on the landing view, docked once engaged. */
@Component({
  selector: 'kv-composer',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="console edge" [class.compact]="compact()"><div class="edge-in">
      @if (!compact()) {
        <div class="con-head">
          <div>
            <div class="con-title">Ask Kavach</div>
            <div class="con-sub">Plain English in. Cited, audit-ready evidence out.</div>
          </div>
          <span class="pill ok mono">GOVERNED</span>
        </div>
      }

      <label class="fld" [class.focus]="focused" [class.live]="voice.listening()">
        <span class="sr">Your question</span>
        <textarea #ta rows="1" [value]="voice.listening() ? voice.transcript() : store.draft()" (input)="onInput($event)" (focus)="focused = true" (blur)="focused = false"
                  (keydown)="onKey($event)" [placeholder]="voice.listening() ? 'Listening… speak your question' : placeholder()" [disabled]="running()" [readOnly]="voice.listening()" aria-label="Ask a risk, fraud or compliance question"></textarea>
        <button type="button" class="mic" [class.on]="voice.listening()" (click)="toggleMic()" [disabled]="!voice.supported || running()"
                [attr.aria-pressed]="voice.listening()" [attr.aria-label]="voice.listening() ? 'Stop and send' : 'Speak to Kavach'"
                [title]="!voice.supported ? 'Voice input needs Chrome, Edge or Safari' : voice.listening() ? 'Stop and send (Esc cancels)' : 'Speak to Kavach (V)'">
          <i class="ring" [style.transform]="'scale(' + (1 + voice.level() * 0.9) + ')'"></i>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            @if (voice.supported) {
              <rect x="9" y="2.5" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3.5"/>
            } @else {
              <path d="M2 2l20 20M9 9v2a3 3 0 0 0 5.1 2.1M15 9.3V5a3 3 0 0 0-5.9-.7M17 16.9A7 7 0 0 1 5 11m14 0a7 7 0 0 1-.1 1.2M12 18v3.5"/>
            }
          </svg>
        </button>
        <button class="btn btn-solid go" type="button" (click)="submit()" [disabled]="running() || !store.draft().trim()" aria-label="Ask Kavach">
          @if (running()) { <i class="spin"></i> Working } @else { Ask <span class="arr">→</span> }
        </button>
      </label>

      @if (voice.listening()) {
        <div class="capsule" role="status" aria-live="polite">
          <span class="orb" [style.--lv]="voice.level()"><i></i></span>
          <span class="bars" aria-hidden="true">
            @for (b of bars; track $index) { <i [style.transform]="'scaleY(' + bar(b) + ')'"></i> }
          </span>
          <span class="cap-t"><b>Listening</b><small>Pause to send · Esc to cancel · try “generate case note”</small></span>
          <button type="button" class="btn btn-ghost btn-sm" (click)="voice.stop(false)">Cancel</button>
          <button type="button" class="btn btn-solid btn-sm" (click)="voice.stop(true)" [disabled]="!voice.transcript()">Send</button>
        </div>
      }
      @if (voice.error(); as err) { <p class="verr">🎙 {{ err }}</p> }

      <div class="hints">
        <span class="kbd mono">↵</span> ask · <span class="kbd mono">⇧ ↵</span> new line · <span class="kbd mono">/</span> focus
        @if (voice.supported) { · <span class="kbd mono">V</span> voice }
        @if (voice.ttsSupported) {
          <button type="button" class="auto" [class.on]="voice.autoSpeak()" (click)="voice.setAutoSpeak(!voice.autoSpeak())" [attr.aria-pressed]="voice.autoSpeak()">
            {{ voice.autoSpeak() ? '🔊' : '🔈' }} Read answers aloud
          </button>
        }
        @if (compact() && store.history().length) {
          <button class="linkish" type="button" (click)="newThread.emit()">＋ New investigation</button>
        }
      </div>

      @if (store.meta(); as m) {
        <div class="sugs" [class.row]="compact()">
          @if (!compact()) { <div class="label-k">Try the rehearsed demo flow</div> }
          @for (d of m.demoQuestions; track d.label; let i = $index) {
            <button type="button" class="sug" (click)="use(d.question)" [disabled]="running()" [title]="d.question">
              <span class="i mono">0{{ i + 1 }}</span>
              <span class="tx"><b>{{ clean(d.label) }}</b>@if (!compact()) {<small>{{ d.hint }}</small>}</span>
              <span class="arr">↗</span>
            </button>
          }
        </div>
      }

      @if (!compact()) {
        <div class="con-foot">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
          Read-only SQL · PII masked · Every step hash-chained to the audit log
        </div>
      }
    </div></div>
  `,
  styles: [`
    .edge-in { padding: 26px 26px 22px; }
    .compact .edge-in { padding: 14px 16px 12px; }
    .con-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 18px; }
    .con-title { font-size: 17px; font-weight: 700; letter-spacing: -.01em; }
    .con-sub { margin-top: 3px; font-size: 12.5px; color: var(--ink-3); }
    .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
    .fld { position: relative; display: flex; align-items: flex-end; gap: 10px; padding: 8px 8px 8px 16px; border-radius: 18px;
      border: 1px solid var(--line-2); background: var(--glass); transition: border-color .2s, box-shadow .2s, background-color .2s; }
    .fld.focus { border-color: var(--accent); background: rgba(var(--accent-rgb), .05); box-shadow: 0 0 0 4px rgba(var(--accent-rgb), .13); }
    textarea { flex: 1; min-height: 46px; max-height: 180px; padding: 11px 0; resize: none; border: 0; outline: none; background: transparent;
      font-size: 15px; line-height: 1.5; color: var(--ink); &::placeholder { color: var(--ink-3); } }
    .go { padding: 12px 22px; flex: none; }
    .fld.live { border-color: var(--accent); box-shadow: 0 0 0 4px rgba(var(--accent-rgb), .16), 0 0 40px -8px rgba(var(--accent-rgb), .6); }
    .mic { position: relative; flex: none; display: grid; place-items: center; width: 46px; height: 46px; border-radius: 50%;
      border: 1px solid var(--line-2); background: var(--glass); color: var(--ink-2); transition: color .25s, border-color .25s, background-color .25s;
      &:hover { color: var(--accent-ink); border-color: rgba(var(--accent-rgb), .6); }
      &:disabled { opacity: .45; pointer-events: none; }
      svg { position: relative; z-index: 1; }
      .ring { position: absolute; inset: 0; border-radius: 50%; background: rgba(var(--accent-rgb), .0); transition: transform .08s linear; }
      &.on { color: var(--on-accent); background: var(--accent); border-color: var(--accent); animation: kv-flash 1.6s ease-out infinite;
        .ring { background: rgba(var(--accent-rgb), .28); } } }
    .capsule { display: flex; align-items: center; gap: 14px; margin-top: 12px; padding: 10px 12px 10px 14px; border-radius: 18px;
      border: 1px solid rgba(var(--accent-rgb), .45); background: rgba(var(--accent-rgb), .07); animation: kv-in .35s var(--ease) both; }
    .orb { position: relative; width: 30px; height: 30px; flex: none;
      i { position: absolute; inset: 0; border-radius: 50%; background: radial-gradient(circle at 35% 30%, #fff, var(--accent) 45%, transparent 72%);
        box-shadow: 0 0 22px rgba(var(--accent-rgb), .8); transform: scale(calc(.8 + var(--lv, 0) * .7)); transition: transform .1s linear; animation: breath 2.4s ease-in-out infinite; } }
    @keyframes breath { 0%, 100% { opacity: .75; } 50% { opacity: 1; } }
    .bars { display: flex; align-items: center; gap: 3px; height: 26px;
      i { display: block; width: 3px; height: 100%; border-radius: 99px; background: var(--accent); transform-origin: center; transition: transform .09s linear; } }
    .cap-t { flex: 1; min-width: 0; display: flex; flex-direction: column; line-height: 1.3;
      b { font-size: 12.5px; color: var(--accent-ink); } small { font-size: 11px; color: var(--ink-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; } }
    .verr { margin: 10px 4px 0; font-size: 12px; color: var(--bad); }
    .auto { margin-left: 8px; padding: 2px 9px; border-radius: 99px; border: 1px solid var(--line-2); font-size: 11px; color: var(--ink-3);
      &.on { color: var(--accent-ink); border-color: rgba(var(--accent-rgb), .5); background: rgba(var(--accent-rgb), .08); } }
    @media (max-width: 640px) { .cap-t small { display: none; } .bars { display: none; } }
    .spin { width: 12px; height: 12px; border-radius: 50%; border: 2px solid currentColor; border-right-color: transparent; animation: kv-spin .7s linear infinite; }
    .hints { display: flex; align-items: center; gap: 6px; margin: 10px 4px 0; font-size: 11.5px; color: var(--ink-3); }
    .kbd { padding: 1px 6px; border: 1px solid var(--line-2); border-radius: 6px; font-size: 10.5px; }
    .linkish { margin-left: auto; font-size: 12px; font-weight: 600; color: var(--accent-ink); }
    .sugs { display: grid; gap: 8px; margin-top: 20px; .label-k { margin-bottom: 2px; } }
    .sugs.row { grid-template-columns: repeat(4, minmax(0, 1fr)); margin-top: 12px; gap: 6px; }
    .sug { display: flex; align-items: center; gap: 12px; padding: 11px 14px; border-radius: 14px; text-align: left;
      border: 1px solid var(--line); background: color-mix(in srgb, var(--glass) 60%, transparent);
      transition: border-color .25s, background-color .25s, transform .25s var(--ease);
      &:hover { border-color: rgba(var(--accent-rgb), .5); background: rgba(var(--accent-rgb), .06); transform: translateX(3px); .arr { color: var(--accent-ink); transform: translate(2px, -2px); } }
      .i { font-size: 11px; color: var(--accent-ink); }
      .tx { flex: 1; min-width: 0; display: flex; flex-direction: column; b { font-size: 13px; font-weight: 600; color: var(--ink); } small { font-size: 11.5px; color: var(--ink-3); } }
      .arr { color: var(--ink-3); transition: transform .25s var(--ease), color .25s; } }
    .row .sug { padding: 8px 11px; b { font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; } &:hover { transform: translateY(-2px); } }
    .con-foot { display: flex; align-items: center; justify-content: center; gap: 7px; margin-top: 18px; font-size: 11px; color: var(--ink-3); }
    @media (max-width: 900px) { .sugs.row { grid-template-columns: 1fr 1fr; } }
  `],
})
export class Composer {
  protected store = inject(KavachStore);
  readonly compact = input(false);
  readonly newThread = output<void>();
  /** Final voice transcript; the page decides whether it is a command or a question. */
  readonly voiceText = output<string>();
  protected voice = inject(VoiceService);
  protected bars = Array.from({ length: 14 }, (_, i) => 0.35 + 0.65 * Math.abs(Math.sin(i * 1.7)));
  private tick = 0;

  constructor() {
    // Grow the box with the live transcript while listening.
    effect(() => {
      this.voice.transcript();
      const el = this.ta()?.nativeElement;
      if (!el) return;
      queueMicrotask(() => { el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px`; });
    });
  }
  private ta = viewChild.required<ElementRef<HTMLTextAreaElement>>('ta');
  protected focused = false;

  protected clean = (l: string) => l.replace(/^\d+\s*·\s*/, '');
  protected running = computed(() => this.store.runState() === 'running');
  protected placeholder = computed(() =>
    this.compact() ? 'Ask a follow-up…' : 'Ask about DPD, structuring, KYC or RBI rules…',
  );

  @HostListener('document:keydown', ['$event'])
  onGlobalKey(e: KeyboardEvent): void {
    const t = e.target as HTMLElement;
    const typing = ['INPUT', 'TEXTAREA'].includes(t.tagName) && !(t as HTMLTextAreaElement).readOnly;
    if (e.key === '/' && !typing) {
      e.preventDefault();
      this.focus();
    } else if ((e.key === 'v' || e.key === 'V') && !typing && !e.metaKey && !e.ctrlKey && !e.altKey && this.primary()) {
      e.preventDefault();
      this.toggleMic();
    } else if (e.key === 'Escape' && this.voice.listening()) {
      this.voice.stop(false);
    }
  }

  /** Only one composer on screen owns the hotkeys. */
  readonly primary = input(true);

  protected toggleMic(): void {
    if (this.running()) return;
    this.voice.toggle((text) => this.voiceText.emit(text));
  }

  /** Bars animate from the live mic level with a per-bar shape. */
  protected bar(shape: number): number {
    this.tick++;
    const lv = this.voice.level();
    return Math.max(0.12, Math.min(1, shape * (0.2 + lv * 1.6) * (0.75 + 0.25 * Math.sin(this.tick * 0.9 + shape * 9))));
  }

  focus(): void {
    this.ta().nativeElement.focus();
  }

  protected onInput(e: Event): void {
    const el = e.target as HTMLTextAreaElement;
    this.store.draft.set(el.value);
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }

  protected onKey(e: KeyboardEvent): void {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || !e.shiftKey)) {
      e.preventDefault();
      this.submit();
    }
  }

  protected use(q: string): void {
    this.store.draft.set(q);
    this.submit();
  }

  protected submit(): void {
    const q = this.store.draft();
    if (q.trim()) this.store.ask(q);
  }
}
