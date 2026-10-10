import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createEventBridge,
  MOTION_RESET_MS,
  RESET_RETRY_MS,
  RING_RESET_MS,
  SNAPSHOT_ATTEMPTS,
  STATES_RETRY_MS,
} from '../src/events.js';
import {
  makeFakeClient,
  makeFakeDevice,
  makeFakeGladys,
  makeFakeSleep,
  makeFakeTimer,
  makeJpeg,
  silentLogger,
} from './helpers.js';

const DOORBELL = 'ext:eufy-test:eufy:D1';
const SENSOR = 'ext:eufy-test:eufy:S1';

async function setup() {
  const gladys = makeFakeGladys({ created: ['D1', 'S1'] });
  const doorbell = makeFakeDevice({
    sn: 'D1',
    name: 'Front door',
    capabilities: ['camera', 'doorbell', 'motion', 'battery'],
    values: { batteryLevel: 80 },
  });
  doorbell.snapshots = [await makeJpeg()];
  const sensor = makeFakeDevice({ sn: 'S1', capabilities: ['contact'], values: { open: false } });
  const registry = new Map([
    ['D1', doorbell],
    ['S1', sensor],
  ]);
  const scheduleTimer = makeFakeTimer();
  const sleep = makeFakeSleep();
  let devicesChanged = 0;
  const bridge = createEventBridge({
    gladys,
    registry,
    logger: silentLogger,
    scheduleTimer,
    sleep,
    onDevicesChanged: () => {
      devicesChanged += 1;
    },
  });
  const client = makeFakeClient();
  bridge.attach(client);
  return {
    gladys,
    doorbell,
    sensor,
    bridge,
    client,
    scheduleTimer,
    sleep,
    devicesChanged: () => devicesChanged,
  };
}

test('a doorbell press rings, fires the scene event and publishes the thumbnail', async () => {
  const { gladys, client, scheduleTimer } = await setup();
  await client.fire('doorbellPress', { deviceSn: 'D1' });

  assert.deepEqual(gladys.statesOf(`${DOORBELL}:ring`), [1]);
  assert.deepEqual(gladys.calls.sceneEvents, [
    { key: 'doorbell_pressed', data: { device: DOORBELL, device_name: 'Front door' } },
  ]);
  assert.equal(gladys.calls.images.length, 1);
  assert.equal(gladys.calls.images[0].deviceExternalId, DOORBELL);
  assert.ok(gladys.calls.images[0].image.startsWith('image/jpg;base64,'));

  assert.equal(scheduleTimer.active()[0].delayMs, RING_RESET_MS);
  await scheduleTimer.runAll();
  assert.deepEqual(gladys.statesOf(`${DOORBELL}:ring`), [1, 0]);
});

test('detections set motion to 1 and back to 0 after the last one', async () => {
  const { gladys, client, scheduleTimer } = await setup();
  await client.fire('motion', { deviceSn: 'D1' });
  await client.fire('personDetected', { deviceSn: 'D1' });

  assert.deepEqual(gladys.statesOf(`${DOORBELL}:motion`), [1, 1]);
  assert.deepEqual(
    gladys.calls.sceneEvents.map((event) => [event.key, event.data.target]),
    [
      ['motion_detected', 'motion'],
      ['motion_detected', 'person'],
    ],
  );
  const active = scheduleTimer.active();
  assert.equal(active.length, 1, 'the second detection re-arms the reset');
  assert.equal(active[0].delayMs, MOTION_RESET_MS);
  await scheduleTimer.runAll();
  assert.deepEqual(gladys.statesOf(`${DOORBELL}:motion`), [1, 1, 0]);
});

test('a pending thumbnail is waited for', async () => {
  const { gladys, client, doorbell, sleep } = await setup();
  const jpeg = await makeJpeg();
  const pending = Object.assign(new Error('pending'), { reason: 'pending' });
  doorbell.snapshots = [pending, pending, jpeg];
  await client.fire('doorbellPress', { deviceSn: 'D1' });
  assert.equal(gladys.calls.images.length, 1);
  assert.equal(sleep.delays.length, 3);
});

