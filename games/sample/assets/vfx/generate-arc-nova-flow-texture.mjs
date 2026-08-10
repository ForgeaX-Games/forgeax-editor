import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const SIZE = 256;
const MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function u32(value) {
  return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];
}

function chunk(name, data) {
  const type = [...name].map((value) => value.charCodeAt(0));
  const body = new Uint8Array([...type, ...data]);
  return [...u32(data.length), ...body, ...u32(crc32(body))];
}

const raw = new Uint8Array(SIZE * (1 + SIZE * 4));
let offset = 0;
for (let y = 0; y < SIZE; y += 1) {
  raw[offset++] = 0;
  for (let x = 0; x < SIZE; x += 1) {
    const px = (x + 0.5) / SIZE * 2 - 1;
    const py = (y + 0.5) / SIZE * 2 - 1;
    const radius = Math.hypot(px, py);
    const angle = Math.atan2(py, px);
    const spiral = Math.abs(Math.sin(angle * 6 + radius * 31));
    const rune = Math.pow(Math.max(0, Math.cos(angle * 12 - radius * 18)), 12);
    const rings = Math.pow(Math.max(0, Math.cos(radius * 44)), 18);
    const envelope = Math.max(0, 1 - radius);
    const energy = Math.min(1, envelope * (spiral * 0.46 + rune * 0.82 + rings * 0.34));
    raw[offset++] = Math.round(22 + energy * 38);
    raw[offset++] = Math.round(70 + energy * 156);
    raw[offset++] = Math.round(128 + energy * 127);
    raw[offset++] = Math.round(energy * 255);
  }
}

const header = new Uint8Array([...u32(SIZE), ...u32(SIZE), 8, 6, 0, 0, 0]);
const pixels = new Uint8Array(deflateSync(raw));
const png = new Uint8Array([
  ...MAGIC,
  ...chunk('IHDR', header),
  ...chunk('IDAT', pixels),
  ...chunk('IEND', new Uint8Array()),
]);
const destination = resolve(dirname(fileURLToPath(import.meta.url)), 'arc-nova-flow.png');
writeFileSync(destination, png);
console.log(`[arc-nova] wrote ${destination} (${png.byteLength} bytes)`);
