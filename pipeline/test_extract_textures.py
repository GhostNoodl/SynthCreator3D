#!/usr/bin/env python3
"""Tests for extract_textures.py — runnable plain-assert script (no pytest).

Synthesizes a real PSD on disk via psd-tools' write API (PSDImage.new,
PixelLayer.frompil, Group.new), then exercises --list, --flatten and
--mask against it, checking output structure and exact pixels.

Run from anywhere with the pipeline venv python:

    pipeline/.venv/Scripts/python.exe pipeline/test_extract_textures.py

Exit code 0 = all tests passed, 1 = at least one failure.
"""

from __future__ import annotations

import contextlib
import io
import json
import subprocess
import sys
import tempfile
import traceback
from pathlib import Path

import numpy as np
from PIL import Image
from psd_tools import PSDImage
from psd_tools.api.layers import Group, PixelLayer

sys.path.insert(0, str(Path(__file__).resolve().parent))
import extract_textures as xt  # noqa: E402

CANVAS = 32  # 32x32 test canvas


# ---------------------------------------------------------------------------
# Synthetic PSD fixture
# ---------------------------------------------------------------------------

def solid(size: tuple[int, int], rgba: tuple[int, int, int, int]) -> Image.Image:
    return Image.new("RGBA", size, rgba)


def make_test_psd(path: Path) -> None:
    """Write a small PSD with known geometry:

    - "red block":  8x8 fully opaque red at (4, 4)
    - "soft ramp":  8x8 green, alpha = x*32 per column, at (16, 16)
    - group "Details" with child "trim": 4x4 opaque blue at (24, 2)
    - "hidden":     4x4 opaque white at (0, 28), visibility off
    """
    psd = PSDImage.new("RGB", (CANVAS, CANVAS), color=(0, 0, 0))
    psd.append(PixelLayer.frompil(
        solid((8, 8), (255, 0, 0, 255)), psd, name="red block", top=4, left=4
    ))

    ramp = Image.new("RGBA", (8, 8))
    px = ramp.load()
    for y in range(8):
        for x in range(8):
            px[x, y] = (0, 255, 0, x * 32)
    psd.append(PixelLayer.frompil(ramp, psd, name="soft ramp", top=16, left=16))

    group = Group.new(psd, name="Details")
    group.append(PixelLayer.frompil(
        solid((4, 4), (0, 0, 255, 255)), group, name="trim", top=2, left=24
    ))

    hidden = PixelLayer.frompil(
        solid((4, 4), (255, 255, 255, 255)), psd, name="hidden", top=28, left=0
    )
    hidden.visible = False
    psd.append(hidden)

    psd.save(path)


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

def test_list_structure(psd_path: Path, out: Path) -> None:
    stdout = io.StringIO()
    with contextlib.redirect_stdout(stdout):
        rc = xt.main(["--list", str(psd_path), "--out", str(out)])
    assert rc == 0, f"--list returned {rc}"

    # stdout is the log line(s) + the JSON document; the JSON file must match.
    report_path = out / f"{psd_path.stem}.layers.json"
    assert report_path.is_file(), "layers JSON not written"
    report = json.loads(report_path.read_text(encoding="utf-8"))
    # stdout carries log lines plus the pretty-printed JSON document; the
    # document spans the first '{' to the last '}' and must equal the file.
    text = stdout.getvalue()
    from_stdout = json.loads(text[text.index("{") : text.rindex("}") + 1])
    assert from_stdout == report, "stdout JSON and file JSON differ"

    assert report["size"] == [CANVAS, CANVAS], report["size"]
    assert report["color_mode"] == "RGB"
    assert report["layer_count"] == 5, report["layer_count"]

    by_name = {entry["name"]: entry for entry in report["layers"]}
    assert set(by_name) == {"red block", "soft ramp", "Details", "hidden"}

    red = by_name["red block"]
    assert red["kind"] == "pixel"
    assert red["visible"] is True
    assert red["opacity"] == 255
    assert red["blend_mode"] == "NORMAL"
    assert red["bbox"] == [4, 4, 12, 12], red["bbox"]
    assert red["size"] == [8, 8]

    group = by_name["Details"]
    assert group["kind"] == "group"
    assert len(group["children"]) == 1
    child = group["children"][0]
    assert child["name"] == "trim"
    assert child["path"] == "Details/trim"
    assert child["bbox"] == [24, 2, 28, 6], child["bbox"]

    assert by_name["hidden"]["visible"] is False


