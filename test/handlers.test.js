import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandlers } from '../src/handlers.js';
import {
  makeFakeClient,
  makeFakeDevice,
  makeFakeGladys,
  makeFakeSleep,
  makeFakeTimer,
  makeJpeg,
  silentLogger,
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

function setup({ config = ACCOUNT, loginResults, devices = makeDevices() } = {}) {
  const gladys = makeFakeGladys({ config });
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
  const { gladys, handlers, clients } = setup();
  await handlers.gladysConnected();

  assert.equal(clients.length, 1);
  assert.equal(clients[0].config.email, 'me@example.com');
  const discovered = gladys.calls.discovered.at(-1);
  assert.deepEqual(
    discovered.map((device) => device.name),
    ['Front door', 'Lock'],
    'the vacuum is not supported',
  );
  assert.deepEqual(gladys.statesOf('ext:eufy-test:eufy:D1:battery'), [55]);
  assert.deepEqual(gladys.statesOf('ext:eufy-test:eufy:L1:lock'), [1]);
  assert.equal(gladys.lastStatus().connected, true);
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
  const { gladys, handlers } = setup({ devices });
  await handlers.gladysConnected();
  assert.deepEqual(
    gladys.calls.discovered.at(-1).map((device) => device.name),
    ['Door', 'Lock'],
  );
  assert.deepEqual(gladys.statesOf('ext:eufy-test:eufy:L1:lock'), [1]);
  assert.equal(gladys.lastStatus().connected, true);
});

test('an incomplete configuration asks for the account', async () => {
  const { gladys, handlers, clients } = setup({ config: { email: 'me@example.com' } });
  await handlers.gladysConnected();
  assert.equal(clients.length, 0);
  assert.equal(gladys.lastStatus().connected, false);
  assert.match(gladys.lastStatus().message.fr, /mot de passe/);
});

test('the verification code typed in the form completes the login', async () => {
  const { gladys, handlers, clients } = setup({
    loginResults: [{ status: '2fa', method: 'email' }, { status: 'ok' }],
  });
  await handlers.gladysConnected();
  assert.match(gladys.lastStatus().message.fr, /Code de vérification/);

  await handlers.configUpdated({ ...ACCOUNT, verification_code: ' 482913 ' });
  assert.deepEqual(clients[0].calls.submitVerifyCode, ['482913']);
  assert.equal(clients.length, 1, 'the pending login is continued');
  assert.deepEqual(gladys.calls.setConfig.at(-1), { verification_code: '', captcha_answer: '' });
  assert.equal(gladys.lastStatus().connected, true);
});

test('the captcha answer typed in the form is handed to the login', async () => {
  const { handlers, clients } = setup({
    loginResults: [
      { status: 'captcha', image: 'data:image/png;base64,AA==', retry: false },
      { status: 'ok' },
    ],
  });
  await handlers.gladysConnected();
  await handlers.configUpdated({ ...ACCOUNT, captcha_answer: 'ab12' });
  assert.deepEqual(clients[0].calls.solveCaptcha, ['ab12']);
});

test('emptying the fields, or saving a used code again, does nothing', async () => {
  const { gladys, handlers, clients } = setup({
    loginResults: [{ status: '2fa' }, { status: '2fa' }],
  });
  await handlers.gladysConnected();
  await handlers.configUpdated({ ...ACCOUNT, verification_code: '111111' });
  // The echo of the integration's own setConfig.
  await handlers.configUpdated({ ...ACCOUNT, verification_code: '' });
  // A form still showing the used code, saved again.
  await handlers.configUpdated({ ...ACCOUNT, verification_code: '111111' });
  assert.deepEqual(clients[0].calls.submitVerifyCode, ['111111']);
  assert.equal(clients.length, 1);
  assert.equal(gladys.calls.setConfig.length, 1);
});

test('a code typed while no login waits for one is ignored', async () => {
  const { handlers, clients } = setup();
  await handlers.gladysConnected();
  await handlers.configUpdated({ ...ACCOUNT, verification_code: '123456' });
  assert.deepEqual(clients[0].calls.submitVerifyCode, []);
  assert.equal(clients.length, 1);
});

test('a new password starts a new login, and drops the stale answers', async () => {
  const { gladys, handlers, clients } = setup();
  await handlers.gladysConnected();
  await handlers.configUpdated({ ...ACCOUNT, password: 'new', verification_code: '999' });
  assert.equal(clients.length, 2);
  assert.equal(clients[0].calls.disconnect, 1);
  assert.equal(clients[1].config.password, 'new');
  assert.deepEqual(clients[1].calls.submitVerifyCode, []);
  assert.deepEqual(gladys.calls.setConfig.at(-1), { verification_code: '', captcha_answer: '' });
});

