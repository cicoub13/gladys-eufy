import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isComplete, normalizeConfig, sameAccount } from '../src/config.js';

test('normalizeConfig trims the fields but never the password', () => {
  const config = normalizeConfig({
    email: '  me@example.com ',
    password: ' secret ',
    country: ' de ',
    verification_code: ' 123456 ',
    captcha_answer: ' ab12 ',
  });
  assert.deepEqual(config, {
    email: 'me@example.com',
    password: ' secret ',
    country: 'DE',
    verificationCode: '123456',
    captchaAnswer: 'ab12',
  });
});

test('normalizeConfig falls back to FR on a missing or invalid country', () => {
  assert.equal(normalizeConfig({}).country, 'FR');
  assert.equal(normalizeConfig({ country: 'France' }).country, 'FR');
  assert.equal(normalizeConfig({ country: 42 }).country, 'FR');
});

test('isComplete needs an email and a password', () => {
  assert.equal(isComplete(normalizeConfig({ email: 'a@b.c' })), false);
  assert.equal(isComplete(normalizeConfig({ password: 'x' })), false);
  assert.equal(isComplete(normalizeConfig({ email: 'a@b.c', password: 'x' })), true);
});

test('sameAccount ignores the one-shot answers', () => {
  const a = normalizeConfig({ email: 'a@b.c', password: 'x', verification_code: '1' });
  const b = normalizeConfig({ email: 'a@b.c', password: 'x', captcha_answer: 'zz' });
  assert.equal(sameAccount(a, b), true);
  assert.equal(sameAccount(a, normalizeConfig({ email: 'a@b.c', password: 'y' })), false);
  assert.equal(
    sameAccount(a, normalizeConfig({ email: 'a@b.c', password: 'x', country: 'DE' })),
    false,
  );
  assert.equal(sameAccount(null, a), false);
});
