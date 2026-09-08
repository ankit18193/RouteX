import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import type { RouteMatchResult } from '../proxy/types.js';
import fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { GatewayConfig, GatewayConfigInput } from '../types/index.js';
import { GatewayConfigSchema } from '../config/schema.js';
import { ProxyRouter } from '../proxy/router.js';
import { UpstreamPoolManager } from '../proxy/pool.js';
import { WebSocketProxyHandler } from '../proxy/websocket.js';
import { UpstreamHealthTracker } from '../proxy/upstream-health.js';
import { handleProxyStream } from '../proxy/stream-handler.js';
import { createLogger, logAccess } from '../logger/logger.js';
import { normalizeRequestId } from '../utils/uuid.js';
import { calculateLatencyBreakdown, elapsedMsFrom } from '../utils/timing.js';
import {
  createErrorEnvelope,
  GatewayError,
  GatewayErrorCode,
  RouteNotFoundError,
  TooManyRequestsError,
  CircuitBreakerOpenError,
} from '../errors/index.js';
import { AuthManager } from '../auth/auth-manager.js';
import type { AuthContext } from '../auth/types.js';
import { RateLimitManager } from '../rate-limit/rate-limit-manager.js';
import type { RedisClient } from '../rate-limit/redis-client.js';
import { CacheManager } from '../cache/cache-manager.js';
import { CircuitManager } from '../circuit-breaker/circuit-manager.js';

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
  /**
   * When true, disables internal server listener setup and prepares RouteX for embedded use.
   * In embedded mode, RouteX does not call listen() and delegates request/upgrade handling.
   * Defaults to false.
   */
  readonly embedded?: boolean | undefined;
}

export class RouteXGatewayServer {
  public readonly config: GatewayConfig;
  private readonly app: FastifyInstance;
  public readonly router: ProxyRouter;
  public readonly poolManager: UpstreamPoolManager;
  public readonly authManager: AuthManager;
  public readonly rateLimitManager: RateLimitManager;
  public readonly cacheManager: CacheManager;
  public readonly circuitManager: CircuitManager;
  public readonly healthTracker: UpstreamHealthTracker;
  public readonly webSocketHandler: WebSocketProxyHandler;
  public readonly isEmbedded: boolean;
  private isRunning = false;
  private isShuttingDown = false;

  constructor(
    config: GatewayConfig | GatewayConfigInput,
    options: GatewayServerOptions = {}
  ) {
    this.config = GatewayConfigSchema.parse(config);
    this.isEmbedded = options.embedded === true;

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
    this.cacheManager = new CacheManager(this.rateLimitManager.client, {
      keyPrefix: this.config.redis.keyPrefix,
    });
    this.healthTracker = new UpstreamHealthTracker({
      checkIntervalMs: 2000,
      checkTimeoutMs: 1000,
      logger,
    });
    for (const route of this.config.routes) {
      const urls = route.upstreams ?? (route.upstream ? [route.upstream] : []);
      this.healthTracker.register(urls);
    }
    this.webSocketHandler = new WebSocketProxyHandler({
      router: this.router,
      healthTracker: this.healthTracker,
      rateLimitManager: this.rateLimitManager,
      authManager: this.authManager,
      logger,
      defaultUpgradeTimeoutMs: 5000,
    });

    this.circuitManager = new CircuitManager({
      onStateChange: (event) => {
        logger.warn(
          {
            type: 'CIRCUIT_STATE_CHANGE',
            origin: event.origin,
            previousState: event.previousState,
            newState: event.newState,
            failureCount: event.failureCount,
          },
          `Circuit state changed for ${event.origin}: ${event.previousState} -> ${event.newState}`
        );
      },
    });

    this.setupMiddleware();
    this.setupRoutes(logger);
  }

