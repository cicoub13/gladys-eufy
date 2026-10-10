import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSession, PHASE } from '../src/session.js';
import { normalizeConfig } from '../src/config.js';
import { makeFakeClient, makeFakeTimer, makeRecordingLogger } from './helpers.js';

const CONFIG = normalizeConfig({ email: 'me@example.com', password: 'secret' });
const CAPTCHA_IMAGE = 'data:image/png;base64,iVBORw0KGgo=';

function setup(loginResults, { deviceCount = 3 } = {}) {
  const client = makeFakeClient({ loginResults });
  const statuses = [];
  const attached = [];
  const connectedWith = [];
  const scheduleTimer = makeFakeTimer();
  const logger = makeRecordingLogger();
  const session = createSession({
    createClient: () => client,
    attachClient: (c) => attached.push(c),
    onConnected: async (c) => {
      connectedWith.push(c);
      return deviceCount;
    },
    setStatus: async (connected, message) => statuses.push({ connected, message }),
    scheduleTimer,
    logger,
  });
  return { client, session, statuses, attached, connectedWith, scheduleTimer, logger };
}

test('a restored session connects at once', async () => {
  const { client, session, statuses, attached, connectedWith } = setup([{ status: 'ok' }]);
  await session.start(CONFIG);
  assert.equal(session.phase, PHASE.CONNECTED);
  assert.deepEqual(attached, [client], 'events are subscribed before the login');
  assert.deepEqual(connectedWith, [client]);
  assert.equal(statuses.at(-1).connected, true);
  assert.match(statuses.at(-1).message.fr, /3 appareil/);
});

test('a verification code is asked, then handed to the pending login', async () => {
  const { client, session, statuses } = setup([
    { status: '2fa', method: 'email' },
    { status: 'ok' },
  ]);
  await session.start(CONFIG);
  assert.equal(session.phase, PHASE.VERIFICATION_CODE);
  assert.equal(statuses.at(-1).connected, false);
  assert.match(statuses.at(-1).message.fr, /Code de vérification/);
  assert.match(statuses.at(-1).message.en, /by email/);

  assert.equal(await session.submitVerificationCode('123456'), true);
  assert.deepEqual(client.calls.submitVerifyCode, ['123456']);
  assert.equal(client.calls.login, 1, 'the pending login is continued, not restarted');
  assert.equal(session.phase, PHASE.CONNECTED);
});

test('the free-text method of eufy-sdk is not pasted into the status', async () => {
  const { statuses, session } = setup([
    { status: '2fa', method: 'code sent via app-push/sendmsg/verify_code' },
  ]);
  await session.start(CONFIG);
  assert.equal(
    statuses.at(-1).message.fr,
    'eufy a envoyé un code de vérification : saisissez-le dans le champ « Code de vérification » ci-dessous, puis enregistrez.',
  );
});

test('an account without any supported device says how to share them', async () => {
  const { statuses, session } = setup([{ status: 'ok' }], { deviceCount: 0 });
  await session.start(CONFIG);
  assert.equal(statuses.at(-1).connected, true);
  assert.match(statuses.at(-1).message.fr, /accepter l’invitation/);
  assert.match(statuses.at(-1).message.en, /List the raw devices/);
});

test('a captcha is written to the logs, then answered', async () => {
  const { client, session, statuses, logger } = setup([
    { status: 'captcha', image: CAPTCHA_IMAGE, retry: false },
    { status: 'captcha', image: CAPTCHA_IMAGE, retry: true },
    { status: '2fa', method: 'email' },
    { status: 'ok' },
  ]);
  await session.start(CONFIG);
  assert.equal(session.phase, PHASE.CAPTCHA);
  assert.ok(logger.lines.warn.includes(CAPTCHA_IMAGE), 'the data URL is alone on its line');
  assert.match(statuses.at(-1).message.fr, /Réponse captcha/);
  assert.match(statuses.at(-1).message.fr, /Logs/);

  await session.submitCaptcha('wrng');
  assert.equal(session.phase, PHASE.CAPTCHA);
  assert.match(statuses.at(-1).message.en, /Wrong captcha answer/);

  await session.submitCaptcha('ab12');
  assert.equal(session.phase, PHASE.VERIFICATION_CODE);
  await session.submitVerificationCode('654321');
  assert.equal(session.phase, PHASE.CONNECTED);
  assert.deepEqual(client.calls.solveCaptcha, ['wrng', 'ab12']);
});