def test_flatten_pixels(psd_path: Path, out: Path) -> None:
    rc = xt.main(["--flatten", str(psd_path), "--out", str(out)])
    assert rc == 0, f"--flatten returned {rc}"
    png = out / f"{psd_path.stem}.png"
    assert png.is_file(), "flattened PNG not written"

    img = Image.open(png)
    assert img.size == (CANVAS, CANVAS), img.size
    assert img.mode == "RGB", img.mode  # albedo: no alpha channel
    assert img.getpixel((6, 6)) == (255, 0, 0)      # inside red block
    assert img.getpixel((25, 3)) == (0, 0, 255)     # inside group child
    assert img.getpixel((0, 0)) == (0, 0, 0)        # bare background
    assert img.getpixel((2, 30)) == (0, 0, 0)       # hidden layer not rendered
    # soft ramp: green at ~50% alpha over black background at x=4 of ramp
    r, g, b = img.getpixel((16 + 4, 20))
    assert r == 0 and b == 0 and 120 <= g <= 136, (r, g, b)


def test_mask_pixels(psd_path: Path, out: Path) -> None:
    spec = {
        "red_mask": ["red block"],
        "combo": ["red block", "trim"],
        "group_mask": ["Details"],
        "ramp_mask": ["soft ramp"],
    }
    out.mkdir(parents=True, exist_ok=True)
    spec_path = out / "spec.json"
    spec_path.write_text(json.dumps(spec), encoding="utf-8")

    rc = xt.main(["--mask", str(psd_path), "--spec", str(spec_path), "--out", str(out)])
    assert rc == 0, f"--mask returned {rc}"

    masks = out / "masks"
    for name in spec:
        png = masks / f"{name}.png"
        assert png.is_file(), f"missing mask {name}"
        img = Image.open(png)
        assert img.mode == "L", f"{name}: mode {img.mode}"
        assert img.size == (CANVAS, CANVAS), f"{name}: size {img.size}"

    red = np.array(Image.open(masks / "red_mask.png"))
    assert red.sum() == 255 * 64, red.sum()                 # exactly 8x8 white
    assert red[6, 6] == 255 and red[0, 0] == 0
    assert red[11, 11] == 255 and red[12, 12] == 0          # sharp edges

    combo = np.array(Image.open(masks / "combo.png"))
    assert combo[6, 6] == 255                                # red block area
    assert combo[3, 25] == 255                               # trim area
    assert int((combo > 0).sum()) == 64 + 16                 # union, no overlap

    group = np.array(Image.open(masks / "group_mask.png"))
    assert group[3, 25] == 255                               # group composited
    assert int((group > 0).sum()) == 16

    ramp = np.array(Image.open(masks / "ramp_mask.png"))
    for x in range(8):
        assert ramp[20, 16 + x] == x * 32, (x, ramp[20, 16 + x])
    assert ramp[15, 16] == 0 and ramp[24, 16] == 0           # stays in bounds


def test_mask_missing_layer_is_loud(psd_path: Path, out: Path) -> None:
    out.mkdir(parents=True, exist_ok=True)
    spec_path = out / "bad_spec.json"
    spec_path.write_text(
        json.dumps({"nope_mask": ["does not exist"]}), encoding="utf-8"
    )
    stderr = io.StringIO()
    with contextlib.redirect_stderr(stderr):
        try:
            xt.main(["--mask", str(psd_path), "--spec", str(spec_path),
                     "--out", str(out)])
        except SystemExit as exc:
            assert exc.code != 0, f"expected non-zero exit, got {exc.code}"
        else:
            raise AssertionError("missing layer did not raise SystemExit")
    err = stderr.getvalue()
    assert "does not exist" in err, err
    assert "red block" in err, "available names not listed"


def test_mask_invisible_layer_warns(psd_path: Path, out: Path) -> None:
    out.mkdir(parents=True, exist_ok=True)
    spec_path = out / "hidden_spec.json"
    spec_path.write_text(json.dumps({"h": ["hidden"]}), encoding="utf-8")
    stderr = io.StringIO()
    with contextlib.redirect_stderr(stderr):
        rc = xt.main(["--mask", str(psd_path), "--spec", str(spec_path),
                      "--out", str(out)])
    assert rc == 0
    assert "invisible" in stderr.getvalue(), stderr.getvalue()
    # Named-but-invisible layers are force-shown: the 4x4 white block at
    # (0, 28) must appear in the mask despite the PSD shipping it hidden.
    mask = np.array(Image.open(out / "masks" / "h.png"))
    assert mask.sum() == 255 * 16, mask.sum()
    assert mask[29, 1] == 255 and mask[0, 0] == 0


