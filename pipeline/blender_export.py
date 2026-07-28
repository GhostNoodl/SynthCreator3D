#!/usr/bin/env python3
"""Headless Blender stage of the SynthCreator3D asset pipeline.

Invoked as:

    blender --background --python pipeline/blender_export.py -- \
        <mode> <input.blend> <out_dir>

Modes:

- ``inventory``: dump a JSON report of the .blend (mesh objects, shape keys,
  materials, UV maps, armatures, modifiers) to ``<out_dir>/inventory.json``
  and stdout. Used to author the pack's manifest.json after the user buys
  the model.
- ``export``:    strip cameras/lights, log every mesh and its shape-key
  count, then write ``<out_dir>/model.glb`` with morph targets and no
  embedded images (textures come from the PSD extractor).

Targets the Blender 4.x LTS Python API, but the purchased source files are
saved in Blender 3.0, and glTF-operator keyword names differ across
versions — so every version-sensitive keyword is filtered against the
operator's actual RNA properties before invocation. Anything skipped is
logged, never silently dropped.

NOTE: this script runs inside Blender's interpreter; it cannot be run with
plain CPython (``bpy`` is unavailable there).
"""

from __future__ import annotations

import json
import sys
import traceback
from pathlib import Path

import bpy

MODES = ("inventory", "export")


def log(msg: str) -> None:
    print(f"[blender_export] {msg}", flush=True)


def parse_args() -> tuple[str, Path, Path]:
    """Parse everything after ``--`` on Blender's command line."""
    argv = sys.argv
    if "--" not in argv:
        raise ValueError(
            "expected arguments after '--': <mode> <input.blend> <out_dir>"
        )
    args = argv[argv.index("--") + 1 :]
    if len(args) != 3:
        raise ValueError(
            f"expected 3 arguments after '--' (<mode> <input.blend> "
            f"<out_dir>), got {len(args)}: {args}"
        )
    mode, blend_path, out_dir = args
    if mode not in MODES:
        raise ValueError(f"unknown mode {mode!r}; expected one of {MODES}")
    blend = Path(blend_path)
    if not blend.is_file():
        raise ValueError(f"input .blend not found: {blend}")
    return mode, blend, Path(out_dir)


def open_blend(blend_path: Path) -> None:
    # load_ui=False: headless, and avoids pulling workspace layouts in.
    try:
        bpy.ops.wm.open_mainfile(filepath=str(blend_path), load_ui=False)
    except RuntimeError as exc:
        # Blender 4.x escalates some load-time data problems to RuntimeError
        # even though the file loads and opens fine interactively — e.g. this
        # model's files contain invalid "KEKey.*" shape keys (null 'from'
        # pointer, junk from a third-party addon) which Blender deletes on
        # load. If data actually arrived, treat it as a warning and continue;
        # only re-raise when nothing loaded at all.
        if bpy.data.objects or bpy.data.meshes:
            log(
                f"open_mainfile raised ({exc}); scene data is present "
                f"({len(bpy.data.objects)} objects) — continuing past "
                f"load-time data cleanup"
            )
        else:
            raise
    log(
        f"opened {blend_path} with Blender {bpy.app.version_string} "
        f"(file saved by Blender {bpy.data.version})"
    )


# ---------------------------------------------------------------------------
# inventory
# ---------------------------------------------------------------------------

def object_in_any_scene(obj) -> bool:
    return any(obj.name in scene.objects for scene in bpy.data.scenes)


def gather_inventory(blend_path: Path) -> dict:
    objects = []
    total_shape_keys = 0
    for obj in bpy.data.objects:
        entry = {
            "name": obj.name,
            "type": obj.type,
            "in_scene": object_in_any_scene(obj),
            "parent": obj.parent.name if obj.parent else None,
        }
        if obj.type == "MESH":
            mesh = obj.data
            shape_keys = []
            if mesh.shape_keys is not None:
                # key_blocks includes "Basis"; Basis is a reference shape,
                # not an exported morph target.
                shape_keys = [kb.name for kb in mesh.shape_keys.key_blocks]
            total_shape_keys += len(shape_keys)
            entry.update(
                {
                    "vertices": len(mesh.vertices),
                    "polygons": len(mesh.polygons),
                    "shape_keys": shape_keys,
                    "materials": [
                        slot.material.name
                        for slot in obj.material_slots
                        if slot.material is not None
                    ],
                    "uv_maps": [uv.name for uv in mesh.uv_layers],
                    "modifiers": [
                        {"name": m.name, "type": m.type} for m in obj.modifiers
                    ],
                }
            )
        elif obj.type == "ARMATURE":
            entry["bones"] = len(obj.data.bones)
        objects.append(entry)

    meshes = [o for o in objects if o["type"] == "MESH"]
    report = {
        "file": blend_path.as_posix(),
        "blender_version": bpy.app.version_string,
        "file_saved_by": ".".join(str(v) for v in bpy.data.version),
        "scenes": [s.name for s in bpy.data.scenes],
        "summary": {
            "objects": len(objects),
            "meshes": len(meshes),
            "meshes_with_shape_keys": sum(1 for o in meshes if o["shape_keys"]),
            "shape_key_total": total_shape_keys,
            "armatures": sum(1 for o in objects if o["type"] == "ARMATURE"),
            "materials": len(bpy.data.materials),
        },
        "objects": objects,
        "materials": sorted(m.name for m in bpy.data.materials),
    }
    return report


