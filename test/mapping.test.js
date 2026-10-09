import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEVICE_FEATURE_CATEGORIES, DEVICE_FEATURE_TYPES } from '@gladysassistant/integration-sdk';
import { ARMING_MODES, buildDevice, isArmingMode, readStates } from '../src/mapping.js';
import { externalIdHelpers, makeFakeDevice } from './helpers.js';

const gladys = { ...externalIdHelpers };
const keysOf = (device) => device.features.map((f) => f.external_id.split(':').at(-1));

test('a battery doorbell gets image, ring, motion and battery features', () => {
  const dev = makeFakeDevice({
    sn: 'T8213',
    name: 'Front door',
    capabilities: ['camera', 'video', 'doorbell', 'motion', 'battery'],
  });
  const device = buildDevice(gladys, dev);
  assert.equal(device.name, 'Front door');
  assert.equal(device.external_id, 'ext:eufy-test:eufy:T8213');
  assert.equal(device.should_poll, false);
  assert.deepEqual(device.params, [
    { name: 'serial_number', value: 'T8213' },
    { name: 'model', value: 'T0000' },
  ]);
  assert.deepEqual(keysOf(device), [
    'image',
    'ring',
    'motion',
    'battery',
    'charging',
    'battery_low',
  ]);

  const image = device.features[0];
  assert.equal(image.category, DEVICE_FEATURE_CATEGORIES.CAMERA);
  assert.equal(image.type, DEVICE_FEATURE_TYPES.CAMERA.IMAGE);
  assert.equal(image.read_only, true);
  const ring = device.features[1];
  assert.equal(ring.category, DEVICE_FEATURE_CATEGORIES.DOORBELL);
  assert.equal(ring.type, DEVICE_FEATURE_TYPES.DOORBELL.RING);
});

test('every sensor capability maps to a binary sensor', () => {
  const dev = makeFakeDevice({ sn: 'S1', capabilities: ['contact', 'leak', 'smoke', 'co'] });
  const byKey = Object.fromEntries(
    buildDevice(gladys, dev).features.map((f) => [f.external_id.split(':').at(-1), f]),
  );
  assert.equal(byKey.opening.category, DEVICE_FEATURE_CATEGORIES.OPENING_SENSOR);
  assert.equal(byKey.leak.category, DEVICE_FEATURE_CATEGORIES.LEAK_SENSOR);
  assert.equal(byKey.smoke.category, DEVICE_FEATURE_CATEGORIES.SMOKE_SENSOR);
  assert.equal(byKey.co.category, DEVICE_FEATURE_CATEGORIES.CO_SENSOR);
  for (const feature of Object.values(byKey)) {
    assert.equal(feature.type, DEVICE_FEATURE_TYPES.SENSOR.BINARY);
    assert.equal(feature.read_only, true);
  }
});

test('a lock is controllable and reports its own battery', () => {
  const dev = makeFakeDevice({
    sn: 'L1',
    capabilities: ['lock'],
    values: { locked: true, lockBattery: 87.4 },
  });
  const device = buildDevice(gladys, dev);
  assert.deepEqual(keysOf(device), ['lock', 'battery']);
  const lock = device.features[0];
  assert.equal(lock.category, DEVICE_FEATURE_CATEGORIES.LOCK);
  assert.equal(lock.type, DEVICE_FEATURE_TYPES.LOCK.BINARY);
  assert.equal(lock.read_only, false);
  assert.deepEqual(readStates(dev), [
    { key: 'lock', value: 1 },
    { key: 'battery', value: 87 },
  ]);
});

test('the guard mode is a select of the eufy modes', () => {
  const dev = makeFakeDevice({
    sn: 'H1',
    capabilities: ['arming', 'siren'],
    values: { armingMode: 63 },
  });
  const device = buildDevice(gladys, dev);
  const arming = device.features.find((f) => f.external_id.endsWith(':arming'));
  assert.equal(arming.category, DEVICE_FEATURE_CATEGORIES.TEXT);
  assert.equal(arming.type, DEVICE_FEATURE_TYPES.TEXT.SELECT);
  assert.equal(arming.read_only, false);
  assert.deepEqual(
    arming.supported_options.map((o) => o.value),
    Object.values(ARMING_MODES).map((m) => m.value),
  );
  assert.deepEqual(readStates(dev), [{ key: 'arming', value: { text: 'disarmed' } }]);
});

test('an unknown guard mode integer publishes nothing', () => {
  const dev = makeFakeDevice({ sn: 'H1', capabilities: ['arming'], values: { armingMode: 99 } });
  assert.deepEqual(readStates(dev), []);
});

test('isArmingMode only accepts the known names', () => {
  assert.equal(isArmingMode('home'), true);
  assert.equal(isArmingMode('Home'), false);
  assert.equal(isArmingMode(1), false);
});

test('readStates skips the values never reported', () => {
  const dev = makeFakeDevice({
    sn: 'S1',
    capabilities: ['contact', 'battery'],
    values: { open: false, batteryLevel: 140 },
  });
  assert.deepEqual(readStates(dev), [
    { key: 'opening', value: 0 },
    { key: 'battery', value: 100 },
  ]);
});

test('a keypad reports its low battery flag', () => {
  const dev = makeFakeDevice({ sn: 'K1', capabilities: ['keypad'], values: { batteryLow: true } });
  assert.deepEqual(keysOf(buildDevice(gladys, dev)), ['battery_low']);
  assert.deepEqual(readStates(dev), [{ key: 'battery_low', value: 1 }]);
});

test('a device with no supported capability is not published', () => {
  const dev = makeFakeDevice({ sn: 'V1', capabilities: ['vacuumClean', 'light'] });
  assert.equal(buildDevice(gladys, dev), null);
});

test('the name falls back to the model, then to the serial number', () => {
  const dev = makeFakeDevice({ sn: 'C1', capabilities: ['camera'] });
  dev.name = '';
  assert.equal(buildDevice(gladys, dev).name, 'Model T0000');
  dev.modelName = '';
  assert.equal(buildDevice(gladys, dev).name, 'C1');
});
