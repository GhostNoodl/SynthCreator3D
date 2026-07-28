/**
 * Texture baking — the CPU/pixel twin of the tint shaders in viewer/pack.ts.
 *
 * Pure and DOM-free: everything operates on plain `{ width, height, data }`
 * RGBA structs (an ImageData-shaped interface), so the Node smoke test can
 * verify the compositing math exactly. The browser layer
 * (viewer/exportRuntime.ts) only moves pixels between canvases and these
 * functions.
 *
 * NOTE on color space: the GPU shader works in linear space after sRGB
 * decode; here we mix directly in 8-bit sRGB space (what the PNGs store).
 * Same formula, slightly different rounding — a deliberate, documented
 * approximation so exported textures line up 1:1 with the source PNG bytes.
 */

/** ImageData-like RGBA pixel buffer. */
export interface PixelImage {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel, row-major. */
  data: Uint8ClampedArray;
}

export interface ColorRegionPixels {
  mask: PixelImage;
  colorHex: string;
}

/** Channel offset ('r'|0, 'g'|1, 'b'|2, 'a'|3) within an RGBA pixel. */
const CHANNEL_OFFSET = { r: 0, g: 1, b: 2, a: 3 } as const;

/**
 * Extract one channel of an RGBA mask pack as a grayscale PixelImage (the
 * channel's value replicated across r/g/b, opaque alpha) — the CPU twin of
 * the shader's `texture2D(pack, uv).<channel>` swizzle. Returns a new image.
 */
export function extractChannel(
  pack: PixelImage,
  channel: keyof typeof CHANNEL_OFFSET,
): PixelImage {
  const offset = CHANNEL_OFFSET[channel];
  const out = new Uint8ClampedArray(pack.data.length);
  for (let i = 0; i < pack.data.length; i += 4) {
    const v = pack.data[i + offset];
    out[i] = v;
    out[i + 1] = v;
    out[i + 2] = v;
    out[i + 3] = 255;
  }
  return { width: pack.width, height: pack.height, data: out };
}

/** "#rrggbb" or "#rgb" -> [r, g, b] bytes. Throws on anything else. */
export function hexToRgb255(hex: string): [number, number, number] {
  const m = /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/.exec(hex);
  if (!m) throw new Error(`hexToRgb255: expected "#rrggbb" or "#rgb", got ${JSON.stringify(hex)}`);
  const body = m[1];
  if (body.length === 3) {
    return [
      parseInt(body[0] + body[0], 16),
      parseInt(body[1] + body[1], 16),
      parseInt(body[2] + body[2], 16),
    ];
  }
  return [parseInt(body.slice(0, 2), 16), parseInt(body.slice(2, 4), 16), parseInt(body.slice(4, 6), 16)];
}

/**
 * Mirror of the color-region GLSL in pack.ts:
 *   diffuse = mix(diffuse, diffuse * regionColor, mask.r)
 * applied per region, in order, so chained regions compose exactly like the
 * shader's sequential mixes. Returns a new image; `base` is not mutated.
 * Masks must match the base dimensions (the browser layer rescales).
 */
export function applyColorRegions(base: PixelImage, regions: ColorRegionPixels[]): PixelImage {
  const out = new Uint8ClampedArray(base.data);
  const { width, height } = base;
  for (const region of regions) {
    if (region.mask.width !== width || region.mask.height !== height) {
      throw new Error(
        `applyColorRegions: mask size ${region.mask.width}x${region.mask.height} does not match base ${width}x${height}`,
      );
    }
    const [cr, cg, cb] = hexToRgb255(region.colorHex);
    const data = region.mask.data;
    for (let i = 0; i < out.length; i += 4) {
      const m = data[i] / 255; // mask red channel, like texture2D(mask, uv).r
      if (m === 0) continue;
      out[i] = Math.round(out[i] + (out[i] * (cr / 255) - out[i]) * m);
      out[i + 1] = Math.round(out[i + 1] + (out[i + 1] * (cg / 255) - out[i + 1]) * m);
      out[i + 2] = Math.round(out[i + 2] + (out[i + 2] * (cb / 255) - out[i + 2]) * m);
      // alpha passes through untouched
    }
  }
  return { width, height, data: out };
}

/**
 * Emissive export for one region: `out.rgb = color * mask.r`, opaque alpha —
 * i.e. what the runtime gets from emissiveMap (mask) × emissive (color).
 */
export function buildEmissiveMap(mask: PixelImage, colorHex: string): PixelImage {
  const [cr, cg, cb] = hexToRgb255(colorHex);
  const out = new Uint8ClampedArray(mask.data.length);
  for (let i = 0; i < out.length; i += 4) {
    const m = mask.data[i] / 255;
    out[i] = Math.round(cr * m);
    out[i + 1] = Math.round(cg * m);
    out[i + 2] = Math.round(cb * m);
    out[i + 3] = 255;
  }
  return { width: mask.width, height: mask.height, data: out };
}
