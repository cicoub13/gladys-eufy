// -----------------------------------------------------------------------------
// Orchestration of the integration: the Gladys handlers, built around one eufy
// session.
//
// Collaborators (the Gladys client, the eufy client factory, timers) are
// injected so the tests drive everything with fakes, without a network.
// -----------------------------------------------------------------------------

import { ANSWER_KEYS, isComplete, normalizeConfig, sameAccount } from './config.js';
import { createCommands } from './commands.js';
import { createEventBridge, SNAPSHOT_ATTEMPTS, SNAPSHOT_RETRY_DELAY_MS } from './events.js';
import { buildDevice } from './mapping.js';
import { toGladysImage } from './image.js';
import { createQueue } from './queue.js';
import { createSession, PHASE } from './session.js';
import { connected as connectedMessage, MISSING_CONFIG } from './status.js';

const REFRESH_DEBOUNCE_MS = 2_000;
const PUBLISH_RETRY_MS = 60_000;
export const SHUTDOWN_TIMEOUT_MS = 5_000;

const defaultScheduleTimer = (fn, delayMs) => {
  const timer = setTimeout(fn, delayMs);
  return () => clearTimeout(timer);
};

const defaultSleep = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs));

function replaceEntries(map, entries) {
  map.clear();
  for (const [key, value] of entries) {
    map.set(key, value);
  }
}

/**
 * @param {object} deps
 * @param {object} deps.gladys GladysIntegration
 * @param {(config: import('./config.js').EufyConfig) => object} deps.createClient
 * @param {object} deps.logger
 * @param {(fn: Function, delayMs: number) => Function} [deps.scheduleTimer]
 * @param {(delayMs: number) => Promise<void>} [deps.sleep]
 */
