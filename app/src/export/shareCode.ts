import { loadPreset } from '../state/presetLogic.ts';
import type { PresetState } from '../state/presetLogic.ts';

/**
 * Share codes: a version-tagged, copy-pasteable string encoding a preset.
 * Format: `SYNTH1.<base64url(JSON)>` — the "1" in the prefix is the format
 * version; bump it if the payload shape ever changes incompatibly.
 *
 * DOM-free on purpose: encoding goes through TextEncoder/TextDecoder and a
 * hand-rolled base64url over Uint8Array (no btoa/FileReader), so the Node
 * smoke test can exercise the full round-trip.
 */

export const SHARE_CODE_PREFIX = 'SYNTH1.';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** base64url (no padding) encode — compatible with atob/btoa-style decoders. */
export function uint8ToBase64Url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : null;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : null;
    out += ALPHABET[b0 >> 2] + ALPHABET[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)];
    if (b1 !== null) out += ALPHABET[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)];
    if (b2 !== null) out += ALPHABET[b2 & 0x3f];
  }
  return out;
}

/** base64url decode; padding optional. Throws on invalid characters/length. */
export function base64UrlToUint8(b64: string): Uint8Array {
  if (b64.length % 4 === 1) throw new Error('invalid base64url length');
  const out: number[] = [];
  let value = 0;
  let bits = 0;
  for (const ch of b64) {
    const idx = ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error(`invalid base64url character ${JSON.stringify(ch)}`);
    value = (value << 6) | idx;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

/** Encode a preset as a share code (compact JSON keeps the string short). */
export function encodeShareCode(preset: PresetState): string {
  const json = JSON.stringify({ version: 1, ...preset });
  return SHARE_CODE_PREFIX + uint8ToBase64Url(new TextEncoder().encode(json));
}

/**
 * Decode a share code back into a validated preset. Throws with a clear,
 * user-presentable message on any garbage input (wrong prefix, bad base64,
 * bad UTF-8, bad JSON, wrong preset shape).
 */
export function decodeShareCode(code: string): PresetState {
  const trimmed = code.trim();
  if (!trimmed.startsWith(SHARE_CODE_PREFIX)) {
    throw new Error(`share code must start with "${SHARE_CODE_PREFIX}"`);
  }
  // tolerate whitespace from line-wrapped copy/paste inside the payload
  const payload = trimmed.slice(SHARE_CODE_PREFIX.length).replace(/\s+/g, '');
  let bytes: Uint8Array;
  try {
    bytes = base64UrlToUint8(payload);
  } catch {
    throw new Error('share code payload is not valid base64url');
  }
  let json: string;
  try {
    json = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('share code payload is not valid UTF-8');
  }
  return loadPreset(json); // loadPreset throws its own clear errors
}
