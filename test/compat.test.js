// -----------------------------------------------------------------------------
// Backward compatibility: the external ids users' devices and scenes are bound
// to. A changed id is a deleted device for every user: these values must only
// ever change on purpose, with a migration.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDevice, EXTERNAL_ID_TYPE, FEATURES } from '../src/mapping.js';
import { externalIdHelpers, makeFakeDevice } from './helpers.js';

test('the external id type stays "eufy"', () => {
  assert.equal(EXTERNAL_ID_TYPE, 'eufy');
});

test('the feature keys stay stable', () => {
  assert.deepEqual(
    FEATURES.map((feature) => feature.key),
    [
      'image',
      'ring',
      'motion',
      'opening',
      'lock',
      'leak',
      'smoke',
      'co',
      'siren',
      'arming',
      'battery',
      'charging',
      'battery_low',
    ],
  );
});

test('a device and its features are keyed by the serial number', () => {
  const dev = makeFakeDevice({ sn: 'T8213P1234', capabilities: ['doorbell'] });
  const device = buildDevice(externalIdHelpers, dev);
  assert.equal(device.external_id, 'ext:eufy-test:eufy:T8213P1234');
  assert.equal(device.features[0].external_id, 'ext:eufy-test:eufy:T8213P1234:ring');
  assert.equal(device.params[0].name, 'serial_number');
});
