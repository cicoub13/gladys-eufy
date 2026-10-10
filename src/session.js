// -----------------------------------------------------------------------------
// eufy login state machine.
//
//   start(config) ──> login() ──┬── ok ───────────────> connected
//                               ├── captcha ──> waits for submitCaptcha(answer)
//                               ├── 2fa ──────> waits for submitVerificationCode(code)
//                               └── error ──┬── transient: retried with a backoff
//                                           └── otherwise: stays failed until the
//                                               configuration is saved again
//
// Once connected, the realtime channels (push, MQTT) eufy-sdk brings up in the
// background are checked: they are restarted (disconnect + login) when they
// failed, or no event would ever arrive while the status says "connected".
//
// A captcha or a code belongs to the login that requested it: a new `login()`
// invalidates it. So a pending login is kept as is until the user answers, and
// the answer is handed to THAT login.
// -----------------------------------------------------------------------------

import { describeEufyError, errorToText } from './errors.js';
import {
  CODE_REFUSED,
  CONNECTING,
  captchaRequired,
  connected,
  realtimeUnavailable,
  retrying,
  verificationCodeRequired,
} from './status.js';

const BACKOFF_START_MS = 60_000;
const BACKOFF_MAX_MS = 15 * 60_000;
export const REALTIME_TIMEOUT_MS = 120_000;

/**
 * Whether the realtime startup of a login failed. The wired-camera P2P warm-up
 * is left out: it is best effort, events come through push and MQTT.
 */
function realtimeFailed(readiness) {
  return (
    readiness.state === 'timed-out' ||
    readiness.state === 'error' ||
    (readiness.push?.failed ?? 0) + (readiness.mqtt?.failed ?? 0) > 0
  );
}

/** The phases a session goes through. */
export const PHASE = {
  IDLE: 'idle',
  CONNECTING: 'connecting',
  CAPTCHA: 'captcha',
  VERIFICATION_CODE: 'verification-code',
  CONNECTED: 'connected',
  FAILED: 'failed',
};

/**
 * @param {object} deps
 * @param {(config: import('./config.js').EufyConfig) => object} deps.createClient
 * @param {(client: object) => void} deps.attachClient Subscribes to the client
 *   events; called BEFORE the first login so that no early event is missed.
 * @param {(client: object) => Promise<number>} deps.onConnected Publishes the
 *   devices once logged in; resolves with how many were found.
 * @param {(connected: boolean, message?: { en: string, fr: string }) => Promise<void>} deps.setStatus
 * @param {(fn: Function, delayMs: number) => Function} deps.scheduleTimer Returns a cancel function.
 * @param {object} deps.logger
 */
