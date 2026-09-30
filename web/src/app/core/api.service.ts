import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, firstValueFrom } from 'rxjs';

import {
  Alert, AlertsByRule, AskEvent, AskResult, AuditReceipt, AuditRow, ChainStatus, Finding, FindingRow,
  FindingType, Kpis, Meta, ReviewDecision,
} from './contract';
import { AccessService } from './access.service';
import { PersonaService } from './persona.service';

@Injectable({ providedIn: 'root' })
export class ApiService {
  private http = inject(HttpClient);
  private persona = inject(PersonaService);
  private access = inject(AccessService);
  private base = '/api';

  private get headers(): HttpHeaders {
    const h: Record<string, string> = { 'X-Kavach-User': this.persona.current().id };
    if (this.access.code()) h['X-Kavach-Access'] = this.access.code();
    return new HttpHeaders(h);
  }

  /** A 401 means the deployment wants an access code: show the unlock screen. */
  private guard<T>(p: Promise<T>): Promise<T> {
    return p.catch((e) => {
      if (e?.status === 401) this.access.deny();
      throw e;
    });
  }

  private get<T>(path: string): Promise<T> {
    return this.guard(firstValueFrom(this.http.get<T>(`${this.base}${path}`, { headers: this.headers })));
  }

  private post<T>(path: string, body: unknown): Promise<T> {
    return this.guard(firstValueFrom(this.http.post<T>(`${this.base}${path}`, body, { headers: this.headers })));
  }

  meta = () => this.get<Meta>('/meta');
  kpis = () => this.get<Kpis>('/kpis');
  alerts = (limit = 25) => this.get<Alert[]>(`/alerts?limit=${limit}`);
  alertsByRule = () => this.get<AlertsByRule[]>('/alerts/by-rule');
  audit = (limit = 100) => this.get<AuditRow[]>(`/audit?limit=${limit}`);
  chainStatus = () => this.get<ChainStatus>('/audit/status');
  auditPayload = (seq: number) => this.get<Record<string, unknown>>(`/audit/${seq}`);
  findings = () => this.get<FindingRow[]>('/findings');
  generateFinding = (resultId: string, findingType: FindingType) =>
    this.post<Finding>('/findings', { resultId, findingType });
  review = (findingId: string, decision: ReviewDecision, comment: string) =>
    this.post<AuditReceipt>(`/findings/${encodeURIComponent(findingId)}/review`, { decision, comment });

  /**
   * Streams pipeline progress over SSE. EventSource cannot send headers, so the persona travels as a
   * query param; falls back to POST /api/ask if the stream fails before any event arrives.
   */
  ask(question: string): Observable<AskEvent> {
    return new Observable<AskEvent>((sub) => {
      const user = encodeURIComponent(this.persona.current().id);
      const code = this.access.code() ? `&access=${encodeURIComponent(this.access.code())}` : '';
      const es = new EventSource(`${this.base}/ask/stream?q=${encodeURIComponent(question)}&user=${user}${code}`);
      let received = false;
      let finished = false;

      es.onmessage = (msg) => {
        received = true;
        const ev = JSON.parse(msg.data) as AskEvent;
        sub.next(ev);
        if (ev.type !== 'step') {
          finished = true;
          es.close();
          sub.complete();
        }
      };
      es.onerror = () => {
        es.close();
        if (finished) return;
        if (received) {
          sub.next({ type: 'error', message: 'Connection to Kavach was interrupted.' });
          sub.complete();
          return;
        }
        this.post<AskResult>('/ask', { question })
          .then((result) => {
            result.steps.forEach((step) => sub.next({ type: 'step', step }));
            sub.next({ type: 'result', result });
            sub.complete();
          })
          .catch((e) => {
            sub.next({ type: 'error', message: e?.error?.message ?? e?.message ?? 'Request failed' });
            sub.complete();
          });
      };
      return () => es.close();
    });
  }
}
