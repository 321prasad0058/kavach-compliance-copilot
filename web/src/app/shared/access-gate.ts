import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';

import { AccessService } from '../core/access.service';
import { KavachCore } from './kavach-core';

/** Full-screen unlock shown when the API answers 401 (deployment has KAVACH_ACCESS_CODE set). */
@Component({
  selector: 'kv-access-gate',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [KavachCore],
  template: `
    <div class="gate" role="dialog" aria-modal="true" aria-labelledby="gate-t">
      <form class="edge" (submit)="unlock($event)"><div class="edge-in">
        <kv-core [state]="access.rejected() ? 'alert' : 'idle'" [size]="64" />
        <div class="label-k">Private preview</div>
        <h2 id="gate-t">Enter the access code</h2>
        <p>This Kavach deployment runs on a live Snowflake account. Ask the team for the code.</p>
        <label class="fld" for="gate-code">
          <input id="gate-code" type="password" autocomplete="off" autofocus placeholder="Access code"
                 [value]="value()" (input)="value.set($any($event.target).value)">
        </label>
        @if (access.rejected()) { <p class="err">That code didn't work. Check it and try again.</p> }
        <button class="btn btn-solid" type="submit" [disabled]="!value().trim()">Unlock <span class="arr">→</span></button>
      </div></form>
    </div>
  `,
  styles: [`
    .gate { position: fixed; inset: 0; z-index: 250; display: grid; place-items: center; padding: 20px;
      background: color-mix(in srgb, var(--bg) 82%, transparent); backdrop-filter: blur(14px); }
    form { width: min(420px, 100%); }
    .edge-in { display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 34px 30px 30px; text-align: center; }
    h2 { font-size: 22px; font-weight: 750; letter-spacing: -.02em; }
    p { font-size: 13.5px; line-height: 1.6; color: var(--ink-2); }
    .fld { width: 100%; margin-top: 6px; }
    input { width: 100%; padding: 13px 16px; border-radius: 14px; border: 1px solid var(--line-2); background: var(--glass);
      font-size: 15px; color: var(--ink); outline: none; text-align: center; letter-spacing: .08em;
      &:focus { border-color: var(--accent); box-shadow: 0 0 0 4px rgba(var(--accent-rgb), .13); } }
    .err { color: var(--bad); font-size: 12.5px; }
    .btn { width: 100%; margin-top: 4px; }
  `],
})
export class AccessGate {
  protected access = inject(AccessService);
  protected value = signal('');

  protected unlock(e: Event): void {
    e.preventDefault();
    if (!this.value().trim()) return;
    this.access.set(this.value());
    location.reload(); // simplest way to re-run every data load with the code attached
  }
}
