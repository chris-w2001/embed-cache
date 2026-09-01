// Runs entirely against a fake embedding provider -- no network, no API key --
// so `node examples/basic.ts` demonstrates the cache end to end on its own.
// See README.md for the expected output.

import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EmbedCache } from '../src/index.ts';

const DIM = 8;
const MODEL = 'fake-embedding-v1';

/**
 * Deterministic stand-in for a real embedding call: same text always maps to
 * the same vector, so the "identical" check below is meaningful, but there's
 * no actual model behind it.
 */
function fakeEmbedding(text: string): number[] {
  const digest = createHash('sha256').update(text).digest();
  return Array.from(digest.subarray(0, DIM), (byte) => (byte / 255) * 2 - 1);
}

async function main(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'embed-cache-example-'));
  try {
    let apiCalls = 0;
    const fakeProvider = (texts: string[]): number[][] => {
      apiCalls++;
      return texts.map(fakeEmbedding);
    };

    const docs = [
      'The quick brown fox jumps over the lazy dog.',
      'Embeddings are cached by the sha256 of (namespace, model, text).',
      'The quick brown fox jumps over the lazy dog.', // duplicate of docs[0]
      'A fourth, unique document.',
    ];

    const cache = new EmbedCache({ dir, expectedDim: DIM });

    const firstPass = await cache.getOrComputeMany(MODEL, docs, fakeProvider);
    console.log(
      `first pass:  ${firstPass.length} vectors, ${apiCalls} api call(s) for ${cache.stats().computed} text(s)`,
    );

    const secondPass = await cache.getOrComputeMany(MODEL, docs, fakeProvider);
    console.log(`second pass: ${secondPass.length} vectors, ${apiCalls} api call(s) total`);

    const identical = firstPass.every((vector, i) => vector.every((value, j) => value === secondPass[i][j]));
    console.log(`identical:   ${identical}`);

    // A fresh instance over the same directory has an empty in-memory tier,
    // so this get() can only be answered from disk.
    const restarted = new EmbedCache({ dir, expectedDim: DIM });
    const fromDisk = await restarted.get(MODEL, docs[0]);
    console.log(`after restart: dim ${fromDisk!.length}, stats ${JSON.stringify(restarted.stats())}`);

    const stats = cache.stats();
    console.log(
      `hit rate ${(stats.hitRate * 100).toFixed(1)}%  ` +
        `(memory ${stats.memoryHits}, disk ${stats.diskHits}, miss ${stats.misses}, computed ${stats.computed})  ` +
        `${stats.entries} entries / ${stats.bytes} bytes in memory`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

await main();
