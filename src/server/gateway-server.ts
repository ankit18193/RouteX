import fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { GatewayConfig, GatewayConfigInput } from '../types/index.js';
import { GatewayConfigSchema } from '../config/schema.js';
import { ProxyRouter } from '../proxy/router.js';
import { UpstreamPoolManager } from '../proxy/pool.js';
import { handleProxyStream } from '../proxy/stream-handler.js';
import { createLogger, logAccess } from '../logger/logger.js';
import { normalizeRequestId } from '../utils/uuid.js';
import { calculateLatencyBreakdown } from '../utils/timing.js';
import {
  createErrorEnvelope,
  GatewayError,
  GatewayErrorCode,
  RouteNotFoundError,
  TooManyRequestsError,
} from '../errors/index.js';
import { AuthManager } from '../auth/auth-manager.js';
import type { AuthContext } from '../auth/types.js';
import { RateLimitManager } from '../rate-limit/rate-limit-manager.js';
import type { RedisClient } from '../rate-limit/redis-client.js';

declare module 'fastify' {
  interface FastifyRequest {
    reqId: string;
    startTime: bigint;
    authContext?: AuthContext | undefined;
  }
}

export interface GatewayServerOptions {
  readonly logger?: boolean | undefined;
  readonly redisClient?: RedisClient | undefined;
}

export class RouteXGatewayServer {
  public readonly config: GatewayConfig;
  private readonly app: FastifyInstance;
  private readonly router: ProxyRouter;
  private readonly poolManager: UpstreamPoolManager;
  private readonly authManager: AuthManager;
  private readonly rateLimitManager: RateLimitManager;
  private isRunning = false;

  constructor(
    config: GatewayConfig | GatewayConfigInput,
    options: GatewayServerOptions = {}
  ) {
    this.config = GatewayConfigSchema.parse(config);

    const logger = createLogger({
      level: this.config.server.logLevel,
      format: this.config.server.logFormat,
      name: 'routex-gateway',
    });

    this.app = fastify({
      logger: options.logger ?? false,
      requestTimeout: this.config.server.requestTimeoutMs,
      routerOptions: {
        maxParamLength: 2048,
      },
    });

    this.router = new ProxyRouter(this.config.routes);
    this.poolManager = new UpstreamPoolManager({
      connectTimeoutMs: 5000,
      headersTimeoutMs: this.config.server.headersTimeoutMs,
      bodyTimeoutMs: this.config.server.requestTimeoutMs,
    });
    this.authManager = new AuthManager(this.config.auth ?? {});
    this.rateLimitManager = new RateLimitManager(this.config.redis ?? {}, {
      redisClient: options.redisClient,
    });

    this.setupMiddleware();
    this.setupRoutes(logger);
  }

