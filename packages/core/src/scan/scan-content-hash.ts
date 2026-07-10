// scan/scan-content-hash.ts — xxHash64-based content hash for L2 false-positive guard.
//
// Implements xxHash64 (XXH64) in pure JavaScript with typed arrays for performance.
// The hash strategy is: xxHash64 of (first 64KB + last 64KB + fileSize as 8-byte LE).
// For files < 128KB, hashes the entire file content. This gives us fast, reliable
// change detection without reading the whole file for large assets.
//
// Anchors:
//   todo: 2026-07-09 startup-asset-scan-auto-import G1

// ── xxHash64 constants ─────────────────────────────────────────────────────────

const PRIME64_1 = 11400714785074694791n;
const PRIME64_2 = 14029467366897019727n;
const PRIME64_3 = 1609587929392839161n;
const PRIME64_4 = 9650029242287828579n;
const PRIME64_5 = 2870177450012600261n;

const HEAD_TAIL_SIZE = 64 * 1024; // 64KB

// ── xxHash64 core ──────────────────────────────────────────────────────────────

function xxh64Round(acc: bigint, lane: bigint): bigint {
  acc += lane * PRIME64_2;
  acc = (acc << 31n) | (acc >> 33n); // rotl 31
  acc *= PRIME64_1;
  return acc;
}

function xxh64Merge(acc: bigint, input: bigint): bigint {
  acc ^= xxh64Round(0n, input);
  acc = acc * PRIME64_1 + PRIME64_4;
  return acc;
}

/** Read a 64-bit little-endian integer from a Uint8Array at offset. */
function readU64LE(buf: Uint8Array, offset: number): bigint {
  const lo = buf[offset]! | (buf[offset + 1]! << 8) | (buf[offset + 2]! << 16) | (buf[offset + 3]! << 24);
  const hi = buf[offset + 4]! | (buf[offset + 5]! << 8) | (buf[offset + 6]! << 16) | (buf[offset + 7]! << 24);
  return BigInt(lo >>> 0) | (BigInt(hi >>> 0) << 32n);
}

/** Compute xxHash64 of a buffer (small files / head-tail slices). */
function xxh64(buf: Uint8Array, seed = 0n): bigint {
  const len = buf.length;
  let h: bigint;

  if (len >= 32) {
    // 4-lane accumulator
    let v1 = seed + PRIME64_1 + PRIME64_2;
    let v2 = seed + PRIME64_2;
    let v3 = seed;
    let v4 = seed - PRIME64_1;

    const limit = len - 32;
    let p = 0;
    for (; p <= limit; p += 32) {
      v1 = xxh64Round(v1, readU64LE(buf, p));
      v2 = xxh64Round(v2, readU64LE(buf, p + 8));
      v3 = xxh64Round(v3, readU64LE(buf, p + 16));
      v4 = xxh64Round(v4, readU64LE(buf, p + 24));
    }

    h = ((v1 << 1n) | (v1 >> 63n))  // rotl 1
      + ((v2 << 7n) | (v2 >> 57n))  // rotl 7
      + ((v3 << 12n) | (v3 >> 52n)) // rotl 12
      + ((v4 << 18n) | (v4 >> 46n)); // rotl 18

    h = xxh64Merge(h, v1);
    h = xxh64Merge(h, v2);
    h = xxh64Merge(h, v3);
    h = xxh64Merge(h, v4);
  } else {
    h = seed + PRIME64_5;
  }

  h += BigInt(len);

  // Process remaining bytes (0-31)
  let p = (len & ~31); // round down to 32
  const limit = len & 31;
  for (let i = 0; i + 8 <= limit; i += 8) {
    let k1 = readU64LE(buf, p + i);
    k1 *= PRIME64_2;
    k1 = (k1 << 31n) | (k1 >> 33n);
    k1 *= PRIME64_1;
    h ^= k1;
    h = ((h << 27n) | (h >> 37n)) * PRIME64_1 + PRIME64_4;
  }
  // 4-byte remainder
  if ((limit & 4) !== 0) {
    h ^= BigInt(
      buf[p + (limit & ~7)]! |
      (buf[p + (limit & ~7) + 1]! << 8) |
      (buf[p + (limit & ~7) + 2]! << 16) |
      (buf[p + (limit & ~7) + 3]! << 24)
    ) & 0xFFFFFFFFn;
    h = ((h << 23n) | (h >> 41n)) * PRIME64_2 + PRIME64_3;
    p += 4;
  }
  // Remaining 1-3 bytes
  const remainingStart = (limit & ~3);
  for (let i = remainingStart; i < limit; i++) {
    h ^= BigInt(buf[p + i]!) << BigInt((i - remainingStart) * 8);
  }
  if (remainingStart < limit) {
    h = ((h << 11n) | (h >> 53n)) * PRIME64_1;
  }

  // Final avalanche
  h ^= h >> 33n;
  h *= PRIME64_2;
  h ^= h >> 29n;
  h *= PRIME64_3;
  h ^= h >> 32n;

  return h;
}

// ── Re-export for testing ─────────────────────────────────────────────────────

export { xxh64, HEAD_TAIL_SIZE, readU64LE };

// ── Content hash strategy: xxHash64(head 64KB + tail 64KB + fileSize as 8-byte LE) ──

/**
 * Compute a content-based hash string for a file buffer using xxHash64.
 * For files < 128KB, hashes entire content. For larger files, hashes
 * head 64KB + tail 64KB + file size (as 8-byte LE metadata).
 *
 * Returns "xxh64:<hex>" format string.
 */
export function computeContentHashFromBytes(bytes: Uint8Array, fileSize?: number): string {
  const size = fileSize ?? bytes.byteLength;
  let hashBuf: Uint8Array;

  if (size <= HEAD_TAIL_SIZE * 2) {
    // Small file: hash the whole thing
    hashBuf = bytes;
  } else {
    // Large file: head 64KB + tail 64KB + size metadata
    const head = bytes.subarray(0, HEAD_TAIL_SIZE);
    const tail = bytes.subarray(size - HEAD_TAIL_SIZE, size);
    hashBuf = new Uint8Array(HEAD_TAIL_SIZE * 2 + 8);
    hashBuf.set(head, 0);
    hashBuf.set(tail, HEAD_TAIL_SIZE);
    // Append fileSize as 8-byte LE
    const sizeView = new DataView(hashBuf.buffer, HEAD_TAIL_SIZE * 2, 8);
    sizeView.setBigUint64(0, BigInt(size), true);
  }

  const hash = xxh64(hashBuf);
  return `xxh64:${hash.toString(16).padStart(16, '0')}`;
}

/**
 * Compute content hash from an ArrayBuffer (convenience wrapper).
 */
export function computeContentHash(buf: ArrayBuffer): string {
  return computeContentHashFromBytes(new Uint8Array(buf));
}
