import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GladysApiError } from '@gladysassistant/integration-sdk';
import { createHandlers, SHUTDOWN_TIMEOUT_MS } from '../src/handlers.js';
import {
  connectFakeGladys,
  makeFakeClient,
  makeFakeDevice,
  makeFakeSleep,
  makeFakeTimer,
  makeJpeg,
  silentLogger,
  statesOf,
} from './helpers.js';

const ACCOUNT = { email: 'me@example.com', password: 'secret', country: 'FR' };

function makeDevices() {
  return [
    makeFakeDevice({
      sn: 'D1',
      name: 'Front door',
      capabilities: ['camera', 'doorbell', 'motion', 'battery'],
      values: { batteryLevel: 55 },
    }),
    makeFakeDevice({ sn: 'L1', name: 'Lock', capabilities: ['lock'], values: { locked: true } }),
    makeFakeDevice({ sn: 'V1', name: 'Vacuum', capabilities: ['vacuumClean'] }),
  ];
}

async function setup({ config = ACCOUNT, loginResults, devices = makeDevices() } = {}) {
  const gladys = await connectFakeGladys({ config, created: devices.map((dev) => dev.sn) });
  const clients = [];
  const scheduleTimer = makeFakeTimer();
  const handlers = createHandlers({
    gladys,
    createClient: (eufyConfig) => {
      const client = makeFakeClient({ devices, loginResults });
      client.config = eufyConfig;
      clients.push(client);
      return client;
    },
    logger: silentLogger,
    scheduleTimer,
    sleep: makeFakeSleep(),
  });
  return { gladys, handlers, clients, scheduleTimer };
}

