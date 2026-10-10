// -----------------------------------------------------------------------------
// eufy device -> Gladys device.
//
// eufy-sdk models a device by its CAPABILITIES (`dev.has('lock')`), not by its
// model: a feature is published for each capability the device reports, so a
// new eufy model is supported as soon as the SDK classifies it.
//
// Each feature declares how to read its current value from the eufy device.
// `read` returns `undefined` while the device never reported the value: nothing
// is published then, rather than a made-up 0.
//
// The `external_id` of devices and features must never change: a renamed id is
// a deleted device for every user (see test/compat.test.js).
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as CATEGORIES,
  DEVICE_FEATURE_TYPES as TYPES,
  DEVICE_FEATURE_UNITS as UNITS,
} from '@gladysassistant/integration-sdk';

export const EXTERNAL_ID_TYPE = 'eufy';

/**
 * Guard modes, by the wire integer `arming().mode` reports. Labels are what the
 * eufy app shows. `setMode` accepts the names.
 */
export const ARMING_MODES = {
  0: { value: 'away', label: 'Away' },
  1: { value: 'home', label: 'Home' },
  2: { value: 'schedule', label: 'Schedule' },
  3: { value: 'custom1', label: 'Custom 1' },
  4: { value: 'custom2', label: 'Custom 2' },
  5: { value: 'custom3', label: 'Custom 3' },
  6: { value: 'off', label: 'Off' },
  47: { value: 'geo', label: 'Geofencing' },
  63: { value: 'disarmed', label: 'Disarmed' },
};

const ARMING_OPTIONS = Object.values(ARMING_MODES).map((mode, index) => ({
  value: mode.value,
  label: mode.label,
  sort_order: index,
}));

const ARMING_VALUES = new Set(ARMING_OPTIONS.map((option) => option.value));

/** Whether `value` is a guard mode name the integration may send. */
export function isArmingMode(value) {
  return ARMING_VALUES.has(value);
}

const bool = (value) => (typeof value === 'boolean' ? (value ? 1 : 0) : undefined);
const percent = (value) =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(100, Math.round(value)))
    : undefined;

const has =
  (...capabilities) =>
  (dev) =>
    capabilities.some((capability) => dev.has(capability));

const sensor = (category) => ({
  category,
  type: TYPES.SENSOR.BINARY,
  read_only: true,
  has_feedback: false,
  keep_history: true,
  min: 0,
  max: 1,
});

/** Battery level, wherever the device reports it (a lock carries its own). */
export function batteryLevel(dev) {
  return percent(dev.battery?.()?.level ?? dev.lock?.()?.battery);
}

/**
 * The features a device can carry, in display order. `key` is the stable
 * suffix of the feature external_id.
 */
