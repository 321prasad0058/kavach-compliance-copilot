import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import { PipelineStep } from '../../core/contract';
import { RunState, STEP_ORDER } from '../../core/kavach.store';
import { CoreState, KavachCore } from '../../shared/kavach-core';

/** Live view of the governed pipeline: route → data → policy → synthesis → audit. */
@Component({
  selector: 'kv-pipeline',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [KavachCore],
  template: `
    <div class="pipe edge"><div class="edge-in">
      <div class="head">
        <kv-core [state]="coreState()" [size]="54" />
        <div class="q">
          <span class="label-k">{{ state() === 'running' ? 'Kavach is working' : state() === 'error' ? 'Something went wrong' : 'Evidence chain' }}</span>
          <p>{{ question() }}</p>
        </div>
        @if (total() > 0 && state() !== 'running') {
          <span class="pill mono">⏱ {{ (total() / 1000).toFixed(1) }}s</span>
        }
      </div>
      <ol class="steps">
        @for (s of view(); track s.key; let i = $index) {
          <li [class]="s.status">
            <div class="bar"><i></i></div>
            <div class="n mono">0{{ i + 1 }}</div>
            <div class="t">
              <b>{{ s.label }}</b>
              <span>
                @switch (s.status) {
                  @case ('running') { <i class="spin"></i> working… }
                  @case ('pending') { waiting }
                  @case ('skipped') { not needed }
                  @default { {{ s.detail || (s.status === 'done' ? 'done' : 'failed') }} }
                }
              </span>
            </div>
            @if (s.ms && (s.status === 'done' || s.status === 'error')) {
              <em class="mono">{{ s.ms < 1000 ? s.ms + 'ms' : (s.ms / 1000).toFixed(1) + 's' }}</em>
            }
          </li>
        }
      </ol>
    </div></div>
  `,
  styles: [`
    :host { display: block; min-width: 0; }
    .edge-in { padding: 18px 22px 20px; }
    .head { display: flex; align-items: center; gap: 16px; margin-bottom: 16px; }
    .q { flex: 1; min-width: 0; p { margin-top: 4px; font-size: 15px; font-weight: 600; color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } }
    .steps { list-style: none; display: grid; grid-template-columns: repeat(5, 1fr); gap: 10px; }
    li { position: relative; display: grid; grid-template-columns: auto 1fr; grid-template-rows: auto auto; column-gap: 10px; padding-top: 14px; transition: opacity .4s; }
    .bar { position: absolute; top: 0; left: 0; right: 0; height: 3px; border-radius: 99px; background: var(--line); overflow: hidden;
      i { position: absolute; inset: 0; background: var(--accent); transform: scaleX(0); transform-origin: left; transition: transform .6s cubic-bezier(.25,1,.5,1); } }
    .n { font-size: 11px; color: var(--ink-3); padding-top: 2px; }
    .t { display: flex; flex-direction: column; gap: 3px; min-width: 0;
      b { font-size: 12.5px; font-weight: 600; color: var(--ink-2); }
      span { font-size: 11.5px; color: var(--ink-3); line-height: 1.4; } }
    em { grid-column: 2; font-style: normal; font-size: 10.5px; color: var(--ink-3); margin-top: 4px; }
    li.running .bar i { transform: scaleX(.6); animation: kv-pulse 1.1s ease-in-out infinite; }
    li.running b, li.done b { color: var(--ink); }
    li.done .bar i { transform: scaleX(1); }
    li.done .n { color: var(--accent-ink); }
    li.skipped { opacity: .45; }
    li.skipped .bar i { transform: scaleX(1); background: var(--line-2); }
    li.error .bar i { transform: scaleX(1); background: var(--bad); }
    li.error span { color: var(--bad); }
    li.pending { opacity: .55; }
    .spin { display: inline-block; width: 9px; height: 9px; margin-right: 4px; border-radius: 50%; border: 1.5px solid var(--accent); border-right-color: transparent; animation: kv-spin .7s linear infinite; vertical-align: -1px; }
    @media (max-width: 900px) { .steps { grid-template-columns: 1fr 1fr; } }
  `],
})
export class Pipeline {
  readonly steps = input<Record<string, PipelineStep>>({});
  readonly state = input<RunState>('idle');
  readonly question = input('');

  protected view = computed(() =>
    STEP_ORDER.map((d) => {
      const s = this.steps()[d.key];
      const status = (s?.status ?? 'pending') as string;
      return { key: d.key, label: s?.label || d.label, status, detail: s?.detail, ms: s?.ms ?? 0 };
    }),
  );

  protected total = computed(() => Object.values(this.steps()).reduce((a, s) => a + (s.ms || 0), 0));

  protected coreState = computed<CoreState>(() =>
    this.state() === 'running' ? 'thinking' : this.state() === 'error' ? 'alert' : this.state() === 'done' ? 'done' : 'idle',
  );
}
