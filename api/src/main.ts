import 'reflect-metadata';

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';

import { AppModule } from './app.module';
import { configureApp } from './bootstrap';

async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ trustProxy: true, bodyLimit: 1_048_576 }),
    { bufferLogs: false },
  );
  const { webDist } = await configureApp(app);
  logger.log(webDist ? `Serving web app from ${webDist}` : 'No web build found (set WEB_DIST or build web/); API only');

  const port = Number(process.env.PORT ?? 8080);
  const host = process.env.HOST ?? '0.0.0.0';
  await app.listen(port, host);
  logger.log(`Kavach API listening on http://${host}:${port}/api`);
}

bootstrap().catch((err) => {
  console.error('Failed to start Kavach API:', err);
  process.exit(1);
});
