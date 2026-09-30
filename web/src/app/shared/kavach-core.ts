import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

export type CoreState = 'idle' | 'thinking' | 'done' | 'alert';

/** VANA "vitality core": a breathing shield orb that reflects what Kavach is doing. */
@Component({
  selector: 'kv-core',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="core" [class]="state()" [style.width.px]="size()" [style.height.px]="size()">
      <i class="halo"></i>
      <i class="ring r1"></i>
      <i class="ring r2"></i>
      <div class="sphere">
        <svg viewBox="0 0 24 24" [attr.width]="size() * 0.42" [attr.height]="size() * 0.42" aria-hidden="true">
          <path d="M12 2.5l7.5 3v5.6c0 4.7-3.2 8.4-7.5 9.9-4.3-1.5-7.5-5.2-7.5-9.9V5.5L12 2.5z"
                fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
          @if (state() === 'alert') {
            <path d="M12 8v5M12 16h.01" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
          } @else {
            <path class="tick" d="M8.6 12.2l2.4 2.4 4.6-5" fill="none" stroke="currentColor" stroke-width="1.9"
                  stroke-linecap="round" stroke-linejoin="round"/>
          }
        </svg>
      </div>
    </div>
  `,
  styles: [`
    :host { display: inline-grid; place-items: center; }
    .core { position: relative; display: grid; place-items: center; --c: var(--accent); --c-rgb: var(--accent-rgb); }
    .core.alert { --c: var(--bad); }
    .core.done { --c: var(--ok); }
    .halo { position: absolute; inset: -18%; border-radius: 50%; background: radial-gradient(circle, color-mix(in srgb, var(--c) 55%, transparent), transparent 65%);
      filter: blur(14px); opacity: .35; animation: breath 4s ease-in-out infinite; }
    .ring { position: absolute; inset: 0; border-radius: 50%; border: 1px solid color-mix(in srgb, var(--c) 40%, transparent); }
    .r1 { border-top-color: var(--c); animation: spin 9s linear infinite; }
    .r2 { inset: 14%; border-style: dashed; opacity: .5; animation: spin 14s linear infinite reverse; }
    .sphere { position: relative; display: grid; place-items: center; width: 62%; height: 62%; border-radius: 50%; color: var(--c);
      background: radial-gradient(circle at 32% 28%, color-mix(in srgb, white 70%, var(--c)), color-mix(in srgb, var(--c) 22%, transparent) 42%, transparent 72%);
      box-shadow: 0 0 40px color-mix(in srgb, var(--c) 35%, transparent), inset 0 0 18px rgba(255,255,255,.18); }
    .sphere svg { filter: drop-shadow(0 0 6px color-mix(in srgb, var(--c) 80%, transparent)); }
    .thinking .halo { animation-duration: 1.4s; opacity: .6; }
    .thinking .r1 { animation-duration: 1.6s; }
    .thinking .r2 { animation-duration: 2.8s; }
    .thinking .tick { stroke-dasharray: 14; animation: draw 1.2s ease-in-out infinite; }
    .done .tick { stroke-dasharray: 14; animation: draw .7s cubic-bezier(.22,1,.36,1) both; }
    @keyframes breath { 0%,100% { transform: scale(.94); opacity: .3; } 50% { transform: scale(1.06); opacity: .55; } }
    @keyframes spin { to { transform: rotate(360deg); } }
    @keyframes draw { from { stroke-dashoffset: 14; } to { stroke-dashoffset: 0; } }
  `],
})
export class KavachCore {
  readonly state = input<CoreState>('idle');
  readonly size = input(64);
  protected readonly _ = computed(() => this.state());
}
