import { Logger } from '@nestjs/common';

import * as config from '../config';
import type { KavachBackend } from './backend.interface';
import { MockBackend } from './mock.backend';
import { resolveSnowflakeAuth } from './snowflake-auth';
import { SnowflakeBackend } from './snowflake.backend';

/**
 * KAVACH_BACKEND = auto | snowflake | mock.
 * auto: Snowflake when credentials are configured (SPCS token, PAT or key pair), otherwise the offline mock.
 */
export function createBackend(mode = config.BACKEND, logger = new Logger('Kavach')): KavachBackend {
  if (mode === 'mock') {
    logger.log('Backend: offline mock (KAVACH_BACKEND=mock)');
    return new MockBackend();
  }
  if (mode !== 'auto' && mode !== 'snowflake') throw new Error(`KAVACH_BACKEND must be auto, snowflake or mock (got "${mode}")`);
  let auth = null;
  try {
    auth = resolveSnowflakeAuth();
  } catch (e) {
    if (mode === 'snowflake') throw e;
    logger.warn(`Snowflake credentials incomplete (${(e as Error).message})`);
  }
  if (auth) {
    const b = new SnowflakeBackend(auth);
    logger.log(`Backend: ${b.mode} -> https://${auth.host} (warehouse ${config.SNOWFLAKE_WAREHOUSE}, role ${config.SNOWFLAKE_ROLE})`);
    return b;
  }
  if (mode === 'snowflake') {
    throw new Error('KAVACH_BACKEND=snowflake but no credentials: set SNOWFLAKE_PAT, or SNOWFLAKE_ACCOUNT + SNOWFLAKE_USER + SNOWFLAKE_PRIVATE_KEY_PATH, or run in SPCS');
  }
  logger.log('Backend: offline mock (no Snowflake credentials configured)');
  return new MockBackend();
}
