/**
 * Snowflake REST authentication. Three modes, tried in this order:
 *   1. SPCS     - /snowflake/session/token (re-read on every request because it rotates), OAUTH token type
 *   2. PAT      - SNOWFLAKE_PAT, PROGRAMMATIC_ACCESS_TOKEN token type
 *   3. Key pair - SNOWFLAKE_ACCOUNT + SNOWFLAKE_USER + SNOWFLAKE_PRIVATE_KEY_PATH (or SNOWFLAKE_PRIVATE_KEY),
 *                 RS256 JWT signed with node:crypto, KEYPAIR_JWT token type, cached ~50 minutes
 */
import { createHash, createPrivateKey, createPublicKey, sign, type KeyObject } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

import * as config from '../config';

export type AuthMode = 'SPCS' | 'PAT' | 'KEYPAIR_JWT';

export interface SnowflakeAuth {
  readonly mode: AuthMode;
  /** e.g. "xy12345.eu-central-1.snowflakecomputing.com" (no scheme). */
  readonly host: string;
  headers(): Promise<Record<string, string>>;
}

export const MODE_LABELS: Record<AuthMode, string> = {
  SPCS: 'Snowflake · SPCS',
  PAT: 'Snowflake · PAT',
  KEYPAIR_JWT: 'Snowflake · Key-pair JWT',
};

/** Account identifier for JWT claims: upper-cased, without region / cloud suffix ("xy12345.eu-central-1" -> "XY12345"). */
export function jwtAccount(account: string): string {
  return account.trim().split('.')[0].toUpperCase();
}

/** Host derived from SNOWFLAKE_ACCOUNT when SNOWFLAKE_HOST is not set. */
export function hostFromAccount(account: string): string {
  return `${account.trim().toLowerCase().replace(/_/g, '-')}.snowflakecomputing.com`;
}

/** "SHA256:<base64 sha256 of the DER (SPKI) public key>". */
export function publicKeyFingerprint(privateKey: KeyObject): string {
  const der = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  return `SHA256:${createHash('sha256').update(der).digest('base64')}`;
}

const b64url = (buf: Buffer | string): string => Buffer.from(buf).toString('base64url');

export interface KeypairJwt {
  token: string;
  claims: { iss: string; sub: string; iat: number; exp: number };
  expiresAtMs: number;
}

/** Build the RS256 JWT Snowflake expects for key-pair authentication. */
export function buildKeypairJwt(opts: {
  account: string; user: string; privateKey: KeyObject | string; passphrase?: string; nowMs?: number; lifetimeS?: number;
}): KeypairJwt {
  const key = typeof opts.privateKey === 'string'
    ? createPrivateKey({ key: opts.privateKey, format: 'pem', ...(opts.passphrase ? { passphrase: opts.passphrase } : {}) })
    : opts.privateKey;
  const qualified = `${jwtAccount(opts.account)}.${opts.user.trim().toUpperCase()}`;
  const iat = Math.floor((opts.nowMs ?? Date.now()) / 1000);
  const exp = iat + (opts.lifetimeS ?? 59 * 60);
  const claims = { iss: `${qualified}.${publicKeyFingerprint(key)}`, sub: qualified, iat, exp };
  const signingInput = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify(claims))}`;
  const signature = sign('RSA-SHA256', Buffer.from(signingInput), key);
  return { token: `${signingInput}.${b64url(signature)}`, claims, expiresAtMs: exp * 1000 };
}

const BASE_HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': `kavach-api/${config.APP_VERSION}` };

class SpcsAuth implements SnowflakeAuth {
  readonly mode = 'SPCS' as const;
  constructor(readonly host: string, private readonly tokenPath: string) {}
  async headers(): Promise<Record<string, string>> {
    const token = readFileSync(this.tokenPath, 'utf8').trim(); // rotates: read per request
    return { ...BASE_HEADERS, Authorization: `Bearer ${token}`, 'X-Snowflake-Authorization-Token-Type': 'OAUTH' };
  }
}

class PatAuth implements SnowflakeAuth {
  readonly mode = 'PAT' as const;
  constructor(readonly host: string, private readonly pat: string) {}
  async headers(): Promise<Record<string, string>> {
    return { ...BASE_HEADERS, Authorization: `Bearer ${this.pat}`, 'X-Snowflake-Authorization-Token-Type': 'PROGRAMMATIC_ACCESS_TOKEN' };
  }
}

class KeypairAuth implements SnowflakeAuth {
  readonly mode = 'KEYPAIR_JWT' as const;
  private cached: KeypairJwt | null = null;
  private readonly key: KeyObject;
  constructor(readonly host: string, private readonly account: string, private readonly user: string, pem: string, passphrase?: string) {
    this.key = createPrivateKey({ key: pem, format: 'pem', ...(passphrase ? { passphrase } : {}) });
  }
  async headers(): Promise<Record<string, string>> {
    // cache for ~50 minutes of the token's 59-minute life
    if (!this.cached || Date.now() > this.cached.expiresAtMs - 9 * 60_000) {
      this.cached = buildKeypairJwt({ account: this.account, user: this.user, privateKey: this.key });
    }
    return { ...BASE_HEADERS, Authorization: `Bearer ${this.cached.token}`, 'X-Snowflake-Authorization-Token-Type': 'KEYPAIR_JWT' };
  }
}

/** Resolve credentials from the environment; null when none are configured. Throws on half-configured key-pair auth. */
export function resolveSnowflakeAuth(env: NodeJS.ProcessEnv = process.env, tokenPath = config.SPCS_TOKEN_PATH): SnowflakeAuth | null {
  const account = env.SNOWFLAKE_ACCOUNT?.trim() ?? '';
  const host = (env.SNOWFLAKE_HOST?.trim() || (account ? hostFromAccount(account) : '')).replace(/^https?:\/\//, '').replace(/\/+$/, '');
  if (existsSync(tokenPath)) {
    if (!host) throw new Error(`SPCS token found at ${tokenPath} but SNOWFLAKE_HOST is not set`);
    return new SpcsAuth(host, tokenPath);
  }
  if (env.SNOWFLAKE_PAT?.trim()) {
    if (!host) throw new Error('SNOWFLAKE_PAT is set but neither SNOWFLAKE_HOST nor SNOWFLAKE_ACCOUNT is');
    return new PatAuth(host, env.SNOWFLAKE_PAT.trim());
  }
  const keyPath = env.SNOWFLAKE_PRIVATE_KEY_PATH?.trim();
  const inlineKey = env.SNOWFLAKE_PRIVATE_KEY?.trim();
  if (account && env.SNOWFLAKE_USER?.trim() && (keyPath || inlineKey)) {
    const pem = inlineKey ? inlineKey.replace(/\\n/g, '\n') : readFileSync(keyPath!, 'utf8');
    return new KeypairAuth(host, account, env.SNOWFLAKE_USER.trim(), pem, env.SNOWFLAKE_PRIVATE_KEY_PASSPHRASE || undefined);
  }
  return null;
}
