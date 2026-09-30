import { Injectable, computed, inject, signal } from '@angular/core';

import { ApiService } from './api.service';
import { AskResult, Finding, FindingType, Kpis, Meta, PipelineStep, StepKey } from './contract';

export const STEP_ORDER: { key: StepKey; label: string; short: string }[] = [
  { key: 'route', label: 'Understand the question', short: 'Route' },
  { key: 'analyst', label: 'Cortex Analyst · governed SQL', short: 'Data' },
  { key: 'search', label: 'Cortex Search · policy clauses', short: 'Policy' },
  { key: 'synthesis', label: 'Cited synthesis', short: 'Synthesis' },
  { key: 'audit', label: 'Immutable audit log', short: 'Audit' },
];

export type RunState = 'idle' | 'running' | 'done' | 'error';

@Injectable({ providedIn: 'root' })
export class KavachStore {
  private api = inject(ApiService);

  readonly meta = signal<Meta | null>(null);
  readonly metaError = signal<string | null>(null);
  readonly kpis = signal<Kpis | null>(null);

  readonly history = signal<AskResult[]>([]);
  readonly selectedId = signal<string | null>(null);
  readonly selected = computed(() => this.history().find((r) => r.id === this.selectedId()) ?? null);

  readonly draft = signal('');
  /** True when the current question was spoken; answers are then read back. */
  readonly viaVoice = signal(false);
  readonly runState = signal<RunState>('idle');
  readonly runQuestion = signal('');
  readonly runError = signal<string | null>(null);
  readonly steps = signal<Record<string, PipelineStep>>({});

  readonly findings = signal<Record<string, Finding[]>>({});
  readonly generating = signal<string | null>(null);

  /** Compact layout once the user has asked something. */
  readonly engaged = computed(() => this.runState() !== 'idle' || this.history().length > 0);

  async boot(): Promise<void> {
    try {
      this.meta.set(await this.api.meta());
      this.metaError.set(null);
    } catch (e: any) {
      this.metaError.set(e?.message ?? 'Kavach API is not reachable');
    }
    this.refreshKpis();
  }

  async refreshKpis(): Promise<void> {
    try {
      this.kpis.set(await this.api.kpis());
    } catch {
      /* keep last good value */
    }
  }

  ask(question: string, viaVoice = false): void {
    const q = question.trim();
    if (!q || this.runState() === 'running') return;
    this.viaVoice.set(viaVoice);
    this.runQuestion.set(q);
    this.runState.set('running');
    this.runError.set(null);
    this.steps.set({});
    this.api.ask(q).subscribe({
      next: (ev) => {
        if (ev.type === 'step') {
          this.steps.update((s) => ({ ...s, [ev.step.key]: ev.step }));
        } else if (ev.type === 'result') {
          const r = ev.result;
          const s: Record<string, PipelineStep> = {};
          r.steps.forEach((st) => (s[st.key] = st));
          this.steps.set(s);
          this.history.update((h) => [r, ...h.filter((x) => x.id !== r.id)]);
          this.selectedId.set(r.id);
          this.runState.set('done');
          this.draft.set('');
          this.refreshKpis();
        } else {
          this.runError.set(ev.message);
          this.runState.set('error');
        }
      },
      error: (e) => {
        this.runError.set(e?.message ?? 'Request failed');
        this.runState.set('error');
      },
    });
  }

  select(id: string): void {
    this.selectedId.set(id);
    const r = this.history().find((x) => x.id === id);
    if (r) {
      const s: Record<string, PipelineStep> = {};
      r.steps.forEach((st) => (s[st.key] = st));
      this.steps.set(s);
      this.runQuestion.set(r.question);
      this.runState.set('done');
    }
  }

  async generateFinding(result: AskResult, type: FindingType): Promise<Finding> {
    this.generating.set(result.id);
    try {
      const f = await this.api.generateFinding(result.id, type);
      this.findings.update((m) => ({ ...m, [result.id]: [f, ...(m[result.id] ?? [])] }));
      return f;
    } finally {
      this.generating.set(null);
    }
  }

  reset(): void {
    this.history.set([]);
    this.selectedId.set(null);
    this.runState.set('idle');
    this.steps.set({});
    this.draft.set('');
  }
}
