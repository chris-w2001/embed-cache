import { DiskStore } from './disk-store.ts';
import { decodeVector, encodeVector, toFloat32, VectorDecodeError } from './codec.ts';
import { embedKey } from './key.ts';
import { Lru } from './lru.ts';
import type { CacheStats, ComputeMany, ComputeOne, EmbedCacheOptions, VectorInput } from './types.ts';

/**
 * In-memory LRU in front of an optional on-disk tier, keyed by the SHA-256 of
 * (namespace, model, text). See README for the on-disk format and the
 * rationale for hashing rather than using the text itself as a key.
 */
export class EmbedCache {
  readonly #memory: Lru<string, Float32Array>;
  readonly #disk: DiskStore | undefined;
  readonly #namespace: string;
  readonly #expectedDim: number | null;
  // Keyed by cache key, not text, so getOrCompute calls for the same
  // (model, text) from concurrent callers await the same computation.
  readonly #pending = new Map<string, Promise<Float32Array>>();

  #memoryHits = 0;
  #diskHits = 0;
  #misses = 0;
  #computed = 0;
  #corrupt = 0;
  #diskWrites = 0;

  constructor(options: EmbedCacheOptions = {}) {
    this.#memory = new Lru<string, Float32Array>(
      { maxEntries: options.maxEntries, maxBytes: options.maxBytes },
      (v) => v.byteLength,
    );
    this.#disk = options.dir != null ? new DiskStore(options.dir) : undefined;
    this.#namespace = options.namespace ?? '';
    this.#expectedDim = options.expectedDim ?? null;
  }

  /** Cached vector for (model, text), or undefined if it isn't cached. */
  async get(model: string, text: string): Promise<Float32Array | undefined> {
    return this.#lookup(embedKey(model, text, this.#namespace));
  }

  /** Store a vector for (model, text) in both tiers. */
  async set(model: string, text: string, vector: VectorInput): Promise<void> {
    await this.#store(embedKey(model, text, this.#namespace), this.#validate(vector));
  }

  /** Remove any cached vector for (model, text) from both tiers. */
  async delete(model: string, text: string): Promise<void> {
    const key = embedKey(model, text, this.#namespace);
    this.#memory.delete(key);
    if (this.#disk) await this.#disk.delete(key);
  }

  /**
   * Return the cached vector for (model, text), computing and storing it via
   * `compute` on a miss. A rejected `compute` is not cached, so the next call
   * tries again. Concurrent calls for the same (model, text) share one
   * in-flight computation rather than each calling `compute` themselves.
   */
  async getOrCompute(model: string, text: string, compute: ComputeOne): Promise<Float32Array> {
    const key = embedKey(model, text, this.#namespace);
    const cached = await this.#lookup(key);
    if (cached !== undefined) return cached;

    const pending = this.#pending.get(key);
    if (pending !== undefined) return pending;

    const promise = (async () => {
      try {
        const vector = this.#validate(await compute(text, model));
        this.#computed++;
        await this.#store(key, vector);
        return vector;
      } finally {
        this.#pending.delete(key);
      }
    })();
    this.#pending.set(key, promise);
    return promise;
  }

  /**
   * Batch form of `getOrCompute`. Looks every text up first, then calls
   * `computeBatch` once with only the texts that were missing -- deduplicated
   * and in first-seen order -- and returns a result array lining up
   * positionally with `texts`.
   */
  async getOrComputeMany(
    model: string,
    texts: readonly string[],
    computeBatch: ComputeMany,
  ): Promise<Float32Array[]> {
    const keys = texts.map((text) => embedKey(model, text, this.#namespace));
    const results = new Array<Float32Array | undefined>(texts.length);

    const missingTexts: string[] = [];
    const missingKeys: string[] = [];
    const seen = new Set<string>();

    for (let i = 0; i < texts.length; i++) {
      const cached = await this.#lookup(keys[i]);
      if (cached !== undefined) {
        results[i] = cached;
      } else if (!seen.has(keys[i])) {
        seen.add(keys[i]);
        missingTexts.push(texts[i]);
        missingKeys.push(keys[i]);
      }
    }

    if (missingTexts.length > 0) {
      const computedVectors = await computeBatch(missingTexts, model);
      if (computedVectors.length !== missingTexts.length) {
        throw new Error(
          `computeBatch returned ${computedVectors.length} vectors for ${missingTexts.length} texts`,
        );
      }

      const byKey = new Map<string, Float32Array>();
      for (let i = 0; i < missingKeys.length; i++) {
        const vector = this.#validate(computedVectors[i]);
        this.#computed++;
        await this.#store(missingKeys[i], vector);
        byKey.set(missingKeys[i], vector);
      }
      for (let i = 0; i < texts.length; i++) {
        if (results[i] === undefined) results[i] = byKey.get(keys[i]);
      }
    }

    return results as Float32Array[];
  }

  stats(): CacheStats {
    const lookups = this.#memoryHits + this.#diskHits + this.#misses;
    return {
      memoryHits: this.#memoryHits,
      diskHits: this.#diskHits,
      misses: this.#misses,
      computed: this.#computed,
      corrupt: this.#corrupt,
      diskWrites: this.#diskWrites,
      entries: this.#memory.size,
      bytes: this.#memory.bytes,
      hitRate: lookups === 0 ? 0 : (this.#memoryHits + this.#diskHits) / lookups,
    };
  }

  resetStats(): void {
    this.#memoryHits = 0;
    this.#diskHits = 0;
    this.#misses = 0;
    this.#computed = 0;
    this.#corrupt = 0;
    this.#diskWrites = 0;
  }

  /** Drop the in-memory tier only; the on-disk tier, if any, is untouched. */
  clearMemory(): void {
    this.#memory.clear();
  }

  /** Drop both tiers. */
  async clear(): Promise<void> {
    this.#memory.clear();
    if (this.#disk) await this.#disk.clear();
  }

  #validate(vector: VectorInput): Float32Array {
    const f32 = toFloat32(vector);
    if (this.#expectedDim != null && f32.length !== this.#expectedDim) {
      throw new TypeError(`expected a ${this.#expectedDim}-dimensional vector, got ${f32.length}`);
    }
    return f32;
  }

  async #lookup(key: string): Promise<Float32Array | undefined> {
    const inMemory = this.#memory.get(key);
    if (inMemory !== undefined) {
      this.#memoryHits++;
      return inMemory;
    }

    if (this.#disk) {
      const raw = await this.#disk.get(key);
      if (raw !== undefined) {
        try {
          const vector = decodeVector(raw);
          this.#diskHits++;
          this.#memory.set(key, vector);
          return vector;
        } catch (err) {
          if (!(err instanceof VectorDecodeError)) throw err;
          // Per the README, a corrupt record is discarded and recomputed
          // rather than served or thrown -- treat it as a plain miss.
          this.#corrupt++;
          await this.#disk.delete(key);
        }
      }
    }

    this.#misses++;
    return undefined;
  }

  async #store(key: string, vector: Float32Array): Promise<void> {
    this.#memory.set(key, vector);
    if (this.#disk) {
      await this.#disk.set(key, encodeVector(vector));
      this.#diskWrites++;
    }
  }
}
