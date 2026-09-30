/** Shared app configuration for main.ts and the e2e tests. */
import { timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import * as path from 'node:path';

import helmet from '@fastify/helmet';
import fastifyStatic from '@fastify/static';
import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { SnowflakeHttpError } from './kavach/backends/sql-api';

export const API_PREFIX = 'api';

/** Constant-time comparison so the access code can't be guessed by timing. */
function sameCode(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Angular build output: WEB_DIST, else ../web/dist/kavach-web/browser relative to the api directory. */
export function resolveWebDist(): string | null {
  const apiDir = path.resolve(__dirname, '..'); // api/src or api/dist -> api
  const dir = process.env.WEB_DIST
    ? path.resolve(process.env.WEB_DIST)
    : path.resolve(apiDir, '..', 'web', 'dist', 'kavach-web', 'browser');
  return existsSync(path.join(dir, 'index.html')) ? dir : null;
}

/**
 * JSON errors for /api; SPA fallback (index.html) for any other unknown GET when the web build is served.
 * Non-HTTP errors become 500 (502 for Snowflake HTTP failures) with the message, and are logged.
 */
@Catch()
export class KavachExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('HTTP');

  constructor(private readonly spaEnabled: boolean) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const reply = ctx.getResponse<FastifyReply & { sendFile?: (f: string) => FastifyReply }>();
    const req = ctx.getRequest<FastifyRequest>();
    const url = req.url ?? '';
    const isApi = url === `/${API_PREFIX}` || url.startsWith(`/${API_PREFIX}/`);

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      if (status === HttpStatus.NOT_FOUND && this.spaEnabled && !isApi && (req.method === 'GET' || req.method === 'HEAD') && reply.sendFile) {
        reply.header('Cache-Control', 'no-cache');
        reply.sendFile('index.html');
        return;
      }
      const body = exception.getResponse();
      reply.status(status).send(typeof body === 'string' ? { statusCode: status, message: body } : body);
      return;
    }
    const err = exception as Error;
    const status = exception instanceof SnowflakeHttpError ? HttpStatus.BAD_GATEWAY : HttpStatus.INTERNAL_SERVER_ERROR;
    this.logger.error(`${req.method} ${url} failed: ${err?.message}`, err?.stack);
    reply.status(status).send({
      statusCode: status,
      error: status === HttpStatus.BAD_GATEWAY ? 'Bad Gateway' : 'Internal Server Error',
      message: err?.message ?? 'Unexpected error',
    });
  }
}

export async function configureApp(app: NestFastifyApplication, opts: { webDist?: string | null } = {}): Promise<{ webDist: string | null }> {
  const webDist = opts.webDist === undefined ? resolveWebDist() : opts.webDist;
  app.setGlobalPrefix(API_PREFIX);

  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'"],
        // Angular's critical-CSS inlining uses <link onload="this.media='all'">
        'script-src-attr': ["'unsafe-inline'"],
        'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        'font-src': ["'self'", 'data:', 'https://fonts.gstatic.com'],
        'img-src': ["'self'", 'data:', 'blob:'],
        'connect-src': ["'self'"],
        'frame-ancestors': ["'self'"],
        'upgrade-insecure-requests': null,
      },
    },
    crossOriginEmbedderPolicy: false,
  });

  const origins = (process.env.CORS_ORIGINS ?? 'http://localhost:4200,http://127.0.0.1:4200')
    .split(',').map((o) => o.trim()).filter(Boolean);
  app.enableCors({
    origin: origins,
    credentials: true,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Accept', 'Authorization', 'X-Kavach-User', 'X-Kavach-Access', 'X-Requested-With', 'Cache-Control', 'Last-Event-ID'],
  });

  // Optional shared access code for public deployments (KAVACH_ACCESS_CODE). Protects your Snowflake credits.
  // Sent as the X-Kavach-Access header, or ?access= on the SSE stream (EventSource cannot send headers).
  const accessCode = process.env.KAVACH_ACCESS_CODE?.trim();
  if (accessCode) {
    app.getHttpAdapter().getInstance().addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
      const url = req.url ?? '';
      if (req.method === 'OPTIONS' || !url.startsWith(`/${API_PREFIX}/`) || url.startsWith(`/${API_PREFIX}/health`)) return;
      const header = req.headers['x-kavach-access'];
      const given = (Array.isArray(header) ? header[0] : header) ?? new URL(url, 'http://local').searchParams.get('access') ?? '';
      if (!sameCode(given, accessCode)) {
        return reply.code(401).send({ statusCode: 401, error: 'Unauthorized', message: 'Access code required', accessRequired: true });
      }
    });
    new Logger('Bootstrap').log('Access code gate enabled for /api');
  }

  if (webDist) {
    await app.register(fastifyStatic, {
      root: webDist,
      prefix: '/',
      index: ['index.html'],
      cacheControl: false,
      setHeaders: (res, filePath) => {
        const hashed = /[.-][A-Z0-9]{8,}\.(js|css|woff2?|ttf|svg|png|jpg|webp)$/i.test(filePath);
        res.setHeader('Cache-Control', filePath.endsWith('.html') ? 'no-cache' : hashed ? 'public, max-age=31536000, immutable' : 'public, max-age=3600');
      },
    });
  }
  app.useGlobalFilters(new KavachExceptionFilter(Boolean(webDist)));
  app.enableShutdownHooks();
  return { webDist };
}