test('a thumbnail still pending after the last attempt is given up', async () => {
  const { gladys, client, doorbell, sleep } = await setup();
  doorbell.snapshots = [Object.assign(new Error('pending'), { reason: 'pending' })];
  await client.fire('motion', { deviceSn: 'D1' });
  assert.equal(gladys.calls.images.length, 0);
  assert.equal(sleep.delays.length, SNAPSHOT_ATTEMPTS);
});

test('a rejected image does not break the event', async () => {
  const { gladys, client } = await setup();
  gladys.publishCameraImage = async () => {
    throw Object.assign(new Error('Too many images'), { status: 429 });
  };
  await client.fire('doorbellPress', { deviceSn: 'D1' });
  assert.equal(gladys.calls.sceneEvents.length, 1);
});

test('events of devices the integration does not know are ignored', async () => {
  const { gladys, client } = await setup();
  await client.fire('doorbellPress', { deviceSn: 'UNKNOWN' });
  await client.fire('motion', {});
  assert.equal(gladys.calls.states.length, 0);
  assert.equal(gladys.calls.sceneEvents.length, 0);
});

test('a contact change publishes the new value only once', async () => {
  const { gladys, client, sensor } = await setup();
  sensor.values.open = true;
  await client.fire('contactState', { deviceSn: 'S1', open: true });
  await client.fire('propertyChanged', { deviceSn: 'S1', property: 'contact', value: true });
  assert.deepEqual(gladys.statesOf(`${SENSOR}:opening`), [1]);
});

test('commandUnconfirmed republishes what the device actually reports', async () => {
  const gladys = makeFakeGladys({ created: ['L1'] });
  const lock = makeFakeDevice({ sn: 'L1', capabilities: ['lock'], values: { locked: true } });
  const bridge = createEventBridge({
    gladys,
    registry: new Map([['L1', lock]]),
    logger: silentLogger,
    scheduleTimer: makeFakeTimer(),
    sleep: makeFakeSleep(),
    onDevicesChanged: () => {},
  });
  const client = makeFakeClient();
  bridge.attach(client);
  // Gladys asked to unlock: the optimistic 0 was published...
  await bridge.publish('ext:eufy-test:eufy:L1:lock', 0, { force: true });
  // ...but the lock stayed locked.
  await client.fire('commandUnconfirmed', { sn: 'L1', property: 'locked' });
  assert.deepEqual(gladys.statesOf('ext:eufy-test:eufy:L1:lock'), [0, 1]);
});

test('battery alerts drive the low battery flag', async () => {
  const { gladys, client } = await setup();
  await client.fire('batteryAlert', { deviceSn: 'D1', state: 'low' });
  await client.fire('batteryAlert', { deviceSn: 'D1', state: 'hot' });
  await client.fire('batteryAlert', { deviceSn: 'D1', state: 'full' });
  assert.deepEqual(gladys.statesOf(`${DOORBELL}:battery_low`), [1, 0]);
});

test('package and alarm events become scene events', async () => {
  const { gladys, client } = await setup();
  await client.fire('packageDelivered', { deviceSn: 'D1' });
  await client.fire('alarm', { deviceSn: 'S1', phase: 'delayed' });
  await client.fire('alarm', { deviceSn: 'S1' });
  assert.deepEqual(
    gladys.calls.sceneEvents.map((event) => [event.key, event.data.phase]),
    [
      ['package_delivered', undefined],
      ['alarm_triggered', 'delayed'],
      ['alarm_triggered', 'triggered'],
    ],
  );
});

test('device list changes are reported', async () => {
  const { client, devicesChanged } = await setup();
  await client.fire('deviceAdded', {});
  await client.fire('deviceCapabilities', { deviceSn: 'D1', gained: ['ptz'] });
  assert.equal(devicesChanged(), 2);
});

test('a failed state publication is retried at the next change', async () => {
  const { gladys, bridge, doorbell } = await setup();
  gladys.publishError = new Error('Gladys down');
  await bridge.publishDeviceStates(doorbell);
  gladys.publishError = null;
  await bridge.publishDeviceStates(doorbell);
  assert.deepEqual(gladys.statesOf(`${DOORBELL}:battery`), [80]);
});

