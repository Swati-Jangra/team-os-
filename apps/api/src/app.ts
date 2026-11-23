import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule, type AppDeps } from './app.module';
import { requestIdMiddleware } from './common/request-id.middleware';
import { createObservability } from './common/observability';

export async function createApp(deps: AppDeps, opts: { logger?: boolean } = {}): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.register(deps), {
    logger: opts.logger === false ? false : ['error', 'warn', 'log'],
    abortOnError: false,
    rawBody: true, // webhook signatures are computed over the exact bytes GitHub sent
  });
  app.set('trust proxy', deps.config.env === 'production' ? 1 : false);
  app.disable('x-powered-by');
  app.use(requestIdMiddleware);
  const obs = createObservability(deps.config);
  app.use(obs.middleware);
  app.getHttpAdapter().getInstance().get('/metrics', obs.metricsHandler); // outside /api/v1 so a reverse proxy that only forwards /api/ never exposes it
  app.use(helmet());
  app.use(cookieParser());
  // meeting audio is uploaded as a raw body (audio/*); everything else keeps the default JSON parser
  app.useBodyParser('raw', { type: 'audio/*', limit: deps.config.maxAudioBytes });
  app.useBodyParser('json', { limit: '1mb' }); // push webhooks can be larger than the 100kb default
  app.setGlobalPrefix('api/v1');
  app.enableCors({
    origin: deps.config.appUrl, // single allowlisted origin; credentials are cookie-based
    credentials: true,
    allowedHeaders: ['content-type', 'x-csrf-token', 'x-request-id'],
    exposedHeaders: ['x-request-id', 'retry-after'],
  });
  return app;
}