def run_inventory(blend_path: Path, out_dir: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    report = gather_inventory(blend_path)
    text = json.dumps(report, indent=2, ensure_ascii=False)
    print(text, flush=True)
    report_path = out_dir / "inventory.json"
    report_path.write_text(text + "\n", encoding="utf-8")
    s = report["summary"]
    log(
        f"wrote {report_path} — {s['meshes']} meshes "
        f"({s['meshes_with_shape_keys']} with shape keys, "
        f"{s['shape_key_total']} key blocks incl. Basis), "
        f"{s['armatures']} armatures, {s['materials']} materials"
    )


# ---------------------------------------------------------------------------
# export
# ---------------------------------------------------------------------------

def strip_junk() -> None:
    """Remove non-exportable scene junk (cameras, lights)."""
    junk = [o for o in bpy.data.objects if o.type in {"CAMERA", "LIGHT"}]
    for obj in junk:
        log(f"stripping {obj.type.lower()} {obj.name!r}")
        bpy.data.objects.remove(obj, do_unlink=True)
    if not junk:
        log("no cameras or lights to strip")


def log_meshes() -> None:
    """Log every mesh with its shape-key count and modifiers.

    Missing shape keys must be obvious in the output *before* export, so a
    bad GLB never surprises us downstream.
    """
    meshes = [o for o in bpy.data.objects if o.type == "MESH"]
    log(f"{len(meshes)} mesh objects:")
    for obj in meshes:
        key_blocks = (
            list(obj.data.shape_keys.key_blocks)
            if obj.data.shape_keys is not None
            else []
        )
        morphs = [kb.name for kb in key_blocks if kb.name != "Basis"]
        modifiers = [f"{m.name}({m.type})" for m in obj.modifiers]
        log(
            f"  {obj.name}: {len(morphs)} morphs "
            f"{morphs if morphs else '[]'}, "
            f"modifiers: {modifiers if modifiers else 'none'}"
        )


def build_gltf_kwargs(glb_path: Path) -> dict:
    """glTF export kwargs, filtered to what this Blender's operator accepts.

    The source .blend files are saved by Blender 3.0 while we run 4.x LTS;
    operator argument names changed across versions. Filtering against the
    operator's RNA properties keeps the script from crashing on renames.
    """
    wanted = {
        "filepath": str(glb_path),
        "export_format": "GLB",
        # Morph targets are the whole point of the sliders in the manifest.
        "export_morph": True,
        "export_morph_normal": True,
        "export_morph_tangent": False,
        # Textures come from the PSD extractor, never from the GLB.
        "export_image_format": "NONE",
        # +Y up (glTF standard); the app assumes it.
        "export_yup": True,
        # Do NOT destructively apply modifiers (would bake/shrink shape keys).
        "export_apply": False,
        "export_texcoords": True,
        "export_normals": True,
        "export_materials": "EXPORT",
        "export_skins": True,
        "export_animations": True,
        "export_cameras": False,
        "export_lights": False,
        # Custom properties ride along as extras — useful for debugging packs.
        "export_extras": True,
    }
    props = set(bpy.ops.export_scene.gltf.get_rna_type().properties.keys())
    accepted = {k: v for k, v in wanted.items() if k in props}
    skipped = [k for k in wanted if k not in props]
    for key in skipped:
        log(
            f"operator has no property {key!r} on Blender "
            f"{bpy.app.version_string}; skipping that option"
        )
    return accepted


def run_export(out_dir: Path) -> None:
    strip_junk()
    log_meshes()

    meshes = [o for o in bpy.data.objects if o.type == "MESH"]
    if not meshes:
        raise RuntimeError("no mesh objects in file; nothing to export")

    out_dir.mkdir(parents=True, exist_ok=True)
    glb_path = out_dir / "model.glb"
    kwargs = build_gltf_kwargs(glb_path)
    log(f"exporting {glb_path} with kwargs: {sorted(kwargs)}")
    bpy.ops.export_scene.gltf(**kwargs)

    if not glb_path.is_file() or glb_path.stat().st_size == 0:
        raise RuntimeError(f"export reported success but {glb_path} is missing/empty")
    log(f"wrote {glb_path} ({glb_path.stat().st_size} bytes)")


# ---------------------------------------------------------------------------

def main() -> int:
    mode, blend_path, out_dir = parse_args()
    log(f"mode={mode} input={blend_path} out_dir={out_dir}")
    open_blend(blend_path)
    if mode == "inventory":
        run_inventory(blend_path, out_dir)
    else:
        run_export(out_dir)
    log("done")
    return 0


if __name__ == "__main__":
    try:
        status = main()
    except Exception:
        traceback.print_exc()
        # In background mode Blender propagates SystemExit to its own exit
        # code; `--python-exit-code 1` on the command line is belt-and-braces.
        sys.exit(1)
    sys.exit(status)