test('a refused verification code says how to get a new one', async () => {
  const { session, statuses } = setup([{ status: '2fa' }, new Error('login failed: 26052')]);
  await session.start(CONFIG);
  await session.submitVerificationCode('000000');
  assert.equal(statuses.at(-2).message.en, 'Connecting to eufy...', 'the code is being checked');
  assert.equal(session.phase, PHASE.FAILED);
  assert.match(statuses.at(-1).message.fr, /refusé le code de vérification/);
});

test('an unexplained failure says how to retry', async () => {
  const { session, statuses } = setup([new Error('login failed: 26052')]);
  await session.start(CONFIG);
  assert.match(statuses.at(-1).message.en, /26052\. Save the configuration again to retry\./);
});

test('an answer without a pending question is ignored', async () => {
  const { client, session } = setup([{ status: 'ok' }]);
  await session.start(CONFIG);
  assert.equal(await session.submitVerificationCode('1'), false);
  assert.equal(await session.submitCaptcha('x'), false);
  assert.deepEqual(client.calls.submitVerifyCode, []);
  assert.deepEqual(client.calls.solveCaptcha, []);
});

test('refused credentials are never retried', async () => {
  const { session, statuses, scheduleTimer } = setup([
    Object.assign(new Error('Wrong password'), { status: 401 }),
  ]);
  await session.start(CONFIG);
  assert.equal(session.phase, PHASE.FAILED);
  assert.match(statuses.at(-1).message.fr, /identifiants/);
  assert.equal(scheduleTimer.active().length, 0);
});

test('an unreachable cloud is retried with a growing backoff', async () => {
  const { client, session, statuses, scheduleTimer } = setup([
    new TypeError('fetch failed'),
    new TypeError('fetch failed'),
    { status: 'ok' },
  ]);
  await session.start(CONFIG);
  assert.equal(session.phase, PHASE.CONNECTING);
  assert.equal(scheduleTimer.active()[0].delayMs, 60_000);
  assert.match(statuses.at(-1).message.fr, /Prochaine tentative dans 1 min/);

  await scheduleTimer.runAll();
  assert.equal(scheduleTimer.active()[0].delayMs, 120_000);
  await scheduleTimer.runAll();
  assert.equal(session.phase, PHASE.CONNECTED);
  assert.equal(client.calls.login, 3);
});

test('an expired session logs in again after the delay eufy asks for', async () => {
  const { client, session, scheduleTimer, statuses } = setup([{ status: 'ok' }]);
  await session.start(CONFIG);
  await client.fire(
    'sessionExpired',
    Object.assign(new Error('expired'), { retryAfterMs: 300_000 }),
  );
  assert.equal(session.phase, PHASE.CONNECTING);
  assert.equal(statuses.at(-1).connected, false);
  assert.equal(scheduleTimer.active()[0].delayMs, 300_000);
  await scheduleTimer.runAll();
  assert.equal(client.calls.login, 2);
  assert.equal(session.phase, PHASE.CONNECTED);
});

test('a session expiry while not connected is ignored', async () => {
  const { client, session, scheduleTimer } = setup([{ status: '2fa' }]);
  await session.start(CONFIG);
  await client.fire('sessionExpired', new Error('expired'));
  assert.equal(session.phase, PHASE.VERIFICATION_CODE);
  assert.equal(scheduleTimer.active().length, 0);
});

test('stop disconnects the client and cancels a pending retry', async () => {
  const { client, session, scheduleTimer } = setup([new TypeError('fetch failed')]);
  await session.start(CONFIG);
  await session.stop();
  assert.equal(session.phase, PHASE.IDLE);
  assert.equal(session.client, null);
  assert.equal(client.calls.disconnect, 1);
  assert.equal(scheduleTimer.active().length, 0);
});

