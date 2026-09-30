import { Injectable, NgZone, inject, signal } from '@angular/core';

type SR = any; // SpeechRecognition is not in lib.dom for all browsers

const AUTO_KEY = 'kavach_autospeak_v1';
const SILENCE_MS = 2200;   // pause this long after speaking -> send
const NO_SPEECH_MS = 9000; // nothing heard -> give up quietly
const MAX_MS = 45000;      // hard cap per utterance

/**
 * Voice in / voice out, following VANA's approach: the browser Web Speech API
 * (continuous, interim results, en-IN) with a silence timer, plus speechSynthesis for read-back
 * and a Web Audio level meter that drives the listening visual.
 */
@Injectable({ providedIn: 'root' })
export class VoiceService {
  private zone = inject(NgZone);
  private Recognition: SR = (globalThis as any).SpeechRecognition || (globalThis as any).webkitSpeechRecognition;

  readonly supported = !!this.Recognition;
  readonly ttsSupported = typeof speechSynthesis !== 'undefined';

  readonly listening = signal(false);
  readonly transcript = signal('');
  readonly level = signal(0);           // 0..1 mic loudness
  readonly error = signal<string | null>(null);
  readonly speaking = signal(false);
  readonly autoSpeak = signal(this.readAuto());

  private rec: SR | null = null;
  private active = false;
  private onFinal: ((text: string) => void) | null = null;
  private silenceTimer?: ReturnType<typeof setTimeout>;
  private capTimer?: ReturnType<typeof setTimeout>;
  private stream: MediaStream | null = null;
  private audioCtx: AudioContext | null = null;
  private raf = 0;

  toggle(onFinal: (text: string) => void): void {
    this.listening() ? this.stop(true) : this.start(onFinal);
  }

  start(onFinal: (text: string) => void): void {
    if (!this.supported || this.active) return;
    this.stopSpeaking();
    this.error.set(null);
    this.transcript.set('');
    this.onFinal = onFinal;
    this.active = true;
    this.listening.set(true);

    const rec: SR = new this.Recognition();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = 'en-IN';
    rec.onresult = (e: any) => this.zone.run(() => {
      let full = '';
      for (let i = 0; i < e.results.length; i++) full += e.results[i][0].transcript;
      this.transcript.set(full.trim());
      this.armSilence(SILENCE_MS);
    });
    // Chrome ends continuous sessions on its own; restart unless we stopped on purpose (VANA's guard).
    rec.onend = () => {
      if (this.rec === rec && this.active) {
        try { rec.start(); } catch { /* already started */ }
      }
    };
    rec.onerror = (e: any) => this.zone.run(() => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        this.error.set('Microphone access was blocked. Allow it in the browser address bar and try again.');
        this.stop(false);
      } else if (e.error === 'network') {
        this.error.set('Speech service unreachable. Voice needs an internet connection in this browser.');
        this.stop(false);
      }
    });
    this.rec = rec;
    try { rec.start(); } catch { /* ignore */ }
    this.armSilence(NO_SPEECH_MS);
    this.capTimer = setTimeout(() => this.stop(true), MAX_MS);
    this.startMeter();
  }

  /** Stop listening. `send` delivers the transcript to the caller if anything was heard. */
  stop(send: boolean): void {
    if (!this.active) return;
    this.active = false;
    clearTimeout(this.silenceTimer);
    clearTimeout(this.capTimer);
    const rec = this.rec;
    this.rec = null; // null first so onend does not restart
    try { rec?.abort(); } catch { /* ignore */ }
    this.stopMeter();
    this.listening.set(false);
    const text = this.transcript().trim();
    if (send && text && this.onFinal) this.onFinal(text);
    this.onFinal = null;
  }

  private armSilence(ms: number): void {
    clearTimeout(this.silenceTimer);
    this.silenceTimer = setTimeout(() => this.zone.run(() => this.stop(true)), ms);
  }

  // ---------------------------------------------------------------- level meter (visual only)
  private async startMeter(): Promise<void> {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      if (!this.active) return this.stopMeter();
      this.audioCtx = new AudioContext();
      const analyser = this.audioCtx.createAnalyser();
      analyser.fftSize = 512;
      this.audioCtx.createMediaStreamSource(this.stream).connect(analyser);
      const buf = new Uint8Array(analyser.fftSize);
      let last = 0;
      this.zone.runOutsideAngular(() => {
        const tick = (now: number) => {
          analyser.getByteTimeDomainData(buf);
          let sum = 0;
          for (const v of buf) sum += ((v - 128) / 128) ** 2;
          const rms = Math.min(1, Math.sqrt(sum / buf.length) * 4);
          if (now - last > 50) {
            last = now;
            this.zone.run(() => this.level.set(this.level() * 0.5 + rms * 0.5));
          }
          this.raf = requestAnimationFrame(tick);
        };
        this.raf = requestAnimationFrame(tick);
      });
    } catch {
      /* the meter is decorative; recognition still works without it */
    }
  }

  private stopMeter(): void {
    cancelAnimationFrame(this.raf);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.audioCtx?.close().catch(() => undefined);
    this.audioCtx = null;
    this.level.set(0);
  }

  // ---------------------------------------------------------------- read-back
  speak(markdown: string): void {
    if (!this.ttsSupported) return;
    this.stopSpeaking();
    const text = spokenSummary(markdown);
    if (!text) return;
    const u = new SpeechSynthesisUtterance(text);
    const voices = speechSynthesis.getVoices();
    u.voice = voices.find((v) => v.lang === 'en-IN') ?? voices.find((v) => v.lang.startsWith('en-GB')) ?? voices.find((v) => v.lang.startsWith('en')) ?? null;
    u.lang = u.voice?.lang ?? 'en-IN';
    u.rate = 1.02;
    u.onend = u.onerror = () => this.zone.run(() => this.speaking.set(false));
    this.speaking.set(true);
    speechSynthesis.speak(u);
  }

  stopSpeaking(): void {
    if (this.ttsSupported && (speechSynthesis.speaking || speechSynthesis.pending)) speechSynthesis.cancel();
    this.speaking.set(false);
  }

  setAutoSpeak(v: boolean): void {
    this.autoSpeak.set(v);
    try { localStorage.setItem(AUTO_KEY, v ? '1' : '0'); } catch { /* ignore */ }
    if (!v) this.stopSpeaking();
  }

  /** Off unless the user explicitly turned it on. */
  private readAuto(): boolean {
    try { return localStorage.getItem(AUTO_KEY) === '1'; } catch { return false; }
  }
}

