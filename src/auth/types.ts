export type AuthType = 'anonymous' | 'jwt' | 'api-key';

export interface AuthContext {
  readonly authenticated: boolean;
  readonly authType: AuthType;
  readonly userId: string | null;
  readonly roles: readonly string[];
  readonly tier?: string | undefined;
  readonly keyId?: string | undefined;
  readonly claims?: Record<string, unknown> | undefined;
}

export const ANONYMOUS_AUTH_CONTEXT: AuthContext = Object.freeze({
  authenticated: false,
  authType: 'anonymous',
  userId: null,
  roles: Object.freeze([]),
});

export type ExtractedCredentialType = 'jwt' | 'api-key';

export interface ExtractedCredentials {
  readonly type: ExtractedCredentialType;
  readonly rawToken: string;
  readonly source: 'authorization-bearer' | 'x-api-key';
}

export interface JwtConfig {
  readonly enabled?: boolean | undefined;
  readonly algorithms?: readonly ('HS256' | 'RS256')[] | undefined;
  readonly issuer?: string | undefined;
  readonly audience?: string | undefined;
  readonly hs256Secret?: string | undefined;
  readonly rs256PublicKey?: string | undefined;
  readonly hs256SecretEnv?: string | undefined;
  readonly rs256PublicKeyEnv?: string | undefined;
}

export interface ApiKeyDefinition {
  readonly id: string;
  readonly key: string;
  readonly userId: string;
  readonly roles: readonly string[];
  readonly tier?: string | undefined;
  readonly revoked?: boolean | undefined;
  readonly expiresAt?: string | number | undefined;
}

export interface ApiKeysConfig {
  readonly enabled?: boolean | undefined;
  readonly cacheTtlMs?: number | undefined;
  readonly cacheMaxEntries?: number | undefined;
  readonly keys?: readonly ApiKeyDefinition[] | undefined;
}

export interface AuthConfig {
  readonly jwt?: JwtConfig | undefined;
  readonly apiKeys?: ApiKeysConfig | undefined;
}