test('a client that cannot be built fails the session with its reason', async () => {
  const statuses = [];
  const session = createSession({
    createClient: () => {
      throw new Error("EACCES: permission denied, mkdir '/data'");
    },
    attachClient: () => {},
    onConnected: async () => 0,
    setStatus: async (connected, message) => statuses.push({ connected, message }),
    scheduleTimer: makeFakeTimer(),
    logger: makeRecordingLogger(),
  });
  await session.start(CONFIG);
  assert.equal(session.phase, PHASE.FAILED);
  assert.match(statuses.at(-1).message.en, /EACCES/);
});

test('the outcome of a login started for a previous account is dropped', async () => {
  let release;
  const slowClient = makeFakeClient();
  slowClient.login = () => new Promise((resolve) => (release = resolve));
  const clients = [slowClient, makeFakeClient({ loginResults: [{ status: '2fa' }] })];
  const statuses = [];
  const session = createSession({
    createClient: () => clients.shift(),
    attachClient: () => {},
    onConnected: async () => 1,
    setStatus: async (connected, message) => statuses.push({ connected, message }),
    scheduleTimer: makeFakeTimer(),
    logger: makeRecordingLogger(),
  });
  const first = session.start(CONFIG);
  await new Promise((resolve) => setImmediate(resolve));
  await session.start(normalizeConfig({ email: 'other@example.com', password: 'x' }));
  release({ status: 'ok' });
  await first;
  assert.equal(session.phase, PHASE.VERIFICATION_CODE);
  assert.ok(statuses.every((status) => !status.connected));
});

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('failed realtime channels are restarted with a disconnect and a new login', async () => {
  const { client, session, statuses, scheduleTimer } = setup([{ status: 'ok' }]);
  client.realtime = { state: 'partial', push: { failed: 1 }, mqtt: { failed: 0 } };
  await session.start(CONFIG);
  await flush();
  assert.equal(session.phase, PHASE.CONNECTED, 'commands keep working meanwhile');
  assert.equal(statuses.at(-1).connected, false);
  assert.match(statuses.at(-1).message.fr, /temps réel/);
  assert.equal(scheduleTimer.active()[0].delayMs, 60_000);

  await scheduleTimer.runAll();
  await flush();
  assert.equal(client.calls.disconnect, 1);
  assert.equal(client.calls.login, 2);
  assert.equal(scheduleTimer.active()[0].delayMs, 120_000, 'still failing: a longer delay');

  client.realtime = { state: 'ready', push: { failed: 0 }, mqtt: { failed: 0 } };
  await scheduleTimer.runAll();
  await flush();
  assert.equal(scheduleTimer.active().length, 0);
  assert.equal(statuses.at(-1).connected, true);
});

test('a realtime startup that times out, or a failed wait, counts as failed', async () => {
  for (const realtime of [{ state: 'timed-out' }, new Error('login() first')]) {
    const { client, session, scheduleTimer } = setup([{ status: 'ok' }]);
    client.waitForRealtime = async () => {
      if (realtime instanceof Error) throw realtime;
      return realtime;
    };
    await session.start(CONFIG);
    await flush();
    assert.equal(scheduleTimer.active().length, 1);
  }
});

test('a failed wired P2P warm-up alone does not restart the realtime channels', async () => {
  const { client, session, scheduleTimer } = setup([{ status: 'ok' }]);
  client.realtime = {
    state: 'partial',
    push: { failed: 0 },
    mqtt: { failed: 0 },
    wiredP2p: { failed: 2 },
  };
  await session.start(CONFIG);
  await flush();
  assert.equal(scheduleTimer.active().length, 0);
});

test('a retried login disconnects first, so that the realtime channels restart', async () => {
  const { client, session, scheduleTimer } = setup([
    new TypeError('fetch failed'),
    { status: 'ok' },
  ]);
  await session.start(CONFIG);
  await scheduleTimer.runAll();
  assert.equal(client.calls.disconnect, 1);
  assert.equal(session.phase, PHASE.CONNECTED);
});
