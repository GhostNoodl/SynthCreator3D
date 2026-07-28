import { create } from 'zustand';
import type { Manifest, Palette } from '../manifest/types.ts';
import {
  applyPaletteToPreset,
  applySliderChange,
  defaultPreset,
  EMPTY_PRESET,
  loadPreset,
} from './presetLogic.ts';
import type { PresetState } from './presetLogic.ts';

export interface PresetStore {
  manifest: Manifest | null;
  preset: PresetState;
  /** Install a manifest and reset the preset to its defaults. */
  initFromManifest: (manifest: Manifest) => void;
  setExclusiveToggle: (groupId: string, optionId: string) => void;
  setIndependentOption: (groupId: string, optionId: string, enabled: boolean) => void;
  /** Clamps to the slider's range and zeroes its conflicts when non-zero. */
  setSlider: (id: string, value: number) => void;
  setTextureSet: (id: string) => void;
  setPose: (id: string) => void;
  setColor: (regionId: string, color: string) => void;
  setEmissive: (regionId: string, color: string) => void;
  /** Apply a manifest palette: colors/emissive only, never toggles/sliders/textureSet. */
  applyPalette: (palette: Palette) => void;
  /** Replace the whole preset from serialized JSON (see presetLogic.loadPreset). */
  loadPresetJson: (json: string | unknown) => void;
}

export const usePresetStore = create<PresetStore>((set) => ({
  manifest: null,
  preset: EMPTY_PRESET,

  initFromManifest: (manifest) => set({ manifest, preset: defaultPreset(manifest) }),

  setExclusiveToggle: (groupId, optionId) =>
    set((s) => ({ preset: { ...s.preset, toggles: { ...s.preset.toggles, [groupId]: optionId } } })),

  setIndependentOption: (groupId, optionId, enabled) =>
    set((s) => {
      const current = s.preset.toggles[groupId];
      const list = Array.isArray(current) ? current : [];
      const next = enabled ? [...new Set([...list, optionId])] : list.filter((id) => id !== optionId);
      return { preset: { ...s.preset, toggles: { ...s.preset.toggles, [groupId]: next } } };
    }),

  setSlider: (id, value) =>
    set((s) => ({
      preset: {
        ...s.preset,
        sliders: applySliderChange(s.preset.sliders, s.manifest?.sliders ?? [], id, value),
      },
    })),

  setTextureSet: (id) => set((s) => ({ preset: { ...s.preset, textureSet: id } })),

  setPose: (id) => set((s) => ({ preset: { ...s.preset, pose: id } })),

  setColor: (regionId, color) =>
    set((s) => ({ preset: { ...s.preset, colors: { ...s.preset.colors, [regionId]: color } } })),

  setEmissive: (regionId, color) =>
    set((s) => ({ preset: { ...s.preset, emissive: { ...s.preset.emissive, [regionId]: color } } })),

  applyPalette: (palette) =>
    set((s) => (s.manifest ? { preset: applyPaletteToPreset(s.preset, palette, s.manifest) } : s)),

  loadPresetJson: (json) => set({ preset: loadPreset(json) }),
}));
