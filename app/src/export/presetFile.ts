import { loadPreset } from '../state/presetLogic.ts';
import type { PresetState } from '../state/presetLogic.ts';

/**
 * Preset file format (`*.synthpreset.json`) — the envelope written by
 * "Save preset" and read by "Load preset":
 *
 * ```jsonc
 * {
 *   "schemaVersion": 1,
 *   "packId": "placeholder-synth",   // presets are pack-specific
 *   "savedAt": "<ISO timestamp>",
 *   "preset": { ... },               // validated with presetLogic.loadPreset
 *   "thumbnail": "data:image/jpeg;base64,…" // optional
 * }
 * ```
 *
 * Backward compatibility: files containing a *bare* preset (the
 * `{ version: 1, toggles, … }` shape written by presetLogic.serializePreset)
 * are still accepted; they carry no packId, so no pack check is possible.
 * Pure/DOM-free so the Node smoke test covers the whole round-trip.
 */

export const PRESET_FILE_SCHEMA_VERSION = 1;

export interface PresetFileV1 {
  schemaVersion: 1;
  packId: string;
  /** ISO 8601 timestamp. */
  savedAt: string;
  preset: PresetState;
  /** Small dataURL (JPEG/PNG) captured from the viewport; optional. */
  thumbnail?: string;
}

export interface ParsedPresetFile {
  /** null for legacy bare-preset files (no pack check possible). */
  packId: string | null;
  savedAt: string | null;
  thumbnail: string | null;
  preset: PresetState;
}

export function buildPresetFile(
  packId: string,
  preset: PresetState,
  savedAt: string,
  thumbnail?: string,
): PresetFileV1 {
  const file: PresetFileV1 = { schemaVersion: PRESET_FILE_SCHEMA_VERSION, packId, savedAt, preset };
  if (thumbnail !== undefined) file.thumbnail = thumbnail;
  return file;
}

export function serializePresetFile(file: PresetFileV1): string {
  return JSON.stringify(file, null, 2);
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/**
 * Parse and validate a preset file. Throws with a clear message on malformed
 * input. When `expectedPackId` is given and the file names a *different*
 * pack, the preset is rejected (a preset only makes sense for its own pack).
 */
export function parsePresetFile(json: string | unknown, expectedPackId?: string): ParsedPresetFile {
  let data: unknown = json;
  if (typeof json === 'string') {
    try {
      data = JSON.parse(json);
    } catch {
      throw new Error('preset file: input is not valid JSON');
    }
  }
  if (!isRecord(data)) throw new Error('preset file: expected a JSON object at the top level');

  // Envelope format (has schemaVersion/preset) vs legacy bare preset.
  if ('schemaVersion' in data || 'preset' in data) {
    if (data.schemaVersion !== PRESET_FILE_SCHEMA_VERSION) {
      throw new Error(
        `preset file: unsupported schemaVersion ${JSON.stringify(data.schemaVersion)} (expected ${PRESET_FILE_SCHEMA_VERSION})`,
      );
    }
    if (typeof data.packId !== 'string' || data.packId === '') {
      throw new Error('preset file: "packId" must be a non-empty string');
    }
    if (data.savedAt !== undefined && typeof data.savedAt !== 'string') {
      throw new Error('preset file: "savedAt" must be a string');
    }
    if (data.thumbnail !== undefined && typeof data.thumbnail !== 'string') {
      throw new Error('preset file: "thumbnail" must be a string data URL');
    }
    if (expectedPackId !== undefined && data.packId !== expectedPackId) {
      throw new Error(
        `preset file: preset belongs to pack "${data.packId}", but the loaded pack is "${expectedPackId}"`,
      );
    }
    return {
      packId: data.packId,
      savedAt: (data.savedAt as string | undefined) ?? null,
      thumbnail: (data.thumbnail as string | undefined) ?? null,
      preset: loadPreset(data.preset), // throws clear errors on a bad preset body
    };
  }

  // Legacy: bare preset JSON as written by serializePreset() — no packId to check.
  return { packId: null, savedAt: null, thumbnail: null, preset: loadPreset(data) };
}

/** Make a user-typed preset name safe to use as a file name. */
export function sanitizeFileName(name: string): string {
  const cleaned = name
    .trim()
    .replace(/[\\/:*?"<>|\x00-\x1f-]/g, '-') // OS-forbidden + control chars
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned.slice(0, 64) || 'preset';
}
