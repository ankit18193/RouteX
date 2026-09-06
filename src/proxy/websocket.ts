import type { IncomingMessage } from 'node:http';
import http from 'node:http';
import https from 'node:https';
import type { Duplex } from 'node:stream';
import net from 'node:net';
import type { ProxyRouter } from './router.js';
import type { UpstreamHealthTracker } from './upstream-health.js';
import type { RateLimitManager } from '../rate-limit/rate-limit-manager.js';
import type { AuthManager } from '../auth/auth-manager.js';
import { sanitizeWebSocketUpgradeHeaders } from './headers.js';
import { normalizeRequestId } from '../utils/uuid.js';
import type { Logger } from 'pino';

export interface WebSocketProxyOptions {
  readonly router: ProxyRouter;
  readonly healthTracker?: UpstreamHealthTracker | undefined;
  readonly rateLimitManager?: RateLimitManager | undefined;
  readonly authManager?: AuthManager | undefined;
  readonly logger?: Logger | undefined;
  readonly defaultUpgradeTimeoutMs?: number | undefined;
}

export interface ActiveTunnel {
  readonly id: string;
  readonly routeId: string;
  readonly clientIp: string;
  readonly targetUrl: string;
  readonly clientSocket: Duplex;
  readonly upstreamSocket: Duplex;
  readonly startedAt: number;
}

export type UpgradeState =
  | 'INITIALIZING'
  | 'CONNECTING'
  | 'UPGRADED'
  | 'ACTIVE_TUNNEL'
  | 'CLOSING'
  | 'CLOSED';

/**
 * Extract and normalize client IP without unsafe regex truncation of IPv6 addresses.
 */
export function normalizeClientIp(rawIp: string | undefined): string {
  if (!rawIp) {
    return '127.0.0.1';
  }
  const trimmed = rawIp.trim();
  // Handle IPv4-mapped IPv6 address: ::ffff:127.0.0.1 -> 127.0.0.1
  if (trimmed.startsWith('::ffff:')) {
    const candidateV4 = trimmed.slice(7);
    if (net.isIPv4(candidateV4)) {
      return candidateV4;
    }
  }
  if (net.isIP(trimmed)) {
    return trimmed;
  }
  return '127.0.0.1';
}

export class WebSocketProxyHandler {
  private readonly router: ProxyRouter;
  private readonly healthTracker?: UpstreamHealthTracker | undefined;
  private readonly rateLimitManager?: RateLimitManager | undefined;
  private readonly authManager?: AuthManager | undefined;
  private readonly logger?: Logger | undefined;
  private readonly defaultUpgradeTimeoutMs: number;
  private readonly activeTunnels = new Set<ActiveTunnel>();

  constructor(options: WebSocketProxyOptions) {
    this.router = options.router;
    this.healthTracker = options.healthTracker;
    this.rateLimitManager = options.rateLimitManager;
    this.authManager = options.authManager;
    this.logger = options.logger;
    this.defaultUpgradeTimeoutMs = options.defaultUpgradeTimeoutMs ?? 5000;
  }

  public get activeTunnelCount(): number {
    return this.activeTunnels.size;
  }

  public getTunnels(): ReadonlySet<ActiveTunnel> {
    return this.activeTunnels;
  }