test('at startup, the supported devices are published with their states', async () => {
  const { gladys, handlers, clients } = await setup();
  await handlers.gladysConnected();

  assert.equal(clients.length, 1);
  assert.equal(clients[0].config.email, 'me@example.com');
  const discovered = gladys.fake.discoveredDevices;
  assert.deepEqual(
    discovered.map((device) => device.name),
    ['Front door', 'Lock'],
    'the vacuum is not supported',
  );
  assert.deepEqual(statesOf(gladys, 'ext:eufy-test:eufy:D1:battery'), [55]);
  assert.deepEqual(statesOf(gladys, 'ext:eufy-test:eufy:L1:lock'), [1]);
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('a device the mapping chokes on does not hide the others', async () => {
  const devices = makeDevices();
  devices[0].has = () => {
    throw new Error('boom');
  };
  // A getter failing only when the states are read.
  const values = {};
  Object.defineProperty(values, 'open', {
    get() {
      throw new Error('getter');
    },
  });
  devices.unshift(makeFakeDevice({ sn: 'S1', name: 'Door', capabilities: ['contact'], values }));
  const { gladys, handlers } = await setup({ devices });
  await handlers.gladysConnected();
  assert.deepEqual(
    gladys.fake.discoveredDevices.map((device) => device.name),
    ['Door', 'Lock'],
  );
  assert.deepEqual(statesOf(gladys, 'ext:eufy-test:eufy:L1:lock'), [1]);
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('Gladys refusing the devices is no eufy failure: they are published again later', async (t) => {
  const { gladys, handlers, clients, scheduleTimer } = await setup();
  const refused = t.mock.method(gladys, 'publishDiscoveredDevices', async () => {
    throw new GladysApiError(429, 'TOO_MANY_REQUESTS', 'Too many requests');
  });
  await handlers.gladysConnected();
  assert.equal(gladys.fake.connectionStatus.connected, true, 'not "the eufy account is blocked"');
  assert.equal(clients[0].calls.login, 1);
  assert.equal(scheduleTimer.active()[0].delayMs, 60_000);

  refused.mock.restore();
  await scheduleTimer.runAll();
  assert.equal(gladys.fake.bodies('POST', '/discovered_device').length, 1);
  assert.equal(clients[0].calls.login, 1);
});

test('an incomplete configuration asks for the account', async () => {
  const { gladys, handlers, clients } = await setup({ config: { email: 'me@example.com' } });
  await handlers.gladysConnected();
  assert.equal(clients.length, 0);
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(gladys.fake.connectionStatus.message.fr, /mot de passe/);
});

test('an invalid country is named in the status, without any login', async () => {
  const { gladys, handlers, clients } = await setup({ config: { ...ACCOUNT, country: 'Germany' } });
  await handlers.gladysConnected();
  assert.equal(clients.length, 0);
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(
    gladys.fake.connectionStatus.message.fr,
    /« GERMANY » n’est pas un code à 2 lettres/,
  );
});

test('the verification code typed in the form completes the login', async () => {
  const { gladys, handlers, clients } = await setup({
    loginResults: [{ status: '2fa', method: 'email' }, { status: 'ok' }],
  });
  await handlers.gladysConnected();
  assert.match(gladys.fake.connectionStatus.message.fr, /Code de vérification/);

  await handlers.configUpdated({ ...ACCOUNT, verification_code: ' 482913 ' });
  assert.deepEqual(clients[0].calls.submitVerifyCode, ['482913']);
  assert.equal(clients.length, 1, 'the pending login is continued');
  assert.deepEqual(gladys.fake.bodies('POST', '/config').at(-1).config, {
    verification_code: '',
    captcha_answer: '',
  });
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('the captcha answer typed in the form is handed to the login', async () => {
  const { handlers, clients } = await setup({
    loginResults: [
      { status: 'captcha', image: 'data:image/png;base64,AA==', retry: false },
      { status: 'ok' },
    ],
  });
  await handlers.gladysConnected();
  await handlers.configUpdated({ ...ACCOUNT, captcha_answer: 'ab12' });
  assert.deepEqual(clients[0].calls.solveCaptcha, ['ab12']);
});

test('saving the form without a new code asks eufy for a new one', async () => {
  const { gladys, handlers, clients } = await setup({
    loginResults: [{ status: '2fa' }, { status: '2fa' }],
  });
  await handlers.gladysConnected();
  await handlers.configUpdated({ ...ACCOUNT, verification_code: '111111' });
  // A form still showing the used code, saved again: the code is never
  // replayed, a new login sends a new one.
  await handlers.configUpdated({ ...ACCOUNT, verification_code: '111111' });
  assert.deepEqual(clients[0].calls.submitVerifyCode, ['111111']);
  assert.equal(clients.length, 2);
  assert.deepEqual(clients[1].calls.submitVerifyCode, []);
  assert.deepEqual(gladys.fake.bodies('POST', '/config').at(-1).config, {
    verification_code: '',
    captcha_answer: '',
  });

  // A Gladys reconnection while a code is awaited asks for nothing.
  await handlers.gladysConnected();
  assert.equal(clients.length, 2);
});

test('saving the form without an answer while a captcha is awaited asks for a new one', async () => {
  const { handlers, clients } = await setup({
    loginResults: [{ status: 'captcha', image: 'data:image/png;base64,AA==', retry: false }],
  });
  await handlers.gladysConnected();
  await handlers.configUpdated(ACCOUNT);
  assert.equal(clients.length, 2);
});

test('a code typed while no login waits for one is ignored', async () => {
  const { handlers, clients } = await setup();
  await handlers.gladysConnected();
  await handlers.configUpdated({ ...ACCOUNT, verification_code: '123456' });
  assert.deepEqual(clients[0].calls.submitVerifyCode, []);
  assert.equal(clients.length, 1);
});

test('a new password starts a new login, and drops the stale answers', async () => {
  const { gladys, handlers, clients } = await setup();
  await handlers.gladysConnected();
  await handlers.configUpdated({ ...ACCOUNT, password: 'new', verification_code: '999' });
  assert.equal(clients.length, 2);
  assert.equal(clients[0].calls.disconnect, 1);
  assert.equal(clients[1].config.password, 'new');
  assert.deepEqual(clients[1].calls.submitVerifyCode, []);
  assert.deepEqual(gladys.fake.bodies('POST', '/config').at(-1).config, {
    verification_code: '',
    captcha_answer: '',
  });
});

test('saving the form again after a refused password retries the login', async () => {
  const { handlers, clients } = await setup({
    loginResults: [Object.assign(new Error('Wrong password'), { status: 401 })],
  });
  await handlers.gladysConnected();
  await handlers.configUpdated(ACCOUNT);
  assert.equal(clients.length, 2);
});

test('clearing the email stops the session', async () => {
  const { gladys, handlers, clients } = await setup();
  await handlers.gladysConnected();
  await handlers.configUpdated({ ...ACCOUNT, email: '' });
  assert.equal(clients[0].calls.disconnect, 1);
  assert.equal(gladys.fake.connectionStatus.connected, false);
});

test('a Gladys reconnection republishes the states without a new login', async () => {
  const { gladys, handlers, clients } = await setup();
  await handlers.gladysConnected();
  await handlers.gladysConnected();
  assert.equal(clients.length, 1);
  assert.equal(clients[0].calls.login, 1);
  assert.deepEqual(statesOf(gladys, 'ext:eufy-test:eufy:D1:battery'), [55, 55]);
});

test('a created device gets its states again', async () => {
  const { gladys, handlers } = await setup();
  await handlers.gladysConnected();
  await handlers.deviceCreated({
    external_id: 'ext:eufy-test:eufy:D1',
    params: [{ name: 'serial_number', value: 'D1' }],
  });
  assert.deepEqual(statesOf(gladys, 'ext:eufy-test:eufy:D1:battery'), [55, 55]);
  await handlers.deviceCreated({ external_id: 'other', params: [] });
});

test('an updated device gets its unchanged states again, for the features the update added', async () => {
  const devices = makeDevices();
  devices[0].values.charging = true;
  const { gladys, handlers, clients } = await setup({ devices });
  await handlers.gladysConnected();
  // Gladys dropped this one: the device did not have the feature yet.
  assert.deepEqual(statesOf(gladys, 'ext:eufy-test:eufy:D1:charging'), [1]);

  // Nothing changed: a state event publishes nothing.
  await clients[0].fire('propertyChanged', { deviceSn: 'D1' });
  assert.deepEqual(statesOf(gladys, 'ext:eufy-test:eufy:D1:charging'), [1]);

  // The user updates the device from the discovery: the feature now exists.
  await handlers.deviceUpdated({
    external_id: 'ext:eufy-test:eufy:D1',
    params: [{ name: 'serial_number', value: 'D1' }],
  });
  assert.deepEqual(statesOf(gladys, 'ext:eufy-test:eufy:D1:charging'), [1, 1]);
  assert.deepEqual(statesOf(gladys, 'ext:eufy-test:eufy:D1:battery'), [55, 55]);
  await handlers.deviceUpdated({ external_id: 'other', params: [] });
});

test('onGetImage answers the last thumbnail of the camera', async () => {
  const devices = makeDevices();
  devices[0].snapshots = [await makeJpeg()];
  const { handlers } = await setup({ devices });
  await handlers.gladysConnected();
  const camera = { params: [{ name: 'serial_number', value: 'D1' }] };
  assert.ok((await handlers.getImage(camera)).startsWith('image/jpg;base64,'));

  devices[0].snapshots = [Object.assign(new Error('none'), { reason: 'not-observed' })];
  await assert.rejects(handlers.getImage(camera), /next motion or doorbell event/);
  await assert.rejects(
    handlers.getImage({ params: [{ name: 'serial_number', value: 'L1' }] }),
    /Unknown eufy camera/,
  );
});

test('onGetImage waits for a thumbnail still downloading', async () => {
  const devices = makeDevices();
  const pending = () => Object.assign(new Error('downloading'), { reason: 'pending' });
  devices[0].snapshots = [pending(), pending(), await makeJpeg()];
  const { handlers } = await setup({ devices });
  await handlers.gladysConnected();
  const camera = { params: [{ name: 'serial_number', value: 'D1' }] };
  assert.ok((await handlers.getImage(camera)).startsWith('image/jpg;base64,'));

  devices[0].snapshots = [pending()];
  await assert.rejects(handlers.getImage(camera), /No eufy image available yet \(pending\)/);
});

test('a scan republishes the devices, only once connected', async () => {
  const { gladys, handlers } = await setup({ loginResults: [{ status: '2fa' }] });
  await handlers.gladysConnected();
  await handlers.scan();
  assert.equal(gladys.fake.bodies('POST', '/discovered_device').length, 0);
});

test('device list changes trigger one debounced refresh', async () => {
  const { gladys, handlers, clients, scheduleTimer } = await setup();
  await handlers.gladysConnected();
  const before = gladys.fake.bodies('POST', '/discovered_device').length;
  await clients[0].fire('deviceAdded', {});
  await clients[0].fire('deviceCapabilities', {});
  await scheduleTimer.runAll();
  assert.equal(gladys.fake.bodies('POST', '/discovered_device').length, before + 1);
});

test('the actions report the connection and dump the devices', async () => {
  const { handlers } = await setup();
  assert.match((await handlers.actions.test_connection()).fr, /Non connecté/);
  assert.match((await handlers.actions.dump_devices()).en, /Not connected/);
  await handlers.gladysConnected();
  assert.match((await handlers.actions.test_connection()).fr, /2 appareil/);
  assert.match((await handlers.actions.dump_devices()).en, /3 device/);
});

test('dump_devices reuses the devices already held', async () => {
  const { handlers, clients } = await setup();
  await handlers.gladysConnected();
  // A new `getDevice()` would replace, in the SDK, the device the property
  // changes are announced against.
  const fetched = [];
  const getDevice = clients[0].getDevice;
  clients[0].getDevice = (sn) => {
    fetched.push(sn);
    return getDevice(sn);
  };
  await handlers.actions.dump_devices();
  assert.deepEqual(fetched, []);
});

test('dump_devices fetches, then holds, a device the refresh could not read', async () => {
  const { handlers, clients } = await setup({
    loginResults: [{ status: '2fa' }, { status: 'ok' }],
  });
  await handlers.gladysConnected();
  const getDevice = clients[0].getDevice;
  const fetched = [];
  let failing = true;
  clients[0].getDevice = (sn) => {
    fetched.push(sn);
    if (sn === 'V1' && failing) {
      throw new Error('timeout');
    }
    return getDevice(sn);
  };
  await handlers.configUpdated({ ...ACCOUNT, verification_code: '123456' });
  failing = false;
  fetched.length = 0;
  await handlers.actions.dump_devices();
  await handlers.actions.dump_devices();
  assert.deepEqual(fetched, ['V1'], 'fetched once, then held');
});

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('a refresh keeps the devices reachable, and never fetches a held device again', async () => {
  const { gladys, handlers, clients, scheduleTimer } = await setup();
  await handlers.gladysConnected();
  const client = clients[0];
  const getDevices = client.getDevices;
  let release;
  client.getDevices = async () => {
    client.getDevices = getDevices;
    await new Promise((resolve) => (release = resolve));
    return getDevices();
  };
  const scan = handlers.scan();
  const test = handlers.actions.test_connection();
  const dump = handlers.actions.dump_devices();
  await flush();
  await client.fire('doorbellPress', { deviceSn: 'D1' });
  assert.equal(gladys.fake.sceneEvents.length, 1, 'the doorbell is still known');
  release();
  await Promise.all([scan, test, dump]);
  await client.fire('deviceCapabilities', {});
  await scheduleTimer.runAll();

  assert.deepEqual(client.calls.getDevice, ['D1', 'L1', 'V1']);
  await handlers.setValue(
    { external_id: 'ext:eufy-test:eufy:L1' },
    { external_id: 'ext:eufy-test:eufy:L1:lock' },
    1,
  );
  assert.equal(client.devices[1].calls.lock, 1);
});

test('configuration changes run one at a time: one client per account', async () => {
  const { gladys, handlers, clients } = await setup();
  await handlers.gladysConnected();
  let release;
  clients[0].disconnect = async () => {
    clients[0].calls.disconnect += 1;
    await new Promise((resolve) => (release = resolve));
  };
  const config = { ...ACCOUNT, password: 'new' };
  gladys.fake.config = config;
  const saved = handlers.configUpdated(config);
  // Gladys reconnects while the previous client is still closing.
  const reconnected = handlers.gladysConnected();
  await flush();
  release();
  await Promise.all([saved, reconnected]);
  assert.equal(clients.length, 2);
  assert.equal(clients[0].calls.disconnect, 1);
  assert.equal(clients[1].calls.login, 1);
});

test('shutdown closes the eufy session', async () => {
  const { handlers, clients } = await setup();
  await handlers.gladysConnected();
  await handlers.shutdown();
  assert.equal(clients[0].calls.disconnect, 1);
});

test('shutdown gives up on a connection that does not close', async () => {
  const { handlers, clients, scheduleTimer } = await setup();
  await handlers.gladysConnected();
  clients[0].disconnect = () => new Promise(() => {});
  const shutdown = handlers.shutdown();
  await flush();
  const timeout = scheduleTimer.active().find((timer) => timer.delayMs === SHUTDOWN_TIMEOUT_MS);
  assert.ok(timeout);
  await timeout.fn();
  await shutdown;
});

test('setValue is routed to the device, unlocking once the configuration allows it', async () => {
  const { handlers, gladys, clients } = await setup();
  await handlers.gladysConnected();
  const unlock = () =>
    handlers.setValue(
      { external_id: 'ext:eufy-test:eufy:L1' },
      { external_id: 'ext:eufy-test:eufy:L1:lock' },
      0,
    );
  await assert.rejects(unlock(), /Allow unlocking/);

  await handlers.configUpdated({ ...ACCOUNT, allow_unlock: true });
  await unlock();
  assert.equal(clients.length, 1, 'no new login');
  assert.deepEqual(statesOf(gladys, 'ext:eufy-test:eufy:L1:lock'), [1, 0]);
});
