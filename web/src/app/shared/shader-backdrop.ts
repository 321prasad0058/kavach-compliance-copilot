import {
  AfterViewInit, ChangeDetectionStrategy, Component, ElementRef, NgZone, OnDestroy, effect, inject, viewChild,
} from '@angular/core';

import { ThemeService } from '../core/theme.service';

const VERT = `attribute vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }`;

// VANA "liquid forest" flow field, tuned down to a calm, low-contrast aurora for a data product.
const FRAG = `
precision mediump float;
uniform float t; uniform vec2 res; uniform vec3 ca; uniform vec3 cb; uniform vec3 cc; uniform float energy;
vec2 h(vec2 p){ p = vec2(dot(p,vec2(127.1,311.7)), dot(p,vec2(269.5,183.3))); return -1.0 + 2.0*fract(sin(p)*43758.5453); }
float n(vec2 p){
  const float K1 = 0.366025404; const float K2 = 0.211324865;
  vec2 i = floor(p + (p.x+p.y)*K1); vec2 a = p - i + (i.x+i.y)*K2;
  vec2 o = (a.x>a.y) ? vec2(1.0,0.0) : vec2(0.0,1.0);
  vec2 b = a - o + K2; vec2 c = a - 1.0 + 2.0*K2;
  vec3 hh = max(0.5 - vec3(dot(a,a), dot(b,b), dot(c,c)), 0.0);
  vec3 nn = hh*hh*hh*hh*vec3(dot(a,h(i)), dot(b,h(i+o)), dot(c,h(i+1.0)));
  return dot(nn, vec3(70.0));
}
float fbm(vec2 p){ float f = 0.0; float w = 0.5; for (int i = 0; i < 4; i++){ f += w*n(p); p *= 2.0; w *= 0.5; } return f; }
void main(){
  vec2 uv = gl_FragCoord.xy / res; vec2 p = uv*2.0 - 1.0; p.x *= res.x/res.y;
  float s = t*0.05*(1.0 + energy*1.6);
  vec2 q = vec2(fbm(p*1.2 + vec2(s, -s*0.6)), fbm(p*1.2 + vec2(-s*0.4, s*0.8)));
  float f = fbm(p*1.4 + q*1.6 + vec2(s*0.3));
  float glow = smoothstep(0.05, 0.85, f*0.5 + 0.5);
  float top = smoothstep(1.3, -0.4, length(p - vec2(0.9, 0.85)));
  vec3 col = mix(ca, cb, glow*0.9);
  col = mix(col, cc, pow(glow, 3.0)*(0.18 + energy*0.22) + top*0.10);
  float vig = smoothstep(1.9, 0.3, length(p*vec2(0.8, 1.0)));
  gl_FragColor = vec4(mix(ca, col, vig), 1.0);
}`;

