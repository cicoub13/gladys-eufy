import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCommands } from '../src/commands.js';
import { createEventBridge } from '../src/events.js';
import {
  makeFakeDevice,
  makeFakeGladys,
  makeFakeSleep,
  makeFakeTimer,
  silentLogger,
} from './helpers.js';

const LOCK = { external_id: 'ext:eufy-test:eufy:L1' };
const LOCK_FEATURE = { external_id: 'ext:eufy-test:eufy:L1:lock' };
const HOMEBASE = { external_id: 'ext:eufy-test:eufy:H1' };
const ARMING_FEATURE = { external_id: 'ext:eufy-test:eufy:H1:arming' };

function setup({ timeoutMs } = {}) {
  const gladys = makeFakeGladys({ created: ['L1', 'H1'] });
  const lock = makeFakeDevice({ sn: 'L1', capabilities: ['lock'], values: { locked: false } });
  const homebase = makeFakeDevice({ sn: 'H1', capabilities: ['arming', 'siren'] });
  const registry = new Map([
    ['L1', lock],
    ['H1', homebase],
  ]);
  const events = createEventBridge({
    gladys,
    registry,
    logger: silentLogger,
    scheduleTimer: makeFakeTimer(),
    sleep: makeFakeSleep(),
    onDevicesChanged: () => {},
  });
  const commands = createCommands({ gladys, registry, events, logger: silentLogger, timeoutMs });
  return { gladys, lock, homebase, commands };
}

test('1 locks and 0 unlocks, and the value is published right away', async () => {
  const { gladys, lock, commands } = setup();
  await commands.setValue(LOCK, LOCK_FEATURE, 1);
  await commands.setValue(LOCK, LOCK_FEATURE, '0');
  assert.equal(lock.calls.lock, 1);
  assert.equal(lock.calls.unlock, 1);
  assert.deepEqual(gladys.statesOf(LOCK_FEATURE.external_id), [1, 0]);
});

test('a lock command that is not exactly 0 or 1 never unlocks', async () => {
  const { lock, commands } = setup();
  for (const value of [null, '', false, 2, 'unlock', undefined]) {
    await assert.rejects(commands.setValue(LOCK, LOCK_FEATURE, value), /Invalid lock command/);
  }
  assert.equal(lock.calls.unlock, 0);
  assert.equal(lock.calls.lock, 0);
});

test('a lock that does not answer fails within the timeout', async () => {
  const { lock, commands } = setup({ timeoutMs: 10 });
  lock.lock = () => ({ lock: () => new Promise(() => {}) });
  await assert.rejects(commands.setValue(LOCK, LOCK_FEATURE, 1), /no answer from eufy/);
});

test('the guard mode is set by name', async () => {
  const { gladys, homebase, commands } = setup();
  await commands.setValue(HOMEBASE, ARMING_FEATURE, 'away');
  assert.deepEqual(homebase.calls.setMode, ['away']);
  assert.deepEqual(gladys.statesOf(ARMING_FEATURE.external_id), [{ text: 'away' }]);
});

test('an unknown guard mode is refused', async () => {
  const { homebase, commands } = setup();
  await assert.rejects(commands.setValue(HOMEBASE, ARMING_FEATURE, 'party'), /Unknown guard mode/);
  assert.deepEqual(homebase.calls.setMode, []);
});

test('read-only features and unknown devices are refused', async () => {
  const { commands } = setup();
  await assert.rejects(
    commands.setValue(HOMEBASE, { external_id: 'ext:eufy-test:eufy:H1:siren' }, 1),
    /read-only/,
  );
  await assert.rejects(
    commands.setValue({ external_id: 'ext:eufy-test:eufy:NOPE' }, LOCK_FEATURE, 1),
    /Unknown eufy device/,
  );
});
