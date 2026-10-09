// -----------------------------------------------------------------------------
// eufy client factory.
//
// The only module that builds an `EufyMega`. Everything the client persists —
// the login session (token + ECDH session key) and the FCM push registration —
// goes under /data, the only writable location of the Gladys sandbox: losing
// them would mean a new login, and so a new 2FA code, at every restart.
// -----------------------------------------------------------------------------

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { EufyMega, FileFcmStore, FileSessionStore } from '@mega-yfue/eufy-sdk';

/** Overridable for local runs outside the container. */
export const DATA_DIR = process.env.EUFY_DATA_DIR || '/data';

export const SESSION_FILE = 'eufy-session.json';
export const PUSH_FILE = 'eufy-push.json';

/**
 * Route the eufy-sdk diagnostics to the integration logger. The SDK reports its
 * routine progress at `info`, which would drown the integration's own lines:
 * it goes to `debug` (`LOG_LEVEL=debug` to see it).
 *
 * @param {{ debug: Function, warn: Function, error: Function }} logger
 */
export function toEufyLogger(logger) {
  return {
    debug: (message, ...args) => logger.debug(`[eufy-sdk] ${message}`, ...args),
    info: (message, ...args) => logger.debug(`[eufy-sdk] ${message}`, ...args),
    warn: (message, ...args) => logger.warn(`[eufy-sdk] ${message}`, ...args),
    error: (message, ...args) => logger.error(`[eufy-sdk] ${message}`, ...args),
  };
}

/**
 * Build the eufy client of an account.
 *
 * @param {import('./config.js').EufyConfig} config
 * @param {object} logger
 * @param {string} [dataDir]
 */
export function createEufyClient(config, logger, dataDir = DATA_DIR) {
  mkdirSync(dataDir, { recursive: true });
  return new EufyMega({
    email: config.email,
    password: config.password,
    countryCode: config.country,
    store: new FileSessionStore(join(dataDir, SESSION_FILE)),
    pushStore: new FileFcmStore(join(dataDir, PUSH_FILE)),
    logger: toEufyLogger(logger),
    // The container sits on a Docker bridge network: a 255.255.255.255
    // broadcast never reaches the LAN, so it would only be noise.
    noBroadcast: true,
  });
}