@Component({
  selector: 'kv-shader-backdrop',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <canvas #cv aria-hidden="true"></canvas>
    <div class="aurora" aria-hidden="true"><i class="a1"></i><i class="a2"></i><i class="a3"></i></div>
    <div class="grid" aria-hidden="true"></div>
  `,
  styles: [`
    :host { position: fixed; inset: 0; z-index: -1; pointer-events: none; background: var(--bg); transition: background-color .8s; }
    canvas { position: absolute; inset: 0; width: 100%; height: 100%; opacity: .9; }
    .aurora i { position: absolute; border-radius: 50%; filter: blur(90px); opacity: .5; animation: drift 26s ease-in-out infinite alternate; }
    .a1 { width: 680px; height: 680px; top: -240px; right: -140px; background: radial-gradient(circle, rgba(var(--accent-rgb), .30), transparent 65%); }
    .a2 { width: 560px; height: 560px; bottom: -220px; left: -160px; background: radial-gradient(circle, rgba(var(--accent-rgb), .14), transparent 65%); animation-duration: 32s !important; }
    .a3 { width: 340px; height: 340px; top: 40%; left: 44%; background: radial-gradient(circle, rgba(var(--accent-rgb), .10), transparent 65%); animation-duration: 21s !important; }
    .grid { position: absolute; inset: 0; opacity: .45;
      background-image: linear-gradient(var(--line) 1px, transparent 1px), linear-gradient(90deg, var(--line) 1px, transparent 1px);
      background-size: 72px 72px; mask-image: radial-gradient(ellipse 70% 55% at 50% 22%, #000 25%, transparent 75%); }
    @keyframes drift { from { transform: translate(0,0) scale(1); } to { transform: translate(-60px, 50px) scale(1.12); } }
    :host-context([data-theme='daylight']) .aurora i { opacity: .35; }
    :host-context([data-theme='daylight']) canvas { opacity: .7; }
  `],
})
export class ShaderBackdrop implements AfterViewInit, OnDestroy {
  private zone = inject(NgZone);
  private theme = inject(ThemeService);
  private canvas = viewChild.required<ElementRef<HTMLCanvasElement>>('cv');

  private gl: WebGLRenderingContext | null = null;
  private prog: WebGLProgram | null = null;
  private raf = 0;
  private colors = { a: [0, 0, 0], b: [0, 0, 0], c: [0, 0, 0] };
  private energy = 0;
  private energyTarget = 0;
  private reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  constructor() {
    effect(() => {
      this.theme.theme();
      queueMicrotask(() => this.readColors());
    });
  }

  /** 0 = calm, 1 = Kavach is working (flow speeds up and brightens). */
  setEnergy(v: number): void {
    this.energyTarget = v;
  }

  ngAfterViewInit(): void {
    const cv = this.canvas().nativeElement;
    const gl = cv.getContext('webgl', { antialias: false, premultipliedAlpha: false });
    if (!gl) return; // CSS aurora still renders
    this.gl = gl;
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return;
    gl.useProgram(prog);
    this.prog = prog;
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    this.readColors();
    this.zone.runOutsideAngular(() => {
      addEventListener('resize', this.resize);
      document.addEventListener('visibilitychange', this.onVis);
      this.resize();
      this.loop(performance.now());
    });
  }

  ngOnDestroy(): void {
    cancelAnimationFrame(this.raf);
    removeEventListener('resize', this.resize);
    document.removeEventListener('visibilitychange', this.onVis);
  }

  private readColors(): void {
    const cs = getComputedStyle(document.documentElement);
    const parse = (v: string) => v.split(',').map((x) => parseFloat(x));
    this.colors = { a: parse(cs.getPropertyValue('--shader-a')), b: parse(cs.getPropertyValue('--shader-b')), c: parse(cs.getPropertyValue('--shader-c')) };
    if (this.reduced) this.draw(12);
  }

  private resize = () => {
    const cv = this.canvas().nativeElement;
    const scale = Math.min(devicePixelRatio, 1.5) * 0.5; // half-res: it's a soft backdrop
    cv.width = Math.floor(innerWidth * scale);
    cv.height = Math.floor(innerHeight * scale);
    this.gl?.viewport(0, 0, cv.width, cv.height);
    if (this.reduced) this.draw(12);
  };

  private onVis = () => {
    cancelAnimationFrame(this.raf);
    if (!document.hidden && !this.reduced) this.loop(performance.now());
  };

  private loop = (now: number) => {
    this.energy += (this.energyTarget - this.energy) * 0.03;
    this.draw(now / 1000);
    if (!this.reduced) this.raf = requestAnimationFrame(this.loop);
  };

  private draw(t: number): void {
    const gl = this.gl;
    const p = this.prog;
    if (!gl || !p) return;
    const cv = this.canvas().nativeElement;
    gl.uniform1f(gl.getUniformLocation(p, 't'), t);
    gl.uniform2f(gl.getUniformLocation(p, 'res'), cv.width, cv.height);
    gl.uniform3fv(gl.getUniformLocation(p, 'ca'), this.colors.a);
    gl.uniform3fv(gl.getUniformLocation(p, 'cb'), this.colors.b);
    gl.uniform3fv(gl.getUniformLocation(p, 'cc'), this.colors.c);
    gl.uniform1f(gl.getUniformLocation(p, 'energy'), this.energy);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}
