import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toFloat32, encodeVector, decodeVector, VectorDecodeError } from '../src/codec.ts';

test('toFloat32 passes a Float32Array through unchanged', () => {
  const input = new Float32Array([1, -2.5, 0]);
  assert.strictEqual(toFloat32(input), input);
});

test('toFloat32 converts number[] and Float64Array', () => {
  assert.deepEqual(Array.from(toFloat32([1, 2, 3])), [1, 2, 3]);
  assert.deepEqual(Array.from(toFloat32(new Float64Array([1, 2, 3]))), [1, 2, 3]);
});

test('toFloat32 rejects non-finite values', () => {
  assert.throws(() => toFloat32([1, NaN, 3]), TypeError);
  assert.throws(() => toFloat32([1, Infinity, 3]), TypeError);
});

test('encode then decode round-trips exact float32 bits', () => {
  const values = [0, -0, 1, -1, 0.1, -123.456, 1e30, -1e-30, 3.4028235e38];
  const decoded = decodeVector(encodeVector(values));
  const expected = Float32Array.from(values);
  assert.deepEqual(Array.from(decoded), Array.from(expected));
});

test('encoded record size matches header + payload formula', () => {
  const dim = 1536;
  const record = encodeVector(new Array(dim).fill(0.5));
  assert.equal(record.length, 16 + dim * 4);
});

test('decode rejects a record that is too short', () => {
  assert.throws(() => decodeVector(Buffer.alloc(8)), VectorDecodeError);
});

test('decode rejects bad magic', () => {
  const record = encodeVector([1, 2, 3]);
  record.write('XXXX', 0, 'ascii');
  assert.throws(() => decodeVector(record), VectorDecodeError);
});

test('decode rejects an unsupported format version', () => {
  const record = encodeVector([1, 2, 3]);
  record.writeUInt8(99, 4);
  assert.throws(() => decodeVector(record), VectorDecodeError);
});

test('decode rejects a length that does not match the dim field', () => {
  const record = encodeVector([1, 2, 3]);
  const truncated = record.subarray(0, record.length - 4);
  assert.throws(() => decodeVector(truncated), VectorDecodeError);
});

test('decode rejects a payload that fails its checksum', () => {
  const record = encodeVector([1, 2, 3]);
  record.writeFloatLE(999, 16); // corrupt the first payload float in place
  assert.throws(() => decodeVector(record), VectorDecodeError);
});

test('decode handles a zero-length vector', () => {
  const decoded = decodeVector(encodeVector([]));
  assert.equal(decoded.length, 0);
});
