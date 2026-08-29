import { timingSafeEqual } from 'node:crypto';
import type { ApiKeysConfig, AuthContext } from './types.js';
import { type ApiKeyStore, hashApiKey, InMemoryApiKeyStore } from './api-key-store.js';
import { ApiKeyCache } from './api-key-cache.js';
import { UnauthorizedError } from '../errors/gateway-error.js';

const API_KEY_REGEX = /^rx_live_[a-zA-Z0-9_-]{16,72}$/;

export interface ApiKeyAuthenticatorOptions {
  readonly store?: ApiKeyStore | undefined;
  readonly cache?: ApiKeyCache | undefined;
}

export class ApiKeyAuthenticator {
  private readonly store: ApiKeyStore;
  private readonly cache: ApiKeyCache;

  constructor(options: ApiKeyAuthenticatorOptions = {}) {
    this.store = options.store ?? new InMemoryApiKeyStore([]);
    this.cache = options.cache ?? new ApiKeyCache({ maxEntries: 1000, ttlMs: 60000 });
  }

  /**
   * Authenticate raw API key string and return trusted AuthContext.
   */
  public async authenticate(rawKey: string): Promise<AuthContext> {
    if (!rawKey || typeof rawKey !== 'string') {
      throw new UnauthorizedError('Missing or empty API key');
    }

    const trimmedKey = rawKey.trim();
    if (!API_KEY_REGEX.test(trimmedKey)) {
      throw new UnauthorizedError(
        'Invalid API key format: key must match rx_live_[identifier]'
      );
    }

    const keyHash = hashApiKey(trimmedKey);

    // 1. Check bounded LRU cache
    const cachedAuth = this.cache.get(keyHash);
    if (cachedAuth) {
      return cachedAuth;
    }

    // 2. Lookup in store
    const stored = await this.store.getByKeyHash(keyHash);
    if (!stored) {
      throw new UnauthorizedError('Invalid API key');
    }

    // 3. Constant-time comparison of computed hash and stored hash
    const computedHashBuf = Buffer.from(keyHash, 'utf-8');
    const storedHashBuf = Buffer.from(stored.keyHash, 'utf-8');

    if (
      computedHashBuf.length !== storedHashBuf.length ||
      !timingSafeEqual(computedHashBuf, storedHashBuf)
    ) {
      throw new UnauthorizedError('Invalid API key');
    }

    // 4. Validate revocation status
    if (stored.revoked) {
      throw new UnauthorizedError('API key has been revoked');
    }

    // 5. Validate expiration
    if (stored.expiresAt !== undefined && Date.now() > stored.expiresAt) {
      throw new UnauthorizedError('API key has expired');
    }

    // 6. Build trusted identity context
    const authContext: AuthContext = {
      authenticated: true,
      authType: 'api-key',
      userId: stored.userId,
      roles: stored.roles,
      tier: stored.tier,
      keyId: stored.id,
    };

    // Cache valid identity context
    this.cache.set(keyHash, authContext);

    return authContext;
  }
}

/**
 * Factory function to create ApiKeyAuthenticator from configuration.
 */
export function createApiKeyAuthenticator(config: ApiKeysConfig = {}): ApiKeyAuthenticator {
  const store = new InMemoryApiKeyStore(config.keys ?? []);
  const cache = new ApiKeyCache({
    maxEntries: config.cacheMaxEntries ?? 1000,
    ttlMs: config.cacheTtlMs ?? 60000,
  });

  return new ApiKeyAuthenticator({ store, cache });
}
