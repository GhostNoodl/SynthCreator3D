# Bundled resources

Everything in this directory ships inside the installer (see
`tauri.conf.json` → `bundle.resources`) and is read at runtime by the
import wizard (`src/import.rs`). Layout:

```
resources/
  python/                 embedded CPython 3.14.6 (Windows x64) + deps
  pipeline/               texture-pipeline scripts copied from <repo>/pipeline
    extract_textures.py
    pack_masks.py
    bake_shading.py
    sample_colors.py
    specs/zairiza-synth/*.json
    specs/zairiza-synth-nsfw/*.json
  packs/
    zairiza-synth-sfw/manifest.json    master manifests, copied from
    zairiza-synth-nsfw/manifest.json   <repo>/pipeline/packs (read-only there)
```

## python/ — how the embedded runtime was produced

1. Downloaded the official Windows embeddable package
   `https://www.python.org/ftp/python/3.14.6/python-3.14.6-embed-amd64.zip`
   and unzipped it into `python/`.
2. Edited `python314._pth` to add `Lib/site-packages` to `sys.path`
   (the embeddable package runs isolated; the `._pth` file is the only
   path configuration it reads).
3. Copied `Lib/site-packages` from the proven pipeline venv
   (`pipeline/.venv/Lib/site-packages`, same CPython 3.14.x ABI),
   excluding `pip*` and `__pycache__`. This provides `psd-tools`,
   `Pillow`, `numpy` (+ `attrs`, `typing_extensions`) without needing
   network access at install or run time.

Verify after any update (from any cwd):

```sh
resources/python/python.exe -c "import numpy, PIL, psd_tools; print('ok')"
resources/python/python.exe resources/pipeline/bake_shading.py --help
```

## Updating the pipeline scripts / manifests

These files are COPIES. The masters live in `<repo>/pipeline/` (scripts,
`specs/`, `packs/*/manifest.json`). After changing a master, re-copy it
here — the app never reads from `<repo>/pipeline` at runtime.
