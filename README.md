# SynthCreator3D

A desktop 3D character customizer for the [Synth VRChat model by Zairiza](https://zairizacustoms.itch.io/synth-vrchat-model) — recolor every region and the glow, drive body-shape sliders, toggle parts (visors, antenna, frills, claws, clothing styles), pose the model, then save presets, capture screenshots/turntable videos, and export GLB, textures, and a VRChat recreation config.

## For users

**You must own a purchased copy of the Synth model** (link above). The app
never ships the model's files — it converts *your* local copy into a pack on
*your* machine (see `docs/licensing.md`).

1. Install `SynthCreator3D_x64-setup.exe` from the latest release.
2. Launch — the app opens with a built-in demo model so you can explore right away.
3. Click **Import model**, pick SFW or NSFW, and point it at your unpacked
   model folder. It auto-finds the FBX and PSDs; conversion takes a couple of
   minutes (progress bar shows each step). The pack appears in the dropdown.
4. Create: panels on the left (pose, clothing, parts), sliders and colors on
   the right. Save presets or share codes from the toolbar; export GLB,
   textures, or a VRChat config when you're happy with the design.

NSFW packs ask for a one-time 18+ confirmation. Requires no internet, no
Blender, no Unity — conversion is fully local.

## For developers

Layout:

- `app/` — the customizer (Vite + React + TypeScript + Three.js frontend, Tauri v2 Rust shell, embedded-Python conversion pipeline)
- `pipeline/` — offline converters that turn a purchased copy of the model into an app "model pack" (headless Blender export + PSD texture extraction + mask packing + shading bake)
- `docs/manifest-schema.md` — the model-pack contract both sides are built against
- `docs/licensing.md` — why model files never enter this repo (paid asset, no redistribution)

Run in dev:

```bash
cd app
npm install
npm run dev        # regenerates the placeholder pack, then starts Vite
```

Checks: `npm run smoke` (logic + GLB round-trip tests), `npm run build` (typecheck + bundle), `cargo test --manifest-path src-tauri/Cargo.toml` (import logic).

Desktop app (Tauri) — requires Rust (stable) + MSVC C++ build tools:

```bash
cd app
npm run tauri dev      # desktop window with hot-reload frontend
npm run tauri build    # production build -> NSIS installer in app/src-tauri/target/release/bundle/
```

The Vite dev server is pinned to port 5173 (`strictPort`) to match Tauri's devUrl.

### Cutting a release (auto-updater feed)

The app checks `releases/latest/download/latest.json` on startup and offers
to update itself (minisign-verified). To publish a release:

```bash
cd app
# 1. bump version in src-tauri/tauri.conf.json
# 2. signed build (private key lives at ~/.tauri/synthcreator3d.key — back it
#    up somewhere safe and NEVER commit it; *.key is gitignored).
#    BOTH env vars are required: the bundler reads the key CONTENT and skips
#    the interactive password prompt only when PASSWORD is set (empty here).
export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/synthcreator3d.key)"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
npm run tauri build
# 3. generate the updater manifest
npm run release:manifest   # writes target/release/bundle/latest.json
# 4. publish: create the release and attach BOTH artifacts
gh release create v<X.Y.Z> --title "SynthCreator3D v<X.Y.Z>" --notes "..." \
  src-tauri/target/release/bundle/nsis/SynthCreator3D_<X.Y.Z>_x64-setup.exe \
  src-tauri/target/release/bundle/latest.json
```

If the key is lost, generate a new one (`npx tauri signer generate -w ~/.tauri/synthcreator3d.key --ci --force`) and update `plugins.updater.pubkey` in `tauri.conf.json` — old installs will then fail signature checks and need a one-time manual update.

### Authoring a pack for a new model

1. Inventory the model's structure (shape keys, meshes, materials, UV maps): `blender --background --python pipeline/blender_export.py -- inventory <model.blend> out/`
2. Author a manifest from the inventory (`docs/manifest-schema.md`) plus mask/packing specs (`pipeline/specs/`).
3. Extract textures and masks from the source PSDs (`pipeline/README.md` has the full flow), pack masks, bake the shading map.
4. Drop the pack where the app can load it. See `pipeline/README.md`.

## Roadmap

- [x] Manifest-driven viewer: toggles, morph sliders, texture sets, region tinting, emissive
- [x] Presets, share codes, screenshot/turntable, GLB + texture + VRChat-config export
- [x] Synth model packs (SFW + NSFW): GLB or FBX, tintable textures, palettes
- [x] Pack selector + 18+ gate for NSFW packs
- [x] Pose library (T-pose, Relaxed, Kneel)
- [x] Tauri desktop shell + NSIS installer + app icon
- [x] In-app import flow (convert user's own files; progress bar, variant guard)
- [x] Auto-updater (minisign-verified, GitHub releases feed)
- [ ] More models (the manifest/pipeline system is built for it — each model is a new pack)
