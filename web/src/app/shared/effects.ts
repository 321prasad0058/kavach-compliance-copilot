import {
  AfterViewInit, ChangeDetectionStrategy, Component, Directive, ElementRef, HostListener, NgZone, OnDestroy,
  effect, inject, input, signal, viewChild,
} from '@angular/core';

/** CJP custom cursor: dot + lagging ring that grows over interactive elements. */
@Component({
  selector: 'kv-cursor',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="kv-cursor-dot" #dot></div><div class="kv-cursor-ring" #ring></div>`,
})
export class Cursor implements AfterViewInit, OnDestroy {
  private zone = inject(NgZone);
  private dot = viewChild.required<ElementRef<HTMLElement>>('dot');
  private ring = viewChild.required<ElementRef<HTMLElement>>('ring');
  private x = -100; private y = -100; private rx = -100; private ry = -100; private raf = 0;

  ngAfterViewInit(): void {
    if (!matchMedia('(hover: hover) and (pointer: fine)').matches) return;
    this.zone.runOutsideAngular(() => {
      addEventListener('pointermove', this.move, { passive: true });
      addEventListener('pointerover', this.over, { passive: true });
      const tick = () => {
        this.rx += (this.x - this.rx) * 0.18;
        this.ry += (this.y - this.ry) * 0.18;
        this.dot().nativeElement.style.transform = `translate(${this.x}px, ${this.y}px)`;
        this.ring().nativeElement.style.transform = `translate(${this.rx}px, ${this.ry}px)`;
        this.raf = requestAnimationFrame(tick);
      };
      tick();
    });
  }

  ngOnDestroy(): void {
    cancelAnimationFrame(this.raf);
    removeEventListener('pointermove', this.move);
    removeEventListener('pointerover', this.over);
  }

  private move = (e: PointerEvent) => { this.x = e.clientX; this.y = e.clientY; };
  private over = (e: PointerEvent) => {
    const t = e.target as HTMLElement;
    const interactive = !!t.closest('a, button, [role="button"], input, textarea, select, label, .cite');
    this.ring().nativeElement.classList.toggle('hover', interactive);
  };
}

/** CJP 3D tilt + cursor-follow shine. Add class "tilt" styles via host bindings. */
@Directive({ selector: '[kvTilt]', standalone: true, host: { style: 'transform-style: preserve-3d; transition: transform .5s cubic-bezier(.22,1,.36,1)' } })
export class TiltDirective {
  private el = inject(ElementRef<HTMLElement>);
  readonly kvTilt = input(6);

  @HostListener('pointermove', ['$event'])
  onMove(e: PointerEvent): void {
    const r = this.el.nativeElement.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width;
    const py = (e.clientY - r.top) / r.height;
    const max = this.kvTilt();
    this.el.nativeElement.style.transform = `perspective(1000px) rotateX(${(0.5 - py) * max}deg) rotateY(${(px - 0.5) * max}deg)`;
    this.el.nativeElement.style.setProperty('--mx', `${px * 100}%`);
    this.el.nativeElement.style.setProperty('--my', `${py * 100}%`);
  }

  @HostListener('pointerleave')
  onLeave(): void {
    this.el.nativeElement.style.transform = '';
  }
}

/** Animated number (ease-out count), used for KPIs and the audit ring. */
@Component({
  selector: 'kv-count',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `{{ text() }}`,
})
export class CountUp {
  readonly value = input<number | null | undefined>(0);
  readonly format = input<(n: number) => string>((n) => Math.round(n).toLocaleString('en-IN'));
  protected text = signal('—');
  private from = 0;
  private raf = 0;

  constructor() {
    effect(() => {
      const target = this.value();
      const fmt = this.format();
      if (target === null || target === undefined || !Number.isFinite(target)) { this.text.set('—'); return; }
      cancelAnimationFrame(this.raf);
      const start = performance.now();
      const from = this.from;
      const dur = 1100;
      const step = (now: number) => {
        const k = Math.min(1, (now - start) / dur);
        const e = 1 - Math.pow(1 - k, 4);
        const v = from + (target - from) * e;
        this.text.set(fmt(v));
        if (k < 1) this.raf = requestAnimationFrame(step);
        else this.from = target;
      };
      this.raf = requestAnimationFrame(step);
    });
  }
}

/** CJP preloader: counting number + filling hairline, then a clip-path wipe. */
@Component({
  selector: 'kv-preloader',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="ld" [class.done]="done()" aria-hidden="true">
      <div class="in">
        <div class="num mono">{{ count() }}</div>
        <div class="bar"><i [style.transform]="'scaleX(' + count() / 100 + ')'"></i></div>
        <div class="tag">Kavach · Governed intelligence</div>
      </div>
    </div>
  `,
  styles: [`
    .ld { position: fixed; inset: 0; z-index: 300; display: grid; place-items: center; background: var(--bg);
      clip-path: inset(0 0 0 0); transition: clip-path .9s cubic-bezier(.22,1,.36,1); }
    .ld.done { clip-path: inset(0 0 100% 0); pointer-events: none; }
    .in { text-align: center; }
    .num { font-size: clamp(56px, 10vw, 110px); font-weight: 300; line-height: 1; letter-spacing: -.04em; }
    .bar { position: relative; width: min(280px, 60vw); height: 1px; margin: 26px auto 0; background: var(--line); overflow: hidden; }
    .bar i { position: absolute; inset: 0; display: block; background: var(--accent); transform-origin: left; }
    .tag { margin-top: 18px; font-size: 11px; letter-spacing: .34em; text-transform: uppercase; color: var(--ink-3); }
    @media (prefers-reduced-motion: reduce) { .ld { display: none; } }
  `],
})
export class Preloader implements AfterViewInit {
  protected count = signal(0);
  readonly done = signal(false);

  ngAfterViewInit(): void {
    const start = performance.now();
    const dur = 1100;
    const step = (now: number) => {
      const k = Math.min(1, (now - start) / dur);
      this.count.set(Math.round(100 * (1 - Math.pow(1 - k, 3))));
      if (k < 1) requestAnimationFrame(step);
      else setTimeout(() => this.done.set(true), 160);
    };
    requestAnimationFrame(step);
  }
}