  private setupMiddleware(): void {
    // 0. HTTP Upgrade listener for RFC 6455 WebSocket proxying
    if (!this.isEmbedded) {
      this.app.server.on('upgrade', (req, socket, head) => {
        if (this.isShuttingDown) {
          socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
          return;
        }
        this.webSocketHandler.handleUpgrade(req, socket, head).catch((_err) => {
          if (!socket.destroyed) socket.destroy();
        });
      });
    }

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
    // 1. Liveness health check endpoints (k8s / docker / load balancer liveness)
    const livenessHandler = async () => {
      return {
        status: 'ok',
        gateway: 'RouteX',
        version: '0.1.0',
        timestamp: new Date().toISOString(),
        uptimeSec: Math.floor(process.uptime()),
        memory: process.memoryUsage(),
      };
    };

    this.app.get('/healthz', livenessHandler);
    this.app.get('/livez', livenessHandler);
    this.app.get('/gateway/healthz', livenessHandler);

    // 2. Readiness health check endpoint (checks Redis dependency, router, and shutdown state)
    this.app.get('/readyz', async (_req: FastifyRequest, reply: FastifyReply) => {
      if (this.isShuttingDown) {
        return reply.status(503).send({
          status: 'not_ready',
          gateway: 'RouteX',
          reason: 'GATEWAY_SHUTTING_DOWN',
          timestamp: new Date().toISOString(),
        });
      }

      const checks: Record<string, 'ok' | 'down'> = {
        router: this.router ? 'ok' : 'down',
        poolManager: this.poolManager ? 'ok' : 'down',
      };

      let isReady = true;

      if (this.rateLimitManager?.client) {
        try {
          const pingResult = await this.rateLimitManager.client.rawClient.ping();
          checks.redis = pingResult === 'PONG' ? 'ok' : 'down';
          if (checks.redis !== 'ok') {
            isReady = false;
          }
        } catch {
          checks.redis = 'down';
          isReady = false;
        }
      }

      const statusCode = isReady ? 200 : 503;
      return reply.status(statusCode).send({
        status: isReady ? 'ok' : 'not_ready',
        gateway: 'RouteX',
        checks,
        timestamp: new Date().toISOString(),
        uptimeSec: Math.floor(process.uptime()),
      });
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

      // 5. Response Cache Lookup (Phase 6)
      const cacheLookup = await this.cacheManager.lookup(req, matchResult.route, authContext);
      if (cacheLookup.status === 'HIT') {
        reply.header('x-cache', 'HIT');
        reply.header('age', String(cacheLookup.ageSec));
        for (const [k, v] of Object.entries(cacheLookup.entry.headers)) {
          reply.header(k, v);
        }

        const totalDurationMs = elapsedMsFrom(startTime);
        logAccess(rootLogger, {
          requestId,
          method: req.method,
          url: req.url,
          statusCode: cacheLookup.entry.statusCode,
          routeId: matchResult.route.id,
          totalDurationMs,
          gatewayOverheadMs: totalDurationMs,
          clientIp: req.ip,
          userAgent: req.headers['user-agent'],
          cacheStatus: 'HIT',
          cacheKeyHash: cacheLookup.cacheKey,
        });

        return reply.status(cacheLookup.entry.statusCode).send(cacheLookup.entry.body);
      }

      // 6. Upstream Circuit Breaker Check (Phase 6)
      const breaker = this.circuitManager.getBreaker(
        matchResult.targetUrl,
        matchResult.route.circuitBreaker
      );
      const circuitDecision = breaker.beforeRequest();

      if (!circuitDecision.allowed) {
        const circuitError = new CircuitBreakerOpenError(
          breaker.origin,
          circuitDecision.retryAfterSec,
          { reason: circuitDecision.reason },
          requestId
        );
        const envelope = createErrorEnvelope(circuitError, requestId);
        for (const [k, v] of Object.entries(envelope.headers)) {
          reply.header(k, v);
        }

        const totalDurationMs = elapsedMsFrom(startTime);
        logAccess(rootLogger, {
          requestId,
          method: req.method,
          url: req.url,
          statusCode: 503,
          routeId: matchResult.route.id,
          totalDurationMs,
          gatewayOverheadMs: totalDurationMs,
          clientIp: req.ip,
          userAgent: req.headers['user-agent'],
          circuitState: circuitDecision.state,
          circuitRejected: true,
        });

        return reply.status(503).send(envelope.envelope);
      }

      // Set initial cache header (MISS or BYPASS)
      if (cacheLookup.status === 'MISS') {
        reply.header('x-cache', 'MISS');
      } else {
        reply.header('x-cache', 'BYPASS');
      }

      // 7. Reverse Proxy Dispatch (with single-flight stampede protection on cache MISS)
      if (cacheLookup.status === 'MISS' && cacheLookup.cacheKey) {
        let isLeader = false;
        const cacheKey = cacheLookup.cacheKey;

        const flightPromise = this.cacheManager.executeSingleFlight(cacheKey, async () => {
          isLeader = true;
          try {
            const result = await handleProxyStream({
              req,
              reply,
              targetUrl: matchResult.targetUrl,
              route: matchResult.route,
              poolManager: this.poolManager,
              requestId,
              startTime,
              authContext,
            });

            if (result.statusCode >= 500) {
              breaker.onFailure(result.statusCode);
            } else {
              breaker.onSuccess();
            }

            let savedEntry = null;
            if (result.statusCode === 200 && result.responseBody) {
              await this.cacheManager.store(
                cacheKey,
                result.statusCode,
                result.responseHeaders ?? {},
                result.responseBody,
                matchResult.route.cache
              );
              savedEntry = {
                statusCode: result.statusCode,
                headers: result.responseHeaders ?? {},
                body: result.responseBody.toString('utf-8'),
              };
            }

            return {
              statusCode: result.statusCode,
              upstreamLatencyMs: result.upstreamLatencyMs,
              totalDurationMs: result.totalDurationMs,
              savedEntry,
            };
          } catch (err: unknown) {
            breaker.onFailure(err instanceof Error ? err : new Error(String(err)));
            throw err;
          }
        });

        const flightResult = await flightPromise;

        if (isLeader) {
          const breakdown = calculateLatencyBreakdown({
            totalDurationMs: flightResult.totalDurationMs,
            upstreamLatencyMs: flightResult.upstreamLatencyMs,
          });

          logAccess(rootLogger, {
            requestId,
            method: req.method,
            url: req.url,
            statusCode: flightResult.statusCode,
            routeId: matchResult.route.id,
            totalDurationMs: breakdown.totalDurationMs,
            upstreamLatencyMs: breakdown.upstreamLatencyMs,
            gatewayOverheadMs: breakdown.gatewayOverheadMs,
            clientIp: req.ip,
            userAgent: req.headers['user-agent'],
            cacheStatus: 'MISS',
            cacheKeyHash: cacheKey,
            circuitState: breaker.state,
            circuitRejected: false,
          });

          return reply;
        } else {
          // Follower request: serve cached response directly without duplicate upstream fetch
          reply.header('x-cache', 'HIT');
          if (flightResult.savedEntry) {
            for (const [k, v] of Object.entries(flightResult.savedEntry.headers)) {
              if (v !== undefined) {
                reply.header(k, v);
              }
            }

            const totalDurationMs = elapsedMsFrom(startTime);
            logAccess(rootLogger, {
              requestId,
              method: req.method,
              url: req.url,
              statusCode: flightResult.savedEntry.statusCode,
              routeId: matchResult.route.id,
              totalDurationMs,
              gatewayOverheadMs: totalDurationMs,
              clientIp: req.ip,
              userAgent: req.headers['user-agent'],
              cacheStatus: 'HIT',
              cacheKeyHash: cacheKey,
              circuitState: breaker.state,
              circuitRejected: false,
            });

            return reply
              .status(flightResult.savedEntry.statusCode)
              .send(flightResult.savedEntry.body);
          } else {
            return await handleProxyStream({
              req,
              reply,
              targetUrl: matchResult.targetUrl,
              route: matchResult.route,
              poolManager: this.poolManager,
              requestId,
              startTime,
              authContext,
            });
          }
        }
      }

      // Default non-cacheable streaming dispatch
      let proxyResult;
      try {
        proxyResult = await handleProxyStream({
          req,
          reply,
          targetUrl: matchResult.targetUrl,
          route: matchResult.route,
          poolManager: this.poolManager,
          requestId,
          startTime,
          authContext,
        });

        // Record Circuit Breaker feedback
        if (proxyResult.statusCode >= 500) {
          breaker.onFailure(proxyResult.statusCode);
        } else {
          breaker.onSuccess();
        }
      } catch (err: unknown) {
        breaker.onFailure(err instanceof Error ? err : new Error(String(err)));
        throw err;
      }

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
        cacheStatus: cacheLookup.status,
        cacheKeyHash: cacheLookup.cacheKey,
        circuitState: breaker.state,
        circuitRejected: false,
      });

      return reply;
    });
  }

  /**
   * Start gateway server and listen on configured host and port.
   */
  public async listen(overridePort?: number, overrideHost?: string): Promise<string> {
    if (this.isEmbedded) {
      throw new Error('RouteXGatewayServer.listen() cannot be called when embedded mode is enabled.');
    }
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
    this.isRunning = true;
  }

  /**
   * Stop gateway server and gracefully close connection pools and Redis.
   */
  public async close(): Promise<void> {
    this.isShuttingDown = true;
    if (!this.isRunning && !this.app.server.listening && !this.isEmbedded) {
      await this.rateLimitManager.close();
      await this.poolManager.close();
      this.circuitManager.resetAll();
      return;
    }
    this.isRunning = false;

    // Close idle keep-alive connections so server closes gracefully without waiting for keep-alive timeout
    if (!this.isEmbedded) {
      const rawServer = this.app.server;
      if (rawServer && typeof (rawServer as any).closeIdleConnections === 'function') {
        (rawServer as any).closeIdleConnections();
      }
    }

    this.healthTracker.stop();
    await this.webSocketHandler.closeAll(5000);
    await this.app.close();
    await this.rateLimitManager.close();
    await this.poolManager.close();
    this.circuitManager.resetAll();
  }

  /**
   * Get underlying Fastify application instance.
   */
  /**
   * Match an incoming request path and method against configured routes.
   */
  public matchRoute(urlPath: string, method: string = 'GET'): RouteMatchResult {
    const rawUrl = urlPath || '/';
    const cleanPath = rawUrl.split('?')[0] ?? '/';
    const search = rawUrl.includes('?') ? rawUrl.slice(rawUrl.indexOf('?')) : '';
    return this.router.match(cleanPath, method, search);
  }

  /**
   * Dispatch an incoming HTTP request through RouteX's Fastify routing and proxy pipeline.
   * Returns true if RouteX consumed the request, or false if not matched.
   */
  public async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const rawUrl = req.url ?? '/';
    const urlPath = rawUrl.split('?')[0] ?? '/';
    const search = rawUrl.includes('?') ? rawUrl.slice(rawUrl.indexOf('?')) : '';
    const method = req.method ?? 'GET';

    // 1. Check RouteX router match for configured proxy routes
    const routeMatch = this.router.match(urlPath, method, search);

    // 2. Explicit gateway probe check (only dedicated /gateway/healthz, never host /healthz or /readyz)
    const isGatewayProbe = method === 'GET' && urlPath === '/gateway/healthz';

    if (!routeMatch.matched && !isGatewayProbe) {
      return false; // RouteX does not consume this request; host application handles it natively
    }

    if (this.isShuttingDown) {
      const body = JSON.stringify({ error: 'Service Unavailable', message: 'Gateway is shutting down' });
      res.writeHead(503, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Connection': 'close',
      });
      res.end(body);
      return true;
    }

    // Dispatch into Fastify's compiled routing pipeline
    this.app.routing(req, res);
    return true;
  }

  /**
   * Dispatch an incoming RFC 6455 HTTP upgrade request through RouteX's WebSocket proxy handler.
   * Returns true if RouteX consumed the upgrade, or false if not matched.
   */
  public async handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<boolean> {
    const rawUrl = req.url ?? '/';
    const urlPath = rawUrl.split('?')[0] ?? '/';
    const search = rawUrl.includes('?') ? rawUrl.slice(rawUrl.indexOf('?')) : '';
    const matchResult = this.router.match(urlPath, 'GET', search);

    if (!matchResult.matched || !matchResult.route.websocket) {
      return false; // RouteX does not consume this upgrade; host application handles it natively
    }

    if (this.isShuttingDown) {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      return true;
    }

    await this.webSocketHandler.handleUpgrade(req, socket, head);
    return true;
  }

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

  /**
   * Get underlying CacheManager instance.
   */
  public get cache(): CacheManager {
    return this.cacheManager;
  }

  /**
   * Get underlying CircuitManager instance.
   */
  public get health(): UpstreamHealthTracker {
    return this.healthTracker;
  }

  public get webSockets(): WebSocketProxyHandler {
    return this.webSocketHandler;
  }

  public get circuitBreakers(): CircuitManager {
    return this.circuitManager;
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
