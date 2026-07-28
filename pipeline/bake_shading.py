#!/usr/bin/env python3
"""Bake a shading-map albedo that reconstructs the original under tinting.

Problem: the white-background shading base (extract_textures --flatten
--background white) loses Photoshop OVERLAY highlight passes (Light /
Highlights), because overlay-over-white is the identity. Shaded areas then
render too dark once tinted (the "two-tone" dick complaint).

Fix: take the ORIGINAL full-color composite and divide out each region's
bright reference color (masks + a high percentile of the original pixels
inside the mask, written back into the manifest as the region default).
Result: shadeMap ~= original / regionColor, so the runtime mix(shadeMap,
shadeMap * color, mask) reproduces the original pixel — highlights,
gradients, and all — at any chosen color.

The divisor/default MUST be a bright percentile, not the flat PSD layer
color: ratio is clipped to 1.0 for PNG storage, and dividing by the flat
color would clip every highlight pixel brighter than it (this was the
"dark brown dick underside" bug).

Rules per pixel, in manifest stacking order (later region wins):
- covered by a region: shadeMap = clip(orig/regionRefColor, 0, 1) per
  channel; region defaultColor <- that reference color.
- covered by a region whose reference is near-black (all channels <= 32):
  white (color * white = color — exact for flat dark regions; default
  keeps the manifest's sampled flat color).
- covered by the emission mask: white (albedo stays neutral; the glow
  comes from the emissive map).
- uncovered: original pixel (lineart, shine, background detail).

Usage:
  pipeline/.venv/Scripts/python.exe pipeline/bake_shading.py \
      --psd "Synth Main Texture.psd" --packed <pack>/textures/packed \
      --spec pipeline/specs/<pack>/mask_packing.json \
      --manifest <pack>/manifest.json --out <pack>/textures/body_albedo.png \
      --colors-out pipeline/out/body_colors.json
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from psd_tools import PSDImage

BLACK_CHANNEL_THRESHOLD = 32
MASK_THRESHOLD = 128
CHANNEL_INDEX = {"r": 0, "g": 1, "b": 2, "a": 3}


def log(msg: str) -> None:
    print(f"[bake_shading] {msg}", flush=True)


def die(msg: str) -> "SystemExit":
    print(f"[bake_shading] ERROR: {msg}", file=sys.stderr, flush=True)
    return SystemExit(2)


def hex_to_rgb(hex_color: str) -> tuple[int, int, int]:
    body = hex_color.lstrip("#")
    if len(body) == 3:
        body = "".join(c * 2 for c in body)
    if len(body) != 6:
        raise die(f"bad hex color {hex_color!r}")
    return tuple(int(body[i : i + 2], 16) for i in (0, 2, 4))


class MaskSource:
    """Per-region grayscale masks resolved through the packing spec.

    Maps region id -> (packed png, channel) so the same packed data the app
    uses is the source of truth here.
    """

    def __init__(self, spec_path: Path, packed_dir: Path):
        spec = json.loads(spec_path.read_text(encoding="utf-8"))
        self.packed_dir = packed_dir
        self.region_to_pack: dict[str, tuple[str, int]] = {}
        for pack_name, channels in spec.items():
            for channel, region_id in channels.items():
                if region_id:
                    self.region_to_pack[region_id] = (pack_name, CHANNEL_INDEX[channel])
        self._cache: dict[str, np.ndarray] = {}

    def get(self, region_id: str) -> np.ndarray:
        if region_id not in self.region_to_pack:
            raise die(f"region {region_id!r} not found in packing spec")
        pack_name, channel_idx = self.region_to_pack[region_id]
        if pack_name not in self._cache:
            pack_path = self.packed_dir / f"{pack_name}.png"
            if not pack_path.is_file():
                raise die(f"packed mask not found: {pack_path}")
            self._cache[pack_name] = np.asarray(Image.open(pack_path))
        return self._cache[pack_name][..., channel_idx]


def flatten_psd(psd_path: Path) -> np.ndarray:
    """Full default-visibility composite of the PSD, opaque, float32 RGB 0..1."""
    psd = PSDImage.open(psd_path)
    image = psd.composite(force=True)
    if image is None:
        raise die("PSD composited to nothing")
    if image.mode == "RGBA":
        background = Image.new("RGBA", image.size, (0, 0, 0, 255))
        image = Image.alpha_composite(background, image)
    return np.asarray(image.convert("RGB"), dtype=np.float32) / 255.0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--psd", type=Path, required=True)
    parser.add_argument("--packed", type=Path, required=True,
                        help="directory with packed RGBA mask PNGs")
    parser.add_argument("--spec", type=Path, required=True,
                        help="mask_packing.json mapping packs to region ids")
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--only-material",
                        help="comma-separated logical material ids; only "
                        "regions whose material list intersects are baked "
                        "(use when the manifest mixes regions from several PSDs)")
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--colors-out", type=Path,
                        help="optional: write {regionId: \"#rrggbb\"} reference "
                        "colors used for the bake (new manifest defaults)")
    args = parser.parse_args()

    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    regions = manifest.get("colorRegions", [])
    emissive = manifest.get("emissiveRegions", [])
    if args.only_material:
        wanted = {s.strip() for s in args.only_material.split(",")}
        def region_materials(r):
            m = r.get("material", "")
            return set(m if isinstance(m, list) else [m])
        regions = [r for r in regions if region_materials(r) & wanted]
        emissive = [r for r in emissive if region_materials(r) & wanted]
    if not regions:
        raise die("manifest has no colorRegions (after filtering)")

    orig = flatten_psd(args.psd)
    h, w, _ = orig.shape
    masks = MaskSource(args.spec, args.packed)

    # Per-region divisor: the PSD flat color (hue truth, from the manifest
    # default) scaled by ONE luminance factor — the 99th percentile of
    # orig_lum/flat_lum inside the mask. Per-channel percentiles shift hue
    # (gray -> tan, the "pink arm" bug); a single scalar preserves the PSD
    # hue while letting highlights through the ratio clip.
    SCALE_PERCENTILE = 99

    covered = np.zeros((h, w), dtype=bool)
    region_masks = []
    for region in regions:
        m = masks.get(region["id"]) > MASK_THRESHOLD
        region_masks.append(m)
        covered |= m
    log(f"{len(regions)} regions mapped; {int(covered.sum())} px covered")

    fill = np.zeros((h, w, 3), dtype=np.float32)
    ref_hex: dict[str, str] = {}
    near_black_ids = set()
    for region, m in zip(regions, region_masks):
        flat = np.array(hex_to_rgb(region["defaultColor"]), dtype=np.float32) / 255.0
        if flat.max() <= BLACK_CHANNEL_THRESHOLD / 255.0:
            # near-black region: white shading, keep manifest default color
            near_black_ids.add(region["id"])
            ref = flat
            fill[m] = 1.0
        else:
            flat_lum = float(flat @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32))
            px = orig[m]
            if px.shape[0] < 50 or flat_lum < 1e-4:
                scale = 1.0
            else:
                px_lum = px @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
                scale = max(float(np.percentile(px_lum / flat_lum, SCALE_PERCENTILE)), 1.0)
            ref = np.clip(flat * scale, 0.0, 1.0)
            fill[m] = ref
        ref_hex[region["id"]] = "#{:02x}{:02x}{:02x}".format(
            *(int(round(c * 255)) for c in ref)
        )

    emission = np.zeros((h, w), dtype=bool)
    for region in emissive:
        emission |= masks.get(region["id"]) > MASK_THRESHOLD

    shade = orig.copy()
    # Near-black regions: white — color * white reconstructs the flat color.
    near_black = np.zeros((h, w), dtype=bool)
    for region, m in zip(regions, region_masks):
        if region["id"] in near_black_ids:
            near_black |= m
    shade[near_black] = 1.0
    # Colored regions: per-channel ratio (clipped; safe by percentile choice).
    divisible = covered & ~near_black
    ratio = np.ones((h, w, 3), dtype=np.float32)
    ratio = np.where(
        divisible[..., None],
        np.clip(orig / np.maximum(fill, 1e-6), 0.0, 1.0),
        ratio,
    )
    shade[divisible] = ratio[divisible]
    # Emission areas: neutral white.
    shade[emission] = 1.0

    out_img = Image.fromarray((shade * 255.0).round().astype(np.uint8), mode="RGB")
    args.out.parent.mkdir(parents=True, exist_ok=True)
    out_img.save(args.out, format="PNG")
    log(f"wrote {args.out} ({w}x{h})")

    if args.colors_out:
        args.colors_out.parent.mkdir(parents=True, exist_ok=True)
        args.colors_out.write_text(
            json.dumps(ref_hex, indent=2) + "\n", encoding="utf-8"
        )
        log(f"wrote {args.colors_out} ({len(ref_hex)} region colors)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
