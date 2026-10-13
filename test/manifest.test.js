// -----------------------------------------------------------------------------
// Consistency checks between `gladys-assistant-integration.json` and the code.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { DEFAULT_CONFIG } from '../src/config.js';
import { DETECTIONS } from '../src/events.js';
import { createHandlers } from '../src/handlers.js';
import { silentLogger } from './helpers.js';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const manifest = JSON.parse(await read('../gladys-assistant-integration.json'));
const pkg = JSON.parse(await read('../package.json'));

const valueFields = manifest.config_schema.filter((field) => field.type !== 'section');
const trigger = (key) => manifest.scene_triggers.find((t) => t.key === key);

function minGladysVersion() {
  const match = manifest.gladys_version.match(/>=\s*(\d+)\.(\d+)\.\d+/);
  assert.ok(match, 'gladys_version must declare a minimum version');
  return [Number(match[1]), Number(match[2])];
}

test('the version and the image tag follow package.json', () => {
  assert.equal(manifest.version, pkg.version);
  assert.equal(manifest.docker_image, `ghcr.io/cicoub13/gladys-eufy:${pkg.version}`);
});

test('the descriptions fit the store limits', () => {
  for (const [lang, text] of Object.entries(manifest.description)) {
    assert.ok(text.length >= 10 && text.length <= 100, `${lang} description: ${text.length} chars`);
  }
  assert.ok(manifest.name.length >= 3 && manifest.name.length <= 30);
});

test('scene triggers require Gladys >= 5.1.0', () => {
  const [major, minor] = minGladysVersion();
  assert.ok(major > 5 || (major === 5 && minor >= 1), manifest.gladys_version);
});

test('the integration is declared cloud-only', () => {
  assert.deepEqual(manifest.transports, ['cloud']);
});

test('the configuration keys are the ones the code reads', () => {
  assert.deepEqual(
    valueFields.map((field) => field.key).sort(),
    Object.keys(DEFAULT_CONFIG).sort(),
  );
  const country = valueFields.find((field) => field.key === 'country');
  assert.equal(country.default, DEFAULT_CONFIG.country);
});

test('the password is stored as a secret', () => {
  assert.equal(valueFields.find((field) => field.key === 'password').type, 'secret');
});

test('the one-shot answers are optional', () => {
  for (const key of ['verification_code', 'captcha_answer']) {
    assert.equal(valueFields.find((field) => field.key === key).required, false, key);
  }
});

test('every manifest action has a handler, and the reverse', () => {
  const { actions } = createHandlers({
    gladys: createFakeGladys({ selector: 'eufy-test' }),
    createClient: () => {
      throw new Error('not used');
    },
    logger: silentLogger,
  });
  assert.deepEqual(
    manifest.actions.map((action) => action.key).sort(),
    Object.keys(actions).sort(),
  );
});

test('every scene event the code fires is declared, and the reverse', async () => {
  const source = await read('../src/events.js');
  const fired = [...source.matchAll(/sceneEvent\('([a-z_]+)'/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(fired)].sort(), manifest.scene_triggers.map((t) => t.key).sort());
});

test('the detection targets offered in scenes are the ones the code sends', () => {
  const target = trigger('motion_detected').fields.find((field) => field.key === 'target');
  assert.deepEqual(
    target.options.map((option) => option.value).sort(),
    [...new Set(Object.values(DETECTIONS))].sort(),
  );
});

test('every scene trigger filters on the device and exposes its name', () => {
  for (const sceneTrigger of manifest.scene_triggers) {
    const device = sceneTrigger.fields.find((field) => field.key === 'device');
    assert.equal(device?.source, 'devices', sceneTrigger.key);
    assert.ok(
      sceneTrigger.variables.some((variable) => variable.key === 'device_name'),
      sceneTrigger.key,
    );
  }
});

test('the user documentation exists in both languages', async () => {
  for (const lang of ['en', 'fr']) {
    const doc = await read(`../docs/${lang}.md`);
    assert.ok(doc.length >= 300, `docs/${lang}.md is too short`);
  }
});
