/** Controller-level e2e: the real Nest module over Fastify (inject, no network), backed by the offline mock. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { KAVACH_BACKEND } from '../src/kavach/backends/backend.interface';
import { MockBackend } from '../src/kavach/backends/mock.backend';
import * as config from '../src/kavach/config';
import type { AskEvent, AskResult, AuditReceipt, ChainStatus, Finding, FindingRow, Meta } from '../src/kavach/contract';

describe('Kavach HTTP API (e2e, mock backend)', () => {
  let app: NestFastifyApplication;
  const Q = config.DEMO_QUESTIONS.map((d) => d.question);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(KAVACH_BACKEND).useValue(new MockBackend(undefined, undefined, 0))
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await configureApp(app, { webDist: null });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });
  afterAll(async () => { await app?.close(); });

  const post = (url: string, payload: unknown, user?: string) =>
    app.inject({ method: 'POST', url, payload: payload as object, headers: user ? { 'x-kavach-user': user } : {} });

  it('GET /api/health and /api/meta', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/health' })).json()).toMatchObject({ status: 'ok', mode: 'Offline mock' });
    const res = await app.inject({ method: 'GET', url: '/api/meta', headers: { 'x-kavach-user': 'priya.checker' } });
    expect(res.statusCode).toBe(200);
    const meta = res.json<Meta>();
    expect(meta).toMatchObject({ mode: 'Offline mock', user: 'priya.checker', searchService: 'KAVACH.KNOWLEDGE.POLICY_SEARCH' });
    expect(meta.demoQuestions).toHaveLength(4);
    expect(meta.demoQuestions[0]).toEqual(expect.objectContaining({ label: expect.any(String), question: Q[0], hint: expect.any(String) }));
    expect(Object.keys(meta.findingTypes)).toEqual(['CASE_NOTE', 'EXCEPTION_REPORT', 'STR_DRAFT']);
    // SPCS identity header beats the persona header
    const spcs = await app.inject({ method: 'GET', url: '/api/meta', headers: { 'sf-context-current-user': 'SF_USER', 'x-kavach-user': 'x' } });
    expect(spcs.json<Meta>().user).toBe('SF_USER');
    expect((await app.inject({ method: 'GET', url: '/api/meta' })).json<Meta>().user).toBe('demo.analyst');
  });

  it('GET /api/kpis, /api/alerts, /api/alerts/by-rule', async () => {
    const k = (await app.inject({ method: 'GET', url: '/api/kpis' })).json();
    expect(k.openAlerts).toBeGreaterThan(0);
    const alerts = (await app.inject({ method: 'GET', url: '/api/alerts?limit=5' })).json();
    expect(alerts).toHaveLength(5);
    expect(Object.keys(alerts[0])).toEqual(expect.arrayContaining(['alertId', 'createdAt', 'analystNotes', 'businessName']));
    expect((await app.inject({ method: 'GET', url: '/api/alerts?limit=abc' })).statusCode).toBe(400);
    const byRule = (await app.inject({ method: 'GET', url: '/api/alerts/by-rule' })).json();
    expect(byRule[0]).toEqual(expect.objectContaining({ ruleTriggered: expect.any(String), n: expect.any(Number) }));
  });

  let result: AskResult;
  let finding: Finding;

  it('POST /api/ask', async () => {
    const res = await post('/api/ask', { question: Q[1] }, 'maker.analyst');
    expect(res.statusCode).toBe(200);
    result = res.json<AskResult>();
    expect(result.route).toBe('BOTH');
    expect(result.data!.rowCount).toBe(3);
    expect(result.policy!.chunks).toHaveLength(6);
    expect(result.audit.auditSeq).toBe(1);
    expect(result.steps.map((s) => s.key)).toEqual(['route', 'analyst', 'search', 'synthesis', 'audit']);
  });

  it('POST /api/findings and POST /api/findings/:id/review (maker-checker)', async () => {
    const res = await post('/api/findings', { resultId: result.id, findingType: 'CASE_NOTE' }, 'maker.analyst');
    expect(res.statusCode).toBe(201);
    finding = res.json<Finding>();
    expect(finding).toMatchObject({ findingType: 'CASE_NOTE', createdBy: 'maker.analyst', status: 'PENDING_REVIEW', sourceAuditSeq: result.audit.auditSeq });
    expect(finding.audit.prevHash).toBe(result.audit.rowHash);

    const rv = await post(`/api/findings/${finding.findingId}/review`, { decision: 'APPROVED', comment: 'Evidence checked' }, 'priya.checker');
    expect(rv.statusCode).toBe(200);
    const receipt = rv.json<AuditReceipt>();
    expect(receipt.prevHash).toBe(finding.audit.rowHash);

    const list = (await app.inject({ method: 'GET', url: '/api/findings' })).json<FindingRow[]>();
    expect(list[0]).toMatchObject({ findingId: finding.findingId, status: 'APPROVED', reviewer: 'priya.checker', makerCheckerOk: true, reviewComment: 'Evidence checked' });

    expect((await post('/api/findings', { resultId: 'nope', findingType: 'CASE_NOTE' })).statusCode).toBe(404);
    expect((await post('/api/findings/KVF-19700101-000000/review', { decision: 'APPROVED' })).statusCode).toBe(404);
  });

  it('GET /api/audit, /api/audit/status and /api/audit/:seq', async () => {
    const status = (await app.inject({ method: 'GET', url: '/api/audit/status' })).json<ChainStatus>();
    expect(status).toEqual({ rows: 3, valid: 3 });
    const rows = (await app.inject({ method: 'GET', url: '/api/audit?limit=2' })).json();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ auditSeq: 3, eventType: 'FINDING_REVIEWED', appUser: 'priya.checker', isValid: true });
    const p = (await app.inject({ method: 'GET', url: '/api/audit/1' })).json();
    expect(p).toMatchObject({ question: Q[1], route: 'BOTH' });
    expect((await app.inject({ method: 'GET', url: '/api/audit/999' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/audit/abc' })).statusCode).toBe(400);
  });

  it('GET /api/ask/stream emits step events then the result (SSE)', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/ask/stream?q=${encodeURIComponent(Q[3])}&user=sse.persona` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/event-stream/);
    expect(res.headers['cache-control']).toMatch(/no-cache/);
    expect(res.headers['x-accel-buffering']).toBe('no');
    const events = res.body.split('\n\n').filter((b) => b.startsWith('data: ')).map((b) => JSON.parse(b.slice(6)) as AskEvent);
    expect(events.some((e) => e.type === 'step' && e.step.key === 'search' && e.step.status === 'running')).toBe(true);
    expect(events.some((e) => e.type === 'step' && e.step.key === 'analyst' && e.step.status === 'skipped')).toBe(true);
    const last = events[events.length - 1];
    expect(last.type).toBe('result');
    const r = (last as { result: AskResult }).result;
    expect(r.route).toBe('POLICY');
    const audit = (await app.inject({ method: 'GET', url: '/api/audit?limit=1' })).json();
    expect(audit[0]).toMatchObject({ appUser: 'sse.persona', route: 'POLICY' });
  });

  it('validates input with 400s', async () => {
    expect((await post('/api/ask', { question: '' })).statusCode).toBe(400);
    expect((await post('/api/ask', { question: '   ' })).statusCode).toBe(400);
    expect((await post('/api/ask', {})).statusCode).toBe(400);
    expect((await post('/api/ask', { question: 'x'.repeat(2001) })).statusCode).toBe(400);
    expect((await post('/api/ask', { question: 42 })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/ask/stream?q=' })).statusCode).toBe(400);
    expect((await post('/api/findings', { resultId: result.id, findingType: 'MEMO' })).statusCode).toBe(400);
    const bad = await post(`/api/findings/${finding.findingId}/review`, { decision: 'MAYBE', comment: '' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().message).toMatch(/decision must be one of/);
    expect((await app.inject({ method: 'GET', url: '/api/unknown' })).statusCode).toBe(404);
  });
});

describe('static web app + SPA fallback', () => {
  let app: NestFastifyApplication;
  let dir: string;

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'kavach-web-'));
    writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>Kavach</title><app-root></app-root>');
    writeFileSync(path.join(dir, 'main-ABCD1234.js'), 'console.log(1)');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(KAVACH_BACKEND).useValue(new MockBackend(undefined, undefined, 0))
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await configureApp(app, { webDist: dir });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });
  afterAll(async () => {
    await app?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('serves index.html, hashed assets, deep links, and keeps JSON 404s under /api', async () => {
    const root = await app.inject({ method: 'GET', url: '/' });
    expect(root.statusCode).toBe(200);
    expect(root.body).toContain('<app-root>');
    expect(root.headers['content-security-policy']).toContain("style-src 'self' 'unsafe-inline'");
    const asset = await app.inject({ method: 'GET', url: '/main-ABCD1234.js' });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers['cache-control']).toContain('immutable');
    const deep = await app.inject({ method: 'GET', url: '/findings/KVF-1', headers: { accept: 'text/html' } });
    expect(deep.statusCode).toBe(200);
    expect(deep.headers['content-type']).toMatch(/text\/html/);
    const api404 = await app.inject({ method: 'GET', url: '/api/nope' });
    expect(api404.statusCode).toBe(404);
    expect(api404.json()).toMatchObject({ statusCode: 404 });
    expect((await app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);
  });
});

describe('Access code gate (KAVACH_ACCESS_CODE)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    process.env.KAVACH_ACCESS_CODE = 'open-sesame';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(KAVACH_BACKEND).useValue(new MockBackend(undefined, undefined, 0))
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await configureApp(app, { webDist: null });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });
  afterAll(async () => {
    delete process.env.KAVACH_ACCESS_CODE;
    await app?.close();
  });

  it('blocks /api without the code, allows health, header and ?access=', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);
    const denied = await app.inject({ method: 'GET', url: '/api/meta' });
    expect(denied.statusCode).toBe(401);
    expect(denied.json()).toMatchObject({ accessRequired: true });
    expect((await app.inject({ method: 'GET', url: '/api/meta', headers: { 'x-kavach-access': 'wrong' } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/meta', headers: { 'x-kavach-access': 'open-sesame' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/kpis?access=open-sesame' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/ask', payload: { question: 'hi' } })).statusCode).toBe(401);
  });
});
