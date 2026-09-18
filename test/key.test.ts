import { test } from 'node:test';
import assert from 'node:assert/strict';
import { embedKey, isCacheKey, assertCacheKey, keyToSegments } from '../src/key.ts';

test('embedKey returns a 64-character hex digest', () => {
  const key = embedKey('text-embedding-3-small', 'hello world');
  assert.equal(key.length, 64);
  assert.match(key, /^[0-9a-f]{64}$/);
});

test('embedKey is deterministic for the same inputs', () => {
  const a = embedKey('model', 'text', 'ns');
  const b = embedKey('model', 'text', 'ns');
  assert.equal(a, b);
});

test('embedKey defaults namespace to the empty string', () => {
  assert.equal(embedKey('model', 'text'), embedKey('model', 'text', ''));
});

test('embedKey differs when the model changes', () => {
  assert.notEqual(embedKey('model-a', 'text'), embedKey('model-b', 'text'));
});

test('embedKey differs when the text changes', () => {
  assert.notEqual(embedKey('model', 'text-a'), embedKey('model', 'text-b'));
});

test('embedKey differs when the namespace changes', () => {
  assert.notEqual(embedKey('model', 'text', 'ns-a'), embedKey('model', 'text', 'ns-b'));
});

test('embedKey is sensitive to whitespace and casing', () => {
  assert.notEqual(embedKey('model', 'Hello'), embedKey('model', 'hello'));
  assert.notEqual(embedKey('model', 'hello'), embedKey('model', 'hello '));
});

test('embedKey has no framing collisions across field boundaries', () => {
  // Without length-prefixing, ('a', 'b|c') and ('a|b', 'c') could collide.
  const a = embedKey('a', 'b|c', 'ns');
  const b = embedKey('a|b', 'c', 'ns');
  assert.notEqual(a, b);
});

test('embedKey rejects a non-string or empty model', () => {
  assert.throws(() => embedKey('', 'text'), TypeError);
  // @ts-expect-error testing runtime validation
  assert.throws(() => embedKey(123, 'text'), TypeError);
});

test('embedKey rejects a non-string text', () => {
  // @ts-expect-error testing runtime validation
  assert.throws(() => embedKey('model', null), TypeError);
});

test('embedKey rejects a non-string namespace', () => {
  // @ts-expect-error testing runtime validation
  assert.throws(() => embedKey('model', 'text', 42), TypeError);
});

test('isCacheKey accepts a valid key and rejects malformed ones', () => {
  const key = embedKey('model', 'text');
  assert.equal(isCacheKey(key), true);
  assert.equal(isCacheKey(key.toUpperCase()), false);
  assert.equal(isCacheKey(key.slice(0, -1)), false);
  assert.equal(isCacheKey(`${key}0`), false);
  assert.equal(isCacheKey('not-a-key'), false);
});

test('assertCacheKey throws on an invalid key and passes through a valid one', () => {
  const key = embedKey('model', 'text');
  assert.doesNotThrow(() => assertCacheKey(key));
  assert.throws(() => assertCacheKey('bogus'), TypeError);
});

test('keyToSegments splits a key into two two-character shards and a filename', () => {
  const key = embedKey('model', 'text');
  const segments = keyToSegments(key);
  assert.equal(segments.length, 3);
  assert.equal(segments[0], key.slice(0, 2));
  assert.equal(segments[1], key.slice(2, 4));
  assert.equal(segments[2], `${key.slice(4)}.vec`);
});

test('keyToSegments rejects a key that is not a valid cache key', () => {
  assert.throws(() => keyToSegments('too-short'), TypeError);
});