def test_mask_group_qualified_paths(psd_path: Path, out: Path) -> None:
    """'Group/Layer' spec entries resolve to one exact path, not name matches."""
    out.mkdir(parents=True, exist_ok=True)
    spec_path = out / "path_spec.json"
    spec_path.write_text(json.dumps({"trim_only": ["Details/trim"]}), encoding="utf-8")
    rc = xt.main(["--mask", str(psd_path), "--spec", str(spec_path),
                  "--out", str(out)])
    assert rc == 0, "path-qualified mask extraction failed"
    mask = np.array(Image.open(out / "masks" / "trim_only.png"))
    assert mask.sum() == 255 * 16, mask.sum()  # the 4x4 blue block only
    assert mask[3, 25] == 255 and mask[6, 6] == 0

    # A nonexistent path is a hard error listing available paths.
    bad_path = out / "bad_path_spec.json"
    bad_path.write_text(json.dumps({"x": ["Details/nope"]}), encoding="utf-8")
    try:
        xt.main(["--mask", str(psd_path), "--spec", str(bad_path), "--out", str(out)])
    except SystemExit as exc:
        assert exc.code != 0, exc.code
    else:
        raise AssertionError("unknown path must fail loudly")


def test_cli_subprocess(psd_path: Path, out: Path) -> None:
    """End-to-end: the file works as a real command-line program."""
    script = Path(xt.__file__)
    proc = subprocess.run(
        [sys.executable, str(script), "--list", str(psd_path), "--out", str(out)],
        capture_output=True,
        text=True,
    )
    assert proc.returncode == 0, proc.stderr
    assert f"opened {psd_path}" in proc.stdout

    proc = subprocess.run(
        [sys.executable, str(script), "--flatten", str(psd_path)],
        capture_output=True,
        text=True,
    )
    assert proc.returncode != 0, "--flatten without --out must fail"
    assert "--out is required" in proc.stderr


def test_flatten_visibility_override(psd_path: Path, out: Path) -> None:
    """--flatten --visibility hides/shows named layers; --name renames output."""
    spec = {"hide": ["red block", "Details"], "show": ["hidden"]}
    out.mkdir(parents=True, exist_ok=True)
    spec_path = out / "visibility.json"
    spec_path.write_text(json.dumps(spec), encoding="utf-8")

    rc = xt.main([
        "--flatten", str(psd_path), "--out", str(out),
        "--visibility", str(spec_path), "--name", "base_albedo",
    ])
    assert rc == 0, f"--flatten --visibility returned {rc}"
    png = out / "base_albedo.png"
    assert png.is_file(), "renamed flatten output not written"

    img = Image.open(png)
    assert img.getpixel((6, 6)) == (0, 0, 0)        # red block hidden
    assert img.getpixel((25, 3)) == (0, 0, 0)       # group child hidden
    assert img.getpixel((1, 29)) == (255, 255, 255)  # hidden layer shown
    # soft ramp untouched (not in spec): green at ~50% alpha over black
    r, g, b = img.getpixel((16 + 4, 20))
    assert r == 0 and b == 0 and 120 <= g <= 136, (r, g, b)

    # Unknown layer name in the spec is a hard error (typo guard).
    bad_path = out / "bad.json"
    bad_path.write_text(json.dumps({"hide": ["no such layer"]}), encoding="utf-8")
    try:
        xt.main([
            "--flatten", str(psd_path), "--out", str(out),
            "--visibility", str(bad_path),
        ])
    except SystemExit as exc:
        assert exc.code != 0, exc.code
    else:
        raise AssertionError("unknown visibility layer must fail loudly")


# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------

def main() -> int:
    tests = [
        test_list_structure,
        test_flatten_pixels,
        test_flatten_visibility_override,
        test_mask_pixels,
        test_mask_group_qualified_paths,
        test_mask_missing_layer_is_loud,
        test_mask_invisible_layer_warns,
        test_cli_subprocess,
    ]
    failures = 0
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        psd_path = tmp / "synthetic.psd"
        make_test_psd(psd_path)
        print(f"synthetic PSD: {psd_path} ({psd_path.stat().st_size} bytes)")
        for i, test in enumerate(tests):
            out = tmp / f"out_{test.__name__}"
            try:
                test(psd_path, out)
            except Exception:
                failures += 1
                print(f"FAIL {test.__name__}")
                traceback.print_exc()
            else:
                print(f"PASS {test.__name__}")
    print(f"\n{len(tests) - failures}/{len(tests)} tests passed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
