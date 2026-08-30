#!/usr/bin/env node
import { buildUserService } from '../../mock-services/user-service/index.js';

async function main(): Promise<void> {
  const port = Number.parseInt(process.env.PORT ?? '4001', 10);
  const host = process.env.HOST ?? '0.0.0.0';

  const app = buildUserService({
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
    console.log(`Mock User Service listening on ${address}`);
  } catch (err) {
    console.error('Failed to start Mock User Service:', err);
    process.exit(1);
  }
}

void main();
