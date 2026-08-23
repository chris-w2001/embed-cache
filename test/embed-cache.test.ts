import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EmbedCache } from '../src/embed-cache.ts';
import { embedKey, keyToSegments } from '../src/key.ts';

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'embed-cache-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('getOrCompute calls compute on a miss and caches the result', async () => {
  const cache = new EmbedCache();
  let calls = 0;
  const vector = await cache.getOrCompute('model-a', 'hello', () => {
    calls++;
    return [1, 2, 3];
  });
  assert.deepEqual(Array.from(vector), [1, 2, 3]);
  assert.equal(calls, 1);

  const again = await cache.getOrCompute('model-a', 'hello', () => {
    calls++;
    return [9, 9, 9];
  });
  assert.deepEqual(Array.from(again), [1, 2, 3]);
  assert.equal(calls, 1);
});

test('getOrCompute does not cache a rejected computation', async () => {
  const cache = new EmbedCache();
  await assert.rejects(
    cache.getOrCompute('model-a', 'hello', () => {
      throw new Error('boom');
    }),
  );
  const vector = await cache.getOrCompute('model-a', 'hello', () => [1, 2]);
  assert.deepEqual(Array.from(vector), [1, 2]);
});

test('concurrent getOrCompute calls for the same text share one computation', async () => {
  const cache = new EmbedCache();
  let calls = 0;
  const compute = async () => {
    calls++;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return [1, 2, 3];
  };
  const [a, b, c] = await Promise.all([
    cache.getOrCompute('model-a', 'hello', compute),
    cache.getOrCompute('model-a', 'hello', compute),
    cache.getOrCompute('model-a', 'hello', compute),
  ]);
  assert.equal(calls, 1);
  assert.deepEqual(Array.from(a), [1, 2, 3]);
  assert.deepEqual(Array.from(b), [1, 2, 3]);
  assert.deepEqual(Array.from(c), [1, 2, 3]);
});

test('different models for the same text are different cache entries', async () => {
  const cache = new EmbedCache();
  const a = await cache.getOrCompute('model-a', 'hello', () => [1]);
  const b = await cache.getOrCompute('model-b', 'hello', () => [2]);
  assert.deepEqual(Array.from(a), [1]);
  assert.deepEqual(Array.from(b), [2]);
});

test('a cache with no dir works purely in memory', async () => {
  const cache = new EmbedCache();
  await cache.set('model-a', 'hello', [1, 2]);
  assert.deepEqual(Array.from((await cache.get('model-a', 'hello'))!), [1, 2]);
});

test('a disk-backed cache reads a value back after being reconstructed', async () => {
  await withTempDir(async (dir) => {
    const first = new EmbedCache({ dir });
    await first.set('model-a', 'hello', [1, 2, 3]);

    const second = new EmbedCache({ dir });
    const vector = await second.get('model-a', 'hello');
    assert.deepEqual(Array.from(vector!), [1, 2, 3]);
    assert.equal(second.stats().diskHits, 1);
  });
});

test('a disk hit promotes the value into memory', async () => {
  await withTempDir(async (dir) => {
    const first = new EmbedCache({ dir });
    await first.set('model-a', 'hello', [1, 2, 3]);

    const second = new EmbedCache({ dir });
    await second.get('model-a', 'hello');
    assert.equal(second.stats().memoryHits, 0);
    await second.get('model-a', 'hello');
    assert.equal(second.stats().memoryHits, 1);
  });
});

test('a corrupt on-disk record is discarded and treated as a miss, not thrown', async () => {
  await withTempDir(async (dir) => {
    const cache = new EmbedCache({ dir });
    const key = embedKey('model-a', 'hello');
    const path = join(dir, ...keyToSegments(key));

    await cache.set('model-a', 'hello', [1, 2, 3]);
    const bytes = await readFile(path);
    bytes[bytes.length - 1] ^= 0xff; // flip a payload bit so the crc32 no longer matches
    await writeFile(path, bytes);

    const fresh = new EmbedCache({ dir });
    const vector = await fresh.get('model-a', 'hello');
    assert.equal(vector, undefined);
    assert.equal(fresh.stats().corrupt, 1);

    const recomputed = await fresh.getOrCompute('model-a', 'hello', () => [4, 5, 6]);
    assert.deepEqual(Array.from(recomputed), [4, 5, 6]);
  });
});

test('expectedDim rejects a vector of the wrong length', async () => {
  const cache = new EmbedCache({ expectedDim: 3 });
  await assert.rejects(cache.set('model-a', 'hello', [1, 2]), TypeError);
  await assert.rejects(
    cache.getOrCompute('model-a', 'hello', () => [1, 2]),
    TypeError,
  );
});

