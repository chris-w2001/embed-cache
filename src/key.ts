import { createHash } from 'node:crypto';

/**
 * Bumping this invalidates every key without touching callers, which is what
 * you want if the key derivation itself ever changes.
 */
export const KEY_VERSION = 'v1';

/**
 * Fields are length-prefixed before hashing. A plain separator would let
 * ("a", "b|c") and ("a|b", "c") collide; a length prefix cannot.
 */
function framed(value: string): string {
  return `${value.length}:${value}`;
}

const KEY_RE = /^[0-9a-f]{64}$/;

/**
 * Derive the cache key for one (namespace, model, text) triple.
 *
 * The text is hashed verbatim: whitespace and casing change the embedding, so
 * they must change the key. Normalise before calling if you want otherwise.
 */
export function embedKey(model: string, text: string, namespace = ''): string {
  if (typeof model !== 'string' || model.length === 0) {
    throw new TypeError('model must be a non-empty string');
  }
  if (typeof text !== 'string') {
    throw new TypeError(`text must be a string, got ${typeof text}`);
  }
  if (typeof namespace !== 'string') {
    throw new TypeError(`namespace must be a string, got ${typeof namespace}`);
  }
  return createHash('sha256')
    .update(`${KEY_VERSION}${framed(namespace)}${framed(model)}${framed(text)}`, 'utf8')
    .digest('hex');
}

export function isCacheKey(value: string): boolean {
  return KEY_RE.test(value);
}

export function assertCacheKey(value: string): void {
  if (!isCacheKey(value)) throw new TypeError(`not a cache key: ${JSON.stringify(value)}`);
}

/**
 * Relative path for a key, as POSIX segments.
 *
 * Two levels of two hex characters keep any single directory under ~256
 * children, which matters once a cache holds a few hundred thousand vectors.
 */
export function keyToSegments(key: string): string[] {
  assertCacheKey(key);
  return [key.slice(0, 2), key.slice(2, 4), `${key.slice(4)}.vec`];
}