export function createSession({
  createClient,
  attachClient,
  onConnected,
  setStatus,
  scheduleTimer,
  logger,
}) {
  let client = null;
  let phase = PHASE.IDLE;
  let backoffMs = BACKOFF_START_MS;
  let realtimeBackoffMs = BACKOFF_START_MS;
  let cancelRetry = null;
  // Bumped by every start/stop: a login still in flight for a previous account
  // must not report its outcome over the current one.
  let generation = 0;

  function clearRetry() {
    if (cancelRetry) {
      cancelRetry();
      cancelRetry = null;
    }
  }

  function scheduleLogin(delayMs) {
    clearRetry();
    const scheduledGeneration = generation;
    cancelRetry = scheduleTimer(() => {
      cancelRetry = null;
      if (scheduledGeneration === generation) {
        // eufy-sdk restarts the realtime channels on a login only after a
        // disconnect(): a login alone would keep the failed ones.
        return run(async () => {
          await client.disconnect();
          return client.login();
        });
      }
      return undefined;
    }, delayMs);
  }

  async function handleResult(result) {
    if (result.status === 'ok') {
      phase = PHASE.CONNECTED;
      backoffMs = BACKOFF_START_MS;
      const runGeneration = generation;
      const count = await onConnected(client);
      if (runGeneration === generation) {
        logger.info(`Connected to eufy, ${count} supported device(s) found`);
        await setStatus(true, connected(count));
        watchRealtime(runGeneration).catch((err) => {
          logger.warn('Failed to check the eufy realtime events:', errorToText(err));
        });
      }
      return;
    }
    if (result.status === 'captcha') {
      phase = PHASE.CAPTCHA;
      // The only way to show an image to the user: the Logs screen of the
      // integration. One line, so it can be copied as a whole.
      logger.warn(
        `eufy asks for a captcha${result.retry ? ' (the previous answer was wrong)' : ''}. Paste the next line into the address bar of a browser to see it, then type the answer in the "Captcha answer" field of the configuration:`,
      );
      logger.warn(result.image);
      await setStatus(false, captchaRequired(Boolean(result.retry)));
      return;
    }
    if (result.status === '2fa') {
      phase = PHASE.VERIFICATION_CODE;
      logger.warn(`eufy sent a verification code${result.method ? ` (${result.method})` : ''}`);
      await setStatus(false, verificationCodeRequired(result.method));
      return;
    }
    throw new Error(`Unexpected eufy login status: ${result.status}`);
  }

  /** Wait for the realtime startup of the login; restart it if it failed. */
  async function watchRealtime(runGeneration) {
    let readiness;
    try {
      readiness = await client.waitForRealtime({ timeoutMs: REALTIME_TIMEOUT_MS });
    } catch (err) {
      readiness = { state: 'error', reason: errorToText(err) };
    }
    if (runGeneration !== generation || phase !== PHASE.CONNECTED) {
      return;
    }
    if (!realtimeFailed(readiness)) {
      realtimeBackoffMs = BACKOFF_START_MS;
      return;
    }
    logger.warn(
      `eufy realtime events unavailable (${JSON.stringify(readiness)}), restarting them in ${realtimeBackoffMs / 1000} s`,
    );
    await setStatus(false, realtimeUnavailable(realtimeBackoffMs));
    scheduleLogin(realtimeBackoffMs);
    realtimeBackoffMs = Math.min(realtimeBackoffMs * 2, BACKOFF_MAX_MS);
  }

  async function handleError(err, { codeSubmitted = false } = {}) {
    const { kind, transient, message, text } = describeEufyError(err);
    if (transient) {
      phase = PHASE.CONNECTING;
      logger.warn(`eufy login failed (${text}), retrying in ${backoffMs / 1000} s`);
      await setStatus(false, retrying(message, backoffMs));
      scheduleLogin(backoffMs);
      backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
      return;
    }
    phase = PHASE.FAILED;
    logger.error(`eufy login failed: ${text}`);
    // eufy-sdk has no error of its own for a refused verification code: an
    // unexplained failure right after one is taken as such.
    await setStatus(false, codeSubmitted && kind === 'unknown' ? CODE_REFUSED : message);
  }

  /** Run one login step and route its outcome; never throws. */
  async function run(step, errorContext) {
    const runGeneration = generation;
    try {
      const result = await step();
      if (runGeneration === generation) {
        await handleResult(result);
      }
    } catch (err) {
      if (runGeneration === generation) {
        await handleError(err, errorContext);
      }
    }
  }

  function onSessionExpired(err) {
    if (phase !== PHASE.CONNECTED) {
      return;
    }
    phase = PHASE.CONNECTING;
    const { message } = describeEufyError(err);
    const delayMs = Math.max(err?.retryAfterMs ?? 0, BACKOFF_START_MS);
    logger.warn(`eufy session expired, logging in again in ${Math.round(delayMs / 1000)} s`);
    setStatus(false, retrying(message, delayMs)).catch(() => {});
    scheduleLogin(delayMs);
  }

  async function stop() {
    generation += 1;
    clearRetry();
    phase = PHASE.IDLE;
    const previous = client;
    client = null;
    if (previous) {
      try {
        await previous.disconnect();
      } catch (err) {
        logger.warn('Failed to close the eufy connection:', err?.message ?? err);
      }
    }
  }

  return {
    get phase() {
      return phase;
    },
    get client() {
      return client;
    },

    /**
     * (Re)start a login for this account, dropping any previous one.
     *
     * @param {import('./config.js').EufyConfig} config
     */
    async start(config) {
      const stopping = stop();
      const startGeneration = generation;
      await stopping;
      if (startGeneration !== generation) {
        // Stopped, or started again, while the previous client closed.
        return;
      }
      backoffMs = BACKOFF_START_MS;
      realtimeBackoffMs = BACKOFF_START_MS;
      phase = PHASE.CONNECTING;
      try {
        client = createClient(config);
      } catch (err) {
        // e.g. /data not writable: nothing to retry until the setup changes.
        await handleError(err);
        return;
      }
      client.on('sessionExpired', onSessionExpired);
      attachClient(client);
      await setStatus(false, CONNECTING);
      await run(() => client.login());
    },

    /**
     * Hand a verification code to the pending login.
     *
     * @returns {Promise<boolean>} false when no login waits for a code.
     */
    async submitVerificationCode(code) {
      if (phase !== PHASE.VERIFICATION_CODE) {
        return false;
      }
      phase = PHASE.CONNECTING;
      await setStatus(false, CONNECTING);
      await run(() => client.submitVerifyCode(code), { codeSubmitted: true });
      return true;
    },

    /**
     * Hand a captcha answer to the pending login.
     *
     * @returns {Promise<boolean>} false when no login waits for a captcha.
     */
    async submitCaptcha(answer) {
      if (phase !== PHASE.CAPTCHA) {
        return false;
      }
      phase = PHASE.CONNECTING;
      await setStatus(false, CONNECTING);
      await run(() => client.solveCaptcha(answer));
      return true;
    },

    stop,
  };
}
