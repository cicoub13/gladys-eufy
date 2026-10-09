import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeEufyError, errorToText } from '../src/errors.js';

class SessionExpiredError extends Error {}

test('errorToText flattens strings, errors and anything else', () => {
  assert.equal(errorToText('boom'), 'boom');
  assert.equal(errorToText(new Error('bang')), 'bang');
  assert.equal(errorToText({ message: 'obj' }), 'obj');
  assert.equal(errorToText(42), '42');
});

test('a refused password is not retried', () => {
  const described = describeEufyError(Object.assign(new Error('Wrong password'), { status: 400 }));
  assert.equal(described.kind, 'credentials');
  assert.equal(described.transient, false);
  assert.match(described.message.fr, /identifiants/);
  assert.equal(
    describeEufyError(Object.assign(new Error('nope'), { status: 401 })).kind,
    'credentials',
  );
});

test('a blocked account is not retried', () => {
  const described = describeEufyError(new Error('Too many requests, try later'));
  assert.equal(described.kind, 'locked');
  assert.equal(described.transient, false);
  assert.equal(describeEufyError(Object.assign(new Error('x'), { status: 429 })).kind, 'locked');
});

test('an unreachable cloud is retried', () => {
  for (const err of [
    new Error('getaddrinfo ENOTFOUND security-app-eu.eufylife.com'),
    new TypeError('fetch failed'),
    Object.assign(new Error('Bad gateway'), { status: 502 }),
  ]) {
    const described = describeEufyError(err);
    assert.equal(described.kind, 'unreachable', err.message);
    assert.equal(described.transient, true);
  }
});

test('an expired session is retried', () => {
  const described = describeEufyError(new SessionExpiredError('session rejected'));
  assert.equal(described.kind, 'session');
  assert.equal(described.transient, true);
});

test('an unknown error keeps its raw text', () => {
  const described = describeEufyError(new Error('something odd'));
  assert.equal(described.kind, 'unknown');
  assert.equal(described.transient, false);
  assert.match(described.message.en, /something odd/);
});
