import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { keyToSegments } from './key.ts';

/**
 * Sharded file store keyed by cache key, two hex-pair directories deep (see
 * README). Reads and writes deal in raw bytes -- it has no idea a vector is
 * float32 or that a header exists, that's the codec's job.
 */
export class DiskStore {
  readonly #dir: string;

  constructor(dir: string) {
    this.#dir = dir;
  }

  #pathFor(key: string): string {
    return join(this.#dir, ...keyToSegments(key));
  }

  /** Read the record for `key`, or undefined if there is none on disk. */
  async get(key: string): Promise<Buffer | undefined> {
    try {
      return await readFile(this.#pathFor(key));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err;
    }
  }

  /**
   * Write `data` for `key`. Writes to a temp file in the same shard
   * directory and renames it into place, so a crash or concurrent read never
   * observes a partially written file -- readers see either the old record
   * or the new one, never a truncated one.
   */
  async set(key: string, data: Uint8Array): Promise<void> {
    const target = this.#pathFor(key);
    const shard = dirname(target);
    await mkdir(shard, { recursive: true });

    const tmp = join(shard, `.tmp-${process.pid}-${randomBytes(6).toString('hex')}`);
    const handle = await open(tmp, 'w');
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(tmp, target);
    } catch (err) {
      await unlink(tmp).catch(() => {});
      throw err;
    }
  }

  /** Remove the record for `key`, if it exists. */
  async delete(key: string): Promise<void> {
    try {
      await unlink(this.#pathFor(key));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  /** Remove the entire store directory and everything under it. */
  async clear(): Promise<void> {
    await rm(this.#dir, { recursive: true, force: true });
  }
}
