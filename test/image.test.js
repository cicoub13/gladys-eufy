import { test } from 'node:test';
import assert from 'node:assert/strict';
import jpeg from 'jpeg-js';
import { MAX_IMAGE_SIZE, toGladysImage } from '../src/image.js';
import { makeJpeg } from './helpers.js';

const PREFIX = 'image/jpg;base64,';
const decode = (image) =>
  jpeg.decode(Buffer.from(image.slice(PREFIX.length), 'base64'), { useTArray: false });

test('a small thumbnail is sent as is', async () => {
  const thumbnail = await makeJpeg(16, 16);
  const image = toGladysImage(thumbnail);
  assert.ok(image.startsWith(PREFIX));
  assert.deepEqual(Buffer.from(image.slice(PREFIX.length), 'base64'), Buffer.from(thumbnail));
});

test('a large image is halved until it fits under 150 KB', async () => {
  const large = await makeJpeg(640, 480, 100);
  assert.ok(`${PREFIX}${Buffer.from(large).toString('base64')}`.length > MAX_IMAGE_SIZE);
  const image = toGladysImage(large);
  assert.ok(image.length <= MAX_IMAGE_SIZE);
  const { width, height } = decode(image);
  assert.ok(width < 640 && width >= 10, `width ${width}`);
  assert.equal(width / height, 640 / 480);
});
