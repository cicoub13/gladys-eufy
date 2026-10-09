// -----------------------------------------------------------------------------
// Gladys commands (onSetValue) -> eufy.
//
// Gladys waits 5 s for the acknowledgement: each command gets 4 s, then fails
// with a clear message instead of timing out silently. eufy lock and guard mode
// writes are fire-and-forget on the eufy side, so the requested value is
// published right away; if the device does not follow, eufy-sdk raises
// `commandUnconfirmed` and events.js publishes the value actually observed.
// -----------------------------------------------------------------------------

import { deviceIds, isArmingMode } from './mapping.js';

export const COMMAND_TIMEOUT_MS = 4_000;

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label}: no answer from eufy within ${ms} ms`)),
      ms,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Lock command value. `Number('')`, `Number(null)` and `Number(false)` are all
 * 0, which would UNLOCK the door: only a real 0/1 or the exact "0"/"1" strings
 * are accepted.
 */
function lockTarget(value) {
  if (value === 1 || value === '1') return true;
  if (value === 0 || value === '0') return false;
  return null;
}

/**
 * @param {object} deps
 * @param {object} deps.gladys
 * @param {Map<string, object>} deps.registry eufy devices by serial number.
 * @param {ReturnType<import('./events.js').createEventBridge>} deps.events
 * @param {object} deps.logger
 * @param {number} [deps.timeoutMs]
 */
export function createCommands({
  gladys,
  registry,
  events,
  logger,
  timeoutMs = COMMAND_TIMEOUT_MS,
}) {
  /** Find the eufy device and the feature key a Gladys feature designates. */
  function resolve(device, feature) {
    for (const dev of registry.values()) {
      const ids = deviceIds(gladys, dev.sn);
      if (ids.device === device.external_id) {
        const prefix = ids.feature('');
        const key = feature.external_id.startsWith(prefix)
          ? feature.external_id.slice(prefix.length)
          : null;
        return { dev, key, featureId: feature.external_id };
      }
    }
    throw new Error(`Unknown eufy device ${device.external_id} (is the integration connected?)`);
  }

  return {
    /**
     * @param {object} device Gladys device
     * @param {object} feature Gladys feature
     * @param {number|string} value
     */
    async setValue(device, feature, value) {
      const { dev, key, featureId } = resolve(device, feature);

      if (key === 'lock') {
        const locked = lockTarget(value);
        if (locked === null) {
          throw new Error(`Invalid lock command: ${JSON.stringify(value)}`);
        }
        const lock = dev.lock?.();
        if (!lock) {
          throw new Error(`${dev.sn} cannot be locked from Gladys`);
        }
        logger.info(`${locked ? 'Locking' : 'Unlocking'} ${dev.sn}`);
        await withTimeout(locked ? lock.lock() : lock.unlock(), timeoutMs, 'Lock');
        await events.publish(featureId, locked ? 1 : 0, { force: true });
        return;
      }

      if (key === 'arming') {
        if (!isArmingMode(value)) {
          throw new Error(`Unknown guard mode: ${JSON.stringify(value)}`);
        }
        const setMode = dev.arming?.()?.setMode;
        if (typeof setMode !== 'function') {
          throw new Error(`The guard mode of ${dev.sn} cannot be changed from Gladys`);
        }
        logger.info(`Setting the guard mode of ${dev.sn} to ${value}`);
        await withTimeout(dev.arming().setMode(value), timeoutMs, 'Guard mode');
        await events.publish(featureId, { text: value }, { force: true });
        return;
      }

      throw new Error(`The feature ${feature.external_id} is read-only`);
    },
  };
}
