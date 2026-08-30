#!/usr/bin/env node
import { loadGatewayConfig } from '../config/loader.js';
import { RouteXGatewayServer } from '../server/gateway-server.js';
import { createLogger } from '../logger/logger.js';

async function main(): Promise<void> {
  const config = loadGatewayConfig();
  const logger = createLogger({
    level: config.server.logLevel,
    format: config.server.logFormat,
    name: 'routex-main',
  });

  logger.info(
    {
      version: '0.1.0',
      port: config.server.port,
      host: config.server.host,
      routesCount: config.routes.length,
      redisHost: config.redis?.host,
    },
    'Initializing RouteX API Gateway...'
  );

  const server = new RouteXGatewayServer(config, { logger: false });

  let isShuttingDown = false;
  const gracefulShutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    logger.info({ signal }, `Received ${signal}, initiating graceful shutdown...`);

    const shutdownTimeout = setTimeout(() => {
      logger.error('Graceful shutdown timed out, forcing exit.');
      process.exit(1);
    }, 10000);

    try {
      await server.close();
      clearTimeout(shutdownTimeout);
      logger.info('RouteX Gateway shutdown completed cleanly.');
      process.exit(0);
    } catch (err) {
      clearTimeout(shutdownTimeout);
      logger.error({ err }, 'Error during RouteX Gateway shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => void gracefulShutdown('SIGINT'));

  try {
    const address = await server.listen();
    logger.info({ address }, `RouteX API Gateway listening on ${address}`);
  } catch (err) {
    logger.fatal({ err }, 'Failed to start RouteX API Gateway');
    process.exit(1);
  }
}

void main();
