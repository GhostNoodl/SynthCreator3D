# Model Pack Manifest Schema (v1)

A **model pack** is a directory the app loads at runtime:

```
<pack>/
  manifest.json      # this schema
  model.glb          # meshes (named nodes) + morph targets + base materials
  textures/          # PNGs referenced by the manifest (albedo sets, masks)
```

The pipeline (`pipeline/`) generates packs; the app (`app/`) consumes them. Neither
may hard-code model-specific names — everything goes through this manifest.

## Top level

```jsonc
{
  "schemaVersion": 1,
  "id": "zairiza-synth-sfw",
  "name": "Synth (Zairiza) — SFW",
  "model": "model.glb",
  "materials": { ... },
  "toggleGroups": [ ... ],
  "sliders": [ ... ],
  "textureSets": [ ... ],
  "colorRegions": [ ... ],
  "emissiveRegions": [ ... ]
}
```

## materials

Maps a logical material id to the GLB material name. All recolor/tint operations
target logical ids, never raw material names.

```jsonc
"materials": {
  "body":     { "glbMaterial": "MainBody", "albedo": "textures/body_albedo.png" },
  "clothing": { "glbMaterial": "Hoodie" }
}
```

- `albedo` (optional): base color map assigned at load. Required when the GLB
  carries no textures (our exporter strips them on purpose) and no `textureSets`
  exist. Texture-set maps override it per material while a set is active.

## toggleGroups — part visibility & morph toggles

```jsonc
{
  "id": "earVisorShape",
  "label": "Ear Visor Shape",
  "mode": "exclusive",          // "exclusive" (radio: exactly one on) | "independent" (checkbox per option)
  "options": [
    { "id": "round",  "label": "Round",  "nodes": ["EarVisor_Round"],  "default": true },
    { "id": "pointy", "label": "Pointy", "nodes": ["EarVisor_Pointy"] },
    { "id": "none",   "label": "None",   "nodes": [] }                 // empty nodes = "hide all" option
  ]
}
```

- `nodes` are GLB node names, exact match. One option may control several nodes.
  Exclusive groups hide sibling options' nodes; independent groups toggle their own.
- `mode: "independent"` options default to `default: false` unless specified.

### Morph-driving options

Options may also drive morph targets — this model toggles many parts via
`*_OFF` / `*_ON` shape keys instead of separate meshes:

```jsonc
{ "id": "tail", "label": "Tail",
  "morphs":    { "Tail_OFF": 0 },   // applied while the option is ACTIVE
  "morphsOff": { "Tail_OFF": 1 },   // applied while it is INACTIVE
  "default": true }
```

- Morph values apply to every mesh that has a morph target of that name.
- `morphsOff` is optional; omitted = the same morphs zeroed. Use it for
  `*_OFF`-semantics keys where "feature on" means morph value 0.
- Exclusive semantics: the active option's `morphs` apply; any morph named by a
  sibling option but not by the active one is zeroed.
- Independent semantics: checked option → `morphs`; unchecked → `morphsOff`.
- An option may combine `nodes` and `morphs` (e.g. show Hoodie mesh + set the
  body's anti-clip `Hoodie_ON` key).

## sliders — morph targets

```jsonc
{
  "id": "thighsButt",
  "label": "Thighs + Butt",
  "group": "Body",                // UI grouping header
  "morphs": ["ThighButt"],        // morph target name(s) driven together (all meshes sharing the name)
  "min": 0, "max": 1, "default": 0,
  "conflicts": ["bellyStandard"]  // optional: ids zeroed when this slider is non-zero
}
```

## textureSets — alternate albedo sets

```jsonc
{
  "id": "set2",
  "label": "Texture Set 2",
  "maps": { "body": "textures/set2/body_albedo.png", "clothing": "textures/set2/clothing_albedo.png" }
}
```

Keys are logical material ids from `materials`. The first set in the array is the default.

## colorRegions — recolorable areas

Each region tints its material's albedo where its mask channel is white
(black = untouched). Regions apply in manifest order (list bottom-most PSD
layer first); where masks overlap, the later region wins — mirror the PSD
stacking order.

```jsonc
{
  "id": "bodyTrim",
  "label": "Body Trim",
  "material": "body",              // string or array of logical material ids
  "mask": { "texture": "textures/packed/body_pack0.png", "channel": "r" },
  "defaultColor": "#37c8ff"
}
```

- `mask` is either `{texture, channel}` — one channel of an RGBA "mask pack"
  (**preferred**: WebGL guarantees only 16 fragment texture units, so each
  region needs its own sampler only if you give it one; four regions share a
  sampler when packed into R/G/B/A) — or a plain string path to a grayscale
  PNG, equivalent to `{texture: path, channel: "r"}` (fine for small packs).
- `material` may be an array (`["body", "eyes"]`) when a texture region spans
  more than one GLB material — the same mask/color applies to each.

## emissiveRegions — glow areas

Same shape as `colorRegions`, plus the mask is used as the emissive mask:

```jsonc
{
  "id": "visorGlow",
  "label": "Visor Glow",
  "material": ["body", "eyes"],
  "mask": { "texture": "textures/packed/body_pack3.png", "channel": "a" },
  "defaultColor": "#ff3fa4",
  "intensity": 1.0
}
```

Current app limitation: one emissive region per material (extra ones warn and skip).

## palettes — built-in color schemes (optional)

Named sets of region colors (e.g. the model's original texture-set variants).
Applying a palette only changes colors/emissive — never toggles or sliders.

```jsonc
"palettes": [
  { "id": "alt1", "label": "Palette 2",
    "colors": { "main": "#226f27", "secondary": "#4aaa51" },
    "emissive": { "emission": "#ffc341" } }
]
```

Regions missing from a palette keep their current color.

## NSFW flag

Top-level `"nsfw": true` marks a pack as adults-only; the app gates it behind
an 18+ confirmation.

## Conventions

- Ids: camelCase, stable — presets store ids, never labels or node names.
- Every `nodes` entry must exist in `model.glb`; every `morphs` entry must exist
  as a morph target on at least one mesh. The app's loader warns on mismatches
  but keeps running.
- Paths are relative to the pack root, forward slashes.
