import {
  BadRequestException, Body, Controller, Get, Headers, HttpCode, Logger, NotFoundException, Param, Post, Query, Req, Res,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

import * as config from './config';
import type {
  Alert, AlertsByRule, AskEvent, AskResult, AuditReceipt, AuditRow, ChainStatus, Finding, FindingRow, FindingType,
  Kpis, Meta, ReviewDecision,
} from './contract';
import { KavachOrchestrator } from './orchestrator.service';

type HeaderBag = Record<string, string | string[] | undefined>;

const USER_RE = /^[\w.@+\-\\ ]{1,128}$/;
const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

/**
 * Caller identity: Sf-Context-Current-User (SPCS ingress) > X-Kavach-User (persona switcher) >
 * ?user= (EventSource cannot set headers) > demo.analyst.
 */
export function resolveUser(headers: HeaderBag, queryUser?: unknown): string {
  for (const candidate of [first(headers['sf-context-current-user']), first(headers['x-kavach-user']), typeof queryUser === 'string' ? queryUser : undefined]) {
    const u = candidate?.trim();
    if (u && USER_RE.test(u)) return u;
  }
  return config.DEFAULT_USER;
}

export function validateQuestion(q: unknown): string {
  if (typeof q !== 'string' || !q.trim()) throw new BadRequestException('question must be a non-empty string');
  const question = q.trim();
  if (question.length > config.MAX_QUESTION_CHARS) {
    throw new BadRequestException(`question must be at most ${config.MAX_QUESTION_CHARS} characters`);
  }
  return question;
}

const DECISIONS: ReviewDecision[] = ['APPROVED', 'NEEDS_CHANGES', 'REJECTED'];

const limitParam = (v: unknown, fallback: number, max: number): number => {
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new BadRequestException('limit must be a positive integer');
  return Math.min(n, max);
};

@Controller()
export class KavachController {
  private readonly logger = new Logger('KavachController');
  private readonly startedAt = Date.now();

  constructor(private readonly kv: KavachOrchestrator) {}

  @Get('health')
  health(): { status: 'ok'; mode: string; version: string; uptimeS: number } {
    return { status: 'ok', mode: this.kv.backend.mode, version: config.APP_VERSION, uptimeS: Math.round((Date.now() - this.startedAt) / 1000) };
  }

  @Get('meta')
  meta(@Headers() headers: HeaderBag, @Query('user') user?: string): Meta {
    return {
      version: config.APP_VERSION,
      mode: this.kv.backend.mode,
      user: resolveUser(headers, user),
      models: this.kv.backend.isMock ? ['deterministic-fallback'] : config.LLM_MODELS,
      semanticModel: config.SEMANTIC_MODEL_FILE,
      searchService: config.SEARCH_SERVICE_FQN,
      demoQuestions: config.DEMO_QUESTIONS.map((d) => ({ ...d })),
      findingTypes: { ...config.FINDING_TYPES },
    };
  }

  @Get('kpis')
  kpis(): Promise<Kpis> {
    return this.kv.backend.kpis();
  }

  @Post('ask')
  @HttpCode(200)
  ask(@Body() body: { question?: unknown } | undefined, @Headers() headers: HeaderBag): Promise<AskResult> {
    return this.kv.ask(validateQuestion(body?.question), resolveUser(headers));
  }

  /** Server-Sent Events: one `data:` message per AskEvent (step events as they happen, then the result). */
  @Get('ask/stream')
  async stream(@Query('q') q: unknown, @Query('user') user: unknown, @Req() req: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const question = validateQuestion(q); // 400 before the stream opens
    const who = resolveUser(req.headers, user);
    reply.hijack();
    const raw = reply.raw;
    const inherited = Object.fromEntries(Object.entries(reply.getHeaders()).filter(([, v]) => v !== undefined)) as Record<string, string | number | string[]>;
    raw.writeHead(200, {
      ...inherited,
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    let open = true;
    raw.on('close', () => { open = false; });
    const write = (chunk: string): void => { if (open && !raw.writableEnded) raw.write(chunk); };
    const send = (ev: AskEvent): void => write(`data: ${JSON.stringify(ev)}\n\n`);
    write('retry: 3000\n: kavach stream open\n\n');
    const ping = setInterval(() => write(': ping\n\n'), 15_000);
    try {
      const result = await this.kv.ask(question, who, (step) => send({ type: 'step', step }));
      send({ type: 'result', result });
    } catch (e) {
      this.logger.error(`ask/stream failed: ${(e as Error).message}`, (e as Error).stack);
      send({ type: 'error', message: (e as Error).message || 'Kavach failed to answer' });
    } finally {
      clearInterval(ping);
      if (!raw.writableEnded) raw.end();
    }
  }

  @Post('findings')
  async createFinding(@Body() body: { resultId?: unknown; findingType?: unknown } | undefined, @Headers() headers: HeaderBag): Promise<Finding> {
    const findingType = body?.findingType;
    if (typeof findingType !== 'string' || !(findingType in config.FINDING_TYPES)) {
      throw new BadRequestException(`findingType must be one of ${Object.keys(config.FINDING_TYPES).join(', ')}`);
    }
    if (typeof body?.resultId !== 'string' || !body.resultId) throw new BadRequestException('resultId is required');
    const res = this.kv.getResult(body.resultId);
    if (!res) throw new NotFoundException(`Unknown or expired result ${body.resultId} - ask the question again`);
    return this.kv.generateFinding(res, findingType as FindingType, resolveUser(headers));
  }

  @Get('findings')
  findings(): Promise<FindingRow[]> {
    return this.kv.backend.findings();
  }

  @Post('findings/:id/review')
  @HttpCode(200)
  review(@Param('id') id: string, @Body() body: { decision?: unknown; comment?: unknown } | undefined, @Headers() headers: HeaderBag): Promise<AuditReceipt> {
    const decision = body?.decision;
    if (typeof decision !== 'string' || !DECISIONS.includes(decision as ReviewDecision)) {
      throw new BadRequestException(`decision must be one of ${DECISIONS.join(', ')}`);
    }
    const comment = body?.comment === undefined || body?.comment === null ? '' : body.comment;
    if (typeof comment !== 'string' || comment.length > 4000) throw new BadRequestException('comment must be a string of at most 4000 characters');
    return this.kv.reviewFinding(id, decision as ReviewDecision, comment.trim(), resolveUser(headers));
  }

  @Get('alerts')
  alerts(@Query('limit') limit?: string): Promise<Alert[]> {
    return this.kv.backend.alertQueue(limitParam(limit, 25, 500));
  }

  @Get('alerts/by-rule')
  alertsByRule(): Promise<AlertsByRule[]> {
    return this.kv.backend.alertsByRule();
  }

  @Get('audit')
  audit(@Query('limit') limit?: string): Promise<AuditRow[]> {
    return this.kv.backend.auditLog(limitParam(limit, 100, 1000));
  }

  @Get('audit/status')
  auditStatus(): Promise<ChainStatus> {
    return this.kv.backend.chainStatus();
  }

  @Get('audit/:seq')
  async auditPayload(@Param('seq') seq: string): Promise<Record<string, unknown>> {
    const n = Number(seq);
    if (!Number.isInteger(n) || n < 1) throw new BadRequestException('seq must be a positive integer');
    const payload = await this.kv.backend.auditPayload(n);
    if (!payload) throw new NotFoundException(`No audit record #${n}`);
    return payload;
  }
}
