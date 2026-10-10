// -----------------------------------------------------------------------------
// Backward compatibility: the external ids users' devices and scenes are bound
// to. A changed id is a deleted device for every user: these values must only
// ever change on purpose, with a migration.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DEFAULT_CONFIG } from '../src/config.js';
import { PUSH_FILE, SESSION_FILE } from '../src/eufy.js';
import { DETECTIONS } from '../src/events.js';
import { ARMING_MODES, buildDevice, EXTERNAL_ID_TYPE, FEATURES } from '../src/mapping.js';
import { externalIdHelpers, makeFakeDevice } from './helpers.js';

const manifest = JSON.parse(
  await readFile(new URL('../gladys-assistant-integration.json', import.meta.url), 'utf8'),
);

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

test('the configuration keys stay stable', () => {
  // Stored by Gladys: a renamed key loses what every user typed.
  assert.deepEqual(Object.keys(DEFAULT_CONFIG), [
    'email',
    'password',
    'country',
    'allow_unlock',
    'allow_disarm',
    'verification_code',
    'captcha_answer',
  ]);
});

test('the files under /data keep their names', () => {
  // A renamed file logs everyone out, and asks for a new 2FA code.
  assert.equal(SESSION_FILE, 'eufy-session.json');
  assert.equal(PUSH_FILE, 'eufy-push.json');
});

test('the scene triggers, their fields and their values stay stable', () => {
  // Saved in the users' scenes.
  assert.deepEqual(
    manifest.scene_triggers.map((trigger) => [
      trigger.key,
      trigger.fields.map((field) => field.key),
      trigger.variables.map((variable) => variable.key),
    ]),
    [
      ['doorbell_pressed', ['device'], ['device_name']],
      ['motion_detected', ['device', 'target'], ['device_name', 'target']],
      ['package_delivered', ['device'], ['device_name']],
      ['alarm_triggered', ['device', 'phase'], ['device_name', 'phase']],
    ],
  );
  assert.deepEqual(
    [...new Set(Object.values(DETECTIONS))],
    ['motion', 'person', 'stranger', 'vehicle', 'pet'],
  );
  const alarm = manifest.scene_triggers.find((trigger) => trigger.key === 'alarm_triggered');
  assert.deepEqual(
    alarm.fields.find((field) => field.key === 'phase').options.map((option) => option.value),
    ['triggered', 'delayed'],
  );
});

test('the guard mode values stay stable', () => {
  // Stored in the states of the arming feature, and in scenes.
  assert.deepEqual(
    Object.values(ARMING_MODES).map((mode) => mode.value),
    ['away', 'home', 'schedule', 'custom1', 'custom2', 'custom3', 'off', 'geo', 'disarmed'],
  );
});

test('a device and its features are keyed by the serial number', () => {
  const dev = makeFakeDevice({ sn: 'T8213P1234', capabilities: ['doorbell'] });
  const device = buildDevice(externalIdHelpers, dev);
  assert.equal(device.external_id, 'ext:eufy-test:eufy:T8213P1234');
  assert.equal(device.features[0].external_id, 'ext:eufy-test:eufy:T8213P1234:ring');
  assert.equal(device.params[0].name, 'serial_number');
});