test('namespace changes the key for the same (model, text)', async () => {
  const a = new EmbedCache({ namespace: 'v1' });
  const b = new EmbedCache({ namespace: 'v2' });
  await a.set('model-a', 'hello', [1]);
  assert.equal(await b.get('model-a', 'hello'), undefined);
});

test('getOrComputeMany dedupes and only calls back with missing texts, in first-seen order', async () => {
  const cache = new EmbedCache();
  await cache.set('model-a', 'cached', [0, 0]);

  let seenTexts: string[] = [];
  const vectors = await cache.getOrComputeMany(
    'model-a',
    ['cached', 'new-b', 'new-a', 'new-b'],
    (missing) => {
      seenTexts = missing;
      return missing.map((_, i) => [i + 1, i + 1]);
    },
  );

  assert.deepEqual(seenTexts, ['new-b', 'new-a']);
  assert.deepEqual(Array.from(vectors[0]), [0, 0]);
  assert.deepEqual(Array.from(vectors[1]), [1, 1]);
  assert.deepEqual(Array.from(vectors[2]), [2, 2]);
  assert.deepEqual(Array.from(vectors[3]), [1, 1]);
});

test('getOrComputeMany does not call back at all when everything is cached', async () => {
  const cache = new EmbedCache();
  await cache.set('model-a', 'hello', [1]);
  let calls = 0;
  await cache.getOrComputeMany('model-a', ['hello', 'hello'], () => {
    calls++;
    return [];
  });
  assert.equal(calls, 0);
});

test('getOrComputeMany throws if computeBatch returns the wrong number of vectors', async () => {
  const cache = new EmbedCache();
  await assert.rejects(
    cache.getOrComputeMany('model-a', ['a', 'b'], () => [[1]]),
  );
});

test('delete removes a value from both tiers', async () => {
  await withTempDir(async (dir) => {
    const cache = new EmbedCache({ dir });
    await cache.set('model-a', 'hello', [1]);
    await cache.delete('model-a', 'hello');
    assert.equal(await cache.get('model-a', 'hello'), undefined);

    const fresh = new EmbedCache({ dir });
    assert.equal(await fresh.get('model-a', 'hello'), undefined);
  });
});

test('clearMemory drops the memory tier but leaves disk intact', async () => {
  await withTempDir(async (dir) => {
    const cache = new EmbedCache({ dir });
    await cache.set('model-a', 'hello', [1]);
    cache.clearMemory();
    assert.equal(cache.stats().entries, 0);
    assert.deepEqual(Array.from((await cache.get('model-a', 'hello'))!), [1]);
  });
});

test('clear drops both tiers', async () => {
  await withTempDir(async (dir) => {
    const cache = new EmbedCache({ dir });
    await cache.set('model-a', 'hello', [1]);
    await cache.clear();
    const fresh = new EmbedCache({ dir });
    assert.equal(await fresh.get('model-a', 'hello'), undefined);
  });
});

test('stats tracks hits, misses, computed and hit rate; resetStats zeroes them', async () => {
  const cache = new EmbedCache();
  await cache.get('model-a', 'miss'); // miss
  await cache.getOrCompute('model-a', 'hello', () => [1]); // miss + computed
  await cache.get('model-a', 'hello'); // memory hit

  const stats = cache.stats();
  assert.equal(stats.misses, 2);
  assert.equal(stats.computed, 1);
  assert.equal(stats.memoryHits, 1);
  assert.equal(stats.hitRate, 1 / 3);
  assert.equal(stats.entries, 1);
  assert.equal(stats.bytes, 4);

  cache.resetStats();
  assert.deepEqual(cache.stats(), {
    memoryHits: 0,
    diskHits: 0,
    misses: 0,
    computed: 0,
    corrupt: 0,
    diskWrites: 0,
    entries: 1,
    bytes: 4,
    hitRate: 0,
  });
});

test('maxBytes evicts from memory but a disk-backed value can still be read back', async () => {
  await withTempDir(async (dir) => {
    const cache = new EmbedCache({ dir, maxBytes: 4 }); // room for exactly one 1-float vector
    await cache.set('model-a', 'a', [1]);
    await cache.set('model-a', 'b', [2]); // evicts 'a' from memory, not from disk
    assert.equal(cache.stats().entries, 1);

    const vector = await cache.get('model-a', 'a');
    assert.deepEqual(Array.from(vector!), [1]);
    assert.equal(cache.stats().diskHits, 1);
  });
});
