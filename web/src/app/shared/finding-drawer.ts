import { ChangeDetectionStrategy, Component, HostListener, input, output, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

import { MarkdownPipe } from '../core/markdown';

export interface DrawerDoc {
  findingId: string;
  label: string;
  markdown: string;
  status: string;
  auditSeq?: number;
}

/** Slide-over "paper" view of a generated finding, with download / copy / sign-off actions. */
@Component({
  selector: 'kv-finding-drawer',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MarkdownPipe, RouterLink],
  template: `
    @let d = doc();
    <div class="scrim" (click)="closed.emit()"></div>
    <section class="drawer" role="dialog" aria-modal="true" [attr.aria-label]="d.label">
      <header>
        <div class="meta">
          <span class="label-k">{{ d.label }}</span>
          <b class="mono">{{ d.findingId }}</b>
        </div>
        <span class="pill" [class.warn]="d.status === 'PENDING_REVIEW'" [class.ok]="d.status === 'APPROVED'" [class.bad]="d.status === 'REJECTED'">
          <i class="dot"></i>{{ d.status.replace('_', ' ') }}
        </span>
        <div class="acts">
          <button class="btn btn-ghost btn-sm" type="button" (click)="copy()">{{ copied() ? 'Copied ✓' : 'Copy' }}</button>
          <button class="btn btn-ghost btn-sm" type="button" (click)="download()">⬇ .md</button>
          @if (showSignoff()) {
            <a class="btn btn-solid btn-sm" routerLink="/findings" [queryParams]="{ id: d.findingId }" (click)="closed.emit()">Send for sign-off →</a>
          }
          <button class="x" type="button" aria-label="Close" (click)="closed.emit()">✕</button>
        </div>
      </header>
      <div class="paper">
        <div class="stamp mono">DRAFT · HUMAN REVIEW REQUIRED</div>
        <div class="md doc" [innerHTML]="d.markdown | markdown"></div>
      </div>
    </section>
  `,
  styles: [`
    .scrim { position: fixed; inset: 0; z-index: 150; background: #02060bb3; backdrop-filter: blur(6px); animation: fade .3s ease both; }
    .drawer { position: fixed; top: 0; right: 0; bottom: 0; z-index: 160; display: flex; flex-direction: column; width: min(860px, 100vw);
      background: var(--bg2); border-left: 1px solid var(--line-2); box-shadow: -40px 0 120px -40px #000; animation: slide .55s cubic-bezier(.22,1,.36,1) both; }
    header { display: flex; align-items: center; gap: 14px; padding: 18px 24px; border-bottom: 1px solid var(--line); flex-wrap: wrap; }
    .meta { display: flex; flex-direction: column; gap: 3px; b { font-size: 13px; color: var(--ink); } }
    .acts { display: flex; align-items: center; gap: 8px; margin-left: auto; }
    .x { width: 34px; height: 34px; border-radius: 50%; border: 1px solid var(--line-2); color: var(--ink-3); &:hover { color: var(--ink); } }
    .paper { position: relative; flex: 1; overflow: auto; margin: 22px; padding: 40px 46px 50px; border-radius: 20px; background: var(--surface); border: 1px solid var(--line); }
    .stamp { position: absolute; top: 18px; right: 22px; padding: 4px 10px; border: 1px solid color-mix(in srgb, var(--warn) 55%, transparent); border-radius: 6px;
      font-size: 10px; letter-spacing: .18em; color: var(--warn); transform: rotate(2deg); }
    .doc { font-size: 14px; }
    .doc ::ng-deep h1 { padding-right: 180px; }
    @keyframes slide { from { transform: translateX(100%); } to { transform: none; } }
    @keyframes fade { from { opacity: 0; } }
    @media (max-width: 720px) { .paper { margin: 10px; padding: 26px 20px; } .doc ::ng-deep h1 { padding-right: 0; } .stamp { position: static; display: inline-block; margin-bottom: 14px; } }
  `],
})
export class FindingDrawer {
  readonly doc = input.required<DrawerDoc>();
  readonly showSignoff = input(true);
  readonly closed = output<void>();
  protected copied = signal(false);

  @HostListener('document:keydown.escape')
  onEsc(): void {
    this.closed.emit();
  }

  protected async copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.doc().markdown);
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 1600);
    } catch {
      /* ignore */
    }
  }

  protected download(): void {
    const blob = new Blob([this.doc().markdown], { type: 'text/markdown' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${this.doc().findingId}.md`;
    a.click();
    URL.revokeObjectURL(a.href);
  }
}
