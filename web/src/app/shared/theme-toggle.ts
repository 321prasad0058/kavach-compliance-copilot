import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';

import { ThemeService } from '../core/theme.service';

/** VANA three-mode switcher with a spring-sliding glow orb. */
@Component({
  selector: 'kv-theme-toggle',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="tt" role="radiogroup" aria-label="Theme">
      <i class="orb" [style.transform]="'translateX(' + index() * 40 + 'px)'" [style.background]="glow()"
         [style.box-shadow]="'0 0 22px ' + glow() + '99'"></i>
      @for (o of theme.options; track o.id) {
        <button type="button" role="radio" [attr.aria-checked]="theme.theme() === o.id" [class.on]="theme.theme() === o.id"
                [attr.aria-label]="o.label + ' theme'" [title]="o.label" (click)="theme.set(o.id)">
          @switch (o.id) {
            @case ('midnight') {
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 2.5l7.5 3v5.6c0 4.7-3.2 8.4-7.5 9.9-4.3-1.5-7.5-5.2-7.5-9.9V5.5z"/></svg>
            }
            @case ('obsidian') {
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>
            }
            @case ('daylight') {
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>
            }
          }
        </button>
      }
    </div>
  `,
  styles: [`
    .tt { position: relative; display: flex; gap: 4px; padding: 4px; border-radius: 99px; border: 1px solid var(--line-2);
      background: var(--glass); backdrop-filter: blur(20px); }
    .orb { position: absolute; top: 4px; left: 4px; width: 36px; height: 36px; border-radius: 50%; filter: blur(1px); opacity: .9;
      transition: transform .55s cubic-bezier(.34,1.56,.64,1), background-color .5s, box-shadow .5s; }
    button { position: relative; z-index: 1; display: grid; place-items: center; width: 36px; height: 36px; border-radius: 50%;
      color: var(--ink-3); transition: color .3s, transform .3s; }
    button:hover { color: var(--ink); }
    button.on { color: #fff; transform: scale(1.06); }
  `],
})
export class ThemeToggle {
  protected theme = inject(ThemeService);
  protected index = computed(() => this.theme.options.findIndex((o) => o.id === this.theme.theme()));
  protected glow = computed(() => this.theme.options[this.index()].glow);
}
