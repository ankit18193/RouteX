import type { IncomingHttpHeaders } from 'node:http';
import type { RouteDefinition } from '../types/index.js';
import { ANONYMOUS_AUTH_CONTEXT, type AuthConfig, type AuthContext } from './types.js';
import { extractCredentials } from './extractor.js';
import { createJwtVerifier, JwtVerifier } from './jwt-verifier.js';
import { createApiKeyAuthenticator, ApiKeyAuthenticator } from './api-key-authenticator.js';
import { ForbiddenError, UnauthorizedError } from '../errors/gateway-error.js';

export class AuthManager {
  private readonly jwtVerifier: JwtVerifier;
  private readonly apiKeyAuthenticator: ApiKeyAuthenticator;

  constructor(config: AuthConfig = {}) {
    this.jwtVerifier = createJwtVerifier(config.jwt ?? {});
    this.apiKeyAuthenticator = createApiKeyAuthenticator(config.apiKeys ?? {});
  }

  /**
   * Authenticate request against configured route authentication policy.
   */
  public async authenticate(
    headers: IncomingHttpHeaders | Record<string, string | string[] | undefined>,
    route: RouteDefinition
  ): Promise<AuthContext> {
    const mode = route.auth.mode ?? 'public';
    const credentials = extractCredentials(headers);

    switch (mode) {
      case 'public': {
        if (!credentials) {
          return ANONYMOUS_AUTH_CONTEXT;
        }
        // If client provided credentials on a public route, validate them (invalid credentials must fail)
        if (credentials.type === 'jwt') {
          return this.jwtVerifier.verify(credentials.rawToken);
        }
        return this.apiKeyAuthenticator.authenticate(credentials.rawToken);
      }

      case 'jwt': {
        if (!credentials) {
          throw new UnauthorizedError('JWT authentication required for this route');
        }
        if (credentials.type !== 'jwt') {
          throw new UnauthorizedError('Expected JWT Bearer token for this route');
        }
        return this.jwtVerifier.verify(credentials.rawToken);
      }

      case 'api-key': {
        if (!credentials) {
          throw new UnauthorizedError('API key authentication required for this route');
        }
        if (credentials.type !== 'api-key') {
          throw new UnauthorizedError('Expected API key credentials for this route');
        }
        return this.apiKeyAuthenticator.authenticate(credentials.rawToken);
      }

      case 'any': {
        if (!credentials) {
          throw new UnauthorizedError(
            'Authentication required: provide a valid JWT Bearer token or API key'
          );
        }
        if (credentials.type === 'jwt') {
          return this.jwtVerifier.verify(credentials.rawToken);
        }
        return this.apiKeyAuthenticator.authenticate(credentials.rawToken);
      }

      default: {
        return ANONYMOUS_AUTH_CONTEXT;
      }
    }
  }

  /**
   * Authorize authenticated identity against required route roles.
   * Policy: Identity must possess ALL required roles specified on the route.
   */
  public authorize(authContext: AuthContext, route: RouteDefinition): void {
    const requiredRoles = route.auth.requiredRoles ?? [];
    if (requiredRoles.length === 0) {
      return;
    }

    if (!authContext.authenticated) {
      throw new UnauthorizedError('Authentication required to access this resource');
    }

    const hasAllRoles = requiredRoles.every((role) =>
      authContext.roles.includes(role)
    );

    if (!hasAllRoles) {
      throw new ForbiddenError(
        'Access forbidden: insufficient role permissions',
        {
          requiredRoles,
          userRoles: authContext.roles,
        }
      );
    }
  }
}

/**
 * Factory function to create an AuthManager from configuration.
 */
export function createAuthManager(config: AuthConfig = {}): AuthManager {
  return new AuthManager(config);
}
