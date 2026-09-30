import { ChangeDetectionStrategy, Component, HostListener, OnDestroy, OnInit, effect, inject, signal, viewChild } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';

import { AccessService } from './core/access.service';
import { ApiService } from './core/api.service';
import { ChainStatus } from './core/contract';
import { KavachStore } from './core/kavach.store';
import { Persona, PersonaService } from './core/persona.service';
import { VoiceService } from './core/voice.service';
import { AccessGate } from './shared/access-gate';
import { Cursor, Preloader } from './shared/effects';
import { ShaderBackdrop } from './shared/shader-backdrop';
import { ThemeToggle } from './shared/theme-toggle';

@Component({
  selector: 'app-root',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet, RouterLink, RouterLinkActive, ShaderBackdrop, ThemeToggle, Cursor, Preloader, AccessGate],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App implements OnInit, OnDestroy {
  protected store = inject(KavachStore);
  protected persona = inject(PersonaService);
  protected access = inject(AccessService);
  private api = inject(ApiService);
  private backdrop = viewChild(ShaderBackdrop);
  private voice = inject(VoiceService);

  protected chain = signal<ChainStatus | null>(null);
  protected personaOpen = signal(false);
  protected scrolled = signal(false);
  private timer?: ReturnType<typeof setInterval>;

  constructor() {
    effect(() => this.backdrop()?.setEnergy(this.store.runState() === 'running' ? 1 : this.voice.listening() ? 0.55 + this.voice.level() * 0.45 : 0));
    effect(() => {
      // refresh chain status whenever a new audited answer lands
      this.store.history();
      this.refreshChain();
    });
  }

  ngOnInit(): void {
    this.store.boot();
    this.timer = setInterval(() => {
      this.store.refreshKpis();
      this.refreshChain();
    }, 20000);
  }

  ngOnDestroy(): void {
    clearInterval(this.timer);
  }

  @HostListener('window:scroll')
  onScroll(): void {
    this.scrolled.set(scrollY > 8);
  }

  @HostListener('document:keydown.escape')
  closeMenus(): void {
    this.personaOpen.set(false);
  }

  protected pick(p: Persona): void {
    this.persona.set(p);
    this.personaOpen.set(false);
  }

  private async refreshChain(): Promise<void> {
    try {
      this.chain.set(await this.api.chainStatus());
    } catch {
      /* API may be warming up */
    }
  }
}