export const FEATURES = [
  {
    key: 'image',
    name: 'Image',
    when: has('camera', 'snapshot'),
    feature: {
      category: CATEGORIES.CAMERA,
      type: TYPES.CAMERA.IMAGE,
      read_only: true,
      has_feedback: false,
      keep_history: false,
      min: 0,
      max: 0,
    },
  },
  {
    key: 'ring',
    name: 'Doorbell',
    when: has('doorbell'),
    feature: {
      category: CATEGORIES.DOORBELL,
      type: TYPES.DOORBELL.RING,
      read_only: true,
      has_feedback: false,
      keep_history: true,
      min: 0,
      max: 1,
    },
  },
  {
    key: 'motion',
    name: 'Motion',
    when: has('motion', 'person_detection'),
    feature: sensor(CATEGORIES.MOTION_SENSOR),
  },
  {
    key: 'opening',
    name: 'Opening',
    when: has('contact'),
    feature: sensor(CATEGORIES.OPENING_SENSOR),
    // Gladys reads an opening sensor as a contact: 1 = closed, 0 = open.
    read: (dev) => {
      const open = bool(dev.contact?.()?.open);
      return open === undefined ? undefined : 1 - open;
    },
  },
  {
    key: 'lock',
    name: 'Lock',
    when: has('lock'),
    feature: {
      category: CATEGORIES.LOCK,
      type: TYPES.LOCK.BINARY,
      read_only: false,
      has_feedback: true,
      keep_history: true,
      min: 0,
      max: 1,
    },
    read: (dev) => bool(dev.lock?.()?.locked),
  },
  {
    key: 'leak',
    name: 'Leak',
    when: has('leak'),
    feature: sensor(CATEGORIES.LEAK_SENSOR),
    read: (dev) => bool(dev.leak?.()?.leakDetected),
  },
  {
    key: 'smoke',
    name: 'Smoke',
    when: has('smoke'),
    feature: sensor(CATEGORIES.SMOKE_SENSOR),
    read: (dev) => bool(dev.smoke?.()?.smokeDetected),
  },
  {
    key: 'co',
    name: 'Carbon monoxide',
    when: has('co'),
    feature: sensor(CATEGORIES.CO_SENSOR),
    read: (dev) => bool(dev.co?.()?.coDetected),
  },
  {
    key: 'siren',
    name: 'Siren',
    when: has('siren'),
    feature: {
      category: CATEGORIES.SIREN,
      type: TYPES.SIREN.BINARY,
      read_only: true,
      has_feedback: false,
      keep_history: true,
      min: 0,
      max: 1,
    },
    read: (dev) => bool(dev.siren?.()?.active),
  },
  {
    key: 'arming',
    name: 'Guard mode',
    when: has('arming'),
    feature: {
      category: CATEGORIES.TEXT,
      type: TYPES.TEXT.SELECT,
      read_only: false,
      has_feedback: true,
      keep_history: false,
      min: 0,
      max: 0,
      supported_options: ARMING_OPTIONS,
    },
    read: (dev) => {
      const mode = ARMING_MODES[dev.arming?.()?.mode];
      return mode ? { text: mode.value } : undefined;
    },
  },
  {
    key: 'battery',
    name: 'Battery',
    when: (dev) => dev.has('battery') || batteryLevel(dev) !== undefined,
    feature: {
      category: CATEGORIES.BATTERY,
      type: TYPES.BATTERY.INTEGER,
      unit: UNITS.PERCENT,
      read_only: true,
      has_feedback: false,
      keep_history: true,
      min: 0,
      max: 100,
    },
    read: batteryLevel,
  },
  {
    key: 'charging',
    name: 'Charging',
    when: has('battery'),
    feature: {
      category: CATEGORIES.BATTERY,
      type: TYPES.BATTERY.CHARGING,
      read_only: true,
      has_feedback: false,
      keep_history: false,
      min: 0,
      max: 1,
    },
    read: (dev) => bool(dev.battery?.()?.charging),
  },
  {
    key: 'battery_low',
    name: 'Battery low',
    when: has('battery', 'keypad'),
    feature: {
      category: CATEGORIES.BATTERY_LOW,
      type: TYPES.BATTERY_LOW.BINARY,
      read_only: true,
      has_feedback: false,
      keep_history: true,
      min: 0,
      max: 1,
    },
    // Only the keypad reports it as a value; the other devices raise a
    // `batteryAlert` event instead (see events.js).
    read: (dev) => bool(dev.keypad?.()?.batteryLow),
  },
];

/** Ids of an eufy device, by serial number. */
export function deviceIds(gladys, sn) {
  return gladys.externalIds(EXTERNAL_ID_TYPE, sn);
}

/** The features of FEATURES a device carries. */
export function featuresOf(dev) {
  return FEATURES.filter((spec) => spec.when(dev));
}

/**
 * Build the Gladys device of an eufy device, or `null` when the integration
 * supports none of its capabilities (vacuum, light...).
 *
 * @param {object} gladys
 * @param {object} dev eufy-sdk `Device`
 */
export function buildDevice(gladys, dev) {
  const specs = featuresOf(dev);
  if (specs.length === 0) {
    return null;
  }
  const ids = deviceIds(gladys, dev.sn);
  return {
    name: dev.name || dev.modelName || dev.sn,
    external_id: ids.device,
    should_poll: false,
    params: [
      { name: 'serial_number', value: dev.sn },
      { name: 'model', value: dev.model || dev.modelName || '' },
    ],
    features: specs.map((spec) => ({
      name: spec.name,
      external_id: ids.feature(spec.key),
      ...spec.feature,
    })),
  };
}

/**
 * Current values of a device, as `{ key, value }` (only the values it reported).
 *
 * @param {object} dev eufy-sdk `Device`
 */
export function readStates(dev) {
  const states = [];
  for (const spec of featuresOf(dev)) {
    if (!spec.read) {
      continue;
    }
    const value = spec.read(dev);
    if (value !== undefined) {
      states.push({ key: spec.key, value });
    }
  }
  return states;
}
