import type { RouteDefinition } from '../types/index.js';
import type { RouteMatchResult, RouteMatchSuccess } from './types.js';

export class ProxyRouter {
  private readonly sortedRoutes: readonly RouteDefinition[];

  constructor(routes: readonly RouteDefinition[]) {
    // Sort routes by pathPrefix length descending (longest prefix matching)
    this.sortedRoutes = [...routes].sort((a, b) => {
      if (b.pathPrefix.length !== a.pathPrefix.length) {
        return b.pathPrefix.length - a.pathPrefix.length;
      }
      return a.id.localeCompare(b.id);
    });
  }

  /**
   * Match an incoming request path and method against configured routes.
   * Finds the longest matching prefix candidate(s) and applies method policy.
   * @param requestPath URL pathname (e.g. '/api/v1/users/me')
   * @param httpMethod HTTP verb (e.g. 'GET', 'POST')
   * @param search Optional query string (e.g. '?page=1&limit=10')
   */
  public match(requestPath: string, httpMethod: string, search = ''): RouteMatchResult {
    const normalizedPath = this.normalizePath(requestPath);
    const normalizedMethod = httpMethod.toUpperCase();

    // 1. Identify all routes that match the request path
    const matchingRoutes: RouteDefinition[] = [];
    for (const route of this.sortedRoutes) {
      if (this.isPrefixMatch(normalizedPath, route.pathPrefix)) {
        matchingRoutes.push(route);
      }
    }

    if (matchingRoutes.length === 0) {
      return {
        matched: false,
        reason: 'NOT_FOUND',
      };
    }

    // 2. Select candidates with the longest matching pathPrefix
    const longestPrefixLength = matchingRoutes[0]!.pathPrefix.length;
    const candidates = matchingRoutes.filter(
      (r) => r.pathPrefix.length === longestPrefixLength
    );

    // 3. Find a candidate that permits the requested HTTP method
    const matchedRoute = candidates.find((r) =>
      r.methods.includes(normalizedMethod as any)
    );

    if (matchedRoute) {
      return this.buildMatchSuccess(matchedRoute, normalizedPath, search);
    }

    // 4. Method not allowed for this specific path prefix
    const allowedMethods = Array.from(
      new Set(candidates.flatMap((r) => r.methods))
    );

    return {
      matched: false,
      reason: 'METHOD_NOT_ALLOWED',
      allowedMethods,
    };
  }

  private isPrefixMatch(pathname: string, prefix: string): boolean {
    if (prefix === '/') {
      return true;
    }

    if (pathname === prefix) {
      return true;
    }

    if (pathname.startsWith(`${prefix}/`)) {
      return true;
    }

    return false;
  }

  private buildMatchSuccess(
    route: RouteDefinition,
    pathname: string,
    search: string
  ): RouteMatchSuccess {
    let remainingPath = pathname;

    if (route.stripPrefix) {
      if (route.pathPrefix === '/') {
        remainingPath = pathname;
      } else {
        remainingPath = pathname.slice(route.pathPrefix.length);
      }
    }

    // Build target upstream URL
    const upstreamBase = route.upstream.endsWith('/')
      ? route.upstream.slice(0, -1)
      : route.upstream;

    let pathPart = '';
    if (remainingPath !== '' && remainingPath !== '/') {
      pathPart = remainingPath.startsWith('/') ? remainingPath : `/${remainingPath}`;
    }

    const cleanSearch = search.startsWith('?') || search === '' ? search : `?${search}`;
    const targetUrl = `${upstreamBase}${pathPart}${cleanSearch}`;

    return {
      matched: true,
      route,
      targetUrl,
      remainingPath: remainingPath === '' ? '/' : remainingPath,
    };
  }

  private normalizePath(rawPath: string): string {
    if (!rawPath || rawPath === '') {
      return '/';
    }
    const clean = rawPath.split('?')[0]?.split('#')[0] ?? '/';
    if (!clean.startsWith('/')) {
      return `/${clean}`;
    }
    return clean;
  }
}
