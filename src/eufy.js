// -----------------------------------------------------------------------------
// eufy client factory.
//
// The only module that builds an `EufyMega`. Everything the client persists —
// the login session (token + ECDH session key) and the FCM push registration —
// goes under /data, the only writable location of the Gladys sandbox: losing
// them would mean a new login, and so a new 2FA code, at every restart.
// -----------------------------------------------------------------------------

import { randomBytes, scryptSync } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EufyMega, FileFcmStore, FileSessionStore } from '@mega-yfue/eufy-sdk';

/** Overridable for local runs outside the container. */
export const DATA_DIR = process.env.EUFY_DATA_DIR || '/data';

export const SESSION_FILE = 'eufy-session.json';
export const PUSH_FILE = 'eufy-push.json';
export const ACCOUNT_FILE = 'eufy-account.json';

/** Salted hash of the account: the marker must not reveal the password. */
function accountHash(config, salt) {
  const account = `${config.email.toLowerCase()}\n${config.country}\n${config.password}`;
  return scryptSync(account, salt, 32).toString('hex');
}

/**
 * The session and push files belong to one account, and eufy-sdk restores a
 * session without any network call: signing in with another account, or a new
 * password, would silently keep using the old token. A marker next to them
 * names the account they belong to, and they are dropped when it changes. A
 * missing or unreadable marker is taken as the current account, so that an
 * existing session survives the upgrade.
 *
 * @param {import('./config.js').EufyConfig} config
 * @param {string} dataDir
 * @param {object} logger
 */
export function dropOtherAccountSession(config, dataDir, logger) {
  const markerFile = join(dataDir, ACCOUNT_FILE);
  let marker = null;
  try {
    marker = JSON.parse(readFileSync(markerFile, 'utf8'));
  } catch {
    // No marker yet.
  }
  const known = typeof marker?.salt === 'string' && typeof marker?.hash === 'string';
  if (known && marker.hash === accountHash(config, marker.salt)) {
    return;
  }
  if (known) {
    rmSync(join(dataDir, SESSION_FILE), { force: true });
    rmSync(join(dataDir, PUSH_FILE), { force: true });
    logger.info('The eufy account or password changed: the previous session is dropped');
  }
  const salt = randomBytes(16).toString('hex');
  writeFileSync(markerFile, JSON.stringify({ salt, hash: accountHash(config, salt) }), {
    mode: 0o600,
  });
}

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
  dropOtherAccountSession(config, dataDir, logger);
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
