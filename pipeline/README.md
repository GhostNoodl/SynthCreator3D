# SynthCreator3D asset pipeline

Converts the user's locally purchased Synth model files (Blender 3.0 `.blend`,
PSD textures) into a **model pack** the app loads: `model.glb` + PNG textures
+ `manifest.json` (schema: `docs/manifest-schema.md`). Nothing here ships or
assumes the licensed files — every input is a CLI argument.

## Prerequisites

- **Blender 4.x LTS** on `PATH` (`blender --version` must work). Only needed
  for `blender_export.py`.
- **Python 3.14** + a venv for the texture extractor:

  ```sh
  python -m venv pipeline/.venv
  pipeline/.venv/Scripts/python.exe -m pip install -r pipeline/requirements.txt
  ```

  (Git Bash on Windows; on POSIX use `pipeline/.venv/bin/python`.)

## Pipeline flow

1. **Buy the model** (itch.io) and unpack it locally.
2. **Inventory** the `.blend` to learn node / morph / material / UV names.
3. **Author** `manifest.json` from the inventory, and a mask spec JSON from
   the PSD `--list` output.
4. **Extract textures** from the PSDs (`--flatten` albedos, `--mask` masks).
5. **Export** `model.glb` from the `.blend`.
6. **Assemble the pack**:

   ```
   <pack>/
     manifest.json          # hand-authored, schema v1
     model.glb              # from step 5
     textures/
       <psd_name>.png       # albedo(s) from step 4
       masks/<name>.png     # region masks from step 4
   ```

   Manifest texture paths are pack-relative with forward slashes, e.g.
   `"mask": "textures/masks/body_trim.png"` — so pass the pack's `textures/`
   dir as `--out` in step 4.

## blender_export.py

```sh
blender --background --python pipeline/blender_export.py -- <mode> <input.blend> <out_dir>
```

- `inventory` — writes `<out_dir>/inventory.json` (also stdout): every mesh
  object with its shape keys (`Basis` is the reference shape, not an exported
  morph), materials, UV maps, modifiers, plus armatures and a file summary.
- `export` — strips cameras/lights, logs every mesh with its morph count and
  modifiers (missing shape keys are visible *before* export), then writes
  `<out_dir>/model.glb`: morph targets on, no embedded images
  (`export_image_format='NONE'` — textures come from the PSD extractor),
  +Y up, modifiers not applied.

glTF operator kwargs are filtered against the running Blender's operator
properties, so version renames (the sources are Blender 3.0 files) skip with
a log line instead of crashing. Exit code is non-zero on failure; adding
`--python-exit-code 1` to the blender invocation is harmless belt-and-braces.

## extract_textures.py

```sh
PY=pipeline/.venv/Scripts/python.exe   # or .venv/bin/python on POSIX

# Layer/group tree as JSON (stdout; also <out>/<name>.layers.json with --out):
$PY pipeline/extract_textures.py --list path/to/Body.psd [--out outdir]

# Albedo: composite -> <out>/<name>.png (RGB). Options:
#   --visibility spec.json   hide/show named layers first (e.g. bake a
#                            shading-only tint base without color layers)
#   --name body_albedo       output file base name (default: PSD stem)
#   --background white       canvas for transparent areas (default: black;
#                            white turns shading-only composites into a
#                            bright tintable shading map)
$PY pipeline/extract_textures.py --flatten path/to/Body.psd --out <pack>/textures \
    --visibility pipeline/specs/<pack>/main_visibility.json \
    --name body_albedo --background white

# Masks per spec -> <out>/masks/<mask_name>.png:
$PY pipeline/extract_textures.py --mask path/to/Body.psd --spec mask_spec.json --out <pack>/textures
```

Mask spec format (`mask_spec.json`):

```json
{
  "body_trim": ["Trim Layer", "Some Group"],
  "visor_glow": ["Visor Glow"]
}
```

Keys become mask file names, values are PSD layer or group names (see
`--list`). A mask pixel is the **max rendered alpha** over the listed layers:
full coverage = white (255), none = black (0). Group names composite the
whole group. Duplicate layer names are combined with a warning; a missing
name is a hard error listing all available names. Layers that are invisible
in the PSD (hidden variant layers, e.g. the Synth's Tail/Spine light groups)
are **force-shown** for mask extraction, with a warning — naming a layer
means its coverage is wanted. Reduced-opacity layers scale coverage and warn.

## bake_shading.py (the albedo step — replaces --flatten for packs)

Builds the runtime albedo ("shading map") the tint shader multiplies against.
Naive white-background flattens lose Photoshop OVERLAY highlight passes, and
dividing by flat layer colors clips highlights (both produced visible
two-tone artifacts). Instead: the ORIGINAL full-color PSD composite is
divided by each region's flat color scaled by ONE luminance factor (99th
percentile of orig/flat luminance inside the mask) — tinting reconstructs
the original texture, highlights included, WITHOUT the hue shift that
per-channel percentiles cause. The emitted `--colors-out` JSON becomes the
manifest's `defaultColor`s (PSD hue, brightness-matched to the composite).

```sh
$PY pipeline/bake_shading.py --psd <Main.psd> \
    --packed <pack>/textures/packed --spec pipeline/specs/<pack>/mask_packing.json \
    --manifest <pack>/manifest.json --only-material body,eyes \
    --out <pack>/textures/body_albedo.png --colors-out pipeline/out/colors_body.json
```

- `--only-material body,eyes` for the main PSD, `--only-material clothing` for the clothing PSD.
- Near-black regions and emission areas bake white (exact for flat dark colors / glow).
- Run AFTER pack_masks.py (masks read from the packed textures; bake again if packs change, e.g. after `--dilate`).

## pack_masks.py

Packs four grayscale masks into the R/G/B/A channels of one PNG. **Required**
for packs with many regions: WebGL guarantees only 16 fragment texture units,
and one sampler per region exceeds that (the app shares one sampler per
pack). Emits `<out>/<pack_name>.png` per spec entry; null channels = zero.
Manifests then reference masks as `{"texture": "textures/packed/X.png",
"channel": "r"}`:

```sh
$PY pipeline/pack_masks.py <pack>/textures/masks \
    --spec pipeline/specs/<pack>/mask_packing.json --out <pack>/textures/packed
```

## sample_colors.py

Recovers layer colors (default palette + "Alt N" schemes) as hex for
authoring manifest `defaultColor`s and `palettes`:

```sh
$PY pipeline/sample_colors.py path/to/Body.psd --out palette.json \
    --layers "Main Color" "Main Color Alt 1" ...
```

Median RGB over pixels with alpha >= 128; invisible layers are force-shown.

## Authored specs & manifests

- `pipeline/specs/zairiza-synth/` / `...-nsfw/` — visibility + mask specs per PSD.
- `pipeline/packs/<pack-id>/manifest.json` — **master copies** of the authored
  manifests (plain mapping data, no licensed art; safe to commit). Copy into
  the pack dir when assembling:

  ```
  app/public/packs/<pack-id>/     # GITIGNORED (derived licensed content)
    manifest.json                 # copy from pipeline/packs/<pack-id>/
    model.glb                     # from blender_export.py export
    textures/                     # from extract_textures.py
  ```

## Tests

```sh
pipeline/.venv/Scripts/python.exe pipeline/test_extract_textures.py
```

Synthesizes a PSD via psd-tools' write API and checks `--list` structure,
`--flatten` pixels, `--mask` math, and error paths. `blender_export.py` has
no automated coverage here (needs Blender + the purchased files).