/** The "Answer" part of a Kavach reply, cleaned for speech (no markdown, no citation tags). */
export function spokenSummary(md: string): string {
  const answer = (md.split(/\*\*Key facts\*\*|\n#+\s/)[0] ?? md).replace(/\*\*Answer\*\*/i, '');
  return answer
    .replace(/\[(?:D|P)\d+\]/g, '')
    .replace(/[*_`>#]/g, '')
    .replace(/§\s?/g, 'section ')
    .replace(/\bRs\.?\s?/g, 'rupees ')
    .replace(/₹\s?/g, 'rupees ')
    .replace(/\bRBI-?/g, 'R B I ')
    .replace(/\bDPD\b/g, 'D P D')
    .replace(/\bKYC\b/g, 'K Y C')
    .replace(/\bSTR\b/g, 'S T R')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 900);
}

export type VoiceCommand =
  | { kind: 'finding'; type: 'CASE_NOTE' | 'EXCEPTION_REPORT' | 'STR_DRAFT' }
  | { kind: 'read' }
  | { kind: 'stop' }
  | { kind: 'new' }
  | { kind: 'go'; path: string }
  | { kind: 'ask'; text: string };

/** Short spoken commands; anything else is treated as a question. */
export function parseVoiceCommand(raw: string): VoiceCommand {
  const t = raw.toLowerCase().replace(/[.!?,]/g, '').trim();
  if (/^(generate|create|draft|make)\b/.test(t)) {
    if (/\b(str|s t r|suspicious)\b/.test(t)) return { kind: 'finding', type: 'STR_DRAFT' };
    if (/\bexception\b/.test(t)) return { kind: 'finding', type: 'EXCEPTION_REPORT' };
    if (/\b(case note|finding|note)\b/.test(t)) return { kind: 'finding', type: 'CASE_NOTE' };
  }
  if (/^(read|speak)( it| that| the answer| out| aloud)*$/.test(t)) return { kind: 'read' };
  if (/^(stop|quiet|silence|stop reading)$/.test(t)) return { kind: 'stop' };
  if (/^(new investigation|start over|clear|reset)$/.test(t)) return { kind: 'new' };
  const go = t.match(/^(open|show|go to)( the)? (alerts?|alert queue|findings?|audit( log)?|copilot|home)$/);
  if (go) {
    const w = go[3];
    return { kind: 'go', path: w.startsWith('alert') ? '/alerts' : w.startsWith('finding') ? '/findings' : w.startsWith('audit') ? '/audit' : '/' };
  }
  return { kind: 'ask', text: raw.trim() };
}
