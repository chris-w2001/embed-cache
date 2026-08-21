export interface LruOptions {
  /** Max number of entries. Default: unlimited. */
  maxEntries?: number;
  /** Max total size, in whatever unit `sizeOf` returns. Default: unlimited. */
  maxBytes?: number;
}

export type SizeOf<V> = (value: V) => number;

interface Entry<V> {
  value: V;
  size: number;
}

/**
 * A least-recently-used cache that evicts by total size rather than just
 * entry count, so a handful of large values and a pile of small ones are
 * weighed the same way. Size defaults to 1 per entry, which makes an
 * unconfigured Lru behave like a plain count-based one.
 *
 * Backed by a Map, whose keys iterate in insertion order -- re-inserting a
 * key on access is enough to keep that order equal to recency order, with no
 * separate linked list to maintain.
 */
export class Lru<K, V> {
  readonly #entries = new Map<K, Entry<V>>();
  readonly #maxEntries: number;
  readonly #maxBytes: number;
  readonly #sizeOf: SizeOf<V>;
  #bytes = 0;

  constructor(options: LruOptions = {}, sizeOf: SizeOf<V> = () => 1) {
    this.#maxEntries = options.maxEntries ?? Infinity;
    this.#maxBytes = options.maxBytes ?? Infinity;
    this.#sizeOf = sizeOf;
  }

  /** Number of entries currently held. */
  get size(): number {
    return this.#entries.size;
  }

  /** Sum of `sizeOf(value)` over every entry currently held. */
  get bytes(): number {
    return this.#bytes;
  }

  has(key: K): boolean {
    return this.#entries.has(key);
  }

  /** Look up a value without affecting recency. */
  peek(key: K): V | undefined {
    return this.#entries.get(key)?.value;
  }

  /** Look up a value, marking it as most recently used. */
  get(key: K): V | undefined {
    const entry = this.#entries.get(key);
    if (entry === undefined) return undefined;
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry.value;
  }

  /**
   * Insert or replace a value, marking it as most recently used, then evict
   * from the least-recently-used end until back within limits. A value whose
   * own size exceeds `maxBytes` will end up evicted immediately -- it is
   * simply too big to retain, not an error.
   */
  set(key: K, value: V): void {
    const size = this.#sizeOf(value);
    const existing = this.#entries.get(key);
    if (existing !== undefined) {
      this.#bytes -= existing.size;
      this.#entries.delete(key);
    }
    this.#entries.set(key, { value, size });
    this.#bytes += size;
    this.#evict();
  }

  delete(key: K): boolean {
    const entry = this.#entries.get(key);
    if (entry === undefined) return false;
    this.#entries.delete(key);
    this.#bytes -= entry.size;
    return true;
  }

  clear(): void {
    this.#entries.clear();
    this.#bytes = 0;
  }

  /** Keys in least-recently-used to most-recently-used order. */
  keys(): IterableIterator<K> {
    return this.#entries.keys();
  }

  #evict(): void {
    for (const [key, entry] of this.#entries) {
      if (this.#entries.size <= this.#maxEntries && this.#bytes <= this.#maxBytes) break;
      this.#entries.delete(key);
      this.#bytes -= entry.size;
    }
  }
}
