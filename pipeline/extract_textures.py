#!/usr/bin/env python3
"""Extract textures and region masks from Synth PSD files.

Part of the SynthCreator3D offline asset pipeline. Turns the purchased
model's PSD texture files into PNGs the model pack references:

- ``--list``:    dump the PSD layer/group tree as JSON (for authoring the
                 manifest and mask specs).
- ``--flatten``: composite the whole PSD to ``<out>/<name>.png`` (albedo).
- ``--mask``:    composite layers named in a JSON spec into grayscale masks
                 at ``<out>/masks/<mask_name>.png`` (coverage -> white).

Mask semantics: a mask pixel is the maximum, over the listed layers, of the
layer's rendered alpha (0-255) at that pixel. Fully covered -> 255 (white),
uncovered -> 0 (black). Opacity applies the way Photoshop renders it (a
reduced-opacity layer warns). Layers named in the spec that are INVISIBLE in
the PSD (e.g. variant layers the artist ships toggled off) are force-shown —
along with their ancestor groups — for the coverage render, with a warning;
naming a layer means its coverage is wanted.

Requires: psd-tools, Pillow, numpy (see requirements.txt).
Python 3.14 compatible; no global installs - run from pipeline/.venv.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from psd_tools import PSDImage
from psd_tools.api.layers import Layer


def log(msg: str) -> None:
    print(f"[extract_textures] {msg}", flush=True)


def warn(msg: str) -> None:
    print(f"[extract_textures] WARNING: {msg}", file=sys.stderr, flush=True)


def die(msg: str, code: int = 2) -> "SystemExit":
    print(f"[extract_textures] ERROR: {msg}", file=sys.stderr, flush=True)
    return SystemExit(code)


# ---------------------------------------------------------------------------
# Layer traversal
# ---------------------------------------------------------------------------

def iter_layers(layers, prefix: tuple[str, ...] = ()):
    """Yield ``(layer, path_tuple)`` for every layer, recursing into groups."""
    for layer in layers:
        path = prefix + (layer.name,)
        yield layer, path
        if layer.is_group():
            yield from iter_layers(layer, path)


def layer_path(path: tuple[str, ...]) -> str:
    """Slash-joined layer path (forward slashes, manifest convention)."""
    return "/".join(path)


def build_name_index(psd: PSDImage) -> dict[str, list[tuple[Layer, str]]]:
    """Map layer name -> all ``(layer, path)`` pairs with that name.

    PSD layer names are not unique, so every name maps to a list.
    """
    index: dict[str, list[tuple[Layer, str]]] = {}
    for layer, path in iter_layers(psd):
        index.setdefault(layer.name, []).append((layer, layer_path(path)))
    return index


def resolve_spec_name(
    index: dict[str, list[tuple[Layer, str]]], name: str
) -> list[tuple[Layer, str]] | None:
    """Resolve a spec entry to layers.

    Bare names match by layer name (possibly several layers — PSD names are
    not unique). ``Group/Layer`` paths match one exact full path, for models
    whose PSDs reuse the same name in different groups (e.g. Framework's
    "Tail Topside" in both the Tail and Normals groups).
    """
    if "/" in name:
        matches = [
            (layer, path)
            for entries in index.values()
            for (layer, path) in entries
            if path == name
        ]
        return matches or None
    return index.get(name)


def available_listing(index: dict[str, list[tuple[Layer, str]]]) -> str:
    """All known names and paths, for not-found error messages."""
    entries = sorted(index) + sorted(
        path for entries in index.values() for _layer, path in entries if "/" in path
    )
    return "\n  ".join(entries) if entries else "(none)"


# ---------------------------------------------------------------------------
# --list
# ---------------------------------------------------------------------------

def layer_to_dict(layer: Layer, path: tuple[str, ...]) -> dict:
    left, top, right, bottom = layer.bbox
    entry = {
        "name": layer.name,
        "path": layer_path(path),
        "kind": layer.kind,  # 'pixel', 'group', 'shape', 'type', ...
        "visible": bool(layer.visible),
        "opacity": int(layer.opacity),
        "blend_mode": layer.blend_mode.name,
        "bbox": [int(left), int(top), int(right), int(bottom)],
        "size": [int(right - left), int(bottom - top)],
    }
    if layer.is_group():
        entry["children"] = [
            layer_to_dict(child, path + (child.name,)) for child in layer
        ]
    return entry


def cmd_list(psd: PSDImage, psd_path: Path, out: Path | None) -> int:
    tree = [layer_to_dict(layer, (layer.name,)) for layer in psd]
    report = {
        "file": str(psd_path),
        "color_mode": psd.color_mode.name,
        "depth": int(psd.depth),
        "size": [int(psd.width), int(psd.height)],
        "layer_count": sum(1 for _ in iter_layers(psd)),
        "layers": tree,
    }
    text = json.dumps(report, indent=2, ensure_ascii=False)
    print(text)
    if out is not None:
        out.mkdir(parents=True, exist_ok=True)
        report_path = out / f"{psd_path.stem}.layers.json"
        report_path.write_text(text + "\n", encoding="utf-8")
        log(f"wrote {report_path}")
    return 0


# ---------------------------------------------------------------------------
# --flatten
# ---------------------------------------------------------------------------

def cmd_flatten(psd: PSDImage, psd_path: Path, out: Path,
                visibility_path: Path | None = None,
                out_name: str | None = None,
                background: str = "black") -> int:
    # Optionally override layer visibility before compositing (e.g. hide all
    # flat color layers to bake a shading-only base albedo). Spec JSON:
    # {"show": ["layer", ...], "hide": ["layer", ...]} — names are matched
    # like mask specs; unknown names are a hard error (typo guard).
    if visibility_path is not None:
        try:
            spec = json.loads(visibility_path.read_text(encoding="utf-8"))
        except OSError as exc:
            raise die(f"cannot read visibility spec {visibility_path}: {exc}")
        except json.JSONDecodeError as exc:
            raise die(f"visibility spec {visibility_path} is not valid JSON: {exc}")
        if not isinstance(spec, dict) or any(k not in ("show", "hide") for k in spec):
            raise die('visibility spec must be {"show": [...], "hide": [...]}')
        index = build_name_index(psd)
        for key, target in (("show", True), ("hide", False)):
            for name in spec.get(key, []):
                matches = index.get(name)
                if not matches:
                    available = sorted(index)
                    listing = "\n  ".join(available) if available else "(none)"
                    raise die(
                        f"visibility {key}: layer {name!r} not found in PSD.\n"
                        f"available layer names:\n  {listing}"
                    )
                for layer, _path in matches:
                    layer.visible = target
        log(f"applied visibility overrides from {visibility_path}")

    # force=True re-renders from layers instead of trusting the embedded
    # preview, which may be stale in files not saved by Photoshop.
    image = psd.composite(force=True)
    if image is None:
        raise die("PSD composited to nothing (no renderable layers?)")
    out.mkdir(parents=True, exist_ok=True)
    png_path = out / f"{out_name or psd_path.stem}.png"
    # Albedo textures are opaque. A layer render comes back RGBA with
    # transparency wherever no layer covers the canvas; flatten that onto
    # black (an artist PSD normally has a background fill layer anyway, in
    # which case this changes nothing).
    if image.mode == "RGBA":
        # Albedo textures are opaque. A layer render comes back RGBA with
        # transparency wherever no layer covers the canvas; flatten that onto
        # the requested background. Black preserves dark-base PSDs as-is;
        # white turns shading-only composites (multiply/overlay passes over
        # nothing) into a bright shading map suitable for runtime tinting.
        bg_rgb = (255, 255, 255) if background == "white" else (0, 0, 0)
        background_img = Image.new("RGBA", image.size, (*bg_rgb, 255))
        image = Image.alpha_composite(background_img, image).convert("RGB")
    image.save(png_path, format="PNG")
    log(f"wrote {png_path} ({image.size[0]}x{image.size[1]}, {image.mode})")
    return 0


# ---------------------------------------------------------------------------
# --mask
# ---------------------------------------------------------------------------

def layer_coverage(layer: Layer, canvas_size: tuple[int, int]) -> np.ndarray:
    """Rendered alpha of one layer on the full canvas, uint8 (H, W).

    Uses ``layer.composite()``: works for pixel layers and groups alike.
    Note: psd-tools' ``Layer.topil()`` drops real alpha (returns 255), so it
    must not be used here. ``composite()`` applies the layer's opacity and
    visibility, matching what Photoshop renders.
    """
    canvas_w, canvas_h = canvas_size
    coverage = np.zeros((canvas_h, canvas_w), dtype=np.uint8)

    image = layer.composite()
    if image is None:
        warn(f"layer {layer.name!r} composited to nothing; skipped")
        return coverage
    if image.mode != "RGBA":
        image = image.convert("RGBA")

    alpha = np.asarray(image, dtype=np.uint8)[..., 3]
    if alpha.size == 0:
        return coverage

    left, top = int(layer.left), int(layer.top)
    layer_h, layer_w = alpha.shape

    # Clip the layer rect against the canvas (offsets may be negative or
    # extend past the edge).
    x0, y0 = max(left, 0), max(top, 0)
    x1, y1 = min(left + layer_w, canvas_w), min(top + layer_h, canvas_h)
    if x1 <= x0 or y1 <= y0:
        warn(f"layer {layer.name!r} lies outside the canvas; skipped")
        return coverage

    sx0, sy0 = x0 - left, y0 - top
    coverage[y0:y1, x0:x1] = alpha[sy0 : sy0 + (y1 - y0), sx0 : sx0 + (x1 - x0)]
    return coverage


def cmd_mask(psd: PSDImage, spec_path: Path, out: Path) -> int:
    try:
        spec = json.loads(spec_path.read_text(encoding="utf-8"))
    except OSError as exc:
        raise die(f"cannot read mask spec {spec_path}: {exc}")
    except json.JSONDecodeError as exc:
        raise die(f"mask spec {spec_path} is not valid JSON: {exc}")
    if not isinstance(spec, dict) or not all(
        isinstance(k, str) and isinstance(v, list) for k, v in spec.items()
    ):
        raise die(
            f"mask spec must be a JSON object of "
            f'{{"mask_name": ["PSD layer name", ...]}}; got {type(spec).__name__}'
        )

    index = build_name_index(psd)
    canvas_size = (int(psd.width), int(psd.height))
    masks_dir = out / "masks"
    masks_dir.mkdir(parents=True, exist_ok=True)

    for mask_name, layer_names in spec.items():
        mask = np.zeros((canvas_size[1], canvas_size[0]), dtype=np.uint8)
        for name in layer_names:
            matches = resolve_spec_name(index, name)
            if not matches:
                raise die(
                    f"mask {mask_name!r}: layer {name!r} not found in PSD.\n"
                    f"available layer names/paths:\n  {available_listing(index)}",
                    code=2,
                )
            if len(matches) > 1:
                paths = ", ".join(path for _layer, path in matches)
                warn(
                    f"mask {mask_name!r}: layer name {name!r} matches "
                    f"{len(matches)} layers ({paths}); combining all of them"
                )
            for layer, _path in matches:
                # An explicitly named layer is wanted for its coverage even
                # when the PSD ships it toggled off — or inside a group that
                # is toggled off (a hidden ancestor suppresses the whole
                # subtree; e.g. Framework's hidden "Emission" group whose
                # children are individually visible). Force-show the chain.
                chain: list[Layer] = []
                node: Layer | None = layer
                while isinstance(node, Layer):  # stops at PSDImage root
                    chain.append(node)
                    node = node.parent
                if any(not n.visible for n in chain):
                    warn(
                        f"mask {mask_name!r}: layer {name!r} or an ancestor "
                        f"group is invisible in the PSD; force-showing the "
                        f"chain for mask extraction"
                    )
                    for n in chain:
                        n.visible = True
                if layer.opacity < 255:
                    warn(
                        f"mask {mask_name!r}: layer {name!r} has opacity "
                        f"{layer.opacity}/255; coverage will be scaled down "
                        f"accordingly"
                    )
                mask = np.maximum(mask, layer_coverage(layer, canvas_size))

        png_path = masks_dir / f"{mask_name}.png"
        Image.fromarray(mask, mode="L").save(png_path, format="PNG")
        covered = int((mask > 0).sum())
        log(
            f"wrote {png_path} ({canvas_size[0]}x{canvas_size[1]}, "
            f"{covered} px covered)"
        )
    return 0


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="extract_textures.py",
        description="Extract albedo PNGs and grayscale region masks from PSDs.",
    )
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument(
        "--list",
        action="store_true",
        help="dump the PSD layer/group tree as JSON (stdout, and "
        "<out>/<name>.layers.json if --out is given)",
    )
    mode.add_argument(
        "--flatten",
        action="store_true",
        help="composite the full PSD to <out>/<name>.png (albedo); "
        "--visibility can hide/show layers first",
    )
    mode.add_argument(
        "--mask",
        action="store_true",
        help="build grayscale masks per --spec into <out>/masks/",
    )
    parser.add_argument("psd", type=Path, help="input .psd file")
    parser.add_argument(
        "--out",
        type=Path,
        default=None,
        help="output directory (required for --flatten/--mask)",
    )
    parser.add_argument(
        "--spec",
        type=Path,
        default=None,
        help='mask spec JSON: {"mask_name": ["PSD layer name", ...]} '
        "(required for --mask)",
    )
    parser.add_argument(
        "--visibility",
        type=Path,
        default=None,
        help='visibility override JSON for --flatten: '
        '{"show": ["layer", ...], "hide": ["layer", ...]}',
    )
    parser.add_argument(
        "--name",
        default=None,
        help="output file base name for --flatten (default: PSD file stem)",
    )
    parser.add_argument(
        "--background",
        choices=["black", "white"],
        default="black",
        help="canvas color transparent areas flatten onto (default: black); "
        "use white for shading-only tint bases",
    )
    args = parser.parse_args(argv)

    if (args.flatten or args.mask) and args.out is None:
        parser.error("--out is required for --flatten and --mask")
    if args.mask and args.spec is None:
        parser.error("--spec is required for --mask")
    if args.visibility is not None and not args.flatten:
        parser.error("--visibility only applies to --flatten")
    if args.name is not None and not args.flatten:
        parser.error("--name only applies to --flatten")
    if args.background != "black" and not args.flatten:
        parser.error("--background only applies to --flatten")
    return args


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if not args.psd.is_file():
        raise die(f"PSD not found: {args.psd}")

    try:
        psd = PSDImage.open(args.psd)
    except Exception as exc:  # psd-tools raises various parse errors
        raise die(f"failed to open {args.psd}: {exc}") from exc

    log(
        f"opened {args.psd} ({psd.width}x{psd.height}, "
        f"{psd.color_mode.name}, depth {psd.depth})"
    )
    if args.list:
        return cmd_list(psd, args.psd, args.out)
    if args.flatten:
        return cmd_flatten(psd, args.psd, args.out,
                           visibility_path=args.visibility, out_name=args.name,
                           background=args.background)
    return cmd_mask(psd, args.spec, args.out)


if __name__ == "__main__":
    sys.exit(main())
