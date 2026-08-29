import { createHmac, createVerify, timingSafeEqual } from 'node:crypto';
import type { AuthContext, JwtConfig } from './types.js';
import { UnauthorizedError } from '../errors/gateway-error.js';

export interface JwtVerifierOptions {
  readonly enabled?: boolean | undefined;
  readonly algorithms?: readonly ('HS256' | 'RS256')[] | undefined;
  readonly issuer?: string | undefined;
  readonly audience?: string | undefined;
  readonly hs256Secret?: string | undefined;
  readonly rs256PublicKey?: string | undefined;
  readonly clockToleranceSec?: number | undefined;
}

export class JwtVerifier {
  private readonly algorithms: Set<'HS256' | 'RS256'>;
  private readonly issuer?: string | undefined;
  private readonly audience?: string | undefined;
  private readonly hs256Secret?: string | undefined;
  private readonly rs256PublicKey?: string | undefined;
  private readonly clockToleranceSec: number;

  constructor(options: JwtVerifierOptions = {}) {
    const algs = options.algorithms ?? ['HS256', 'RS256'];
    this.algorithms = new Set(algs);
    this.issuer = options.issuer;
    this.audience = options.audience;
    this.hs256Secret = options.hs256Secret;
    this.rs256PublicKey = options.rs256PublicKey;
    this.clockToleranceSec = options.clockToleranceSec ?? 0;
  }

  /**
   * Verify an incoming JWT string and construct a trusted AuthContext.
   */
  public verify(rawToken: string): AuthContext {
    if (!rawToken || typeof rawToken !== 'string') {
      throw new UnauthorizedError('Missing or empty JWT');
    }

    const parts = rawToken.split('.');
    if (parts.length !== 3) {
      throw new UnauthorizedError('Invalid JWT format: must contain 3 segments');
    }

    const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

    // 1. Decode header and validate algorithm
    let header: Record<string, unknown>;
    try {
      header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf-8')) as Record<string, unknown>;
    } catch {
      throw new UnauthorizedError('Invalid JWT header: malformed JSON or base64url');
    }

    const alg = header.alg;
    if (typeof alg !== 'string' || alg === 'none' || !this.algorithms.has(alg as any)) {
      throw new UnauthorizedError(`Unsupported or disallowed JWT algorithm: ${String(alg)}`);
    }

    // 2. Cryptographic signature verification BEFORE trusting payload
    const dataToVerify = `${headerB64}.${payloadB64}`;

    if (alg === 'HS256') {
      if (!this.hs256Secret) {
        throw new UnauthorizedError('HS256 verification failed: No HS256 secret configured');
      }

      const expectedSignature = createHmac('sha256', this.hs256Secret)
        .update(dataToVerify)
        .digest('base64url');

      const expectedBuffer = Buffer.from(expectedSignature, 'utf-8');
      const actualBuffer = Buffer.from(signatureB64, 'utf-8');

      if (
        expectedBuffer.length !== actualBuffer.length ||
        !timingSafeEqual(expectedBuffer, actualBuffer)
      ) {
        throw new UnauthorizedError('JWT signature verification failed');
      }
    } else if (alg === 'RS256') {
      if (!this.rs256PublicKey) {
        throw new UnauthorizedError('RS256 verification failed: No RS256 public key configured');
      }

      try {
        const verifier = createVerify('RSA-SHA256');
        verifier.update(dataToVerify);
        const isValid = verifier.verify(this.rs256PublicKey, signatureB64, 'base64url');
        if (!isValid) {
          throw new UnauthorizedError('JWT signature verification failed');
        }
      } catch (err: unknown) {
        throw new UnauthorizedError(
          err instanceof UnauthorizedError ? err.message : 'JWT RS256 signature verification failed'
        );
      }
    }

    // 3. Decode and validate claims
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf-8')) as Record<string, unknown>;
    } catch {
      throw new UnauthorizedError('Invalid JWT payload: malformed JSON or base64url');
    }

    const nowSec = Math.floor(Date.now() / 1000);

    // Expiration check (exp)
    if (payload.exp !== undefined) {
      if (typeof payload.exp !== 'number' || Number.isNaN(payload.exp)) {
        throw new UnauthorizedError('Invalid JWT exp claim: must be a numeric timestamp');
      }
      if (payload.exp + this.clockToleranceSec < nowSec) {
        throw new UnauthorizedError('JWT has expired');
      }
    }

    // Not before check (nbf)
    if (payload.nbf !== undefined) {
      if (typeof payload.nbf !== 'number' || Number.isNaN(payload.nbf)) {
        throw new UnauthorizedError('Invalid JWT nbf claim: must be a numeric timestamp');
      }
      if (payload.nbf - this.clockToleranceSec > nowSec) {
        throw new UnauthorizedError('JWT is not active yet (nbf claim in the future)');
      }
    }

    // Issuer check (iss)
    if (this.issuer !== undefined && this.issuer.length > 0) {
      if (typeof payload.iss !== 'string' || payload.iss !== this.issuer) {
        throw new UnauthorizedError(`JWT issuer mismatch: expected '${this.issuer}', got '${String(payload.iss)}'`);
      }
    }

    // Audience check (aud)
    if (this.audience !== undefined && this.audience.length > 0) {
      const audMatches = Array.isArray(payload.aud)
        ? payload.aud.includes(this.audience)
        : payload.aud === this.audience;

      if (!audMatches) {
        throw new UnauthorizedError(
          `JWT audience mismatch: expected '${this.audience}', got '${String(payload.aud)}'`
        );
      }
    }

    // Subject check (sub)
    const sub = payload.sub;
    if (typeof sub !== 'string' || sub.trim().length === 0) {
      throw new UnauthorizedError("JWT missing required 'sub' (subject) identity claim");
    }

    // Extract roles from claims
    let roles: string[] = [];
    if (Array.isArray(payload.roles)) {
      roles = payload.roles.filter((r): r is string => typeof r === 'string' && r.length > 0);
    } else if (typeof payload.role === 'string' && payload.role.length > 0) {
      roles = [payload.role];
    }

    const tier = typeof payload.tier === 'string' ? payload.tier : undefined;

    return {
      authenticated: true,
      authType: 'jwt',
      userId: sub.trim(),
      roles: Object.freeze(roles),
      tier,
      claims: payload,
    };
  }
}

/**
 * Factory function to create a JwtVerifier from configuration.
 */
export function createJwtVerifier(config: JwtConfig = {}): JwtVerifier {
  let hs256Secret = config.hs256Secret;
  if (!hs256Secret && config.hs256SecretEnv) {
    hs256Secret = process.env[config.hs256SecretEnv];
  }

  let rs256PublicKey = config.rs256PublicKey;
  if (!rs256PublicKey && config.rs256PublicKeyEnv) {
    rs256PublicKey = process.env[config.rs256PublicKeyEnv];
  }

  return new JwtVerifier({
    enabled: config.enabled ?? true,
    algorithms: config.algorithms,
    issuer: config.issuer,
    audience: config.audience,
    hs256Secret,
    rs256PublicKey,
  });
}
