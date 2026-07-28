import type { Manifest, Palette, SliderDef, ToggleGroup } from '../manifest/types.ts';

/**
 * Full serializable preset state. Keys are manifest ids (never labels or node
 * names). This is the single source of truth the viewer is driven from.
 */
export interface PresetState {
  /** groupId -> selected optionId (exclusive) or array of enabled optionIds (independent). */
  toggles: Record<string, string | string[]>;
  /** sliderId -> value within [min, max]. */
  sliders: Record<string, number>;
  /** textureSet id. */
  textureSet: string;
  /** colorRegion id -> "#rrggbb". */
  colors: Record<string, string>;
  /** emissiveRegion id -> "#rrggbb". */
  emissive: Record<string, string>;
  /** pose library id (viewer/poses.ts); 'tpose' = bind pose. */
  pose: string;
}

export const EMPTY_PRESET: PresetState = {
  toggles: {},
  sliders: {},
  textureSet: '',
  colors: {},
  emissive: {},
  pose: 'tpose',
};

function clamp(value: number, def: SliderDef): number {
  return Math.min(def.max, Math.max(def.min, value));
}

/** Build the initial preset from manifest defaults. */
export function defaultPreset(manifest: Manifest): PresetState {
  const toggles: Record<string, string | string[]> = {};
  for (const g of manifest.toggleGroups) {
    if (g.mode === 'exclusive') {
      const def = g.options.find((o) => o.default) ?? g.options[0];
      toggles[g.id] = def ? def.id : '';
    } else {
      toggles[g.id] = g.options.filter((o) => o.default).map((o) => o.id);
    }
  }
  const sliders: Record<string, number> = {};
  for (const s of manifest.sliders) sliders[s.id] = clamp(s.default, s);
  const colors: Record<string, string> = {};
  for (const r of manifest.colorRegions) colors[r.id] = r.defaultColor;
  const emissive: Record<string, string> = {};
  for (const r of manifest.emissiveRegions) emissive[r.id] = r.defaultColor;
  return { toggles, sliders, textureSet: manifest.textureSets[0]?.id ?? '', colors, emissive, pose: 'tpose' };
}

/**
 * Conflict resolution: clamp `value` into the slider's range; when the
 * resulting value is non-zero, every slider listed in its `conflicts` is
 * zeroed. Returns a new record; the input is not mutated.
 */
export function applySliderChange(
  sliders: Record<string, number>,
  defs: SliderDef[],
  id: string,
  value: number,
): Record<string, number> {
  const def = defs.find((d) => d.id === id);
  if (!def) return sliders;
  const next = { ...sliders, [id]: clamp(value, def) };
  if (next[id] !== 0 && def.conflicts) {
    for (const otherId of def.conflicts) {
      if (otherId in next) next[otherId] = 0;
    }
  }
  return next;
}

/**
 * Morph values implied by the current toggle selection, flattened to
 * morph name -> value (see docs/manifest-schema.md "Morph-driving options"):
 *
 * - exclusive: the active option's `morphs` apply; any morph named by a
 *   sibling option but not by the active one is zeroed.
 * - independent: a checked option applies its `morphs`; an unchecked one
 *   applies its `morphsOff` (omitted = the same morphs zeroed).
 *
 * Unknown/missing selections fall back the same way defaultPreset does.
 */
export function toggleMorphValues(
  groups: ToggleGroup[],
  toggles: Record<string, string | string[]>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const group of groups) {
    const selection = toggles[group.id];
    if (group.mode === 'exclusive') {
      const active =
        group.options.find((o) => o.id === selection) ??
        group.options.find((o) => o.default) ??
        group.options[0];
      if (!active) continue;
      const activeNames = new Set(Object.keys(active.morphs ?? {}));
      for (const sibling of group.options) {
        if (sibling === active) continue;
        for (const name of Object.keys(sibling.morphs ?? {})) {
          if (!activeNames.has(name)) out[name] = 0;
        }
      }
      Object.assign(out, active.morphs);
    } else {
      for (const option of group.options) {
        const enabled = Array.isArray(selection) && selection.includes(option.id);
        if (enabled) {
          Object.assign(out, option.morphs);
        } else if (option.morphsOff) {
          Object.assign(out, option.morphsOff);
        } else {
          for (const name of Object.keys(option.morphs ?? {})) out[name] = 0;
        }
      }
    }
  }
  return out;
}

