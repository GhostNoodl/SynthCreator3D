#!/usr/bin/env python3
"""Pack grayscale region masks into RGBA textures (4 regions per texture).

WebGL guarantees only 16 fragment-shader texture units; one sampler per
recolor region blows past that on the real model (15 body regions). Packing
four masks into the R/G/B/A channels of one texture keeps the shader at one
sampler per four regions — the standard configurator approach.

Usage:
  pipeline/.venv/Scripts/python.exe pipeline/pack_masks.py <masks_dir> \
      --spec packing.json --out <dir> [--dilate 9]

Packing spec:

```json
{
  "body_pack0": { "r": "under_belly", "g": "secondary", "b": "main", "a": "shoulder" },
  "body_pack1": { "r": "inner_visor", "g": "visor", "b": "claws", "a": null }
}
```

Keys become `<out>/<name>.png`; channel values are mask file base names in
<masks_dir> (null channel = zero). All masks must share dimensions.
`--dilate N` grows every mask with a MaxFilter of size N before packing —
tint reaches a few px past the mask edge, so interpolated fragments and mip
levels at UV-island borders don't sample the untinted gutter/outline in the
albedo (dark seams on the model). Use 7-9 at 4096px.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

CHANNELS = ("r", "g", "b", "a")


def log(msg: str) -> None:
    print(f"[pack_masks] {msg}", flush=True)


def die(msg: str) -> "SystemExit":
    print(f"[pack_masks] ERROR: {msg}", file=sys.stderr, flush=True)
    return SystemExit(2)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("masks_dir", type=Path)
    parser.add_argument("--spec", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--dilate", type=int, default=0, metavar="N",
                        help="MaxFilter kernel size (odd) to dilate masks "
                        "before packing; 0 = off")
    args = parser.parse_args()
    if args.dilate and args.dilate % 2 == 0:
        raise die("--dilate kernel size must be odd")

    try:
        spec = json.loads(args.spec.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise die(f"cannot read packing spec {args.spec}: {exc}")
    if not isinstance(spec, dict) or not spec:
        raise die("packing spec must be a non-empty JSON object")
    for out_name, channels in spec.items():
        if not isinstance(channels, dict) or any(
            c not in CHANNELS for c in channels
        ):
            raise die(
                f"pack {out_name!r}: channels must be an object with keys "
                f"subset of {CHANNELS}; got {channels!r}"
            )
        if not any(channels.get(c) for c in CHANNELS):
            raise die(f"pack {out_name!r}: all channels are null — pointless pack")

    args.out.mkdir(parents=True, exist_ok=True)
    expected_size: tuple[int, int] | None = None

    for out_name, channels in spec.items():
        planes: dict[str, np.ndarray] = {}
        for channel in CHANNELS:
            mask_name = channels.get(channel)
            if mask_name is None:
                planes[channel] = None  # filled with zeros once size is known
                continue
            png = args.masks_dir / f"{mask_name}.png"
            if not png.is_file():
                raise die(f"pack {out_name!r}: mask not found: {png}")
            arr = np.asarray(Image.open(png).convert("L"), dtype=np.uint8)
            if args.dilate:
                # grayscale dilation: tint reaches past the mask edge so UV
                # borders don't sample the untinted albedo gutter
                arr = np.asarray(
                    Image.fromarray(arr, mode="L").filter(
                        ImageFilter.MaxFilter(args.dilate)
                    ),
                    dtype=np.uint8,
                )
            if expected_size is None:
                expected_size = (arr.shape[1], arr.shape[0])
            elif (arr.shape[1], arr.shape[0]) != expected_size:
                raise die(
                    f"pack {out_name!r}: mask {png.name} is "
                    f"{arr.shape[1]}x{arr.shape[0]}, expected {expected_size}"
                )
            planes[channel] = arr

        if expected_size is None:
            raise die(f"pack {out_name!r}: no channels to pack")
        w, h = expected_size
        rgba = np.stack(
            [planes[c] if planes[c] is not None else np.zeros((h, w), np.uint8)
             for c in CHANNELS],
            axis=-1,
        )
        out_path = args.out / f"{out_name}.png"
        Image.fromarray(rgba, mode="RGBA").save(out_path, format="PNG")
        filled = {c: channels.get(c) for c in CHANNELS if channels.get(c)}
        log(f"wrote {out_path} ({w}x{h}) channels: {filled}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
