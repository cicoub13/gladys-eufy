import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EufyMega } from '@mega-yfue/eufy-sdk';
import { createEufyClient, toEufyLogger } from '../src/eufy.js';
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
