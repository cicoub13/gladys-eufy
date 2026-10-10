// -----------------------------------------------------------------------------
// Hand-written fakes shared by the tests: a Gladys client, an eufy client, eufy
// devices and timers. No mocking library: each fake records what it received.
// -----------------------------------------------------------------------------

import { EventEmitter } from 'node:events';

/**
 * The id helpers of `GladysIntegration`, METHOD-shaped like the real ones: a
 * caller that passes `gladys.externalIds` around detached from its object gets
 * `this.externalId is not a function` here too.
 */
export const externalIdHelpers = {
  externalId(suffix) {
    return `ext:eufy-test:${suffix}`;
  },
  externalIds(type, platformId) {
    const device = this.externalId(`${type}:${platformId}`);
    return {
      device,
      feature: (key) => `${device}:${key}`,
    };
  },
};

export const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

/** A logger that keeps every line, by level. */
export function makeRecordingLogger() {
  const lines = { debug: [], info: [], warn: [], error: [] };
  const record =
    (level) =>
    (message, ...args) =>
      lines[level].push([message, ...args].join(' '));
  return {
    lines,
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
  };
}

/**
 * Fake GladysIntegration recording every call. `created` lists the serial
 * numbers of the eufy devices the user created (`gladys.devices`).
 */
export function makeFakeGladys({ config = {}, created = [] } = {}) {
  const calls = {
    discovered: [],
    states: [],
    images: [],
    sceneEvents: [],
    connectionStatus: [],
    setConfig: [],
  };
  return {
    calls,
    config,
    devices: created.map((sn) => ({
      external_id: externalIdHelpers.externalIds('eufy', sn).device,
    })),
    /** Set to an Error to make the next publications reject. */
    publishError: null,
    ...externalIdHelpers,
    async getConfig() {
      return this.config;
    },
    async setConfig(partial) {
      calls.setConfig.push(partial);
      this.config = { ...this.config, ...partial };
      return { success: true };
    },
    async publishDiscoveredDevices(devices) {
      calls.discovered.push(devices);
      return { success: true };
    },
    async publishState(featureExternalId, value) {
      if (this.publishError) {
        throw this.publishError;
      }
      calls.states.push({ featureExternalId, value });
      return { success: true };
    },
    async publishCameraImage(deviceExternalId, image) {
      if (this.publishError) {
        throw this.publishError;
      }
      calls.images.push({ deviceExternalId, image });
      return { success: true };
    },
    async publishSceneEvent(key, data) {
      calls.sceneEvents.push({ key, data });
      return { success: true };
    },
    async setConnectionStatus(connected, message) {
      calls.connectionStatus.push({ connected, message });
      return { success: true };
    },
    /** The last connection status published. */
    lastStatus() {
      return calls.connectionStatus.at(-1);
    },
    /** Values published for one feature, in order. */
    statesOf(featureExternalId) {
      return calls.states
        .filter((state) => state.featureExternalId === featureExternalId)
        .map((state) => state.value);
    },
  };
}

/**
 * Collects the timers the code under test schedules so tests can fire them on
 * demand instead of waiting.
 */
export function makeFakeTimer() {
  const pending = [];
  const scheduleTimer = (fn, delayMs) => {
    const entry = { fn, delayMs, cancelled: false };
    pending.push(entry);
    return () => {
      entry.cancelled = true;
    };
  };
  scheduleTimer.pending = pending;
  /** Timers still armed. */
  scheduleTimer.active = () => pending.filter((entry) => !entry.cancelled);
  scheduleTimer.runAll = async () => {
    for (const entry of pending.splice(0)) {
      if (!entry.cancelled) {
        await entry.fn();
      }
    }
  };
  return scheduleTimer;
}

/** A `sleep` that returns at once and records the delays asked. */
export function makeFakeSleep() {
  const delays = [];
  const sleep = async (delayMs) => {
    delays.push(delayMs);
  };
  sleep.delays = delays;
  return sleep;
}

/**
 * Fake eufy-sdk `Device`. `values` holds what the capability getters answer.
 *
 * @param {object} spec
 * @param {string} spec.sn
 * @param {string[]} spec.capabilities
 * @param {object} [spec.values]
 */