  /**
   * Handle incoming HTTP 'upgrade' event from the server.
   */
  public async handleUpgrade(
    req: IncomingMessage,
    clientSocket: Duplex,
    head: Buffer
  ): Promise<void> {
    let state: UpgradeState = 'INITIALIZING';
    const rawReqId = req.headers['x-request-id'];
    const requestId = normalizeRequestId(rawReqId);

    // Extract client IP safely using node:net
    const clientIp = normalizeClientIp(req.socket.remoteAddress);

    // 1. Validate RFC 6455 upgrade request headers
    const connectionHeader = req.headers['connection'];
    const upgradeHeader = req.headers['upgrade'];
    const secWsKey = req.headers['sec-websocket-key'];

    const isUpgrade =
      typeof upgradeHeader === 'string' &&
      upgradeHeader.toLowerCase().trim() === 'websocket';
    const hasUpgradeConnection =
      typeof connectionHeader === 'string' &&
      connectionHeader.toLowerCase().includes('upgrade');

    if (!isUpgrade || !hasUpgradeConnection || !secWsKey) {
      this.writeErrorAndClose(
        clientSocket,
        400,
        'Bad Request',
        'Invalid or missing WebSocket Upgrade headers',
        requestId
      );
      return;
    }

    // 2. Route matching
    const rawUrl = req.url ?? '/';
    const urlPath = rawUrl.split('?')[0] || '/';
    const search = rawUrl.includes('?') ? rawUrl.slice(rawUrl.indexOf('?')) : '';

    const matchResult = this.router.match(urlPath, 'GET', search);

    if (!matchResult.matched) {
      this.writeErrorAndClose(
        clientSocket,
        404,
        'Not Found',
        `No route found matching path '${urlPath}'`,
        requestId
      );
      return;
    }

    const route = matchResult.route;

    // Reject upgrade if route does not permit WebSockets
    if (!route.websocket) {
      this.writeErrorAndClose(
        clientSocket,
        400,
        'Bad Request',
        `Route '${route.id}' does not allow WebSocket upgrade`,
        requestId
      );
      return;
    }

    // 3. Edge Rate Limiting
    if (route.rateLimit?.enabled && this.rateLimitManager) {
      try {
        const ipRateLimit = await this.rateLimitManager.checkIpRateLimit(clientIp, route);
        if (ipRateLimit && !ipRateLimit.allowed) {
          const rlHeaders = this.rateLimitManager.formatHeaders(ipRateLimit);
          const extraHeaders: Record<string, string> = {};
          for (const [k, v] of Object.entries(rlHeaders)) {
            extraHeaders[k] = String(v);
          }
          this.writeErrorAndClose(
            clientSocket,
            429,
            'Too Many Requests',
            `Rate limit exceeded for client IP '${clientIp}' on route '${route.id}'`,
            requestId,
            extraHeaders
          );
          return;
        }
      } catch (err) {
        this.logger?.warn({ err, routeId: route.id, requestId }, 'Rate limit check failed on upgrade');
        if (route.rateLimit.failurePolicy === 'fail-closed') {
          this.writeErrorAndClose(
            clientSocket,
            500,
            'Internal Server Error',
            'Rate limiting policy error',
            requestId
          );
          return;
        }
      }
    }

    // 4. Edge Auth Evaluation (if configured for route)
    let authContext = undefined;
    if (this.authManager && route.auth && route.auth.mode !== 'public') {
      try {
        authContext = await this.authManager.authenticate(req.headers, route);
        this.authManager.authorize(authContext, route);

        if (route.rateLimit?.enabled && this.rateLimitManager) {
          const idRateLimit = await this.rateLimitManager.checkIdentityRateLimit(authContext, route);
          if (idRateLimit && !idRateLimit.allowed) {
            const idHeaders = this.rateLimitManager.formatHeaders(idRateLimit);
            const extraHeaders: Record<string, string> = {};
            for (const [k, v] of Object.entries(idHeaders)) {
              extraHeaders[k] = String(v);
            }
            this.writeErrorAndClose(
              clientSocket,
              429,
              'Too Many Requests',
              'Rate limit exceeded for authenticated identity',
              requestId,
              extraHeaders
            );
            return;
          }
        }
      } catch (authErr: any) {
        const status = authErr.statusCode ?? 401;
        const msg = authErr.message ?? 'Unauthorized';
        this.writeErrorAndClose(
          clientSocket,
          status,
          status === 403 ? 'Forbidden' : 'Unauthorized',
          msg,
          requestId
        );
        return;
      }
    }

    // 5. Candidate upstream determination & bounded pre-101 connect-time failover
    const candidateUpstreams: string[] =
      route.upstreams && route.upstreams.length > 0
        ? route.upstreams
        : [route.upstream ?? matchResult.targetUrl];

    const maxAttempts = Math.min(2, candidateUpstreams.length);
    const attemptedUpstreams = new Set<string>();

    return new Promise<void>((resolve) => {
      let isHandshakeComplete = false;
      let activeUpstreamReq: http.ClientRequest | undefined;
      let timeoutTimer: NodeJS.Timeout | undefined;

      // Handle client socket premature abort during handshake
      const onClientAbort = () => {
        if (!isHandshakeComplete) {
          if (timeoutTimer) clearTimeout(timeoutTimer);
          if (activeUpstreamReq && !activeUpstreamReq.destroyed) {
            activeUpstreamReq.destroy();
          }
          resolve();
        }
      };
      clientSocket.once('close', onClientAbort);
      clientSocket.once('error', onClientAbort);

      const attemptConnect = (attemptNumber: number) => {
        if (isHandshakeComplete || clientSocket.destroyed) {
          resolve();
          return;
        }

        // Select next READY candidate (skipping already attempted upstreams)
        const selectedUpstream =
          this.healthTracker?.selectUpstream(route.id, candidateUpstreams, attemptedUpstreams) ??
          candidateUpstreams.find((u) => !attemptedUpstreams.has(u)) ??
          candidateUpstreams[0]!;

        attemptedUpstreams.add(selectedUpstream);
        state = 'CONNECTING';

        const targetUrl = this.router.buildTargetUrl(route, urlPath, search, selectedUpstream);
        const parsedTarget = new URL(targetUrl);
        const isHttps = parsedTarget.protocol === 'https:';
        const clientLib = isHttps ? https : http;

        const sanitizedHeaders = sanitizeWebSocketUpgradeHeaders(req.headers, {
          clientIp,
          requestId,
          targetHost: parsedTarget.host,
          originalHost: typeof req.headers['host'] === 'string' ? req.headers['host'] : undefined,
          proto: isHttps ? 'https' : 'http',
          authContext,
        });

        const timeoutMs = route.timeouts?.connectTimeoutMs ?? this.defaultUpgradeTimeoutMs;

        timeoutTimer = setTimeout(() => {
          if (!isHandshakeComplete && state === 'CONNECTING') {
            upstreamReq.destroy();
            this.healthTracker?.markDegraded(selectedUpstream, 'Connect timeout');

            if (attemptNumber < maxAttempts && !clientSocket.destroyed) {
              this.logger?.warn(
                { routeId: route.id, failedUpstream: selectedUpstream, attempt: attemptNumber, requestId },
                'Pre-101 connect timeout; attempting failover to next upstream'
              );
              attemptConnect(attemptNumber + 1);
            } else {
              this.writeErrorAndClose(
                clientSocket,
                504,
                'Gateway Timeout',
                `WebSocket upgrade connection to upstream '${route.id}' timed out after ${timeoutMs}ms`,
                requestId
              );
              resolve();
            }
          }
        }, timeoutMs);

        const requestPath = `${parsedTarget.pathname}${parsedTarget.search}`;

        const upstreamReq = clientLib.request({
          hostname: parsedTarget.hostname,
          port: parsedTarget.port ? Number(parsedTarget.port) : (isHttps ? 443 : 80),
          path: requestPath,
          method: 'GET',
          headers: sanitizedHeaders,
        });
        activeUpstreamReq = upstreamReq;

        // Handle upstream connect / network error before 101
        upstreamReq.on('error', (err) => {
          if (timeoutTimer) clearTimeout(timeoutTimer);

          if (!isHandshakeComplete && state === 'CONNECTING') {
            this.healthTracker?.markDegraded(selectedUpstream, err.message);

            // Bounded pre-101 retry (at most 1 failover retry)
            if (attemptNumber < maxAttempts && !clientSocket.destroyed) {
              this.logger?.warn(
                { err: err.message, routeId: route.id, failedUpstream: selectedUpstream, attempt: attemptNumber, requestId },
                'Pre-101 upstream connection failure; failing over to next READY upstream'
              );
              attemptConnect(attemptNumber + 1);
            } else {
              clientSocket.off('close', onClientAbort);
              clientSocket.off('error', onClientAbort);
              this.writeErrorAndClose(
                clientSocket,
                502,
                'Bad Gateway',
                `Failed to connect to upstream WebSocket server: ${err.message}`,
                requestId
              );
              resolve();
            }
          }
        });

        // Handle upstream non-101 response (e.g. 401 Unauthorized or 503 Service Unavailable)
        upstreamReq.on('response', (upstreamRes) => {
          if (timeoutTimer) clearTimeout(timeoutTimer);

          const statusCode = upstreamRes.statusCode ?? 502;

          // If upstream returns 5xx (e.g. 503 draining / 502 bad gateway) before 101:
          // Treat as connect-time failure and attempt pre-101 failover to next candidate
          if (statusCode >= 500 && attemptNumber < maxAttempts && !clientSocket.destroyed) {
            upstreamRes.resume();
            this.healthTracker?.markDegraded(selectedUpstream, `Upstream returned HTTP ${statusCode}`);
            this.logger?.warn(
              { statusCode, routeId: route.id, failedUpstream: selectedUpstream, attempt: attemptNumber, requestId },
              'Pre-101 upstream 5xx response; failing over to next READY upstream'
            );
            attemptConnect(attemptNumber + 1);
            return;
          }

          isHandshakeComplete = true;
          clientSocket.off('close', onClientAbort);
          clientSocket.off('error', onClientAbort);

          const statusMessage = upstreamRes.statusMessage ?? 'Bad Gateway';
          const headers: string[] = [`HTTP/1.1 ${statusCode} ${statusMessage}`];

          for (const [k, v] of Object.entries(upstreamRes.headers)) {
            if (v !== undefined) {
              if (Array.isArray(v)) {
                for (const item of v) {
                  headers.push(`${k}: ${item}`);
                }
              } else {
                headers.push(`${k}: ${v}`);
              }
            }
          }
          headers.push(`X-Request-Id: ${requestId}`);

          clientSocket.write(headers.join('\r\n') + '\r\n\r\n');
          upstreamRes.pipe(clientSocket);
          upstreamRes.on('end', () => {
            clientSocket.end();
            resolve();
          });
        });

        // Handle upstream 101 Switching Protocols
        upstreamReq.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead) => {
          isHandshakeComplete = true;
          if (timeoutTimer) clearTimeout(timeoutTimer);
          clientSocket.off('close', onClientAbort);
          clientSocket.off('error', onClientAbort);

          // Mark upstream healthy upon successful upgrade
          this.healthTracker?.markHealthy(selectedUpstream);

          state = 'UPGRADED';

          // 1. Build HTTP 101 response line and forward upstream headers
          const headers: string[] = [
            'HTTP/1.1 101 Switching Protocols',
            'Upgrade: websocket',
            'Connection: Upgrade',
          ];

          if (upstreamRes.headers['sec-websocket-accept']) {
            headers.push(`Sec-WebSocket-Accept: ${upstreamRes.headers['sec-websocket-accept']}`);
          }
          if (upstreamRes.headers['sec-websocket-protocol']) {
            headers.push(`Sec-WebSocket-Protocol: ${upstreamRes.headers['sec-websocket-protocol']}`);
          }
          if (upstreamRes.headers['sec-websocket-extensions']) {
            headers.push(`Sec-WebSocket-Extensions: ${upstreamRes.headers['sec-websocket-extensions']}`);
          }
          headers.push(`X-Request-Id: ${requestId}`);

          // Write 101 Switching Protocols to client
          clientSocket.write(headers.join('\r\n') + '\r\n\r\n');

          // 2. Forward upstreamHead buffer if present
          if (upstreamHead && upstreamHead.length > 0) {
            clientSocket.write(upstreamHead);
          }

          // 3. Forward client head buffer if present
          if (head && head.length > 0) {
            upstreamSocket.write(head);
          }

          // 4. Configure socket flags
          if (typeof (clientSocket as any).setNoDelay === 'function') {
            (clientSocket as any).setNoDelay(true);
          }
          if (typeof (upstreamSocket as any).setNoDelay === 'function') {
            (upstreamSocket as any).setNoDelay(true);
          }
          if (typeof (clientSocket as any).setKeepAlive === 'function') {
            (clientSocket as any).setKeepAlive(true, 10000);
          }
          if (typeof (upstreamSocket as any).setKeepAlive === 'function') {
            (upstreamSocket as any).setKeepAlive(true, 10000);
          }

          // 5. Transition to ACTIVE_TUNNEL:
          // STRICT INVARIANT: Zero retry, zero upstream reselection, zero duplication
          state = 'ACTIVE_TUNNEL';

          const tunnel: ActiveTunnel = {
            id: requestId,
            routeId: route.id,
            clientIp,
            targetUrl,
            clientSocket,
            upstreamSocket,
            startedAt: Date.now(),
          };

          this.activeTunnels.add(tunnel);

          this.logger?.info(
            {
              event: 'WEBSOCKET_TUNNEL_ESTABLISHED',
              requestId,
              routeId: route.id,
              clientIp,
              targetUrl,
            },
            `WebSocket tunnel active: ${route.id} -> ${targetUrl}`
          );

          // 6. Native bidirectional stream piping
          clientSocket.pipe(upstreamSocket);
          upstreamSocket.pipe(clientSocket);

          // 7. Cleanup & mutual teardown with half-duplex end()
          let isCleanedUp = false;
          const cleanup = () => {
            if (isCleanedUp) return;
            isCleanedUp = true;
            state = 'CLOSED';
            this.activeTunnels.delete(tunnel);

            if (!clientSocket.destroyed) clientSocket.destroy();
            if (!upstreamSocket.destroyed) upstreamSocket.destroy();

            this.logger?.info(
              {
                event: 'WEBSOCKET_TUNNEL_CLOSED',
                requestId,
                routeId: route.id,
                durationMs: Date.now() - tunnel.startedAt,
              },
              `WebSocket tunnel closed: ${route.id}`
            );
            resolve();
          };

          // Half-duplex end propagation
          clientSocket.on('end', () => {
            if (!upstreamSocket.destroyed && upstreamSocket.writable) {
              upstreamSocket.end();
            }
          });
          upstreamSocket.on('end', () => {
            if (!clientSocket.destroyed && clientSocket.writable) {
              clientSocket.end();
            }
          });

          clientSocket.on('close', cleanup);
          clientSocket.on('error', (err) => {
            this.logger?.debug({ err: err.message, requestId }, 'Client socket error in active tunnel');
            cleanup();
          });

          upstreamSocket.on('close', cleanup);
          upstreamSocket.on('error', (err) => {
            this.logger?.debug({ err: err.message, requestId }, 'Upstream socket error in active tunnel');
            cleanup();
          });
        });

        upstreamReq.end();
      };

      attemptConnect(1);
    });
  }

  /**
   * Gracefully close all active WebSocket tunnels during RouteX shutdown.
   */
  public async closeAll(timeoutMs = 5000): Promise<void> {
    if (this.activeTunnels.size === 0) {
      return;
    }

    const tunnels = Array.from(this.activeTunnels);
    for (const tunnel of tunnels) {
      try {
        if (!tunnel.upstreamSocket.destroyed && tunnel.upstreamSocket.writable) {
          tunnel.upstreamSocket.end();
        }
        if (!tunnel.clientSocket.destroyed && tunnel.clientSocket.writable) {
          tunnel.clientSocket.end();
        }
      } catch {
        tunnel.upstreamSocket.destroy();
        tunnel.clientSocket.destroy();
      }
    }

    await new Promise<void>((resolve) => {
      let checkInterval: NodeJS.Timeout | undefined;
      const timer = setTimeout(() => {
        if (checkInterval) clearInterval(checkInterval);
        for (const tunnel of tunnels) {
          if (!tunnel.upstreamSocket.destroyed) tunnel.upstreamSocket.destroy();
          if (!tunnel.clientSocket.destroyed) tunnel.clientSocket.destroy();
        }
        this.activeTunnels.clear();
        resolve();
      }, timeoutMs);

      checkInterval = setInterval(() => {
        if (this.activeTunnels.size === 0) {
          clearTimeout(timer);
          if (checkInterval) clearInterval(checkInterval);
          resolve();
        }
      }, 50);
    });
  }

  private writeErrorAndClose(
    socket: Duplex,
    statusCode: number,
    statusText: string,
    message: string,
    requestId: string,
    extraHeaders: Record<string, string> = {}
  ): void {
    if (socket.destroyed || !socket.writable) {
      socket.destroy();
      return;
    }

    const code =
      statusCode === 429
        ? 'TOO_MANY_REQUESTS'
        : statusCode === 404
        ? 'ROUTE_NOT_FOUND'
        : statusCode === 401
        ? 'UNAUTHORIZED'
        : statusCode === 403
        ? 'FORBIDDEN'
        : statusCode === 502
        ? 'BAD_GATEWAY'
        : statusCode === 504
        ? 'GATEWAY_TIMEOUT'
        : 'BAD_REQUEST';

    const body = JSON.stringify({
      error: {
        code,
        message,
        statusCode,
        requestId,
      },
    });

    const headers: string[] = [
      `HTTP/1.1 ${statusCode} ${statusText}`,
      'Content-Type: application/json',
      `Content-Length: ${Buffer.byteLength(body)}`,
      'Connection: close',
      `X-Request-Id: ${requestId}`,
    ];

    for (const [k, v] of Object.entries(extraHeaders)) {
      headers.push(`${k}: ${v}`);
    }

    socket.write(headers.join('\r\n') + '\r\n\r\n' + body, () => {
      socket.destroy();
    });
  }
}
