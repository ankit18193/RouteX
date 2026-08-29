import fastify, { type FastifyError, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';

export interface ChatServiceOptions {
  readonly port?: number | undefined;
  readonly host?: string | undefined;
  readonly logger?: boolean | undefined;
}

export function buildChatService(options: ChatServiceOptions = {}): FastifyInstance {
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
      service: 'chat-service',
    });
  });

  // Allow raw stream payloads for binary and streaming endpoints
  app.addContentTypeParser('application/octet-stream', (_req, payload, done) => {
    done(null, payload);
  });

  // 1. Health check endpoint
  app.get('/healthz', async () => {
    return {
      status: 'ok',
      service: 'chat-service',
      timestamp: new Date().toISOString(),
    };
  });

  // 2. Mock chat list endpoint
  app.get('/api/v1/chats', async () => {
    return {
      service: 'chat-service',
      chats: [
        {
          id: 'chat_gen_01',
          name: 'General Discussion',
          topic: 'Architecture and Systems',
          memberCount: 42,
          createdAt: '2026-01-01T00:00:00.000Z',
        },
        {
          id: 'chat_infra_02',
          name: 'Infrastructure & Gateways',
          topic: 'Reverse proxies and edge controllers',
          memberCount: 18,
          createdAt: '2026-01-15T00:00:00.000Z',
        },
      ],
    };
  });

  // 3. Mock message creation endpoint
  app.post('/api/v1/messages', async (req: FastifyRequest, reply: FastifyReply) => {
    let body: Record<string, unknown> = {};

    if (Buffer.isBuffer(req.body) || typeof req.body === 'string') {
      try {
        body = JSON.parse(req.body.toString('utf-8')) as Record<string, unknown>;
      } catch {
        return reply.status(400).send({
          error: 'BAD_REQUEST',
          message: 'Invalid JSON body',
        });
      }
    } else if (req.body instanceof Readable || (req.body && typeof (req.body as any).pipe === 'function')) {
      const chunks: Buffer[] = [];
      for await (const chunk of req.body as AsyncIterable<Buffer | Uint8Array | string>) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as any));
      }
      const rawStr = Buffer.concat(chunks).toString('utf-8');
      try {
        body = JSON.parse(rawStr) as Record<string, unknown>;
      } catch {
        return reply.status(400).send({
          error: 'BAD_REQUEST',
          message: 'Invalid JSON body',
        });
      }
    } else if (typeof req.body === 'object' && req.body !== null) {
      body = req.body as Record<string, unknown>;
    }

    const chatId = typeof body.chatId === 'string' ? body.chatId.trim() : '';
    const content = typeof body.content === 'string' ? body.content.trim() : '';

    if (!chatId || !content) {
      return reply.status(400).send({
        error: 'BAD_REQUEST',
        message: 'chatId and content must be non-empty strings',
      });
    }

    return reply.status(201).send({
      id: `msg_${randomUUID()}`,
      chatId,
      content,
      senderId: (req.headers['x-user-id'] as string | undefined) ?? 'usr_anonymous',
      createdAt: new Date().toISOString(),
    });
  });

  // 4. Zero-buffer stream upload consumer endpoint
  app.post('/api/v1/echo-stream', async (req: FastifyRequest, reply: FastifyReply) => {
    let receivedBytes = 0;
    let chunkCount = 0;

    // Consume request body stream directly without accumulating in memory
    const stream = req.body instanceof Readable ? req.body : req.raw;

    for await (const chunk of stream) {
      const bufferChunk = Buffer.isBuffer(chunk)
        ? chunk
        : typeof chunk === 'string'
          ? Buffer.from(chunk)
          : Buffer.from(chunk as Uint8Array);
      receivedBytes += bufferChunk.length;
      chunkCount += 1;
    }

    return reply.status(200).send({
      status: 'ok',
      service: 'chat-service',
      receivedBytes,
      chunkCount,
    });
  });

  // 5. Zero-buffer stream download generator endpoint
  app.get('/api/v1/stream-payload', async (req: FastifyRequest, reply: FastifyReply) => {
    const query = (req.query ?? {}) as Record<string, string | undefined>;
    const rawSize = query.sizeMb ?? '1';
    const sizeMb = Number.parseInt(rawSize, 10);

    if (Number.isNaN(sizeMb) || sizeMb < 1 || sizeMb > 500) {
      return reply.status(400).send({
        error: 'BAD_REQUEST',
        message: 'sizeMb must be an integer between 1 and 500',
      });
    }

    const totalBytes = sizeMb * 1024 * 1024;
    const CHUNK_SIZE = 64 * 1024; // 64KB chunks
    const chunkTemplate = Buffer.alloc(CHUNK_SIZE, 'X');

    let bytesSent = 0;

    const stream = new Readable({
      read() {
        if (bytesSent >= totalBytes) {
          this.push(null); // End of stream
          return;
        }

        const remaining = totalBytes - bytesSent;
        const currentChunkSize = Math.min(remaining, CHUNK_SIZE);

        if (currentChunkSize === CHUNK_SIZE) {
          this.push(chunkTemplate);
        } else {
          this.push(chunkTemplate.subarray(0, currentChunkSize));
        }

        bytesSent += currentChunkSize;
      },
    });

    reply.header('content-type', 'application/octet-stream');
    reply.header('content-length', String(totalBytes));
    return reply.send(stream);
  });

  return app;
}

// Standalone runner
if (process.env.RUN_MOCK_CHAT_SERVICE === 'true') {
  const port = Number(process.env.CHAT_SERVICE_PORT ?? 4002);
  const host = process.env.CHAT_SERVICE_HOST ?? '0.0.0.0';
  const server = buildChatService({ port, host, logger: true });

  server.listen({ port, host }, (err, address) => {
    if (err) {
      server.log.error(err);
      process.exit(1);
    }
    server.log.info(`Mock Chat Service listening on ${address}`);
  });
}
