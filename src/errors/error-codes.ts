/**
 * Standard Gateway Error Codes
 */

export const GatewayErrorCode = {
  BAD_REQUEST: 'BAD_REQUEST',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  ROUTE_NOT_FOUND: 'ROUTE_NOT_FOUND',
  TOO_MANY_REQUESTS: 'TOO_MANY_REQUESTS',
  RATE_LIMIT_UNAVAILABLE: 'RATE_LIMIT_UNAVAILABLE',
  INTERNAL_SERVER_ERROR: 'INTERNAL_SERVER_ERROR',
  BAD_GATEWAY: 'BAD_GATEWAY',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  GATEWAY_TIMEOUT: 'GATEWAY_TIMEOUT',
  UPSTREAM_CIRCUIT_OPEN: 'UPSTREAM_CIRCUIT_OPEN',
  CONFIGURATION_ERROR: 'CONFIGURATION_ERROR',
} as const;

export type GatewayErrorCode = (typeof GatewayErrorCode)[keyof typeof GatewayErrorCode];

export const GatewayErrorStatusMap: Record<GatewayErrorCode, number> = {
  [GatewayErrorCode.BAD_REQUEST]: 400,
  [GatewayErrorCode.UNAUTHORIZED]: 401,
  [GatewayErrorCode.FORBIDDEN]: 403,
  [GatewayErrorCode.NOT_FOUND]: 404,
  [GatewayErrorCode.ROUTE_NOT_FOUND]: 404,
  [GatewayErrorCode.TOO_MANY_REQUESTS]: 429,
  [GatewayErrorCode.RATE_LIMIT_UNAVAILABLE]: 503,
  [GatewayErrorCode.INTERNAL_SERVER_ERROR]: 500,
  [GatewayErrorCode.BAD_GATEWAY]: 502,
  [GatewayErrorCode.SERVICE_UNAVAILABLE]: 503,
  [GatewayErrorCode.GATEWAY_TIMEOUT]: 504,
  [GatewayErrorCode.UPSTREAM_CIRCUIT_OPEN]: 503,
  [GatewayErrorCode.CONFIGURATION_ERROR]: 500,
};
