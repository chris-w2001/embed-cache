import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiskStore } from '../src/disk-store.ts';

const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'embed-cache-disk-store-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('get on a missing key returns undefined', async () => {
  await withTempDir(async (dir) => {
    const store = new DiskStore(dir);
    assert.equal(await store.get(KEY_A), undefined);
  });
});

test('set then get round-trips the exact bytes', async () => {
  await withTempDir(async (dir) => {
    const store = new DiskStore(dir);
    const data = Buffer.from([1, 2, 3, 4, 5]);
    await store.set(KEY_A, data);
    assert.deepEqual(await store.get(KEY_A), data);
  });
});

test('records land at the two-level shard path derived from the key', async () => {
  await withTempDir(async (dir) => {
    const store = new DiskStore(dir);
    await store.set(KEY_A, Buffer.from([9]));
    const shard1 = await readdir(join(dir, KEY_A.slice(0, 2)));
    assert.deepEqual(shard1, [KEY_A.slice(2, 4)]);
    const shard2 = await readdir(join(dir, KEY_A.slice(0, 2), KEY_A.slice(2, 4)));
    assert.deepEqual(shard2, [`${KEY_A.slice(4)}.vec`]);
  });
});

test('set overwrites a previous value for the same key', async () => {
  await withTempDir(async (dir) => {
    const store = new DiskStore(dir);
    await store.set(KEY_A, Buffer.from([1, 2, 3]));
    await store.set(KEY_A, Buffer.from([9, 9]));
    assert.deepEqual(await store.get(KEY_A), Buffer.from([9, 9]));
  });
});

test('different keys do not collide', async () => {
  await withTempDir(async (dir) => {
    const store = new DiskStore(dir);
    await store.set(KEY_A, Buffer.from([1]));
    await store.set(KEY_B, Buffer.from([2]));
    assert.deepEqual(await store.get(KEY_A), Buffer.from([1]));
    assert.deepEqual(await store.get(KEY_B), Buffer.from([2]));
  });
});

test('delete removes a record and is a no-op on a missing one', async () => {
  await withTempDir(async (dir) => {
    const store = new DiskStore(dir);
    await store.set(KEY_A, Buffer.from([1]));
    await store.delete(KEY_A);
    assert.equal(await store.get(KEY_A), undefined);
    await store.delete(KEY_A); // must not throw
  });
});

test('clear removes the whole store directory', async () => {
  await withTempDir(async (dir) => {
    const store = new DiskStore(dir);
    await store.set(KEY_A, Buffer.from([1]));
    await store.set(KEY_B, Buffer.from([2]));
    await store.clear();
    assert.equal(await store.get(KEY_A), undefined);
    await assert.rejects(readdir(dir));
  });
});

test('a rename onto a target held by an unrelated file at that path does not corrupt the store', async () => {
  await withTempDir(async (dir) => {
    const store = new DiskStore(dir);
    await store.set(KEY_A, Buffer.from([1, 2, 3]));
    // simulate a stray leftover temp file from a previous crashed process
    const shard = join(dir, KEY_A.slice(0, 2), KEY_A.slice(2, 4));
    await writeFile(join(shard, '.tmp-stale-leftover'), Buffer.from([0]));
    assert.deepEqual(await store.get(KEY_A), Buffer.from([1, 2, 3]));
  });
});
