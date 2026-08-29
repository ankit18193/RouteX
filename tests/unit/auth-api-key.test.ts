import { describe, it, expect, beforeEach } from 'vitest';
import { ApiKeyAuthenticator, createApiKeyAuthenticator } from '../../src/auth/api-key-authenticator.js';
import { InMemoryApiKeyStore, hashApiKey } from '../../src/auth/api-key-store.js';
import { ApiKeyCache } from '../../src/auth/api-key-cache.js';
import { UnauthorizedError } from '../../src/errors/gateway-error.js';

describe('ApiKeyAuthenticator & Cache', () => {
  const validKey = 'rx_live_12345678901234567890123456789012';
  const revokedKey = 'rx_live_revoked_key_12345678901234567890';
  const expiredKey = 'rx_live_expired_key_12345678901234567890';

  let store: InMemoryApiKeyStore;
  let cache: ApiKeyCache;
  let authenticator: ApiKeyAuthenticator;

  beforeEach(() => {
    store = new InMemoryApiKeyStore([
      {
        id: 'key_valid_01',
        key: validKey,
        userId: 'usr_api_client_01',
        roles: ['api:read', 'api:write'],
        tier: 'business',
        revoked: false,
      },
      {
        id: 'key_revoked_02',
        key: revokedKey,
        userId: 'usr_api_client_02',
        roles: ['api:read'],
        tier: 'starter',
        revoked: true,
      },
      {
        id: 'key_expired_03',
        key: expiredKey,
        userId: 'usr_api_client_03',
        roles: ['api:read'],
        tier: 'starter',
        revoked: false,
        expiresAt: Date.now() - 10000, // 10s in past
      },
    ]);

    cache = new ApiKeyCache({ maxEntries: 10, ttlMs: 1000 });
    authenticator = new ApiKeyAuthenticator({ store, cache });
  });

  it('should authenticate valid API key and return trusted AuthContext', async () => {
    const auth = await authenticator.authenticate(validKey);
    expect(auth.authenticated).toBe(true);
    expect(auth.authType).toBe('api-key');
    expect(auth.userId).toBe('usr_api_client_01');
    expect(auth.roles).toEqual(['api:read', 'api:write']);
    expect(auth.tier).toBe('business');
    expect(auth.keyId).toBe('key_valid_01');
  });

  it('should throw UnauthorizedError on unknown API key', async () => {
    const unknownKey = 'rx_live_unknown_key_99999999999999999999';
    await expect(authenticator.authenticate(unknownKey)).rejects.toThrow(UnauthorizedError);
    await expect(authenticator.authenticate(unknownKey)).rejects.toThrow('Invalid API key');
  });

  it('should throw UnauthorizedError on revoked API key', async () => {
    await expect(authenticator.authenticate(revokedKey)).rejects.toThrow(UnauthorizedError);
    await expect(authenticator.authenticate(revokedKey)).rejects.toThrow('API key has been revoked');
  });

  it('should throw UnauthorizedError on expired API key', async () => {
    await expect(authenticator.authenticate(expiredKey)).rejects.toThrow(UnauthorizedError);
    await expect(authenticator.authenticate(expiredKey)).rejects.toThrow('API key has expired');
  });

  it('should throw UnauthorizedError on invalid key format (missing rx_live_ prefix)', async () => {
    const invalidFormat = 'not_a_valid_prefix_key_123456789012345';
    await expect(authenticator.authenticate(invalidFormat)).rejects.toThrow(UnauthorizedError);
    await expect(authenticator.authenticate(invalidFormat)).rejects.toThrow('Invalid API key format');
  });

  describe('ApiKeyCache Behavior', () => {
    it('should hit cache on subsequent authentications of same key', async () => {
      expect(cache.size).toBe(0);

      // First call (cache miss -> stored in cache)
      const auth1 = await authenticator.authenticate(validKey);
      expect(cache.size).toBe(1);

      // Second call (cache hit)
      const keyHash = hashApiKey(validKey);
      const cached = cache.get(keyHash);
      expect(cached).toEqual(auth1);

      const auth2 = await authenticator.authenticate(validKey);
      expect(auth2).toEqual(auth1);
    });

    it('should expire entries after TTL', async () => {
      const shortTtlCache = new ApiKeyCache({ maxEntries: 10, ttlMs: 10 }); // 10ms
      const shortTtlAuthenticator = new ApiKeyAuthenticator({ store, cache: shortTtlCache });

      await shortTtlAuthenticator.authenticate(validKey);
      const keyHash = hashApiKey(validKey);
      expect(shortTtlCache.get(keyHash)).not.toBeNull();

      // Wait 25ms for TTL expiry
      await new Promise((r) => setTimeout(r, 25));
      expect(shortTtlCache.get(keyHash)).toBeNull();
    });

    it('should evict least-recently-used entry when maxEntries is exceeded', () => {
      const lruCache = new ApiKeyCache({ maxEntries: 2, ttlMs: 60000 });
      const authCtx = (id: string) => ({
        authenticated: true,
        authType: 'api-key' as const,
        userId: id,
        roles: [],
      });

      lruCache.set('hash1', authCtx('usr1'));
      lruCache.set('hash2', authCtx('usr2'));
      expect(lruCache.size).toBe(2);

      // Access hash1 to make it most-recently-used
      lruCache.get('hash1');

      // Insert hash3 -> should evict hash2 (least recently used)
      lruCache.set('hash3', authCtx('usr3'));
      expect(lruCache.size).toBe(2);
      expect(lruCache.get('hash2')).toBeNull();
      expect(lruCache.get('hash1')).not.toBeNull();
      expect(lruCache.get('hash3')).not.toBeNull();
    });
  });

  describe('createApiKeyAuthenticator factory', () => {
    it('should initialize authenticator from config definition', async () => {
      const authFactory = createApiKeyAuthenticator({
        enabled: true,
        cacheTtlMs: 30000,
        cacheMaxEntries: 500,
        keys: [
          {
            id: 'key_factory_01',
            key: 'rx_live_factory_key_12345678901234567890',
            userId: 'usr_factory',
            roles: ['api:all'],
          },
        ],
      });

      const res = await authFactory.authenticate('rx_live_factory_key_12345678901234567890');
      expect(res.userId).toBe('usr_factory');
    });
  });
});