export function makeFakeDevice({ sn, name, model = 'T0000', capabilities, values = {} }) {
  const calls = { lock: 0, unlock: 0, setMode: [] };
  const caps = new Set(capabilities);
  const dev = {
    sn,
    name: name ?? `Device ${sn}`,
    model,
    modelName: `Model ${model}`,
    codec: 'camera',
    stationSn: sn,
    capabilities,
    calls,
    values,
    /** What `snapshotStored` returns: a Buffer, or an Error to throw. */
    snapshots: [],
    has: (capability) => caps.has(capability),
  };
  const accessor = (capability, build) => () => (caps.has(capability) ? build() : undefined);
  dev.camera = accessor('camera', () => ({
    snapshotStored: async () => {
      const next = dev.snapshots.length > 1 ? dev.snapshots.shift() : dev.snapshots[0];
      if (next instanceof Error) {
        throw next;
      }
      if (!next) {
        throw Object.assign(new Error('no thumbnail'), { reason: 'not-observed' });
      }
      return next;
    },
  }));
  dev.battery = accessor('battery', () => ({
    level: values.batteryLevel,
    charging: values.charging,
  }));
  dev.contact = accessor('contact', () => ({ open: values.open }));
  dev.lock = accessor('lock', () => ({
    locked: values.locked,
    battery: values.lockBattery,
    lock: async () => {
      calls.lock += 1;
    },
    unlock: async () => {
      calls.unlock += 1;
    },
  }));
  dev.leak = accessor('leak', () => ({ leakDetected: values.leak }));
  dev.smoke = accessor('smoke', () => ({ smokeDetected: values.smoke }));
  dev.co = accessor('co', () => ({ coDetected: values.co }));
  dev.siren = accessor('siren', () => ({ active: values.siren }));
  dev.keypad = accessor('keypad', () => ({ batteryLow: values.batteryLow }));
  dev.arming = accessor('arming', () => ({
    mode: values.armingMode,
    setMode: async (mode) => {
      calls.setMode.push(mode);
    },
  }));
  return dev;
}

/**
 * Fake `EufyMega`. `loginResults` is played in order by login /
 * submitVerifyCode / solveCaptcha: each entry is a result, or an Error to throw.
 */
export function makeFakeClient({ devices = [], loginResults = [{ status: 'ok' }] } = {}) {
  const client = new EventEmitter();
  const results = [...loginResults];
  const next = async () => {
    const result = results.length > 1 ? results.shift() : results[0];
    if (result instanceof Error) {
      throw result;
    }
    return result;
  };
  client.calls = {
    login: 0,
    submitVerifyCode: [],
    solveCaptcha: [],
    disconnect: 0,
    getDevice: [],
  };
  client.devices = devices;
  // Like eufy-sdk, `getDevice` builds a new object each time and announces
  // against the last one built for a serial.
  client.live = new Map();
  client.login = async () => {
    client.calls.login += 1;
    return next();
  };
  client.submitVerifyCode = async (code) => {
    client.calls.submitVerifyCode.push(code);
    return next();
  };
  client.solveCaptcha = async (answer) => {
    client.calls.solveCaptcha.push(answer);
    return next();
  };
  client.getDevices = async () =>
    client.devices.map((dev) => ({ sn: dev.sn, name: dev.name, model: dev.model }));
  client.getDevice = async (sn) => {
    const dev = client.devices.find((candidate) => candidate.sn === sn);
    client.calls.getDevice.push(sn);
    if (!dev) {
      throw new Error(`unknown device ${sn}`);
    }
    // Reads fall through to the fake device, so the tests can change it.
    const built = Object.create(dev);
    client.live.set(sn, built);
    return built;
  };
  client.disconnect = async () => {
    client.calls.disconnect += 1;
  };
  /** What `waitForRealtime` answers. */
  client.realtime = { state: 'ready', push: { failed: 0 }, mqtt: { failed: 0 } };
  client.waitForRealtime = async () => client.realtime;
  /** Emit an event and wait for the listeners' work (they return promises). */
  client.fire = async (name, ...args) => {
    await Promise.all(client.listeners(name).map((listener) => listener(...args)));
  };
  return client;
}

/** A minimal valid JPEG, as produced by jpeg-js. */
export async function makeJpeg(width = 8, height = 8, quality = 90) {
  const { default: jpeg } = await import('jpeg-js');
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    // Noise: it compresses badly, which is what the size tests need.
    data[i] = (i * 7919) % 256;
    data[i + 1] = (i * 104729) % 256;
    data[i + 2] = (i * 1299709) % 256;
    data[i + 3] = 255;
  }
  return jpeg.encode({ width, height, data }, quality).data;
}
