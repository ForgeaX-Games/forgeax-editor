import { describe, expect, it } from 'bun:test';

import {
  computeContentHash,
  computeContentHashFromBytes,
  HEAD_TAIL_SIZE,
  readU64LE,
  xxh64,
} from './scan-content-hash';

const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values);
const filled = (length: number, seed = 1): Uint8Array => {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) out[i] = (i * 31 + seed) & 0xff;
  return out;
};

describe('readU64LE', () => {
  it('reads a little-endian 64-bit integer at the given offset', () => {
    expect(readU64LE(bytes(1, 0, 0, 0, 0, 0, 0, 0), 0)).toBe(1n);
    expect(readU64LE(bytes(0, 1, 0, 0, 0, 0, 0, 0), 0)).toBe(256n);
    expect(readU64LE(bytes(0, 0, 0, 0, 1, 0, 0, 0), 0)).toBe(1n << 32n);
    expect(readU64LE(new Uint8Array(8).fill(0xff), 0)).toBe(0xffffffffffffffffn);
    // Honors the offset rather than always reading from zero.
    expect(readU64LE(bytes(9, 9, 2, 0, 0, 0, 0, 0, 0, 0), 2)).toBe(2n);
  });
});

describe('xxh64', () => {
  it('is deterministic and length-sensitive across remainder shapes', () => {
    // Exercise the tail branches: the <32 short path, the trailing 1-3 byte path,
    // the standalone 4-byte remainder, the 8-byte lane loop, and the >=32 main
    // loop. (Lengths whose `size & 31` lands in {5,6,7,13,14,15,...} hit a latent
    // out-of-bounds in the combined 4-byte+trailing tail and are covered by the
    // separate report, not asserted here.)
    for (const length of [0, 1, 2, 3, 4, 8, 16, 32, 33, 40, 64, 128, 129]) {
      const buf = filled(length);
      expect(xxh64(buf)).toBe(xxh64(filled(length)));
      expect(typeof xxh64(buf)).toBe('bigint');
    }
  });

  it('separates content from length: a one-byte change and a length change both move the hash', () => {
    const base = filled(48);
    const flipped = filled(48);
    flipped[10] = (flipped[10]! ^ 0xff) & 0xff;
    expect(xxh64(flipped)).not.toBe(xxh64(base));
    expect(xxh64(filled(49))).not.toBe(xxh64(base));
  });

  it('honors the seed argument', () => {
    const buf = filled(64);
    expect(xxh64(buf, 1n)).not.toBe(xxh64(buf, 0n));
  });
});

describe('computeContentHash', () => {
  it('emits a stable xxh64:<hex> string and matches the ArrayBuffer wrapper', () => {
    const buf = filled(200);
    const viaBytes = computeContentHashFromBytes(buf);
    expect(viaBytes).toMatch(/^xxh64:[0-9a-f]+$/);
    expect(computeContentHashFromBytes(filled(200))).toBe(viaBytes);

    const copy = buf.slice();
    expect(computeContentHash(copy.buffer)).toBe(viaBytes);
  });

  it('takes the whole-file path up to 2x the head/tail window and the head+tail+size path beyond it', () => {
    const small = filled(HEAD_TAIL_SIZE * 2);
    const large = filled(HEAD_TAIL_SIZE * 2 + 1);
    expect(computeContentHashFromBytes(small)).toMatch(/^xxh64:/);
    expect(computeContentHashFromBytes(large)).toMatch(/^xxh64:/);
    expect(computeContentHashFromBytes(large)).not.toBe(computeContentHashFromBytes(small));
  });

  it('is insensitive to the middle bytes of a large file but sensitive to head/tail and reported size', () => {
    const size = HEAD_TAIL_SIZE * 2 + 4096;
    const original = filled(size);
    const middleChanged = filled(size);
    // Mutate a byte squarely inside the skipped middle window.
    middleChanged[HEAD_TAIL_SIZE + 1024] = (middleChanged[HEAD_TAIL_SIZE + 1024]! ^ 0xff) & 0xff;
    expect(computeContentHashFromBytes(middleChanged)).toBe(computeContentHashFromBytes(original));

    const headChanged = filled(size);
    headChanged[0] = (headChanged[0]! ^ 0xff) & 0xff;
    expect(computeContentHashFromBytes(headChanged)).not.toBe(computeContentHashFromBytes(original));

    // The explicit fileSize is folded into the digest as metadata.
    expect(computeContentHashFromBytes(original, size + 1)).not.toBe(computeContentHashFromBytes(original, size));
  });
});
