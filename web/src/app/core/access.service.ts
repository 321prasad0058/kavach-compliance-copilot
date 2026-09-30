import { Injectable, signal } from '@angular/core';

const KEY = 'kavach_access_v1';

/**
 * Shared access code for public deployments. The API only asks for it when KAVACH_ACCESS_CODE is set;
 * the first 401 flips `required`, the unlock screen collects the code, and it is remembered per browser.
 */
@Injectable({ providedIn: 'root' })
export class AccessService {
  readonly code = signal(this.read());
  readonly required = signal(false);
  readonly rejected = signal(false);

  set(code: string): void {
    this.code.set(code.trim());
    this.required.set(false);
    this.rejected.set(false);
    try { localStorage.setItem(KEY, this.code()); } catch { /* private window: keep it for this tab only */ }
  }

  /** Called on any 401 from the API. */
  deny(): void {
    this.rejected.set(!!this.code());
    this.required.set(true);
  }

  forget(): void {
    this.code.set('');
    try { localStorage.removeItem(KEY); } catch { /* ignore */ }
  }

  private read(): string {
    try { return localStorage.getItem(KEY) ?? ''; } catch { return ''; }
  }
}
