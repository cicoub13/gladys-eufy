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
