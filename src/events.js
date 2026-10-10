// -----------------------------------------------------------------------------
// eufy events -> Gladys states, camera images and scene events.
//
// eufy-sdk fans every transport (FCM push, P2P, MQTT, cloud poll) into one
// stream of semantic events. Two families:
//   - PULSES (motion, doorbell press, person detected...): never de-duplicated
//     by the SDK. They set a binary feature to 1 for a while, fire a scene
//     event and, for a camera, publish the thumbnail the push carried;
//   - STATE CHANGES (contact, lock, guard mode, battery...): the device object
//     is re-read and only the values that changed are published.
//
// States published before the user creates the device in Gladys are silently
// dropped by the host API: `forget()` lets a newly created device get them all
// again (see handlers.js).
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { deviceIds, featuresOf, readStates } from './mapping.js';
import { toGladysImage } from './image.js';
import { createQueue } from './queue.js';

export const MOTION_RESET_MS = 30_000;
export const RING_RESET_MS = 5_000;
export const RESET_RETRY_MS = 30_000;

/** Pulse features: 0 unless an event is in progress. */
const PULSE_KEYS = ['ring', 'motion'];

// Host API limits: 300 states per minute per integration, 12 images per minute
// per camera.
const STATES_PER_MINUTE = 300;
const IMAGES_PER_MINUTE = 12;
const RATE_WINDOW_MS = 60_000;
export const STATES_RETRY_MS = 60_000;

export const SNAPSHOT_FIRST_DELAY_MS = 1_000;
export const SNAPSHOT_RETRY_DELAY_MS = 2_000;
export const SNAPSHOT_ATTEMPTS = 4;

/** Detection events, and the `target` they carry in the scene event. */
export const DETECTIONS = {
  motion: 'motion',
  personDetected: 'person',
  strangerDetected: 'stranger',
  vehicleDetected: 'vehicle',
  petDetection: 'pet',
  dogDetected: 'pet',
};

/** Events after which the device is re-read. */
const STATE_EVENTS = [
  'propertyChanged',
  'lockState',
  'armingModeChanged',
  'contactState',
  'commandUnconfirmed',
];

/** A value as the host API takes it: a number, or `{ text }` for a select. */
function toState(featureId, value) {
  return typeof value === 'object'
    ? { device_feature_external_id: featureId, text: value.text }
    : { device_feature_external_id: featureId, state: value };
}

/**
 * @param {object} deps
 * @param {object} deps.gladys
 * @param {Map<string, object>} deps.registry eufy devices by serial number.
 * @param {object} deps.logger
 * @param {(fn: Function, delayMs: number) => Function} deps.scheduleTimer Returns a cancel function.
 * @param {(delayMs: number) => Promise<void>} deps.sleep
 * @param {() => void} deps.onDevicesChanged Called when the device list changed.
 * @param {() => number} [deps.now]
 */