  private setupMiddleware(): void {
    // 1. Zero-buffer stream payload content-type parsers
    this.app.addContentTypeParser('application/octet-stream', (_req, payload, done) => {
      done(null, payload);
    });
    this.app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, payload, done) => {
      done(null, payload);
    });

    // 2. Request initialisation hook: correlation ID & timer
    this.app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
      const incomingReqId = req.headers['x-request-id'];
      const requestId = normalizeRequestId(incomingReqId);

      req.reqId = requestId;
      req.startTime = process.hrtime.bigint();

      reply.header('x-request-id', requestId);
    });

    // 3. Global error handler
    this.app.setErrorHandler((error, req, reply) => {
      const requestId = req.reqId ?? 'req_unknown';
      const envelopeResponse = createErrorEnvelope(error, requestId);

      for (const [key, val] of Object.entries(envelopeResponse.headers)) {
        reply.header(key, val);
      }
      reply.status(envelopeResponse.statusCode).send(envelopeResponse.envelope);
    });
  }

  private setupRoutes(rootLogger: ReturnType<typeof createLogger>): void {
    // Health check endpoint for gateway itself
    this.app.get('/gateway/healthz', async () => {
      return {
        status: 'ok',
        gateway: 'RouteX',
        timestamp: new Date().toISOString(),
        uptimeSec: Math.floor(process.uptime()),
      };
    });

    // Catch-all reverse proxy dispatcher
    this.app.all('/*', async (req: FastifyRequest, reply: FastifyReply) => {
      const requestId = req.reqId;
      const startTime = req.startTime;

      const urlPath = req.url.split('?')[0] ?? '/';
      const search = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';

      const matchResult = this.router.match(urlPath, req.method, search);

      if (!matchResult.matched) {
        if (matchResult.reason === 'METHOD_NOT_ALLOWED') {
          const allowed = matchResult.allowedMethods ?? [];
          reply.header('allow', allowed.join(', '));

          const methodError = new GatewayError({
            message: `Method '${req.method}' not allowed for path '${urlPath}'`,
            statusCode: 405,
            code: GatewayErrorCode.BAD_REQUEST,
            details: { allowedMethods: allowed },
            requestId,
          });

          const envelope = createErrorEnvelope(methodError, requestId);
          for (const [k, v] of Object.entries(envelope.headers)) {
            reply.header(k, v);
          }
          return reply.status(405).send(envelope.envelope);
        }

        // Unmatched route -> 404 Route Not Found
        const notFoundError = new RouteNotFoundError(urlPath, req.method, requestId);
        const envelope = createErrorEnvelope(notFoundError, requestId);
        for (const [k, v] of Object.entries(envelope.headers)) {
          reply.header(k, v);
        }
        return reply.status(404).send(envelope.envelope);
      }

      // 1. Tier-1 IP Rate Limit Shield (before auth to prevent brute force / unauthenticated abuse)
      try {
        const ipRateLimit = await this.rateLimitManager.checkIpRateLimit(req.ip, matchResult.route);
        if (ipRateLimit) {
          const rlHeaders = this.rateLimitManager.formatHeaders(ipRateLimit);
          for (const [k, v] of Object.entries(rlHeaders)) {
            reply.header(k, v);
          }

          if (!ipRateLimit.allowed) {
            const error = new TooManyRequestsError(
              'Rate limit exceeded for IP address',
              ipRateLimit.retryAfterSec,
              { limit: ipRateLimit.limit, resetAt: ipRateLimit.resetAt },
              requestId
            );
            const envelope = createErrorEnvelope(error, requestId);
            for (const [k, v] of Object.entries(envelope.headers)) {
              reply.header(k, v);
            }
            return reply.status(429).send(envelope.envelope);
          }
        }
      } catch (err: unknown) {
        const envelope = createErrorEnvelope(err, requestId);
        for (const [k, v] of Object.entries(envelope.headers)) {
          reply.header(k, v);
        }
        return reply.status(envelope.statusCode).send(envelope.envelope);
      }

      // 2. Edge Authentication
      let authContext: AuthContext;
      try {
        authContext = await this.authManager.authenticate(req.headers, matchResult.route);
        req.authContext = authContext;
      } catch (err: unknown) {
        const envelope = createErrorEnvelope(err, requestId);
        reply.header('www-authenticate', 'Bearer realm="RouteX"');
        for (const [k, v] of Object.entries(envelope.headers)) {
          reply.header(k, v);
        }
        return reply.status(envelope.statusCode).send(envelope.envelope);
      }

      // 3. Edge Authorization (Required Roles)
      try {
        this.authManager.authorize(authContext, matchResult.route);
      } catch (err: unknown) {
        const envelope = createErrorEnvelope(err, requestId);
        for (const [k, v] of Object.entries(envelope.headers)) {
          reply.header(k, v);
        }
        return reply.status(envelope.statusCode).send(envelope.envelope);
      }

      // 4. Tier-2 Identity Rate Limit (User / API Key / Tiered)
      try {
        const identityRateLimit = await this.rateLimitManager.checkIdentityRateLimit(
          authContext,
          matchResult.route
        );
        if (identityRateLimit) {
          const idHeaders = this.rateLimitManager.formatHeaders(identityRateLimit);
          for (const [k, v] of Object.entries(idHeaders)) {
            reply.header(k, v);
          }

          if (!identityRateLimit.allowed) {
            const error = new TooManyRequestsError(
              'Rate limit exceeded for identity',
              identityRateLimit.retryAfterSec,
              { limit: identityRateLimit.limit, resetAt: identityRateLimit.resetAt },
              requestId
            );
            const envelope = createErrorEnvelope(error, requestId);
            for (const [k, v] of Object.entries(envelope.headers)) {
              reply.header(k, v);
            }
            return reply.status(429).send(envelope.envelope);
          }
        }
      } catch (err: unknown) {
        const envelope = createErrorEnvelope(err, requestId);
        for (const [k, v] of Object.entries(envelope.headers)) {
          reply.header(k, v);
        }
        return reply.status(envelope.statusCode).send(envelope.envelope);
      }

      // 5. Execute streaming reverse proxy dispatch with verified identity
      const proxyResult = await handleProxyStream({
        req,
        reply,
        targetUrl: matchResult.targetUrl,
        route: matchResult.route,
        poolManager: this.poolManager,
        requestId,
        startTime,
        authContext,
      });

      const breakdown = calculateLatencyBreakdown({
        totalDurationMs: proxyResult.totalDurationMs,
        upstreamLatencyMs: proxyResult.upstreamLatencyMs,
      });

      // Structured JSON access logging
      logAccess(rootLogger, {
        requestId,
        method: req.method,
        url: req.url,
        statusCode: proxyResult.statusCode,
        routeId: matchResult.route.id,
        totalDurationMs: breakdown.totalDurationMs,
        upstreamLatencyMs: breakdown.upstreamLatencyMs,
        gatewayOverheadMs: breakdown.gatewayOverheadMs,
        clientIp: req.ip,
        userAgent: req.headers['user-agent'],
      });

      return reply;
    });
  }

  /**
   * Start gateway server and listen on configured host and port.
   */
  public async listen(overridePort?: number, overrideHost?: string): Promise<string> {
    const port = overridePort ?? this.config.server.port;
    const host = overrideHost ?? this.config.server.host;

    await this.rateLimitManager.init();
    const address = await this.app.listen({ port, host });
    this.isRunning = true;
    return address;
  }

  /**
   * Wait until Fastify application is ready.
   */
  public async ready(): Promise<void> {
    await this.rateLimitManager.init();
    await this.app.ready();
  }

  /**
   * Stop gateway server and gracefully close connection pools and Redis.
   */
  public async close(): Promise<void> {
    if (!this.isRunning && !this.app.server.listening) {
      await this.rateLimitManager.close();
      await this.poolManager.close();
      return;
    }
    this.isRunning = false;
    await this.app.close();
    await this.rateLimitManager.close();
    await this.poolManager.close();
  }

  /**
   * Get underlying Fastify application instance.
   */
  public get fastifyInstance(): FastifyInstance {
    return this.app;
  }

  /**
   * Get underlying AuthManager instance.
   */
  public get auth(): AuthManager {
    return this.authManager;
  }

  /**
   * Get underlying RateLimitManager instance.
   */
  public get rateLimit(): RateLimitManager {
    return this.rateLimitManager;
  }
}

/**
 * Factory function to create a RouteX Gateway Server instance.
 */
export function createGatewayServer(
  config: GatewayConfig | GatewayConfigInput,
  options?: GatewayServerOptions
): RouteXGatewayServer {
  return new RouteXGatewayServer(config, options);
}