export function createHandlers({
  gladys,
  createClient,
  logger,
  scheduleTimer = defaultScheduleTimer,
  sleep = defaultSleep,
}) {
  // Supported eufy devices by serial number.
  const registry = new Map();
  // Every eufy `Device` fetched, supported or not. eufy-sdk holds them weakly
  // and announces property changes against the last one `getDevice()` built
  // for a serial: this map keeps them alive, or the announcements would stop.
  // Never call `getDevice()` for a serial already held.
  const held = new Map();
  // The eufy client the held devices come from: another client starts afresh.
  let heldClient = null;
  // Device reads (refreshes, dump) run one at a time: two at once would race
  // on the maps above. So do configuration changes: two at once would build
  // two eufy clients for one account.
  const queueDevices = createQueue();
  const queueConfig = createQueue();
  let account = null;
  // Read at each command: switching them needs no new login.
  let permissions = { allowUnlock: false, allowDisarm: false };
  let cancelRefresh = null;
  // The answers already handed to a login: if Gladys does not empty the form
  // fields, saving the form again must not replay a used code.
  const usedAnswers = new Set();

  const events = createEventBridge({
    gladys,
    registry,
    logger,
    scheduleTimer,
    sleep,
    onDevicesChanged: () => scheduleRefresh(),
  });
  const commands = createCommands({
    gladys,
    registry,
    events,
    logger,
    permissions: () => permissions,
  });

  async function setStatus(connected, message) {
    try {
      await gladys.setConnectionStatus(connected, message);
    } catch (err) {
      logger.warn('Failed to publish the connection status:', err?.message ?? err);
    }
  }

  /**
   * Fetch the eufy devices, publish the supported ones; resolves with their
   * count. The maps are swapped once complete: events and commands keep
   * finding the devices while it runs.
   */
  function refreshDevices(client = session.client) {
    return queueDevices(() => readDevices(client));
  }

  async function readDevices(client) {
    const records = await client.getDevices();
    const reusable = heldClient === client ? held : new Map();
    const nextHeld = new Map();
    const nextRegistry = new Map();
    const devices = [];
    for (const record of records) {
      // eufy-sdk updates a held device in place, new capabilities included.
      let dev = reusable.get(record.sn);
      if (!dev) {
        try {
          dev = await client.getDevice(record.sn);
        } catch (err) {
          logger.warn(`Failed to read the eufy device ${record.sn}:`, err?.message ?? err);
          continue;
        }
      }
      nextHeld.set(dev.sn, dev);
      // One device the mapping chokes on must not hide the others.
      let device;
      try {
        device = buildDevice(gladys, dev);
      } catch (err) {
        logger.warn(`Failed to map the eufy device ${record.sn}:`, err?.message ?? err);
        continue;
      }
      if (device) {
        nextRegistry.set(dev.sn, dev);
        devices.push(device);
      } else {
        logger.debug(`eufy device ${record.sn} (${record.model}) has no supported capability`);
      }
    }
    if (client !== session.client) {
      // The session moved to another client meanwhile.
      return devices.length;
    }
    replaceEntries(held, nextHeld);
    replaceEntries(registry, nextRegistry);
    heldClient = client;
    try {
      await gladys.publishDiscoveredDevices(devices);
    } catch (err) {
      // eufy answered: Gladys refusing or missing the devices is no eufy
      // failure (it would fail the login), so publish them again later.
      logger.warn(
        `Failed to publish the eufy devices to Gladys, retrying in ${PUBLISH_RETRY_MS / 1000} s:`,
        err?.message ?? err,
      );
      scheduleRefresh(PUBLISH_RETRY_MS);
      return devices.length;
    }
    for (const dev of registry.values()) {
      try {
        await events.publishDeviceStates(dev);
      } catch (err) {
        logger.warn(`Failed to read the states of the eufy device ${dev.sn}:`, err?.message ?? err);
      }
    }
    return devices.length;
  }

  // Capability and device list changes come in bursts at startup: one refresh
  // for the whole burst.
  function scheduleRefresh(delayMs = REFRESH_DEBOUNCE_MS) {
    cancelRefresh?.();
    cancelRefresh = scheduleTimer(async () => {
      cancelRefresh = null;
      if (session.phase !== PHASE.CONNECTED) {
        return;
      }
      try {
        await refreshDevices();
      } catch (err) {
        logger.warn('Failed to refresh the eufy devices:', err?.message ?? err);
      }
    }, delayMs);
  }

  const session = createSession({
    createClient,
    attachClient: (client) => events.attach(client),
    onConnected: (client) => refreshDevices(client),
    setStatus,
    scheduleTimer,
    logger,
  });

  /** Empty the one-shot answers of the form, once used. */
  async function clearAnswers() {
    try {
      await gladys.setConfig(Object.fromEntries(ANSWER_KEYS.map((key) => [key, ''])));
    } catch (err) {
      logger.warn('Failed to empty the verification code / captcha fields:', err?.message ?? err);
    }
  }

  /**
   * Apply a configuration: a new account starts a new login, an answer is
   * handed to the pending login. Never throws: Gladys does not acknowledge a
   * configuration update, an error would vanish.
   */
  function applyConfig(raw, options) {
    return queueConfig(() => applyConfigNow(raw, options));
  }

  async function applyConfigNow(raw, { reconnect = false } = {}) {
    const config = normalizeConfig(raw);
    permissions = { allowUnlock: config.allowUnlock, allowDisarm: config.allowDisarm };

    if (!isComplete(config)) {
      account = config;
      await events.stop();
      registry.clear();
      held.clear();
      await session.stop();
      await setStatus(false, MISSING_CONFIG);
      return;
    }

    if (!sameAccount(account, config) || session.phase === PHASE.IDLE) {
      account = config;
      events.forgetAll();
      // An answer left in the form belongs to an older login.
      if (config.verificationCode || config.captchaAnswer) {
        usedAnswers.add(config.verificationCode).add(config.captchaAnswer);
        await clearAnswers();
      }
      await session.start(config);
      return;
    }

    const fresh = (answer) => answer !== '' && !usedAnswers.has(answer);

    if (fresh(config.captchaAnswer) && session.phase === PHASE.CAPTCHA) {
      usedAnswers.add(config.captchaAnswer);
      await clearAnswers();
      await session.submitCaptcha(config.captchaAnswer);
      return;
    }

    if (fresh(config.verificationCode) && session.phase === PHASE.VERIFICATION_CODE) {
      usedAnswers.add(config.verificationCode);
      await clearAnswers();
      await session.submitVerificationCode(config.verificationCode);
      return;
    }

    // Saving the form again after a refused password, a blocked account...
    // is the way to ask for a new attempt.
    if (session.phase === PHASE.FAILED) {
      await session.start(config);
      return;
    }

    // Gladys came back while the eufy session stayed up: the states published
    // meanwhile may have been lost, publish everything again.
    if (reconnect && session.phase === PHASE.CONNECTED) {
      events.forgetAll();
      try {
        await setStatus(true, connectedMessage(await refreshDevices()));
      } catch (err) {
        logger.warn('Failed to republish the eufy devices:', err?.message ?? err);
      }
    }
  }

  function findDevice(device) {
    const sn = device?.params?.find((param) => param.name === 'serial_number')?.value;
    return sn ? registry.get(sn) : undefined;
  }

  const actions = {
    async test_connection() {
      const client = session.client;
      if (session.phase !== PHASE.CONNECTED || !client) {
        return {
          en: 'Not connected to eufy: see the connection status above.',
          fr: 'Non connecté à eufy : voir le statut de connexion ci-dessus.',
        };
      }
      const count = await refreshDevices(client);
      return {
        en: `Connected to eufy, ${count} supported device(s).`,
        fr: `Connecté à eufy, ${count} appareil(s) pris en charge.`,
      };
    },

    async dump_devices() {
      const client = session.client;
      if (session.phase !== PHASE.CONNECTED || !client) {
        return {
          en: 'Not connected to eufy: see the connection status above.',
          fr: 'Non connecté à eufy : voir le statut de connexion ci-dessus.',
        };
      }
      return queueDevices(() => dumpDevices(client));
    },
  };

  async function dumpDevices(client) {
    const records = await client.getDevices();
    for (const record of records) {
      try {
        let dev = held.get(record.sn);
        if (!dev) {
          dev = await client.getDevice(record.sn);
          held.set(dev.sn, dev);
        }
        logger.info(
          `eufy device ${JSON.stringify({
            sn: dev.sn,
            name: dev.name,
            model: dev.model,
            modelName: dev.modelName,
            codec: dev.codec,
            stationSn: dev.stationSn,
            capabilities: dev.capabilities,
            supported: registry.has(dev.sn),
          })}`,
        );
      } catch (err) {
        logger.warn(`Failed to read the eufy device ${record.sn}:`, err?.message ?? err);
      }
    }
    return {
      en: `${records.length} device(s) written to the Logs of the integration.`,
      fr: `${records.length} appareil(s) écrit(s) dans les Logs de l’intégration.`,
    };
  }

  return {
    actions,

    async gladysConnected() {
      try {
        await applyConfig(await gladys.getConfig(), { reconnect: true });
      } catch (err) {
        logger.error('Failed to start the eufy integration:', err);
      }
    },

    async configUpdated(config) {
      try {
        await applyConfig(config);
      } catch (err) {
        logger.error('Failed to apply the configuration:', err);
      }
    },

    async scan() {
      if (session.phase !== PHASE.CONNECTED) {
        logger.warn('Scan requested while not connected to eufy');
        return;
      }
      try {
        await refreshDevices();
      } catch (err) {
        logger.error('Failed to scan the eufy devices:', err?.message ?? err);
      }
    },

    setValue: (device, feature, value) => commands.setValue(device, feature, value),

    async getImage(device) {
      const camera = findDevice(device)?.camera?.();
      if (typeof camera?.snapshotStored !== 'function') {
        throw new Error('Unknown eufy camera (is the integration connected?)');
      }
      for (let attempt = 1; ; attempt += 1) {
        try {
          return toGladysImage(await camera.snapshotStored());
        } catch (err) {
          // A scene sending the image of a doorbell press asks for it while
          // the thumbnail still downloads: worth waiting for, within the 15 s
          // Gladys gives.
          if (err?.reason === 'pending' && attempt < SNAPSHOT_ATTEMPTS) {
            await sleep(SNAPSHOT_RETRY_DELAY_MS);
            continue;
          }
          if (err?.reason) {
            throw new Error(
              `No eufy image available yet (${err.reason}): an image arrives with the next motion or doorbell event`,
              { cause: err },
            );
          }
          throw err;
        }
      }
    },

    // States published before the user creates the device were dropped by
    // Gladys: publish them all again.
    async deviceCreated(device) {
      const dev = findDevice(device);
      if (dev) {
        events.forget(dev.sn);
        await events.publishDeviceStates(dev);
      }
    },

    // Docker kills the container 10 s after SIGTERM: give up closing before
    // that, so that the SDK still disconnects from Gladys and exits cleanly.
    async shutdown() {
      cancelRefresh?.();
      let cancelTimeout;
      const timeout = new Promise((resolve) => {
        cancelTimeout = scheduleTimer(() => {
          logger.warn('The eufy connection did not close in time');
          resolve();
        }, SHUTDOWN_TIMEOUT_MS);
      });
      const close = async () => {
        await events.stop();
        await session.stop();
      };
      await Promise.race([close(), timeout]);
      cancelTimeout();
    },
  };
}
