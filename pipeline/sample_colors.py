#!/usr/bin/env python3
"""Sample the representative color of named PSD layers -> palettes JSON.

For each layer name given, renders the layer and takes the median RGB over
pixels with alpha >= 128. Used to recover the Synth's default palette and the
"Alt 1/2/3" texture-set color schemes, which ship as built-in app presets
instead of baked albedo variants.

Usage:
  pipeline/.venv/Scripts/python.exe pipeline/sample_colors.py <input.psd> \
      --layers "Main Color" "Main Color Alt 1" ... --out palettes.json
"""

from __future__ import annotations

import argparse
import json
import sys

import numpy as np
from psd_tools import PSDImage


def sample_layer_color(layer, threshold: int = 128) -> str | None:
    """Median RGB of a layer's solid-coverage pixels as ``#rrggbb``."""
    # Alt-palette layers ship invisible; force-show (with ancestors) so they
    # render for sampling. See extract_textures.py for the same pattern.
    node = layer
    from psd_tools.api.layers import Layer
    while isinstance(node, Layer):
        node.visible = True
        node = node.parent
    image = layer.composite()
    if image is None:
        return None
    if image.mode != "RGBA":
        image = image.convert("RGBA")
    data = np.asarray(image, dtype=np.uint8)
    solid = data[data[..., 3] >= threshold]
    if solid.size == 0:
        return None
    median = np.median(solid[..., :3], axis=0).astype(int)
    return "#{:02x}{:02x}{:02x}".format(*median)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("psd")
    parser.add_argument("--layers", nargs="+", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    psd = PSDImage.open(args.psd)
    index: dict[str, list] = {}
    for layer in psd.descendants():
        index.setdefault(layer.name, []).append(layer)

    result: dict[str, str | None] = {}
    for name in args.layers:
        layers = index.get(name)
        if not layers:
            print(f"WARNING: layer {name!r} not found", file=sys.stderr)
            result[name] = None
            continue
        color = sample_layer_color(layers[0])
        if len(layers) > 1:
            print(f"WARNING: {name!r} matches {len(layers)} layers; used first",
                  file=sys.stderr)
        result[name] = color
        print(f"{name}: {color}")

    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(result, fh, indent=2)
        fh.write("\n")
    print(f"wrote {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