test('forget makes a device publish everything again', async () => {
  const { gladys, bridge, doorbell } = await setup();
  await bridge.publishDeviceStates(doorbell);
  await bridge.publishDeviceStates(doorbell);
  bridge.forget('D1');
  await bridge.publishDeviceStates(doorbell);
  assert.deepEqual(gladys.statesOf(`${DOORBELL}:battery`), [80, 80]);
});

test('the states of a device go in one request, retried a minute after a failure', async () => {
  const { gladys, bridge, doorbell, scheduleTimer } = await setup();
  gladys.publishError = new Error('Gladys restarting');
  await bridge.publishDeviceStates(doorbell);
  await bridge.publishDeviceStates(doorbell);
  assert.deepEqual(
    scheduleTimer.active().map((timer) => timer.delayMs),
    [STATES_RETRY_MS],
    'one retry per device',
  );
  gladys.publishError = null;
  await scheduleTimer.runAll();
  assert.deepEqual(gladys.calls.batches, [3], 'battery, ring and motion at once');
  assert.deepEqual(gladys.statesOf(`${DOORBELL}:battery`), [80]);
});

test('the states wait for the 300 per minute budget instead of a 429', async () => {
  const gladys = makeFakeGladys({ created: ['D1'] });
  let clock = 0;
  const sleep = async (delayMs) => {
    clock += delayMs;
  };
  const bridge = createEventBridge({
    gladys,
    registry: new Map(),
    logger: silentLogger,
    scheduleTimer: makeFakeTimer(),
    sleep,
    onDevicesChanged: () => {},
    now: () => clock,
  });
  for (let i = 0; i < 300; i += 1) {
    await bridge.publish(`${DOORBELL}:f${i}`, 1);
    clock += 10;
  }
  assert.equal(clock, 3_000);
  await bridge.publish(`${DOORBELL}:last`, 1);
  assert.equal(clock, 60_000, 'waited until the first state left the window');
  assert.equal(gladys.calls.states.length, 301);
});

test('nothing is published for a device the user did not create', async () => {
  const { gladys, client, bridge, doorbell, scheduleTimer } = await setup();
  gladys.devices = [{ external_id: `${DOORBELL}0` }];
  await client.fire('motion', { deviceSn: 'D1' });
  await scheduleTimer.runAll();
  await bridge.publishDeviceStates(doorbell);
  assert.deepEqual(gladys.calls.states, []);
  assert.deepEqual(gladys.calls.images, []);
  assert.equal(gladys.calls.sceneEvents.length, 1, 'scene events do not need a device');

  gladys.devices.push({ external_id: DOORBELL });
  bridge.forget('D1');
  await bridge.publishDeviceStates(doorbell);
  assert.deepEqual(gladys.statesOf(`${DOORBELL}:battery`), [80]);
});

test('stop cancels the pending resets and publishes their 0 at once', async () => {
  const { gladys, client, bridge, scheduleTimer } = await setup();
  await client.fire('motion', { deviceSn: 'D1' });
  await bridge.stop();
  assert.equal(scheduleTimer.active().length, 0);
  assert.deepEqual(gladys.statesOf(`${DOORBELL}:motion`), [1, 0]);
});

test('a failed reset is retried', async () => {
  const { gladys, client, scheduleTimer } = await setup();
  await client.fire('doorbellPress', { deviceSn: 'D1' });
  gladys.publishError = new Error('Gladys down');
  await scheduleTimer.runAll();
  gladys.publishError = null;
  assert.equal(scheduleTimer.active()[0].delayMs, RESET_RETRY_MS);
  await scheduleTimer.runAll();
  assert.deepEqual(gladys.statesOf(`${DOORBELL}:ring`), [1, 0]);
});

test('the device states set the pulses back to 0, unless an event is in progress', async () => {
  const { gladys, client, bridge, doorbell } = await setup();
  await bridge.publishDeviceStates(doorbell);
  assert.deepEqual(gladys.statesOf(`${DOORBELL}:ring`), [0]);
  assert.deepEqual(gladys.statesOf(`${DOORBELL}:motion`), [0]);

  await client.fire('motion', { deviceSn: 'D1' });
  await bridge.publishDeviceStates(doorbell);
  assert.deepEqual(gladys.statesOf(`${DOORBELL}:motion`), [0, 1]);
});
