import { crc32 } from 'node:zlib';
import type { VectorInput } from './types.ts';

/**
 * On-disk vector format (see README): a 16-byte header followed by the
 * payload, all little-endian regardless of host byte order.
 */
const MAGIC = Buffer.from('EMBC', 'ascii');
const FORMAT_VERSION = 1;
const DTYPE_FLOAT32 = 1;
const HEADER_BYTES = 16;

export class VectorDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VectorDecodeError';
  }
}

/**
 * Coerce any accepted vector shape into a Float32Array. Values are checked
 * for finiteness here because a NaN or Infinity would silently round-trip
 * through the float32 codec and corrupt whatever consumes the vector later.
 */
export function toFloat32(input: VectorInput): Float32Array {
  const out = input instanceof Float32Array ? input : Float32Array.from(input);
  for (let i = 0; i < out.length; i++) {
    if (!Number.isFinite(out[i])) {
      throw new TypeError(`vector element at index ${i} is not finite: ${out[i]}`);
    }
  }
  return out;
}

/** Encode a vector as the on-disk EMBC record described in the README. */
export function encodeVector(vector: VectorInput): Buffer {
  const f32 = toFloat32(vector);
  const dim = f32.length;
  const buf = Buffer.alloc(HEADER_BYTES + dim * 4);

  MAGIC.copy(buf, 0);
  buf.writeUInt8(FORMAT_VERSION, 4);
  buf.writeUInt8(DTYPE_FLOAT32, 5);
  buf.writeUInt16LE(0, 6); // reserved
  buf.writeUInt32LE(dim, 8);

  for (let i = 0; i < dim; i++) {
    buf.writeFloatLE(f32[i], HEADER_BYTES + i * 4);
  }

  const payloadCrc = crc32(buf.subarray(HEADER_BYTES)) >>> 0;
  buf.writeUInt32LE(payloadCrc, 12);

  return buf;
}

/**
 * Decode an EMBC record back into a Float32Array. Throws VectorDecodeError
 * on anything that doesn't check out -- callers reading from disk are
 * expected to catch this, delete the file, and recompute rather than throw
 * further, per the README's "never serve a corrupt vector" rule.
 */
export function decodeVector(data: Uint8Array): Float32Array {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength);

  if (buf.length < HEADER_BYTES) {
    throw new VectorDecodeError(`record too short: ${buf.length} bytes`);
  }
  if (!buf.subarray(0, 4).equals(MAGIC)) {
    throw new VectorDecodeError('bad magic');
  }
  const version = buf.readUInt8(4);
  if (version !== FORMAT_VERSION) {
    throw new VectorDecodeError(`unsupported format version: ${version}`);
  }
  const dtype = buf.readUInt8(5);
  if (dtype !== DTYPE_FLOAT32) {
    throw new VectorDecodeError(`unsupported dtype: ${dtype}`);
  }

  const dim = buf.readUInt32LE(8);
  const expectedLength = HEADER_BYTES + dim * 4;
  if (buf.length !== expectedLength) {
    throw new VectorDecodeError(`length mismatch: expected ${expectedLength} bytes for dim ${dim}, got ${buf.length}`);
  }

  const storedCrc = buf.readUInt32LE(12);
  const payload = buf.subarray(HEADER_BYTES);
  const actualCrc = crc32(payload) >>> 0;
  if (actualCrc !== storedCrc) {
    throw new VectorDecodeError(`crc32 mismatch: expected ${storedCrc}, got ${actualCrc}`);
  }

  const vector = new Float32Array(dim);
  for (let i = 0; i < dim; i++) {
    vector[i] = payload.readFloatLE(i * 4);
  }
  return vector;
}
