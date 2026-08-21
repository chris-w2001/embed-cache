import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Lru } from '../src/lru.ts';

test('get and set round-trip a value', () => {
  const lru = new Lru<string, number>();
  lru.set('a', 1);
  assert.equal(lru.get('a'), 1);
  assert.equal(lru.has('a'), true);
  assert.equal(lru.size, 1);
});

test('get on a missing key returns undefined without throwing', () => {
  const lru = new Lru<string, number>();
  assert.equal(lru.get('missing'), undefined);
});

test('peek does not affect recency', () => {
  const lru = new Lru<string, number>({ maxEntries: 2 });
  lru.set('a', 1);
  lru.set('b', 2);
  lru.peek('a'); // would save 'a' from eviction if it counted as a use
  lru.set('c', 3);
  assert.equal(lru.has('a'), false);
  assert.equal(lru.has('b'), true);
  assert.equal(lru.has('c'), true);
});

test('get marks a key as most recently used', () => {
  const lru = new Lru<string, number>({ maxEntries: 2 });
  lru.set('a', 1);
  lru.set('b', 2);
  lru.get('a'); // 'b' is now the least recently used
  lru.set('c', 3);
  assert.equal(lru.has('a'), true);
  assert.equal(lru.has('b'), false);
  assert.equal(lru.has('c'), true);
});

test('maxEntries evicts the least recently used entry first', () => {
  const lru = new Lru<string, number>({ maxEntries: 2 });
  lru.set('a', 1);
  lru.set('b', 2);
  lru.set('c', 3);
  assert.deepEqual(Array.from(lru.keys()), ['b', 'c']);
  assert.equal(lru.size, 2);
});

test('setting an existing key updates its value and recency without duplicating it', () => {
  const lru = new Lru<string, number>({ maxEntries: 2 });
  lru.set('a', 1);
  lru.set('b', 2);
  lru.set('a', 10); // refreshes 'a', 'b' becomes least recently used
  lru.set('c', 3);
  assert.equal(lru.size, 2);
  assert.equal(lru.get('a'), 10);
  assert.equal(lru.has('b'), false);
});

test('maxBytes evicts by total size, not entry count', () => {
  const lru = new Lru<string, string>({ maxBytes: 10 }, (v) => v.length);
  lru.set('a', '12345');
  lru.set('b', '12345');
  assert.equal(lru.bytes, 10);
  lru.set('c', '123'); // pushes total to 13, must evict 'a'
  assert.equal(lru.has('a'), false);
  assert.equal(lru.has('b'), true);
  assert.equal(lru.has('c'), true);
  assert.equal(lru.bytes, 8);
});

test('a value larger than maxBytes on its own is not retained', () => {
  const lru = new Lru<string, string>({ maxBytes: 4 }, (v) => v.length);
  lru.set('a', 'ab');
  lru.set('huge', '1234567890');
  assert.equal(lru.has('huge'), false);
  assert.equal(lru.has('a'), false); // 'a' was evicted to make room first
  assert.equal(lru.bytes, 0);
});

test('replacing a value updates the byte total by the delta', () => {
  const lru = new Lru<string, string>({ maxBytes: 100 }, (v) => v.length);
  lru.set('a', '12345');
  lru.set('a', '12');
  assert.equal(lru.bytes, 2);
});

test('delete removes an entry and its bytes, returning whether it existed', () => {
  const lru = new Lru<string, string>({}, (v) => v.length);
  lru.set('a', '12345');
  assert.equal(lru.delete('a'), true);
  assert.equal(lru.delete('a'), false);
  assert.equal(lru.has('a'), false);
  assert.equal(lru.bytes, 0);
});

test('clear empties the cache and resets bytes', () => {
  const lru = new Lru<string, string>({}, (v) => v.length);
  lru.set('a', '12345');
  lru.set('b', '123');
  lru.clear();
  assert.equal(lru.size, 0);
  assert.equal(lru.bytes, 0);
  assert.equal(lru.has('a'), false);
});

test('keys are ordered from least to most recently used', () => {
  const lru = new Lru<string, number>();
  lru.set('a', 1);
  lru.set('b', 2);
  lru.set('c', 3);
  lru.get('a');
  assert.deepEqual(Array.from(lru.keys()), ['b', 'c', 'a']);
});

test('an unconfigured Lru has no limits', () => {
  const lru = new Lru<number, number>();
  for (let i = 0; i < 1000; i++) lru.set(i, i);
  assert.equal(lru.size, 1000);
});
