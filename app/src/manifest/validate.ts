import type { Manifest } from './types.ts';

export interface ManifestValidation {
  /** false = required structure missing/wrong; the pack should not load. */
  ok: boolean;
  /** Human-readable problems. Unknown extra fields are tolerated silently. */
  warnings: string[];
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** morphs / morphsOff: object mapping morph target name -> number. */
function isMorphValues(x: unknown): boolean {
  return isRecord(x) && Object.values(x).every((v) => typeof v === 'number');
}

/**
 * Validates unknown data against the v1 manifest schema.
 * Fatal problems (missing/wrong-typed required fields) set ok=false AND push a
 * warning; non-fatal problems (bad cross-references, out-of-range defaults)
 * only push warnings — the loader logs them and keeps running.
 */
export function validateManifest(data: unknown): ManifestValidation {
  const warnings: string[] = [];
  let ok = true;

  const fatal = (msg: string) => {
    ok = false;
    warnings.push(msg);
  };
  const warn = (msg: string) => {
    warnings.push(msg);
  };

  if (!isRecord(data)) {
    return { ok: false, warnings: ['manifest: expected a JSON object at the top level'] };
  }

  if (data.schemaVersion !== 1) {
    warn(`schemaVersion: expected 1, got ${JSON.stringify(data.schemaVersion)} — continuing anyway`);
  }
  for (const key of ['id', 'name', 'model'] as const) {
    if (typeof data[key] !== 'string' || data[key] === '') {
      fatal(`${key}: required non-empty string`);
    }
  }
  if (data.nsfw !== undefined && typeof data.nsfw !== 'boolean') {
    warn(`nsfw: expected boolean, got ${JSON.stringify(data.nsfw)}`);
  }

  // --- materials (needed for cross-reference checks below) ---
  const materialIds = new Set<string>();
  if (!isRecord(data.materials)) {
    fatal('materials: required object mapping logical id -> { glbMaterial }');
  } else {
    for (const [logicalId, def] of Object.entries(data.materials)) {
      if (!isRecord(def) || typeof def.glbMaterial !== 'string' || def.glbMaterial === '') {
        warn(`materials.${logicalId}: expected { glbMaterial: string }`);
      } else {
        materialIds.add(logicalId);
        if (def.albedo !== undefined && (typeof def.albedo !== 'string' || def.albedo === '')) {
          warn(`materials.${logicalId}.albedo: expected non-empty string path`);
        }
      }
    }
  }

  // --- toggleGroups ---
  const toggleGroupIds = new Set<string>();
  if (!Array.isArray(data.toggleGroups)) {
    fatal('toggleGroups: required array');
  } else {
    data.toggleGroups.forEach((g, i) => {
      const at = `toggleGroups[${i}]`;
      if (!isRecord(g)) return fatal(`${at}: expected object`);
      if (typeof g.id !== 'string' || g.id === '') return fatal(`${at}.id: required non-empty string`);
      if (toggleGroupIds.has(g.id)) warn(`${at}.id: duplicate id "${g.id}"`);
      toggleGroupIds.add(g.id);
      if (typeof g.label !== 'string') warn(`${at}.label: expected string`);
      if (g.mode !== 'exclusive' && g.mode !== 'independent') {
        fatal(`${at}.mode: expected "exclusive" | "independent"`);
      }
      if (!Array.isArray(g.options) || g.options.length === 0) {
        fatal(`${at}.options: required non-empty array`);
      } else {
        let defaults = 0;
        const optionIds = new Set<string>();
        g.options.forEach((o, j) => {
          const oat = `${at}.options[${j}]`;
          if (!isRecord(o)) return warn(`${oat}: expected object`);
          if (typeof o.id !== 'string' || o.id === '') warn(`${oat}.id: required non-empty string`);
          else if (optionIds.has(o.id)) warn(`${oat}.id: duplicate id "${o.id}" in group "${String(g.id)}"`);
          else optionIds.add(o.id);
          if (typeof o.label !== 'string') warn(`${oat}.label: expected string`);
          // nodes are optional (morph-only options), but must be string[] when present
          if (o.nodes !== undefined && (!Array.isArray(o.nodes) || o.nodes.some((n) => typeof n !== 'string'))) {
            warn(`${oat}.nodes: expected array of strings`);
          }
          if (o.morphs !== undefined && !isMorphValues(o.morphs)) {
            warn(`${oat}.morphs: expected object mapping morph target name -> number`);
          }
          if (o.morphsOff !== undefined && !isMorphValues(o.morphsOff)) {
            warn(`${oat}.morphsOff: expected object mapping morph target name -> number`);
          }
          if (o.nodes === undefined && o.morphs === undefined) {
            warn(`${oat}: option "${String(o.id)}" has neither nodes nor morphs — it does nothing`);
          }
          if (o.default === true) defaults += 1;
        });
        if (g.mode === 'exclusive' && defaults !== 1) {
          warn(`${at}: exclusive group should have exactly one default option, found ${defaults} — loader falls back to the first option`);
        }
      }
    });
  }

  // --- sliders ---
  const sliderIds = new Set<string>();
  if (!Array.isArray(data.sliders)) {
    fatal('sliders: required array');
  } else {
    data.sliders.forEach((s, i) => {
      const at = `sliders[${i}]`;
      if (!isRecord(s)) return fatal(`${at}: expected object`);
      if (typeof s.id !== 'string' || s.id === '') return fatal(`${at}.id: required non-empty string`);
      if (sliderIds.has(s.id)) warn(`${at}.id: duplicate id "${s.id}"`);
      sliderIds.add(s.id);
      if (typeof s.label !== 'string') warn(`${at}.label: expected string`);
      if (typeof s.group !== 'string') warn(`${at}.group: expected string`);
      if (!Array.isArray(s.morphs) || s.morphs.length === 0 || s.morphs.some((m) => typeof m !== 'string')) {
        warn(`${at}.morphs: expected non-empty array of strings`);
      }
      for (const key of ['min', 'max', 'default'] as const) {
        if (typeof s[key] !== 'number') warn(`${at}.${key}: expected number`);
      }
      if (typeof s.min === 'number' && typeof s.max === 'number' && s.min >= s.max) {
        warn(`${at}: min (${s.min}) must be < max (${s.max})`);
      }
      if (
        typeof s.default === 'number' &&
        typeof s.min === 'number' &&
        typeof s.max === 'number' &&
        (s.default < s.min || s.default > s.max)
      ) {
        warn(`${at}.default: ${s.default} outside [${s.min}, ${s.max}] — will be clamped`);
      }
      if (s.conflicts !== undefined && (!Array.isArray(s.conflicts) || s.conflicts.some((c) => typeof c !== 'string'))) {
        warn(`${at}.conflicts: expected array of slider ids`);
      }
    });
    // conflicts cross-reference (needs all ids collected first)
    data.sliders.forEach((s, i) => {
      if (!isRecord(s) || !Array.isArray(s.conflicts)) return;
      for (const c of s.conflicts) {
        if (typeof c === 'string' && !sliderIds.has(c)) {
          warn(`sliders[${i}].conflicts: unknown slider id "${c}"`);
        }
      }
    });
  }

  // --- textureSets ---
  if (!Array.isArray(data.textureSets)) {
    fatal('textureSets: required array');
  } else {
    // empty is fine: materials[].albedo can carry the base maps instead
    const setIds = new Set<string>();
    data.textureSets.forEach((t, i) => {
      const at = `textureSets[${i}]`;
      if (!isRecord(t)) return warn(`${at}: expected object`);
      if (typeof t.id !== 'string' || t.id === '') warn(`${at}.id: required non-empty string`);
      else if (setIds.has(t.id)) warn(`${at}.id: duplicate id "${t.id}"`);
      else setIds.add(t.id);
      if (typeof t.label !== 'string') warn(`${at}.label: expected string`);
      if (!isRecord(t.maps)) {
        warn(`${at}.maps: expected object mapping logical material id -> path`);
      } else {
        for (const [logicalId, path] of Object.entries(t.maps)) {
          if (!materialIds.has(logicalId)) warn(`${at}.maps: unknown material id "${logicalId}"`);
          if (typeof path !== 'string') warn(`${at}.maps.${logicalId}: expected string path`);
        }
      }
    });
  }

  // --- colorRegions / emissiveRegions (same shape + intensity for emissive) ---
  const colorRegionIds = new Set<string>();
  const emissiveRegionIds = new Set<string>();
  const checkRegions = (list: unknown, kind: 'colorRegions' | 'emissiveRegions') => {
    if (!Array.isArray(list)) {
      fatal(`${kind}: required array`);
      return;
    }
    const ids = kind === 'colorRegions' ? colorRegionIds : emissiveRegionIds;
    list.forEach((r, i) => {
      const at = `${kind}[${i}]`;
      if (!isRecord(r)) return warn(`${at}: expected object`);
      if (typeof r.id !== 'string' || r.id === '') warn(`${at}.id: required non-empty string`);
      else if (ids.has(r.id)) warn(`${at}.id: duplicate id "${r.id}"`);
      else ids.add(r.id);
      if (typeof r.label !== 'string') warn(`${at}.label: expected string`);
      // material: a logical id, or an array of them (same mask/color applied to each)
      const refs = Array.isArray(r.material) ? r.material : [r.material];
      if (refs.length === 0 || refs.some((m) => typeof m !== 'string' || !materialIds.has(m as string))) {
        warn(`${at}.material: expected known material id or non-empty array of ids, got ${JSON.stringify(r.material)}`);
      }
      // mask: grayscale PNG path, or {texture, channel} into an RGBA pack
      if (typeof r.mask === 'string') {
        if (r.mask === '') warn(`${at}.mask: required non-empty string`);
      } else if (isRecord(r.mask)) {
        if (typeof r.mask.texture !== 'string' || r.mask.texture === '') {
          warn(`${at}.mask.texture: required non-empty string`);
        }
        if (!['r', 'g', 'b', 'a'].includes(r.mask.channel as string)) {
          warn(`${at}.mask.channel: expected "r"|"g"|"b"|"a", got ${JSON.stringify(r.mask.channel)}`);
        }
      } else {
        warn(`${at}.mask: expected path string or {texture, channel} object`);
      }
      if (typeof r.defaultColor !== 'string' || !HEX_COLOR.test(r.defaultColor)) {
        warn(`${at}.defaultColor: expected "#rgb" or "#rrggbb", got ${JSON.stringify(r.defaultColor)}`);
      }
      if (kind === 'emissiveRegions' && typeof r.intensity !== 'number') {
        warn(`${at}.intensity: expected number`);
      }
    });
  };
  checkRegions(data.colorRegions, 'colorRegions');
  checkRegions(data.emissiveRegions, 'emissiveRegions');

  // --- palettes (optional) ---
  if (data.palettes !== undefined) {
    if (!Array.isArray(data.palettes)) {
      warn('palettes: expected array');
    } else {
      const paletteIds = new Set<string>();
      const checkPaletteColors = (x: unknown, at: string, field: 'colors' | 'emissive', known: Set<string>) => {
        if (x === undefined) return;
        if (!isRecord(x)) {
          warn(`${at}.${field}: expected object mapping region id -> "#rgb"/"#rrggbb"`);
          return;
        }
        for (const [regionId, color] of Object.entries(x)) {
          if (typeof color !== 'string' || !HEX_COLOR.test(color)) {
            warn(`${at}.${field}.${regionId}: expected "#rgb"/"#rrggbb", got ${JSON.stringify(color)}`);
          }
          if (!known.has(regionId)) warn(`${at}.${field}: unknown region id "${regionId}"`);
        }
      };
      data.palettes.forEach((p, i) => {
        const at = `palettes[${i}]`;
        if (!isRecord(p)) return warn(`${at}: expected object`);
        if (typeof p.id !== 'string' || p.id === '') warn(`${at}.id: required non-empty string`);
        else if (paletteIds.has(p.id)) warn(`${at}.id: duplicate id "${p.id}"`);
        else paletteIds.add(p.id);
        if (typeof p.label !== 'string') warn(`${at}.label: expected string`);
        if (p.resetToDefaults !== undefined && typeof p.resetToDefaults !== 'boolean') {
          warn(`${at}.resetToDefaults: expected boolean`);
        }
        checkPaletteColors(p.colors, at, 'colors', colorRegionIds);
        checkPaletteColors(p.emissive, at, 'emissive', emissiveRegionIds);
      });
    }
  }

  return { ok, warnings };
}

/** Validate, log warnings to the console, and narrow to Manifest if loadable. */
export function parseManifest(data: unknown): Manifest | null {
  const { ok, warnings } = validateManifest(data);
  for (const w of warnings) console.warn(`[manifest] ${w}`);
  return ok ? (data as Manifest) : null;
}
