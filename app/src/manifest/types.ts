/**
 * TypeScript mirror of docs/manifest-schema.md (v1).
 * Field names match the schema doc exactly; presets store ids, never labels.
 */

export interface ManifestMaterial {
  /** GLB material name this logical id maps to. */
  glbMaterial: string;
  /** Base color map assigned at load; texture-set maps override it per material. */
  albedo?: string;
}

export interface ToggleOption {
  id: string;
  label: string;
  /** GLB node names, exact match. Empty array = "hide all" option. Optional for morph-only options. */
  nodes?: string[];
  /** Morph name -> value, applied while the option is ACTIVE (every mesh that has the morph). */
  morphs?: Record<string, number>;
  /** Morph name -> value, applied while the option is INACTIVE (independent groups). Omitted = the `morphs` keys zeroed. */
  morphsOff?: Record<string, number>;
  /** exclusive: exactly one option should be default; independent: defaults to false. */
  default?: boolean;
}

export interface ToggleGroup {
  id: string;
  label: string;
  /** exclusive = radio (exactly one on); independent = checkbox per option. */
  mode: 'exclusive' | 'independent';
  options: ToggleOption[];
}

export interface SliderDef {
  id: string;
  label: string;
  /** UI grouping header. */
  group: string;
  /** Morph target name(s) driven together, on every mesh that has them. */
  morphs: string[];
  min: number;
  max: number;
  default: number;
  /** Slider ids zeroed when this slider is non-zero. */
  conflicts?: string[];
}

export interface TextureSet {
  id: string;
  label: string;
  /** logical material id -> pack-relative albedo PNG path. */
  maps: Record<string, string>;
}

/** One channel of an RGBA mask pack. Packing four regions into R/G/B/A keeps
 * the shader at one sampler per four regions — WebGL only guarantees 16
 * fragment texture units, so one texture per region does not scale. */
export type MaskChannel = 'r' | 'g' | 'b' | 'a';

export interface MaskRef {
  /** Pack-relative path to the mask texture. */
  texture: string;
  channel: MaskChannel;
}

/** A packed `{texture, channel}` reference, or a plain grayscale PNG path
 * (equivalent to `{texture: path, channel: 'r'}`). */
export type MaskRefInput = string | MaskRef;

export interface ColorRegion {
  id: string;
  label: string;
  /** Logical material id(s) from `materials` — an array applies the same mask/color to each. */
  material: string | string[];
  /** Mask reference (white = tinted, black = untouched). */
  mask: MaskRefInput;
  defaultColor: string;
}

export interface EmissiveRegion extends ColorRegion {
  intensity: number;
}

export interface Palette {
  id: string;
  label: string;
  /** true = reset all colors/emissive to manifest defaults before applying this palette's entries. */
  resetToDefaults?: boolean;
  /** colorRegion id -> "#rrggbb"; missing regions keep their current color. */
  colors?: Record<string, string>;
  /** emissiveRegion id -> "#rrggbb"; missing regions keep their current color. */
  emissive?: Record<string, string>;
}

export interface Manifest {
  schemaVersion: number;
  id: string;
  name: string;
  model: string;
  materials: Record<string, ManifestMaterial>;
  toggleGroups: ToggleGroup[];
  sliders: SliderDef[];
  textureSets: TextureSet[];
  colorRegions: ColorRegion[];
  emissiveRegions: EmissiveRegion[];
  palettes?: Palette[];
  /** true = adults-only pack; the app gates it behind an 18+ confirmation. */
  nsfw?: boolean;
}

/** Normalize a region's `material` field (string or array) to a list of logical material ids. */
export function materialIdList(material: string | string[]): string[] {
  return Array.isArray(material) ? material : [material];
}

/** Normalize a region's `mask` field to its `{texture, channel}` parts. */
export function maskRefParts(mask: MaskRefInput): MaskRef {
  return typeof mask === 'string' ? { texture: mask, channel: 'r' } : mask;
}
