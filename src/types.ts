/** Anything that can be turned into a Float32Array of embedding values. */
export type VectorInput = Float32Array | Float64Array | readonly number[];

export interface EmbedCacheOptions {
  /**
   * Directory for the on-disk tier. Leave it out (or pass null) for a purely
   * in-memory cache.
   */
  dir?: string | null;
  /** Max number of vectors kept in memory. Default: unlimited. */
  maxEntries?: number;
  /**
   * Max bytes of vector payload kept in memory. Default: unlimited.
   * One 1536-dim float32 vector is 6144 bytes, so 64 MB holds ~10900 of them.
   */
  maxBytes?: number;
  /**
   * Mixed into every key. Bump it to invalidate everything after changing how
   * you chunk or preprocess text.
   */
  namespace?: string;
  /** Reject vectors whose length is not this. Default: accept any length. */
  expectedDim?: number | null;
}

export interface CacheStats {
  /** Lookups served from the in-memory tier. */
  memoryHits: number;
  /** Lookups served from disk (and promoted into memory). */
  diskHits: number;
  misses: number;
  /** Vectors produced by a `getOrCompute` callback. */
  computed: number;
  /** On-disk entries that failed to decode and were discarded. */
  corrupt: number;
  /** Vectors written to disk. */
  diskWrites: number;
  /** Vectors currently held in memory. */
  entries: number;
  /** Bytes of vector payload currently held in memory. */
  bytes: number;
  /** (memoryHits + diskHits) / lookups, or 0 when nothing was looked up. */
  hitRate: number;
}

/** Produces embeddings for texts the cache did not have. */
export type ComputeOne = (text: string, model: string) => Promise<VectorInput> | VectorInput;
export type ComputeMany = (texts: string[], model: string) => Promise<VectorInput[]> | VectorInput[];
