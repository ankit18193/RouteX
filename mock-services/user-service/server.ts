import fastify, { type FastifyError, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { generateTestJwt, type TestJwtOptions } from './jwt-utils.js';

export interface UserServiceOptions {
  readonly port?: number | undefined;
  readonly host?: string | undefined;
  readonly logger?: boolean | undefined;
}

export function buildUserService(options: UserServiceOptions = {}): FastifyInstance {
  const app = fastify({
    logger: options.logger ?? false,
  });

  // Custom error handler for consistent JSON errors
  app.setErrorHandler((error: FastifyError | Error, _request, reply) => {
    const statusCode = ('statusCode' in error && typeof error.statusCode === 'number') ? error.statusCode : 500;
    const errorCode = statusCode === 400 ? 'BAD_REQUEST' : statusCode === 404 ? 'NOT_FOUND' : 'INTERNAL_SERVER_ERROR';
    reply.status(statusCode).send({
      error: errorCode,
      message: error.message,
      service: 'user-service',
    });
  });

  // 1. Health check endpoint
  app.get('/healthz', async () => {
    return {
      status: 'ok',
      service: 'user-service',
      timestamp: new Date().toISOString(),
    };
  });

  // 2. Identity reflection endpoint (reads downstream trusted headers injected by RouteX Gateway)
  app.get('/api/v1/users/me', async (req: FastifyRequest) => {
    const rawUserId = req.headers['x-user-id'];
    const rawRoles = req.headers['x-user-roles'];
    const rawRequestId = req.headers['x-request-id'];
    const rawAuthType = req.headers['x-auth-type'];

    const userId = typeof rawUserId === 'string' ? rawUserId : null;
    const requestId = typeof rawRequestId === 'string' ? rawRequestId : null;
    const authType = typeof rawAuthType === 'string' ? rawAuthType : null;

    let roles: string[] = [];
    if (typeof rawRoles === 'string' && rawRoles.trim().length > 0) {
      roles = rawRoles.split(',').map((r) => r.trim()).filter(Boolean);
    }

    return {
      service: 'user-service',
      userId,
      roles,
      userRoles: roles,
      requestId,
      authType,
      receivedHeaders: req.headers,
    };
  });

  // 3. Test JWT token generator endpoint
  app.post('/api/v1/auth/token', async (req: FastifyRequest, reply: FastifyReply) => {
    const body = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as {
      sub?: unknown;
      roles?: unknown;
      expiresInSec?: unknown;
      algorithm?: unknown;
      claims?: unknown;
    };

    let algorithm: 'HS256' | 'RS256' = 'HS256';
    if (body.algorithm !== undefined) {
      if (body.algorithm !== 'HS256' && body.algorithm !== 'RS256') {
        return reply.status(400).send({
          error: 'BAD_REQUEST',
          message: 'Algorithm must be "HS256" or "RS256"',
        });
      }
      algorithm = body.algorithm;
    }

    let expiresInSec = 3600;
    if (body.expiresInSec !== undefined) {
      const parsed = Number(body.expiresInSec);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 604800) {
        return reply.status(400).send({
          error: 'BAD_REQUEST',
          message: 'expiresInSec must be an integer between 1 and 604800 (7 days)',
        });
      }
      expiresInSec = parsed;
    }

    const sub = typeof body.sub === 'string' && body.sub.trim().length > 0 ? body.sub.trim() : 'usr_test_123';
    const roles = Array.isArray(body.roles) ? body.roles.map(String) : ['user'];
    const customClaims = typeof body.claims === 'object' && body.claims !== null ? (body.claims as Record<string, unknown>) : undefined;

    const jwtOptions: TestJwtOptions = {
      sub,
      roles,
      expiresInSec,
      algorithm,
      customClaims,
    };

    const token = generateTestJwt(jwtOptions);

    return reply.status(200).send({
      token,
      tokenType: 'Bearer',
      expiresIn: expiresInSec,
      algorithm,
      claims: {
        sub,
        roles,
        ...(customClaims ?? {}),
      },
    });
  });

  // 4. Slow endpoint for gateway timeout testing
  app.get('/api/v1/users/slow', async (req: FastifyRequest, reply: FastifyReply) => {
    const query = (req.query ?? {}) as Record<string, string | undefined>;
    const rawDelay = query.delayMs ?? '1000';
    const delayMs = Number.parseInt(rawDelay, 10);

    if (Number.isNaN(delayMs) || delayMs < 1 || delayMs > 60000) {
      return reply.status(400).send({
        error: 'BAD_REQUEST',
        message: 'delayMs must be an integer between 1 and 60000',
      });
    }

    await new Promise((resolve) => setTimeout(resolve, delayMs));

    return {
      status: 'ok',
      service: 'user-service',
      delayedMs: delayMs,
    };
  });

  // 5. Fault simulation endpoint (controlled 500 or abrupt connection crash)
  app.get('/api/v1/users/fault', async (req: FastifyRequest, reply: FastifyReply) => {
    const query = (req.query ?? {}) as Record<string, string | undefined>;
    const faultType = query.type;

    if (faultType === '500') {
      return reply.status(500).send({
        error: 'INTERNAL_SERVER_ERROR',
        message: 'Simulated upstream 500 error',
        service: 'user-service',
      });
    }

    if (faultType === 'crash') {
      // Abruptly terminate the underlying TCP connection without sending HTTP response
      reply.raw.destroy();
      return;
    }

    return reply.status(400).send({
      error: 'BAD_REQUEST',
      message: 'Query parameter "type" must be "500" or "crash"',
    });
  });

  return app;
}

// Standalone runner
if (process.env.RUN_MOCK_USER_SERVICE === 'true') {
  const port = Number(process.env.USER_SERVICE_PORT ?? 4001);
  const host = process.env.USER_SERVICE_HOST ?? '0.0.0.0';
  const server = buildUserService({ port, host, logger: true });

  server.listen({ port, host }, (err, address) => {
    if (err) {
      server.log.error(err);
      process.exit(1);
    }
    server.log.info(`Mock User Service listening on ${address}`);
  });
}
