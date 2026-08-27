import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import YAML from 'yaml';
import { ZodError } from 'zod';
import {
  GatewayConfigSchema,
  RoutesConfigSchema,
  RoutesListSchema,
} from './schema.js';
import type { GatewayConfig, RouteDefinition } from '../types/index.js';
import { ConfigurationError } from '../errors/gateway-error.js';

export interface LoadConfigOptions {
  readonly configPath?: string | undefined;
  readonly routesPath?: string | undefined;
  readonly env?: Record<string, string | undefined> | undefined;
}

function isRecord(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}

/**
 * Load, merge, and validate gateway configuration from files and environment variables.
 */
export function loadGatewayConfig(options: LoadConfigOptions = {}): GatewayConfig {
  const env = options.env ?? process.env;

  const defaultConfigFile = env.ROUTEX_CONFIG_PATH ?? options.configPath ?? 'config/gateway.config.yaml';
  const explicitRoutesFile = env.ROUTEX_ROUTES_PATH ?? options.routesPath;

  const rawConfig = loadRawFile(defaultConfigFile);
  const rawConfigRecord = isRecord(rawConfig) ? rawConfig : {};

  // Check if routes are embedded directly in the main config file
  let mergedRoutes: unknown = rawConfigRecord.routes;

  // Precedence rule for routes loading:
  // 1. If an explicit routes file is specified (via options.routesPath or ROUTEX_ROUTES_PATH), load it.
  // 2. If no explicit routes file is specified and no embedded routes exist in main config, load default 'config/routes.yaml'.
  // 3. If embedded routes exist in main config and no explicit routes file was requested, preserve embedded routes.
  const routesFileToLoad = explicitRoutesFile ?? (!mergedRoutes ? 'config/routes.yaml' : null);

  if (routesFileToLoad) {
    const rawRoutes = loadRawFile(routesFileToLoad);
    if (rawRoutes) {
      if (Array.isArray(rawRoutes)) {
        mergedRoutes = rawRoutes;
      } else if (isRecord(rawRoutes) && 'routes' in rawRoutes) {
        mergedRoutes = rawRoutes.routes;
      }
    }
  }

  // Build intermediate config object with env overrides
  const serverOverrides: Record<string, unknown> = {};
  if (env.PORT !== undefined && env.PORT !== '') {
    const parsed = Number.parseInt(env.PORT, 10);
    if (!Number.isNaN(parsed)) {
      serverOverrides.port = parsed;
    }
  }
  if (env.HOST !== undefined && env.HOST !== '') {
    serverOverrides.host = env.HOST;
  }
  if (env.LOG_LEVEL !== undefined && env.LOG_LEVEL !== '') {
    serverOverrides.logLevel = env.LOG_LEVEL.toLowerCase();
  }
  if (env.LOG_FORMAT !== undefined && env.LOG_FORMAT !== '') {
    serverOverrides.logFormat = env.LOG_FORMAT.toLowerCase();
  }

  const redisOverrides: Record<string, unknown> = {};
  if (env.REDIS_HOST !== undefined && env.REDIS_HOST !== '') {
    redisOverrides.host = env.REDIS_HOST;
  }
  if (env.REDIS_PORT !== undefined && env.REDIS_PORT !== '') {
    const parsed = Number.parseInt(env.REDIS_PORT, 10);
    if (!Number.isNaN(parsed)) {
      redisOverrides.port = parsed;
    }
  }
  if (env.REDIS_PASSWORD !== undefined) {
    redisOverrides.password = env.REDIS_PASSWORD;
  }

  const rawServer = isRecord(rawConfigRecord.server) ? rawConfigRecord.server : {};
  const rawRedis = isRecord(rawConfigRecord.redis) ? rawConfigRecord.redis : {};

  const candidateConfig = {
    server: {
      ...rawServer,
      ...serverOverrides,
    },
    redis: {
      ...rawRedis,
      ...redisOverrides,
    },
    routes: mergedRoutes,
  };

  try {
    return GatewayConfigSchema.parse(candidateConfig);
  } catch (error) {
    if (error instanceof ZodError) {
      const issues = error.issues
        .map((issue) => `  - [${issue.path.join('.')}]: ${issue.message}`)
        .join('\n');
      throw new ConfigurationError(`Invalid RouteX configuration:\n${issues}`, error.issues);
    }
    throw new ConfigurationError(`Failed to parse RouteX configuration: ${String(error)}`);
  }
}

/**
 * Load and validate a standalone routes file
 */
export function loadRoutesConfig(filePath: string): readonly RouteDefinition[] {
  const raw = loadRawFile(filePath);
  if (!raw) {
    throw new ConfigurationError(`Routes file not found or empty at: ${filePath}`);
  }

  try {
    if (Array.isArray(raw)) {
      return RoutesListSchema.parse(raw);
    }
    if (isRecord(raw) && 'routes' in raw) {
      return RoutesConfigSchema.parse(raw).routes;
    }
    throw new ConfigurationError('Routes file must contain an array of routes or an object with a "routes" array');
  } catch (error) {
    if (error instanceof ZodError) {
      const issues = error.issues
        .map((issue) => `  - [${issue.path.join('.')}]: ${issue.message}`)
        .join('\n');
      throw new ConfigurationError(`Invalid routes configuration in ${filePath}:\n${issues}`, error.issues);
    }
    if (error instanceof ConfigurationError) {
      throw error;
    }
    throw new ConfigurationError(`Failed to load routes from ${filePath}: ${String(error)}`);
  }
}

/**
 * Helper to safely read and parse a YAML/JSON file from disk
 */
function loadRawFile(filePath: string): Record<string, unknown> | unknown[] | null {
  const resolved = resolve(process.cwd(), filePath);
  if (!existsSync(resolved)) {
    return null;
  }

  const content = readFileSync(resolved, 'utf-8');
  if (!content.trim()) {
    return null;
  }

  try {
    return YAML.parse(content) as Record<string, unknown> | unknown[];
  } catch (err) {
    throw new ConfigurationError(
      `Syntax error while parsing YAML configuration file (${filePath}): ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
