import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { Counter, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import type { AppConfig } from './app-config';

/**
 * Prometheus metrics + structured access log.
 *
 * Label hygiene: the route label is the Express route *template* (`/api/v1/organizations/:orgId/...`),
 * never the concrete URL, so ids, tokens and query strings cannot leak into metrics or logs and the
 * label set stays bounded. Unmatched requests share one `unmatched` label.
 */
export function createObservability(config: Pick<AppConfig, 'accessLog' | 'metricsToken'>) {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry, prefix: 'teamos_api_' });
  const requests = new Counter({
    name: 'teamos_http_requests_total',
    help: 'HTTP requests by method, route template and status class',
    labelNames: ['method', 'route', 'status'] as const,
    registers: [registry],
  });
  const duration = new Histogram({
    name: 'teamos_http_request_duration_seconds',
    help: 'HTTP request duration',
    labelNames: ['method', 'route'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [registry],
  });

  const routeOf = (req: Request): string => {
    const base = req.baseUrl ?? '';
    const path = (req.route as { path?: string } | undefined)?.path;
    return path ? `${base}${path}` : 'unmatched';
  };

  function middleware(req: Request, res: Response, next: NextFunction): void {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const seconds = Number(process.hrtime.bigint() - start) / 1e9;
      const route = routeOf(req);
      requests.inc({ method: req.method, route, status: `${Math.floor(res.statusCode / 100)}xx` });
      duration.observe({ method: req.method, route }, seconds);
      if (config.accessLog === 'off') return;
      const line = {
        ts: new Date().toISOString(),
        level: res.statusCode >= 500 ? 'error' : 'info',
        msg: 'http',
        requestId: req.id,
        method: req.method,
        route,
        status: res.statusCode,
        ms: Math.round(seconds * 1000 * 10) / 10,
        userId: req.auth?.userId,
        orgId: req.tenant?.orgId,
      };
      if (config.accessLog === 'json') console.log(JSON.stringify(line));
      else console.log(`${line.ts} ${line.method} ${route} ${line.status} ${line.ms}ms req=${line.requestId}${line.userId ? ` user=${line.userId}` : ''}`);
    });
    next();
  }

  /** GET /metrics — bearer-token protected; 404 when no token is configured (so its existence is not advertised). */
  function metricsHandler(req: Request, res: Response): void {
    const expected = config.metricsToken;
    if (!expected) {
      res.status(404).end();
      return;
    }
    const given = (req.header('authorization') ?? '').replace(/^Bearer /i, '');
    const a = Buffer.from(given);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      res.status(401).set('WWW-Authenticate', 'Bearer').end();
      return;
    }
    void registry.metrics().then((body) => res.type(registry.contentType).send(body));
  }

  return { registry, middleware, metricsHandler };
}
