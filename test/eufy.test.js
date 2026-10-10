import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EufyMega } from '@mega-yfue/eufy-sdk';
import {
  ACCOUNT_FILE,
  createEufyClient,
  dropOtherAccountSession,
  JsonFileStore,
  PUSH_FILE,
  SESSION_FILE,
  toEufyLogger,
} from '../src/eufy.js';
import { normalizeConfig } from '../src/config.js';
import { makeRecordingLogger } from './helpers.js';

test('the eufy-sdk routine logs go to debug, problems stay visible', () => {
  const logger = makeRecordingLogger();
  const eufyLogger = toEufyLogger(logger);
  eufyLogger.debug('d');
  eufyLogger.info('i');
  eufyLogger.warn('w');
  eufyLogger.error('e');
  assert.deepEqual(logger.lines.debug, ['[eufy-sdk] d', '[eufy-sdk] i']);
  assert.deepEqual(logger.lines.warn, ['[eufy-sdk] w']);
  assert.deepEqual(logger.lines.error, ['[eufy-sdk] e']);
});

test('the client is built without any network access, its data dir created', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gladys-eufy-'));
  const dataDir = join(root, 'data');
  try {
    const client = createEufyClient(
      normalizeConfig({ email: 'me@example.com', password: 'x' }),
      makeRecordingLogger(),
      dataDir,
    );
    assert.ok(client instanceof EufyMega);
    assert.equal(client.loggedIn, false);
    assert.ok((await stat(dataDir)).isDirectory());
    await client.disconnect();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the store writes through a renamed file, and logs a failed write', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'gladys-eufy-'));
  const logger = makeRecordingLogger();
  try {
    const store = new JsonFileStore(join(dataDir, SESSION_FILE), logger);
    assert.equal(store.load(), null);
    store.save({ authToken: 't' });
    assert.deepEqual(store.load(), { authToken: 't' });
    assert.deepEqual(readdirSync(dataDir), [SESSION_FILE]);
    store.clear();
    assert.equal(store.load(), null);

    writeFileSync(join(dataDir, PUSH_FILE), '{"creds":');
    const broken = new JsonFileStore(join(dataDir, PUSH_FILE), logger);
    assert.equal(broken.load(), null, 'a truncated file reads as nothing');

    const unwritable = new JsonFileStore(join(dataDir, 'missing', PUSH_FILE), logger);
    assert.doesNotThrow(() => unwritable.save({ persistentIds: [] }));
    assert.match(logger.lines.warn[0], /Failed to save eufy-push\.json/);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('the session of another account, or of an old password, is dropped', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'gladys-eufy-'));
  const files = [SESSION_FILE, PUSH_FILE].map((name) => join(dataDir, name));
  const writeSession = () => files.forEach((file) => writeFileSync(file, '{}'));
  const kept = () => files.every((file) => existsSync(file));
  const logger = makeRecordingLogger();
  const config = normalizeConfig({ email: 'me@example.com', password: 'x', country: 'FR' });
  try {
    // A session older than the marker is taken as the current account's.
    writeSession();
    dropOtherAccountSession(config, dataDir, logger);
    assert.ok(kept());
    assert.doesNotMatch(readFileSync(join(dataDir, ACCOUNT_FILE), 'utf8'), /me@example|"x"/);

    dropOtherAccountSession({ ...config, email: 'ME@example.com' }, dataDir, logger);
    assert.ok(kept(), 'same account');

    for (const other of [
      { ...config, email: 'other@example.com' },
      { ...config, password: 'new' },
      { ...config, country: 'DE' },
    ]) {
      writeSession();
      dropOtherAccountSession(other, dataDir, logger);
      assert.ok(files.every((file) => !existsSync(file)));
      dropOtherAccountSession(config, dataDir, logger);
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
