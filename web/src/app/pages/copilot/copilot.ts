import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, computed, effect, inject, input, signal, untracked, viewChild } from '@angular/core';
import { Router } from '@angular/router';

import { Finding } from '../../core/contract';
import { inr } from '../../core/format';
import { KavachStore } from '../../core/kavach.store';
import { VoiceService, parseVoiceCommand } from '../../core/voice.service';
import { CountUp } from '../../shared/effects';
import { DrawerDoc, FindingDrawer } from '../../shared/finding-drawer';
import { AnswerCard } from './answer-card';
import { Composer } from './composer';
import { EvidencePanel } from './evidence-panel';
import { Pipeline } from './pipeline';

@Component({
  selector: 'kv-copilot',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Composer, Pipeline, AnswerCard, EvidencePanel, FindingDrawer, CountUp],
  templateUrl: './copilot.html',
  styleUrl: './copilot.scss',
})
export class CopilotPage implements OnInit, OnDestroy {
  protected store = inject(KavachStore);
  private router = inject(Router);
  private composer = viewChild(Composer);
  protected voice = inject(VoiceService);
  protected toast = signal<string | null>(null);
  private spokenFor: string | null = null;

  /** ?q= deep link, used by "Investigate" on the alert queue. */
  readonly q = input<string>();

  protected cite = signal<{ tag: string; n: number } | null>(null);
  protected drawer = signal<DrawerDoc | null>(null);
  protected gnpa = computed(() => {
    const k = this.store.kpis();
    return k && k.totalExposure ? (k.npaExposure / k.totalExposure) * 100 : null;
  });
  protected crore = (n: number) => inr(n, 1);
  protected pct = (n: number) => `${n.toFixed(2)}%`;
  protected int = (n: number) => Math.round(n).toLocaleString('en-IN');

  constructor() {
    // Read a fresh answer aloud only when the user has turned on "Read answers aloud".
    effect(() => {
      const r = this.store.selected();
      const done = this.store.runState() === 'done';
      if (!r || !done || r.id === this.spokenFor) return;
      this.spokenFor = r.id;
      untracked(() => {
        if (this.voice.autoSpeak()) this.voice.speak(r.answer);
      });
    });
  }

  ngOnDestroy(): void {
    this.voice.stop(false);
    this.voice.stopSpeaking();
  }

  /** Spoken input: short commands act on the current result, anything else is a question. */
  protected async onVoice(text: string): Promise<void> {
    const cmd = parseVoiceCommand(text);
    const r = this.store.selected();
    switch (cmd.kind) {
      case 'ask':
        this.store.draft.set(cmd.text);
        this.store.ask(cmd.text, true);
        return;
      case 'read':
        if (r) this.voice.speak(r.answer);
        return;
      case 'stop':
        this.voice.stopSpeaking();
        return;
      case 'new':
        this.newThread();
        return;
      case 'go':
        this.router.navigateByUrl(cmd.path);
        return;
      case 'finding':
        if (!r) return this.flash('Ask a question first, then say “generate case note”.');
        this.flash(`Drafting ${cmd.type.replace('_', ' ').toLowerCase()}…`);
        try {
          this.openFinding(await this.store.generateFinding(r, cmd.type));
        } catch {
          this.flash('Could not generate the finding.');
        }
        return;
    }
  }

  private flash(msg: string): void {
    this.toast.set(msg);
    setTimeout(() => this.toast.set(null), 2600);
  }

  ngOnInit(): void {
    const q = this.q();
    if (q) {
      this.store.draft.set(q);
      this.router.navigate([], { queryParams: {}, replaceUrl: true });
      setTimeout(() => this.store.ask(q), 350);
    }
  }

  protected onCite(tag: string): void {
    this.cite.set({ tag, n: Date.now() });
  }

  protected openFinding(f: Finding): void {
    this.drawer.set({ findingId: f.findingId, label: f.label, markdown: f.markdown, status: f.status, auditSeq: f.audit.auditSeq });
  }

  protected newThread(): void {
    this.store.reset();
    setTimeout(() => this.composer()?.focus(), 50);
  }
}
