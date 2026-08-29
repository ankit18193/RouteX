import { createHmac, createSign, createVerify, generateKeyPairSync } from 'node:crypto';

export const TEST_JWT_SECRET = 'routex-dev-super-secret-key-for-testing-at-least-32-chars-long!';

// Generate deterministic/stable RSA key pair for testing
const rsaKeyPair = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: {
    type: 'spki',
    format: 'pem',
  },
  privateKeyEncoding: {
    type: 'pkcs8',
    format: 'pem',
  },
});

export const TEST_RSA_PUBLIC_KEY = rsaKeyPair.publicKey;
export const TEST_RSA_PRIVATE_KEY = rsaKeyPair.privateKey;

export interface TestJwtOptions {
  readonly sub?: string | undefined;
  readonly roles?: readonly string[] | undefined;
  readonly expiresInSec?: number | undefined;
  readonly algorithm?: 'HS256' | 'RS256' | undefined;
  readonly customClaims?: Record<string, unknown> | undefined;
}

export interface VerifiedJwt {
  readonly header: Record<string, unknown>;
  readonly payload: Record<string, unknown>;
}

function base64UrlEncode(str: string): string {
  return Buffer.from(str, 'utf-8').toString('base64url');
}

function base64UrlDecode(str: string): string {
  return Buffer.from(str, 'base64url').toString('utf-8');
}

/**
 * Generate a cryptographically signed JWT for development and testing.
 */
export function generateTestJwt(options: TestJwtOptions = {}): string {
  const algorithm = options.algorithm ?? 'HS256';
  const sub = options.sub ?? 'usr_test_123';
  const roles = options.roles ?? ['user'];
  const expiresInSec = options.expiresInSec ?? 3600;

  const nowSec = Math.floor(Date.now() / 1000);
  const expSec = nowSec + expiresInSec;

  const header = {
    alg: algorithm,
    typ: 'JWT',
  };

  const payload = {
    sub,
    roles,
    iat: nowSec,
    exp: expSec,
    iss: 'routex-mock-user-service',
    aud: 'routex-gateway',
    ...(options.customClaims ?? {}),
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const dataToSign = `${encodedHeader}.${encodedPayload}`;

  let signature: string;
  if (algorithm === 'HS256') {
    signature = createHmac('sha256', TEST_JWT_SECRET)
      .update(dataToSign)
      .digest('base64url');
  } else if (algorithm === 'RS256') {
    const signer = createSign('RSA-SHA256');
    signer.update(dataToSign);
    signature = signer.sign(TEST_RSA_PRIVATE_KEY, 'base64url');
  } else {
    throw new Error(`Unsupported JWT algorithm: ${String(algorithm)}`);
  }

  return `${dataToSign}.${signature}`;
}

/**
 * Verify a test JWT signature and return parsed header and payload
 */
export function verifyTestJwt(token: string, algorithm: 'HS256' | 'RS256' = 'HS256'): VerifiedJwt {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid JWT format: must contain 3 segments');
  }

  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];
  const dataToVerify = `${headerB64}.${payloadB64}`;

  let isValid = false;
  if (algorithm === 'HS256') {
    const expectedSignature = createHmac('sha256', TEST_JWT_SECRET)
      .update(dataToVerify)
      .digest('base64url');
    isValid = signatureB64 === expectedSignature;
  } else if (algorithm === 'RS256') {
    const verifier = createVerify('RSA-SHA256');
    verifier.update(dataToVerify);
    isValid = verifier.verify(TEST_RSA_PUBLIC_KEY, signatureB64, 'base64url');
  }

  if (!isValid) {
    throw new Error(`JWT signature verification failed for algorithm ${algorithm}`);
  }

  const header = JSON.parse(base64UrlDecode(headerB64)) as Record<string, unknown>;
  const payload = JSON.parse(base64UrlDecode(payloadB64)) as Record<string, unknown>;

  const nowSec = Math.floor(Date.now() / 1000);
  if (typeof payload.exp === 'number' && payload.exp < nowSec) {
    throw new Error('JWT has expired');
  }

  return { header, payload };
}