/**
 * Apply a palette to a preset: only colors/emissive change — toggles, sliders
 * and the texture set are never touched. With `resetToDefaults: true` every
 * color/emissive first returns to the manifest default, then the palette's
 * own entries apply on top; regions the palette omits keep their current
 * color otherwise. Returns a new preset; the input is not mutated.
 */
export function applyPaletteToPreset(preset: PresetState, palette: Palette, manifest: Manifest): PresetState {
  const baseColors: Record<string, string> = palette.resetToDefaults
    ? Object.fromEntries(manifest.colorRegions.map((r) => [r.id, r.defaultColor]))
    : preset.colors;
  const baseEmissive: Record<string, string> = palette.resetToDefaults
    ? Object.fromEntries(manifest.emissiveRegions.map((r) => [r.id, r.defaultColor]))
    : preset.emissive;
  return {
    ...preset,
    colors: { ...baseColors, ...palette.colors },
    emissive: { ...baseEmissive, ...palette.emissive },
  };
}

// ---------------------------------------------------------------------------
// Preset (de)serialization — JSON round-trip helpers for future export/share.
// ---------------------------------------------------------------------------

interface SerializedPreset extends PresetState {
  version: 1;
}

export function serializePreset(preset: PresetState): string {
  const payload: SerializedPreset = { version: 1, ...preset };
  return JSON.stringify(payload, null, 2);
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function readStringRecord(x: unknown, field: string): Record<string, string> {
  if (!isRecord(x) || Object.values(x).some((v) => typeof v !== 'string')) {
    throw new Error(`loadPreset: "${field}" must be an object of strings`);
  }
  return { ...(x as Record<string, string>) };
}

function readToggles(x: unknown): Record<string, string | string[]> {
  if (
    !isRecord(x) ||
    Object.values(x).some(
      (v) => typeof v !== 'string' && !(Array.isArray(v) && v.every((e) => typeof e === 'string')),
    )
  ) {
    throw new Error('loadPreset: "toggles" must map group ids to a string or string array');
  }
  return { ...(x as Record<string, string | string[]>) };
}

/**
 * Parse a serialized preset back into state. Throws with a clear message on
 * malformed input; unknown extra fields are tolerated (forward-compatible).
 */
export function loadPreset(json: string | unknown): PresetState {
  let data: unknown = json;
  if (typeof json === 'string') {
    try {
      data = JSON.parse(json);
    } catch {
      throw new Error('loadPreset: input is not valid JSON');
    }
  }
  if (!isRecord(data)) throw new Error('loadPreset: preset must be a JSON object');

  const toggles = readToggles(data.toggles);
  if (!isRecord(data.sliders) || Object.values(data.sliders).some((v) => typeof v !== 'number')) {
    throw new Error('loadPreset: "sliders" must be an object of numbers');
  }
  const sliders = { ...(data.sliders as Record<string, number>) };
  if (typeof data.textureSet !== 'string') {
    throw new Error('loadPreset: "textureSet" must be a string');
  }
  const colors = readStringRecord(data.colors, 'colors');
  const emissive = readStringRecord(data.emissive, 'emissive');
  // pose is optional for backward compatibility with presets saved before poses
  if (data.pose !== undefined && typeof data.pose !== 'string') {
    throw new Error('loadPreset: "pose" must be a string');
  }
  const pose = typeof data.pose === 'string' && data.pose !== '' ? data.pose : 'tpose';
  return { toggles, sliders, textureSet: data.textureSet, colors, emissive, pose };
}
