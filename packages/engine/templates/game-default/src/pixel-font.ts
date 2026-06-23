// Procedural 5x7 bitmap font -> engine FontAsset (asset-free, self-contained).
//
// The engine's world-space text (GlyphText) renders through the MSDF shader
// (packages/shader/src/msdf-text.wgsl): `sd = median(rgb)`,
// `opacity = clamp((sd - 0.5) * screenPxRange + 0.5, 0, 1)`. A PLAIN
// white-on-transparent bitmap atlas (all RGB channels equal: 1 inside the
// glyph, 0 outside) renders readably through it -- inside -> opaque, outside ->
// transparent, with an fwidth()-based AA edge. So no true-MSDF generation is
// needed; a hand-authored bitmap is enough for short labels / scores.
//
// We register the atlas TextureAsset + a SamplerAsset + the FontAsset and
// return the FontAsset handle for GlyphText.fontHandle.

import type { AssetRegistry } from '@forgeax/engine-runtime';
import type { FontAsset, GlyphMetric, Handle } from '@forgeax/engine-types';

// ── 5x7 bitmap glyphs ('#' = ink, anything else = empty). Each glyph is
//    exactly 7 rows of 5 columns. ──────────────────────────────────────────
const GLYPHS: Record<string, readonly string[]> = {
  '0': ['.###.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '.###.'],
  '1': ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  '2': ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
  '3': ['#####', '...#.', '..#..', '...#.', '....#', '#...#', '.###.'],
  '4': ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
  '5': ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
  '6': ['..##.', '.#...', '#....', '####.', '#...#', '#...#', '.###.'],
  '7': ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
  '8': ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
  '9': ['.###.', '#...#', '#...#', '.####', '....#', '...#.', '.##..'],
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  B: ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
  C: ['.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.'],
  D: ['###..', '#..#.', '#...#', '#...#', '#...#', '#..#.', '###..'],
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  F: ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
  G: ['.###.', '#...#', '#....', '#.###', '#...#', '#...#', '.###.'],
  H: ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  I: ['.###.', '..#..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  J: ['..###', '...#.', '...#.', '...#.', '#..#.', '#..#.', '.##..'],
  K: ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
  L: ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
  M: ['#...#', '##.##', '#.#.#', '#.#.#', '#...#', '#...#', '#...#'],
  N: ['#...#', '#...#', '##..#', '#.#.#', '#..##', '#...#', '#...#'],
  O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  Q: ['.###.', '#...#', '#...#', '#...#', '#.#.#', '#..#.', '.##.#'],
  R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  S: ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  U: ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  V: ['#...#', '#...#', '#...#', '#...#', '#...#', '.#.#.', '..#..'],
  W: ['#...#', '#...#', '#...#', '#.#.#', '#.#.#', '##.##', '#...#'],
  X: ['#...#', '#...#', '.#.#.', '..#..', '.#.#.', '#...#', '#...#'],
  Y: ['#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..'],
  Z: ['#####', '....#', '...#.', '..#..', '.#...', '#....', '#####'],
  ':': ['.....', '..#..', '.....', '.....', '.....', '..#..', '.....'],
  '+': ['.....', '..#..', '..#..', '#####', '..#..', '..#..', '.....'],
  '-': ['.....', '.....', '.....', '#####', '.....', '.....', '.....'],
};

const GW = 5; // glyph width (px)
const GH = 7; // glyph height (px)
const CELL = 8; // atlas cell stride (px) — glyph drawn top-left, 1px+ pad
const COLS = 16; // glyphs per atlas row

/**
 * Build the bitmap atlas + glyph metrics and register a FontAsset.
 * Returns its handle for GlyphText.fontHandle. Charset: 0-9 A-Z space : + -
 */
export function registerPixelFont(assets: AssetRegistry): Handle<'FontAsset', 'unmanaged'> {
  const chars = Object.keys(GLYPHS);
  const rows = Math.ceil(chars.length / COLS);
  const atlasWidth = COLS * CELL;
  const atlasHeight = rows * CELL;
  const data = new Uint8Array(atlasWidth * atlasHeight * 4); // rgba8, zero = transparent black

  const glyphs: Record<number, GlyphMetric> = {};
  chars.forEach((ch, i) => {
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    const ox = col * CELL;
    const oy = row * CELL;
    const rowsBits = GLYPHS[ch]!;
    for (let gy = 0; gy < GH; gy++) {
      const line = rowsBits[gy] ?? '';
      for (let gx = 0; gx < GW; gx++) {
        if (line[gx] === '#') {
          const px = ox + gx;
          const py = oy + gy;
          const o = (py * atlasWidth + px) * 4;
          data[o] = 255; data[o + 1] = 255; data[o + 2] = 255; data[o + 3] = 255;
        }
      }
    }
    glyphs[ch.codePointAt(0) as number] = {
      advance: GW + 1,
      bearingX: 0,
      bearingY: GH,
      size: { w: GW, h: GH },
      region: { x: ox, y: oy, w: GW, h: GH },
    };
  });

  // Space: no atlas cell, advances the cursor only.
  glyphs[32] = { advance: 4, bearingX: 0, bearingY: 0, size: { w: 0, h: 0 }, region: { x: 0, y: 0, w: 0, h: 0 } };

  const atlas = assets
    .register({
      kind: 'texture',
      width: atlasWidth,
      height: atlasHeight,
      format: 'rgba8unorm',
      data,
      colorSpace: 'linear',
      mipmap: false,
    })
    .unwrap();

  const sampler = assets
    .register({
      kind: 'sampler',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
      addressModeW: 'clamp-to-edge',
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'nearest',
    })
    .unwrap();

  const font: FontAsset = {
    kind: 'font',
    atlas: atlas as unknown as Handle<'TextureAsset', 'managed'>,
    sampler: sampler as unknown as Handle<'SamplerAsset', 'managed'>,
    glyphs,
    common: {
      lineHeight: GH + 2,
      base: GH,
      distanceRange: 2,
      pxRange: 2,
      atlasWidth,
      atlasHeight,
    },
  };
  return assets.register(font).unwrap() as Handle<'FontAsset', 'unmanaged'>;
}