test('saving the form again after a refused password retries the login', async () => {
  const { handlers, clients } = setup({
    loginResults: [Object.assign(new Error('Wrong password'), { status: 401 })],
  });
  await handlers.gladysConnected();
  await handlers.configUpdated(ACCOUNT);
  assert.equal(clients.length, 2);
});

test('clearing the email stops the session', async () => {
  const { gladys, handlers, clients } = setup();
  await handlers.gladysConnected();
  await handlers.configUpdated({ ...ACCOUNT, email: '' });
  assert.equal(clients[0].calls.disconnect, 1);
  assert.equal(gladys.lastStatus().connected, false);
});

test('a Gladys reconnection republishes the states without a new login', async () => {
  const { gladys, handlers, clients } = setup();
  await handlers.gladysConnected();
  await handlers.gladysConnected();
  assert.equal(clients.length, 1);
  assert.equal(clients[0].calls.login, 1);
  assert.deepEqual(gladys.statesOf('ext:eufy-test:eufy:D1:battery'), [55, 55]);
});

test('a created device gets its states again', async () => {
  const { gladys, handlers } = setup();
  await handlers.gladysConnected();
  await handlers.deviceCreated({
    external_id: 'ext:eufy-test:eufy:D1',
    params: [{ name: 'serial_number', value: 'D1' }],
  });
  assert.deepEqual(gladys.statesOf('ext:eufy-test:eufy:D1:battery'), [55, 55]);
  await handlers.deviceCreated({ external_id: 'other', params: [] });
});

test('onGetImage answers the last thumbnail of the camera', async () => {
  const devices = makeDevices();
  devices[0].snapshots = [await makeJpeg()];
  const { handlers } = setup({ devices });
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
  const { handlers } = setup({ devices });
  await handlers.gladysConnected();
  const camera = { params: [{ name: 'serial_number', value: 'D1' }] };
  assert.ok((await handlers.getImage(camera)).startsWith('image/jpg;base64,'));

  devices[0].snapshots = [pending()];
  await assert.rejects(handlers.getImage(camera), /No eufy image available yet \(pending\)/);
});

test('a scan republishes the devices, only once connected', async () => {
  const { gladys, handlers } = setup({ loginResults: [{ status: '2fa' }] });
  await handlers.gladysConnected();
  await handlers.scan();
  assert.equal(gladys.calls.discovered.length, 0);
});

test('device list changes trigger one debounced refresh', async () => {
  const { gladys, handlers, clients, scheduleTimer } = setup();
  await handlers.gladysConnected();
  const before = gladys.calls.discovered.length;
  await clients[0].fire('deviceAdded', {});
  await clients[0].fire('deviceCapabilities', {});
  await scheduleTimer.runAll();
  assert.equal(gladys.calls.discovered.length, before + 1);
});

test('the actions report the connection and dump the devices', async () => {
  const { handlers } = setup();
  assert.match((await handlers.actions.test_connection()).fr, /Non connecté/);
  assert.match((await handlers.actions.dump_devices()).en, /Not connected/);
  await handlers.gladysConnected();
  assert.match((await handlers.actions.test_connection()).fr, /2 appareil/);
  assert.match((await handlers.actions.dump_devices()).en, /3 device/);
});

test('dump_devices reuses the devices already held', async () => {
  const { handlers, clients } = setup();
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
  const { handlers, clients } = setup({
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
  const { gladys, handlers, clients, scheduleTimer } = setup();
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
  assert.equal(gladys.calls.sceneEvents.length, 1, 'the doorbell is still known');
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
  const { gladys, handlers, clients } = setup();
  await handlers.gladysConnected();
  let release;
  clients[0].disconnect = async () => {
    clients[0].calls.disconnect += 1;
    await new Promise((resolve) => (release = resolve));
  };
  const config = { ...ACCOUNT, password: 'new' };
  gladys.config = config;
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
  const { handlers, clients } = setup();
  await handlers.gladysConnected();
  await handlers.shutdown();
  assert.equal(clients[0].calls.disconnect, 1);
});

test('setValue is routed to the device', async () => {
  const { handlers, gladys } = setup();
  await handlers.gladysConnected();
  await handlers.setValue(
    { external_id: 'ext:eufy-test:eufy:L1' },
    { external_id: 'ext:eufy-test:eufy:L1:lock' },
    0,
  );
  assert.deepEqual(gladys.statesOf('ext:eufy-test:eufy:L1:lock'), [1, 0]);
});
