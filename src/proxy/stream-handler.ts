import type { FastifyReply, FastifyRequest } from 'fastify';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import type { RouteDefinition } from '../types/index.js';
import type { UpstreamPoolManager } from './pool.js';
import { sanitizeRequestHeaders, sanitizeResponseHeaders } from './headers.js';
import { createErrorEnvelope, GatewayTimeoutError } from '../errors/index.js';
import { elapsedMsFrom, startTimer } from '../utils/timing.js';
import type { AuthContext } from '../auth/types.js';

export interface ProxyHandlerOptions {
  readonly req: FastifyRequest;
  readonly reply: FastifyReply;
  readonly targetUrl: string;
  readonly route: RouteDefinition;
  readonly poolManager: UpstreamPoolManager;
  readonly requestId: string;
  readonly startTime: bigint;
  readonly authContext?: AuthContext | undefined;
}

export interface ProxyResult {
  readonly statusCode: number;
  readonly upstreamLatencyMs: number;
  readonly totalDurationMs: number;
  readonly responseHeaders?: Record<string, string | string[] | undefined> | undefined;
  readonly responseBody?: Buffer | undefined;
}

/**
 * Execute zero-buffer streaming reverse proxy dispatch to upstream service.
 */
export async function handleProxyStream(options: ProxyHandlerOptions): Promise<ProxyResult> {
  const { req, reply, targetUrl, route, poolManager, requestId, startTime, authContext } = options;
  const parsedTarget = new URL(targetUrl);

  const upstreamTimer = startTimer();
  const pool = poolManager.getPool(targetUrl, {
    connectTimeoutMs: route.timeouts.connectTimeoutMs,
    headersTimeoutMs: route.timeouts.responseTimeoutMs,
    bodyTimeoutMs: route.timeouts.responseTimeoutMs,
  });

  const abortController = new AbortController();
  let isTimedOut = false;

  const timeoutTimer = setTimeout(() => {
    isTimedOut = true;
    abortController.abort(
      new GatewayTimeoutError(
        `Upstream request to '${route.id}' timed out after ${route.timeouts.responseTimeoutMs}ms`
      )
    );
  }, route.timeouts.responseTimeoutMs);

  // Abort upstream request only if client truly aborts prematurely
  const onClientAbort = () => {
    abortController.abort();
  };
  req.raw.on('aborted', onClientAbort);

  const onSocketClose = () => {
    if (!req.raw.complete && !reply.raw.writableEnded) {
      abortController.abort();
    }
  };
  req.raw.socket?.on('close', onSocketClose);

  try {
    const sanitizedHeaders = sanitizeRequestHeaders(req.headers, {
      clientIp: req.ip,
      requestId,
      targetHost: parsedTarget.host,
      originalHost: typeof req.headers['host'] === 'string' ? req.headers['host'] : undefined,
      proto: req.protocol,
      authContext,
    });

    const method = req.method.toUpperCase();
    const hasRequestBody = method !== 'GET' && method !== 'HEAD';

    let body: any = null;
    if (hasRequestBody) {
      if (Buffer.isBuffer(req.body) || typeof req.body === 'string') {
        body = req.body;
      } else if (req.body instanceof Readable || (req.body && typeof (req.body as any).pipe === 'function')) {
        body = req.body;
      } else if (req.raw && typeof req.raw.pipe === 'function' && !req.raw.destroyed && !req.raw.readableEnded) {
        body = req.raw;
      } else if (req.body !== undefined && req.body !== null) {
        body = JSON.stringify(req.body);
      }
    }

    const requestPath = `${parsedTarget.pathname}${parsedTarget.search}`;

    const upstreamResponse = await pool.request({
      path: requestPath,
      method: method as any,
      headers: sanitizedHeaders,
      body,
      signal: abortController.signal,
    });

    const upstreamLatencyMs = upstreamTimer.stop();
    clearTimeout(timeoutTimer);

    const sanitizedResponseHeaders = sanitizeResponseHeaders(
      upstreamResponse.headers,
      requestId
    );

    // Merge headers configured on Fastify reply (e.g. rate limit headers, cache headers) into client response
    const replyHeaders = reply.getHeaders();
    for (const [key, val] of Object.entries(replyHeaders)) {
      if (val !== undefined) {
        sanitizedResponseHeaders[key.toLowerCase()] = String(val);
      }
    }

    // Write upstream status and sanitized headers directly to client response
    reply.raw.writeHead(upstreamResponse.statusCode, sanitizedResponseHeaders);

    // Bounded cache collection during streaming (only if route has caching enabled and 200 OK)
    let accumulatedChunks: Buffer[] | null = null;
    let accumulatedBytes = 0;
    let isOversized = false;
    const maxCacheBytes = route.cache?.enabled ? route.cache.maxBodyBytes : 0;

    if (route.cache?.enabled && method === 'GET' && upstreamResponse.statusCode === 200) {
      accumulatedChunks = [];
      upstreamResponse.body.on('data', (chunk: Buffer | string) => {
        if (!isOversized && accumulatedChunks) {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          accumulatedBytes += buf.length;
          if (accumulatedBytes <= maxCacheBytes) {
            accumulatedChunks.push(buf);
          } else {
            isOversized = true;
            accumulatedChunks = null; // Immediate GC if exceeds maxBodyBytes
          }
        }
      });
    }

    // Stream upstream response body directly to client with backpressure
    await pipeline(upstreamResponse.body, reply.raw);

    const totalDurationMs = elapsedMsFrom(startTime);
    const collectedBody = !isOversized && accumulatedChunks ? Buffer.concat(accumulatedChunks) : undefined;

    return {
      statusCode: upstreamResponse.statusCode,
      upstreamLatencyMs,
      totalDurationMs,
      responseHeaders: upstreamResponse.headers,
      responseBody: collectedBody,
    };
  } catch (err: unknown) {
    clearTimeout(timeoutTimer);
    const upstreamLatencyMs = upstreamTimer.stop();
    const totalDurationMs = elapsedMsFrom(startTime);

    if (isTimedOut) {
      const timeoutError = new GatewayTimeoutError(
        `Gateway timed out waiting for upstream '${route.id}' (${route.timeouts.responseTimeoutMs}ms)`
      );
      sendGatewayErrorResponse(reply, timeoutError, requestId);
      return {
        statusCode: 504,
        upstreamLatencyMs,
        totalDurationMs,
      };
    }

    if (!reply.raw.headersSent) {
      const errorEnvelope = createErrorEnvelope(err, requestId);
      for (const [headerKey, headerVal] of Object.entries(errorEnvelope.headers)) {
        reply.raw.setHeader(headerKey, headerVal);
      }
      reply.raw.writeHead(errorEnvelope.statusCode);
      reply.raw.end(JSON.stringify(errorEnvelope.envelope));
      return {
        statusCode: errorEnvelope.statusCode,
        upstreamLatencyMs,
        totalDurationMs,
      };
    } else {
      reply.raw.destroy(err instanceof Error ? err : new Error(String(err)));
      return {
        statusCode: 500,
        upstreamLatencyMs,
        totalDurationMs,
      };
    }
  } finally {
    clearTimeout(timeoutTimer);
    req.raw.off('aborted', onClientAbort);
    req.raw.socket?.off('close', onSocketClose);
  }
}

function sendGatewayErrorResponse(
  reply: FastifyReply,
  err: unknown,
  requestId: string
): void {
  if (reply.raw.headersSent) {
    reply.raw.destroy();
    return;
  }

  const envelopeResponse = createErrorEnvelope(err, requestId);
  for (const [key, val] of Object.entries(envelopeResponse.headers)) {
    reply.raw.setHeader(key, val);
  }
  reply.raw.writeHead(envelopeResponse.statusCode);
  reply.raw.end(JSON.stringify(envelopeResponse.envelope));
}