export function createEventBridge({
  gladys,
  registry,
  logger,
  scheduleTimer,
  sleep,
  onDevicesChanged,
  now = Date.now,
}) {
  // Last value published per feature external_id, to publish changes only.
  const published = new Map();
  // Pending "back to 0" timers, per feature external_id.
  const resets = new Map();
  // Serial numbers with a thumbnail fetch in flight.
  const fetching = new Set();
  // Pending republications of the states of a device, per serial number.
  const retries = new Map();
  // Accepted state batches of the last minute: { at, count }.
  const sent = [];
  // Last image published per serial number, and when the last ones were.
  const images = new Map();
  const queuePublish = createQueue();

  const hasFeature = (dev, key) => featuresOf(dev).some((spec) => spec.key === key);

  // Gladys drops the states of a device the user did not create (they still
  // count in its rate limit) and refuses its images: they are skipped, and
  // `forget()` republishes everything once the device is created.
  const created = (externalId) =>
    gladys.devices.some(
      (device) =>
        externalId === device.external_id || externalId.startsWith(`${device.external_id}:`),
    );

  /**
   * Hold back until `count` more states fit in the 300 per minute of the
   * integration: a 429 would lose them, a short wait does not.
   */
  async function waitForBudget(count) {
    for (;;) {
      while (sent.length > 0 && sent[0].at <= now() - RATE_WINDOW_MS) {
        sent.shift();
      }
      const used = sent.reduce((total, entry) => total + entry.count, 0);
      if (used + count <= STATES_PER_MINUTE || sent.length === 0) {
        return;
      }
      const waitMs = sent[0].at + RATE_WINDOW_MS - now();
      logger.warn(`Gladys state rate limit reached, waiting ${Math.ceil(waitMs / 1000)} s`);
      await sleep(waitMs);
    }
  }

  async function publishNow(entries) {
    const changed = entries.filter(
      ({ featureId, value, force }) =>
        created(featureId) && (force || published.get(featureId) !== JSON.stringify(value)),
    );
    if (changed.length === 0) {
      return true;
    }
    await waitForBudget(changed.length);
    try {
      await gladys.publishStates(changed.map(({ featureId, value }) => toState(featureId, value)));
    } catch (err) {
      logger.warn(
        `Failed to publish ${changed.map(({ featureId }) => featureId).join(', ')}:`,
        err?.message ?? err,
      );
      return false;
    }
    sent.push({ at: now(), count: changed.length });
    // Recorded only once accepted, so a failed publish is retried next time.
    for (const { featureId, value } of changed) {
      published.set(featureId, JSON.stringify(value));
    }
    return true;
  }

  /**
   * Publish the states of ONE device in one request (a device has far fewer
   * than the 100 a request takes), one request at a time so that the rate
   * budget holds. Resolves with whether Gladys has them all (or does not
   * want them).
   *
   * @param {{ featureId: string, value: number | { text: string }, force?: boolean }[]} entries
   */
  function publishStates(entries) {
    return queuePublish(() => publishNow(entries));
  }

  function publish(featureId, value, { force = false } = {}) {
    return publishStates([{ featureId, value, force }]);
  }

  /** Publish the current values of a device (only the changed ones). */
  async function publishDeviceStates(dev) {
    const ids = deviceIds(gladys, dev.sn);
    const entries = readStates(dev).map(({ key, value }) => ({
      featureId: ids.feature(key),
      value,
    }));
    // A pulse without an event in progress is 0: this also clears a 1 left by
    // a reset that failed, or that a restart cancelled.
    for (const key of PULSE_KEYS) {
      const featureId = ids.feature(key);
      if (hasFeature(dev, key) && !resets.has(featureId)) {
        entries.push({ featureId, value: 0 });
      }
    }
    if (!(await publishStates(entries)) && !retries.has(dev.sn)) {
      retries.set(
        dev.sn,
        scheduleTimer(() => {
          retries.delete(dev.sn);
          const current = registry.get(dev.sn);
          return current ? publishDeviceStates(current) : undefined;
        }, STATES_RETRY_MS),
      );
    }
  }

  function scheduleReset(featureId, delayMs) {
    resets.get(featureId)?.();
    resets.set(
      featureId,
      scheduleTimer(async () => {
        resets.delete(featureId);
        if (!(await publish(featureId, 0)) && !resets.has(featureId)) {
          scheduleReset(featureId, RESET_RETRY_MS);
        }
      }, delayMs),
    );
  }

  /** Set a binary feature to 1, and back to 0 once the event is over. */
  async function pulse(dev, key, resetMs) {
    const featureId = deviceIds(gladys, dev.sn).feature(key);
    scheduleReset(featureId, resetMs);
    await publish(featureId, 1, { force: true });
  }

  async function sceneEvent(key, dev, extra = {}) {
    try {
      await gladys.publishSceneEvent(key, {
        device: deviceIds(gladys, dev.sn).device,
        device_name: dev.name || dev.sn,
        ...extra,
      });
    } catch (err) {
      logger.warn(`Failed to publish the "${key}" scene event:`, err?.message ?? err);
    }
  }

  /**
   * One push fires several detection events (motion, person...) carrying the
   * same thumbnail, and Gladys takes 12 images per minute per camera: an image
   * already sent within the minute, or one over the limit, is skipped.
   */
  async function publishImage(sn, deviceId, jpeg) {
    const hash = createHash('sha1').update(jpeg).digest('hex');
    const last = images.get(sn) ?? { hash: null, at: [] };
    const recent = last.at.filter((at) => at > now() - RATE_WINDOW_MS);
    if (last.hash === hash && recent.length > 0) {
      return;
    }
    if (recent.length >= IMAGES_PER_MINUTE) {
      logger.debug(`Thumbnail of ${sn} skipped: ${IMAGES_PER_MINUTE} images in the last minute`);
      return;
    }
    await gladys.publishCameraImage(deviceId, toGladysImage(jpeg));
    images.set(sn, { hash, at: [...recent, now()] });
  }

  /**
   * Publish the push thumbnail of a camera. The SDK downloads it when the push
   * arrives, so it may still be pending when the event fires.
   */
  async function publishThumbnail(dev) {
    const deviceId = deviceIds(gladys, dev.sn).device;
    if (!hasFeature(dev, 'image') || !created(deviceId) || fetching.has(dev.sn)) {
      return;
    }
    fetching.add(dev.sn);
    try {
      await sleep(SNAPSHOT_FIRST_DELAY_MS);
      for (let attempt = 1; attempt <= SNAPSHOT_ATTEMPTS; attempt += 1) {
        try {
          const camera = dev.camera?.();
          if (typeof camera?.snapshotStored !== 'function') {
            return;
          }
          const jpeg = await camera.snapshotStored();
          await publishImage(dev.sn, deviceId, jpeg);
          return;
        } catch (err) {
          if (err?.reason === 'pending' && attempt < SNAPSHOT_ATTEMPTS) {
            await sleep(SNAPSHOT_RETRY_DELAY_MS);
            continue;
          }
          logger.warn(`No thumbnail published for ${dev.sn}:`, err?.message ?? err);
          return;
        }
      }
    } finally {
      fetching.delete(dev.sn);
    }
  }

  const known = (event) => (event?.deviceSn ? registry.get(event.deviceSn) : undefined);

  const listeners = {
    doorbellPress: async (event) => {
      const dev = known(event);
      if (!dev) return;
      await Promise.all([
        hasFeature(dev, 'ring') ? pulse(dev, 'ring', RING_RESET_MS) : undefined,
        sceneEvent('doorbell_pressed', dev),
        publishThumbnail(dev),
      ]);
    },
    packageDelivered: async (event) => {
      const dev = known(event);
      if (!dev) return;
      await Promise.all([sceneEvent('package_delivered', dev), publishThumbnail(dev)]);
    },
    alarm: async (event) => {
      const dev = known(event);
      if (!dev) return;
      await sceneEvent('alarm_triggered', dev, { phase: event.phase ?? 'triggered' });
    },
    batteryAlert: async (event) => {
      const dev = known(event);
      if (!dev || !hasFeature(dev, 'battery_low')) return;
      const featureId = deviceIds(gladys, dev.sn).feature('battery_low');
      if (event.state === 'low') {
        await publish(featureId, 1);
      } else if (event.state === 'full') {
        await publish(featureId, 0);
      }
    },
    deviceAdded: () => onDevicesChanged(),
    deviceRemoved: () => onDevicesChanged(),
    deviceCapabilities: () => onDevicesChanged(),
    error: (err) => {
      logger.warn('eufy client error:', err?.message ?? err);
    },
  };

  for (const [name, target] of Object.entries(DETECTIONS)) {
    listeners[name] = async (event) => {
      const dev = known(event);
      if (!dev) return;
      await Promise.all([
        hasFeature(dev, 'motion') ? pulse(dev, 'motion', MOTION_RESET_MS) : undefined,
        sceneEvent('motion_detected', dev, { target }),
        publishThumbnail(dev),
      ]);
    };
  }

  for (const name of STATE_EVENTS) {
    listeners[name] = async (event) => {
      // `commandUnconfirmed` names its device `sn`, every other event `deviceSn`.
      const dev = registry.get(event?.deviceSn ?? event?.sn);
      if (dev) {
        await publishDeviceStates(dev);
      }
    };
  }

  return {
    listeners,

    /** Subscribe to the events of a client (before its login). */
    attach(client) {
      for (const [name, listener] of Object.entries(listeners)) {
        // The promise is returned for the tests; the client itself ignores it.
        client.on(name, (...args) =>
          Promise.resolve(listener(...args)).catch((err) => {
            logger.warn(`Failed to handle the eufy "${name}" event:`, err?.message ?? err);
          }),
        );
      }
    },

    publish,
    publishDeviceStates,
    publishThumbnail,

    /** Forget what was published for a device, so that it gets everything again. */
    forget(sn) {
      const prefix = deviceIds(gladys, sn).feature('');
      for (const featureId of published.keys()) {
        if (featureId.startsWith(prefix)) {
          published.delete(featureId);
        }
      }
    },

    forgetAll() {
      published.clear();
    },

    /** Cancel the pending resets, and publish their 0 right away. */
    async stop() {
      const pending = [...resets.keys()];
      for (const cancel of [...resets.values(), ...retries.values()]) {
        cancel();
      }
      resets.clear();
      retries.clear();
      await Promise.all(pending.map((featureId) => publish(featureId, 0)));
    },
  };
}
