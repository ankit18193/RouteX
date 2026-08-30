#!/usr/bin/env node
import { buildChatService } from '../../mock-services/chat-service/index.js';

async function main(): Promise<void> {
  const port = Number.parseInt(process.env.PORT ?? '4002', 10);
  const host = process.env.HOST ?? '0.0.0.0';

  const app = buildChatService({
    port,
    host,
    logger: process.env.LOG_LEVEL !== 'silent',
  });

  const gracefulShutdown = async () => {
    try {
      await app.close();
      process.exit(0);
    } catch {
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void gracefulShutdown());
  process.on('SIGINT', () => void gracefulShutdown());

  try {
    const address = await app.listen({ port, host });
    console.log(`Mock Chat Service listening on ${address}`);
  } catch (err) {
    console.error('Failed to start Mock Chat Service:', err);
    process.exit(1);
  }
}

void main();
