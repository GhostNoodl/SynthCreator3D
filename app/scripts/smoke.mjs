/**
 * Lightweight smoke test (no test framework): manifest validation, preset
 * serialize/load round-trip, and slider conflict resolution — plus the
 * zustand store wiring and a GLTFLoader round-trip of the generated GLB
 * (the same loader the app uses at runtime).
 *
 * Phase 4 (export & sharing) coverage: share-code round-trips, preset-file
 * round-trip + wrong-packId rejection, morph baking correctness, GLB
 * export -> GLTFLoader re-import, texture compositing math on synthetic
 * pixels, and the VRChat config builder. Browser-only paths (canvas capture,
 * MediaRecorder, downloads, clipboard) are NOT covered here.
 *
 * Run via `npm run smoke` (regenerates the pack first).
 * Imports the app's pure TS modules directly; Node >= 22.6 strips the types.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

// GLTFExporter assembles the GLB through FileReader; provide the same minimal
// polyfill scripts/make-placeholder-pack.mjs uses (array-buffer path only).
if (typeof globalThis.FileReader === 'undefined') {
  globalThis.FileReader = class {
    readAsArrayBuffer(blob) {
      blob.arrayBuffer().then((buf) => {
        this.result = buf;
        this.onloadend?.();
      });
    }
  };
}

import { validateManifest } from '../src/manifest/validate.ts';
import {
  applyPaletteToPreset,
  applySliderChange,
  defaultPreset,
  loadPreset,
  serializePreset,
  toggleMorphValues,
} from '../src/state/presetLogic.ts';
import { usePresetStore } from '../src/state/preset.ts';
import {
  base64UrlToUint8,
  decodeShareCode,
  encodeShareCode,
  uint8ToBase64Url,
} from '../src/export/shareCode.ts';
import {
  buildPresetFile,
  parsePresetFile,
  sanitizeFileName,
  serializePresetFile,
} from '../src/export/presetFile.ts';
import { applyColorRegions, buildEmissiveMap, hexToRgb255 } from '../src/export/textureBake.ts';
import { buildExportClone } from '../src/export/morphBake.ts';
import { exportSceneToGlb } from '../src/export/glbExport.ts';
import { buildVrcConfig, renderVrcConfigMarkdown } from '../src/export/vrcConfig.ts';
import * as THREE from 'three';
import { applyPose, captureBindPose, poseById, resetToBindPose } from '../src/viewer/poses.ts';

const PACK_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'packs', 'placeholder');

let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log(`ok - ${name}`);
}

// --- manifest loads and validates clean -----------------------------------

const manifest = JSON.parse(readFileSync(join(PACK_DIR, 'manifest.json'), 'utf8'));

await test('placeholder manifest validates with no warnings', () => {
  const { ok, warnings } = validateManifest(manifest);
  assert.deepEqual(warnings, []);
  assert.equal(ok, true);
});

await test('validateManifest rejects missing/invalid required fields', () => {
  assert.equal(validateManifest(null).ok, false);
  assert.equal(validateManifest({}).ok, false);
  const noArrays = { schemaVersion: 1, id: 'x', name: 'x', model: 'model.glb', materials: {} };
  const result = validateManifest(noArrays);
  assert.equal(result.ok, false);
  assert.ok(result.warnings.some((w) => w.startsWith('toggleGroups')));
  assert.ok(result.warnings.some((w) => w.startsWith('sliders')));
});

await test('validateManifest tolerates unknown fields, warns on bad cross-references', () => {
  const m = structuredClone(manifest);
  m.futureField = { anything: true };
  m.sliders[0].conflicts = ['noSuchSlider'];
  const { ok, warnings } = validateManifest(m);
  assert.equal(ok, true);
  assert.ok(warnings.some((w) => w.includes('noSuchSlider')));
});

// --- defaults ---------------------------------------------------------------

await test('defaultPreset picks manifest defaults', () => {
  const p = defaultPreset(manifest);
  assert.equal(p.toggles.earVisorShape, 'round'); // exclusive -> default option
  assert.deepEqual(p.toggles.antenna, ['antenna']); // independent -> array
  assert.equal(p.toggles.hoodieStyle, 'none');
  assert.deepEqual(p.sliders, { thighsButt: 0, thickerBody: 0, bellyStandard: 0 });
  assert.equal(p.textureSet, 'set1'); // first set is the default
  assert.equal(p.colors.bodyTrim, '#37c8ff');
  assert.equal(p.emissive.visorGlow, '#ff3fa4');
});

// --- serialize / load round-trip ---------------------------------------------

await test('serializePreset/loadPreset round-trips', () => {
  const p = defaultPreset(manifest);
  p.sliders.thickerBody = 0.5;
  p.toggles.earVisorShape = 'pointy';
  p.colors.bodyTrim = '#123456';
  assert.deepEqual(loadPreset(serializePreset(p)), p);
  // also accepts an already-parsed object
  assert.deepEqual(loadPreset(JSON.parse(serializePreset(p))), p);
});

await test('loadPreset throws clear errors on malformed input', () => {
  assert.throws(() => loadPreset('not json'), /not valid JSON/);
  assert.throws(() => loadPreset(42), /must be a JSON object/);
  assert.throws(
    () => loadPreset('{"toggles": {}, "sliders": 5, "textureSet": "set1", "colors": {}, "emissive": {}}'),
    /"sliders"/,
  );
});

// --- slider conflict resolution ----------------------------------------------

await test('applySliderChange clamps to range', () => {
  const defs = manifest.sliders;
  const next = applySliderChange({ thighsButt: 0, thickerBody: 0, bellyStandard: 0 }, defs, 'thickerBody', 99);
  assert.equal(next.thickerBody, 1); // max
});

await test('applySliderChange zeroes conflicts when non-zero', () => {
  const defs = manifest.sliders;
  const start = { thighsButt: 0, thickerBody: 0, bellyStandard: 0.4 };
  const next = applySliderChange(start, defs, 'thighsButt', 0.6);
  assert.equal(next.thighsButt, 0.6);
  assert.equal(next.bellyStandard, 0); // conflict zeroed
  assert.equal(start.bellyStandard, 0.4); // input not mutated
  // ...and the reverse direction (mutual conflict pair)
  const back = applySliderChange(next, defs, 'bellyStandard', 0.3);
  assert.equal(back.thighsButt, 0);
  assert.equal(back.bellyStandard, 0.3);
});

await test('applySliderChange to zero does NOT touch conflicts', () => {
  const defs = manifest.sliders;
  const start = { thighsButt: 0.5, thickerBody: 0, bellyStandard: 0.4 };
  const next = applySliderChange(start, defs, 'thighsButt', 0);
  assert.equal(next.thighsButt, 0);
  assert.equal(next.bellyStandard, 0.4);
});

await test('applySliderChange ignores unknown slider ids', () => {
  const start = { thighsButt: 0 };
  assert.equal(applySliderChange(start, manifest.sliders, 'nope', 1), start);
});

// --- morph-driving toggle options ----------------------------------------------

const MORPH_TOGGLES = [
  {
    id: 'hoodie',
    label: 'Hoodie',
    mode: 'exclusive',
    options: [
      { id: 'full', label: 'Full', nodes: ['Hoodie'], morphs: { Hoodie_ON: 1, Sleeves_OFF: 0, CropTop: 0 } },
      { id: 'sleeveless', label: 'Sleeveless', nodes: ['Hoodie'], morphs: { Hoodie_ON: 1, Sleeves_OFF: 1, CropTop: 0 } },
      { id: 'cropTop', label: 'Crop Top', morphs: { Hoodie_ON: 1, Sleeves_OFF: 0, CropTop: 1 } },
      { id: 'none', label: 'None', nodes: [], morphs: { Hoodie_ON: 0, Sleeves_OFF: 0, CropTop: 0 } },
    ],
  },
  {
    id: 'addOns',
    label: 'Add-Ons',
    mode: 'independent',
    options: [
      { id: 'tail', label: 'Tail', morphs: { Tail_OFF: 0 }, morphsOff: { Tail_OFF: 1 }, default: true },
      { id: 'spikes', label: 'Spine Spikes', morphs: { Spine_Spikes: 1 } },
    ],
  },
];

await test('toggleMorphValues: exclusive applies the active option morphs (nodes+morphs combo)', () => {
  const values = toggleMorphValues(MORPH_TOGGLES, { hoodie: 'cropTop', addOns: ['tail'] });
  assert.equal(values.Hoodie_ON, 1);
  assert.equal(values.Sleeves_OFF, 0);
  assert.equal(values.CropTop, 1);
});

await test('toggleMorphValues: exclusive zeroes morphs named only by sibling options', () => {
  const groups = [
    {
      id: 'g',
      mode: 'exclusive',
      options: [
        { id: 'a', morphs: { Shared: 1 } },
        { id: 'b', morphs: { Shared: 0, BOnly: 1 } },
      ],
    },
  ];
  const values = toggleMorphValues(groups, { g: 'a' });
  assert.equal(values.Shared, 1);
  assert.equal(values.BOnly, 0); // named by sibling b but not by active a -> zeroed
  const switched = toggleMorphValues(groups, { g: 'b' });
  assert.equal(switched.Shared, 0);
  assert.equal(switched.BOnly, 1);
});

await test('toggleMorphValues: exclusive falls back to default/first option on unknown selection', () => {
  const groups = [
    {
      id: 'g',
      mode: 'exclusive',
      options: [
        { id: 'a', morphs: { M: 1 } },
        { id: 'b', morphs: { M: 0 }, default: true },
      ],
    },
  ];
  assert.equal(toggleMorphValues(groups, {}).M, 0); // default option wins
  assert.equal(toggleMorphValues(groups, { g: 'nope' }).M, 0);
  const noDefault = [
    { id: 'g', mode: 'exclusive', options: [{ id: 'a', morphs: { M: 1 } }, { id: 'b', morphs: { M: 0 } }] },
  ];
  assert.equal(toggleMorphValues(noDefault, {}).M, 1); // else first option
});

await test('toggleMorphValues: independent checked -> morphs, unchecked -> morphsOff (OFF-semantics)', () => {
  const checked = toggleMorphValues(MORPH_TOGGLES, { hoodie: 'none', addOns: ['tail'] });
  assert.equal(checked.Tail_OFF, 0); // checked applies morphs ("feature on" = morph 0)
  const unchecked = toggleMorphValues(MORPH_TOGGLES, { hoodie: 'none', addOns: [] });
  assert.equal(unchecked.Tail_OFF, 1); // unchecked applies morphsOff ("feature off" = morph 1)
});

await test('toggleMorphValues: independent unchecked without morphsOff zeroes the morphs keys', () => {
  const off = toggleMorphValues(MORPH_TOGGLES, { hoodie: 'none', addOns: [] });
  assert.equal(off.Spine_Spikes, 0);
  const on = toggleMorphValues(MORPH_TOGGLES, { hoodie: 'none', addOns: ['spikes'] });
  assert.equal(on.Spine_Spikes, 1);
});

// --- palettes --------------------------------------------------------------------

const PALETTE_MANIFEST = {
  ...manifest,
  colorRegions: [
    { id: 'main', label: 'Main', material: ['body', 'eyes'], mask: 'm.png', defaultColor: '#f0f0f0' },
    { id: 'trim', label: 'Trim', material: 'body', mask: 'm.png', defaultColor: '#37c8ff' },
  ],
  emissiveRegions: [
    { id: 'glow', label: 'Glow', material: 'body', mask: 'm.png', defaultColor: '#ff3fa4', intensity: 1 },
  ],
};

await test('applyPaletteToPreset: partial palette keeps other colors, never touches toggles/sliders/textureSet', () => {
  const preset = {
    toggles: { g: 'x' },
    sliders: { s: 0.5 },
    textureSet: 'set2',
    colors: { main: '#111111', trim: '#222222', custom: '#333333' },
    emissive: { glow: '#444444' },
  };
  const next = applyPaletteToPreset(preset, { id: 'p', label: 'P', colors: { main: '#226f27' } }, PALETTE_MANIFEST);
  assert.equal(next.colors.main, '#226f27'); // palette entry applied
  assert.equal(next.colors.trim, '#222222'); // region missing from palette keeps its color
  assert.equal(next.colors.custom, '#333333'); // non-manifest key kept too
  assert.equal(next.emissive.glow, '#444444'); // emissive untouched
  assert.deepEqual(next.toggles, preset.toggles);
  assert.deepEqual(next.sliders, preset.sliders);
  assert.equal(next.textureSet, 'set2');
  assert.equal(preset.colors.main, '#111111'); // input not mutated
});

await test('applyPaletteToPreset: resetToDefaults restores manifest defaults, palette entries apply on top', () => {
  const preset = {
    toggles: {},
    sliders: {},
    textureSet: '',
    colors: { main: '#111111', trim: '#222222', custom: '#333333' },
    emissive: { glow: '#444444' },
  };
  const reset = applyPaletteToPreset(
    preset,
    { id: 'def', label: 'Default', resetToDefaults: true, colors: {}, emissive: {} },
    PALETTE_MANIFEST,
  );
  assert.deepEqual(reset.colors, { main: '#f0f0f0', trim: '#37c8ff' }); // non-manifest key dropped
  assert.deepEqual(reset.emissive, { glow: '#ff3fa4' });
  const both = applyPaletteToPreset(
    preset,
    { id: 'p', label: 'P', resetToDefaults: true, colors: { trim: '#000000' } },
    PALETTE_MANIFEST,
  );
  assert.deepEqual(both.colors, { main: '#f0f0f0', trim: '#000000' });
});

await test('zustand store: applyPalette action resets + applies via the manifest', () => {
  usePresetStore.getState().initFromManifest(manifest);
  usePresetStore.getState().setColor('bodyTrim', '#123456');
  usePresetStore.getState().applyPalette({ id: 'p', label: 'P', resetToDefaults: true, colors: {} });
  assert.equal(usePresetStore.getState().preset.colors.bodyTrim, '#37c8ff'); // back to manifest default
});

// --- new v1 field validation -------------------------------------------------------

const REAL_MANIFEST = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'packs', 'zairiza-synth-sfw', 'manifest.json'), 'utf8'),
);

await test('real pack manifest validates with no warnings (exercises every new v1 field)', () => {
  const { ok, warnings } = validateManifest(REAL_MANIFEST);
  assert.deepEqual(warnings, []);
  assert.equal(ok, true);
});

await test('validateManifest flags bad toggle morphs / morphsOff types', () => {
  const m = structuredClone(manifest);
  m.toggleGroups[0].options[0].morphs = { Foo: 'lots' }; // values must be numbers
  m.toggleGroups[0].options[1].morphsOff = ['not', 'a', 'record'];
  const { ok, warnings } = validateManifest(m);
  assert.equal(ok, true); // non-fatal, like other cross-reference issues
  assert.ok(warnings.some((w) => w.includes('options[0].morphs')), 'morphs warning');
  assert.ok(warnings.some((w) => w.includes('options[1].morphsOff')), 'morphsOff warning');
});

await test('validateManifest flags bad region material arrays, palettes, nsfw', () => {
  const m = structuredClone(manifest);
  m.colorRegions[0].material = ['body', 'noSuchMaterial'];
  m.emissiveRegions[0].material = [];
  m.nsfw = 'yes';
  m.palettes = [{ id: 'p', label: 'P', resetToDefaults: 'yes', colors: { bodyTrim: 'red', nope: '#123456' } }];
  const { warnings } = validateManifest(m);
  assert.ok(warnings.some((w) => w.includes('colorRegions[0].material')), 'region material array warning');
  assert.ok(warnings.some((w) => w.includes('emissiveRegions[0].material')), 'empty material array warning');
  assert.ok(warnings.some((w) => w.startsWith('nsfw')), 'nsfw warning');
  assert.ok(warnings.some((w) => w.includes('palettes[0].resetToDefaults')), 'resetToDefaults warning');
  assert.ok(warnings.some((w) => w.includes('palettes[0].colors.bodyTrim')), 'bad hex warning');
  assert.ok(warnings.some((w) => w.includes('unknown region id "nope"')), 'unknown palette region warning');
});

await test('validateManifest accepts morph-only, node-only and combined options', () => {
  const m = structuredClone(manifest); // placeholder: antenna has node-only + morph-only options
  const { ok, warnings } = validateManifest(m);
  assert.deepEqual(warnings, []);
  assert.equal(ok, true);
  // an option with neither nodes nor morphs does nothing -> warned
  const bare = structuredClone(manifest);
  bare.toggleGroups[0].options.push({ id: 'empty', label: 'Empty' });
  assert.ok(validateManifest(bare).warnings.some((w) => w.includes('neither nodes nor morphs')));
});

// --- store wiring --------------------------------------------------------------

await test('zustand store: initFromManifest + setSlider applies conflict rules', () => {
  const store = usePresetStore.getState();
  store.initFromManifest(manifest);
  assert.deepEqual(usePresetStore.getState().preset, defaultPreset(manifest));
  usePresetStore.getState().setSlider('bellyStandard', 0.5);
  usePresetStore.getState().setSlider('thighsButt', 0.3);
  const { preset } = usePresetStore.getState();
  assert.equal(preset.sliders.thighsButt, 0.3);
  assert.equal(preset.sliders.bellyStandard, 0);
});

await test('zustand store: toggles and loadPresetJson', () => {
  usePresetStore.getState().initFromManifest(manifest);
  usePresetStore.getState().setExclusiveToggle('earVisorShape', 'pointy');
  usePresetStore.getState().setIndependentOption('antenna', 'antenna', false);
  let p = usePresetStore.getState().preset;
  assert.equal(p.toggles.earVisorShape, 'pointy');
  assert.deepEqual(p.toggles.antenna, []);
  // round-trip through the store action too
  usePresetStore.getState().loadPresetJson(serializePreset(p));
  assert.deepEqual(usePresetStore.getState().preset, p);
});

// --- GLB round-trip through the same loader the app uses ---------------------

await test('GLB round-trip: node names, morph dictionary, materials survive GLTFLoader', async () => {
  const glb = readFileSync(join(PACK_DIR, 'model.glb'));
  const buffer = glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength);
  const gltf = await new Promise((resolve, reject) => {
    new GLTFLoader().parse(buffer, '', resolve, reject);
  });
  const nodeNames = new Set();
  let body = null;
  const matNames = new Set();
  gltf.scene.traverse((o) => {
    if (o.name) nodeNames.add(o.name);
    if (o.name === 'Body') body = o;
    if (o.isMesh) {
      (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => matNames.add(m.name));
    }
  });
  for (const name of ['Body', 'Head', 'EarVisor_Round', 'EarVisor_Pointy', 'Antenna', 'Hoodie_Full', 'Hoodie_Sleeveless']) {
    assert.ok(nodeNames.has(name), `missing node "${name}"`);
  }
  assert.deepEqual(body.morphTargetDictionary, { ThighButt: 0, ThickerBody: 1, Belly: 2 });
  assert.deepEqual([...body.morphTargetInfluences], [0, 0, 0]);
  assert.ok(matNames.has('MainBody') && matNames.has('Clothing'));
});

// --- Phase 4: share codes ----------------------------------------------------

await test('share code: encode/decode round-trips, incl. unicode ids', () => {
  const p = defaultPreset(manifest);
  p.sliders.thickerBody = 0.25;
  p.toggles['größe選択'] = '选项-✓'; // ids are arbitrary strings; exercise UTF-8
  const code = encodeShareCode(p);
  assert.ok(code.startsWith('SYNTH1.'));
  assert.deepEqual(decodeShareCode(code), p);
  // surrounding whitespace / line wraps from copy-paste are tolerated
  assert.deepEqual(decodeShareCode(`  ${code}\n`), p);
});

await test('share code: base64url helpers round-trip arbitrary bytes', () => {
  const bytes = Uint8Array.from([0, 1, 2, 250, 251, 252, 253, 254, 255, 66]);
  assert.deepEqual([...base64UrlToUint8(uint8ToBase64Url(bytes))], [...bytes]);
});

await test('share code: graceful errors on garbage input', () => {
  assert.throws(() => decodeShareCode('hello'), /SYNTH1\./);
  assert.throws(() => decodeShareCode('SYNTH1.@@@!!!'), /base64url/);
  assert.throws(() => decodeShareCode('SYNTH1.aGVsbG8'), /not valid JSON/); // "hello"
  const wrongShape = 'SYNTH1.' + uint8ToBase64Url(new TextEncoder().encode('{"a":1}'));
  assert.throws(() => decodeShareCode(wrongShape), /"toggles"/);
});

// --- Phase 4: preset files -----------------------------------------------------

await test('preset file: serialize/parse round-trip incl. thumbnail', () => {
  const p = defaultPreset(manifest);
  p.sliders.thickerBody = 0.7;
  const file = buildPresetFile(manifest.id, p, '2026-07-27T00:00:00.000Z', 'data:image/jpeg;base64,xx');
  const parsed = parsePresetFile(serializePresetFile(file), manifest.id);
  assert.deepEqual(parsed.preset, p);
  assert.equal(parsed.packId, manifest.id);
  assert.equal(parsed.savedAt, '2026-07-27T00:00:00.000Z');
  assert.equal(parsed.thumbnail, 'data:image/jpeg;base64,xx');
});

await test('preset file: wrong packId rejected with a clear message', () => {
  const file = buildPresetFile(manifest.id, defaultPreset(manifest), '2026-07-27T00:00:00.000Z');
  const text = serializePresetFile(file);
  assert.throws(() => parsePresetFile(text, 'some-other-pack'), /some-other-pack/);
  assert.throws(() => parsePresetFile(text, 'some-other-pack'), /placeholder-synth/);
  // ...and malformed envelopes
  assert.throws(() => parsePresetFile('{"schemaVersion":2,"packId":"x","preset":{}}'), /schemaVersion/);
  assert.throws(() => parsePresetFile('{"schemaVersion":1,"preset":{}}'), /"packId"/);
  assert.throws(() => parsePresetFile('[1,2,3]'), /expected a JSON object/);
});

await test('preset file: legacy bare presets (serializePreset format) still load', () => {
  const p = defaultPreset(manifest);
  p.toggles.earVisorShape = 'pointy';
  const parsed = parsePresetFile(serializePreset(p), manifest.id);
  assert.equal(parsed.packId, null); // no packId in the file -> no check possible
  assert.deepEqual(parsed.preset, p);
});

await test('sanitizeFileName strips OS-hostile characters', () => {
  assert.equal(sanitizeFileName('My Synth: v2/終'), 'My-Synth-v2-終');
  assert.equal(sanitizeFileName('   '), 'preset');
  assert.equal(sanitizeFileName('a/b\\c:d*e?f"g<h>i|j'), 'a-b-c-d-e-f-g-h-i-j');
});

// --- Phase 4: texture compositing math ------------------------------------------

const px = (width, height, data) => ({ width, height, data: Uint8ClampedArray.from(data) });

await test('hexToRgb255 parses #rrggbb and #rgb, rejects junk', () => {
  assert.deepEqual(hexToRgb255('#37c8ff'), [55, 200, 255]);
  assert.deepEqual(hexToRgb255('#abc'), [170, 187, 204]);
  assert.throws(() => hexToRgb255('red'), /#rrggbb/);
  assert.throws(() => hexToRgb255('#12345'), /#rrggbb/);
});

await test('applyColorRegions mirrors the shader mix (mix(base, base*color, mask))', () => {
  // px0: full mask -> base * (128/255); px1: half mask -> halfway mix; alpha preserved
  const base = px(2, 1, [200, 100, 50, 255, 200, 100, 50, 200]);
  const mask = px(2, 1, [255, 0, 0, 255, 128, 0, 0, 255]);
  const out = applyColorRegions(base, [{ mask, colorHex: '#808080' }]);
  assert.deepEqual([...out.data], [100, 50, 25, 255, 150, 75, 38, 200]);
  // black mask leaves the base untouched
  const untouched = applyColorRegions(base, [{ mask: px(2, 1, [0, 0, 0, 255, 0, 0, 0, 255]), colorHex: '#ff0000' }]);
  assert.deepEqual([...untouched.data], [...base.data]);
});

await test('applyColorRegions chains regions in order like the shader', () => {
  const base = px(1, 1, [255, 255, 255, 255]);
  const full = px(1, 1, [255, 0, 0, 255]);
  // black tint first, then white: 0 * white stays 0 — proves sequential composition
  const out = applyColorRegions(base, [
    { mask: full, colorHex: '#000000' },
    { mask: full, colorHex: '#ffffff' },
  ]);
  assert.deepEqual([...out.data], [0, 0, 0, 255]);
  // mismatched mask size is an error, not silent corruption
  assert.throws(
    () => applyColorRegions(base, [{ mask: px(2, 2, new Array(16).fill(255)), colorHex: '#000000' }]),
    /does not match/,
  );
});

await test('buildEmissiveMap produces mask × color with opaque alpha', () => {
  const mask = px(2, 1, [255, 0, 0, 255, 128, 0, 0, 255]);
  const out = buildEmissiveMap(mask, '#ff3fa4');
  assert.deepEqual([...out.data], [255, 63, 164, 255, 128, 32, 82, 255]);
});

// --- Phase 4: GLB export (morph bake + visibility) -------------------------------

const parseGlb = (arrayBuffer) =>
  new Promise((resolve, reject) => new GLTFLoader().parse(arrayBuffer, '', resolve, reject));

const findByName = (root, name) => {
  let hit = null;
  root.traverse((o) => {
    if (o.name === name) hit = o;
  });
  return hit;
};

await test('GLB export: morphs baked into positions, hidden nodes excluded, re-imports clean', async () => {
  const glb = readFileSync(join(PACK_DIR, 'model.glb'));
  const gltf = await parseGlb(glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength));
  const body = findByName(gltf.scene, 'Body');
  const pointy = findByName(gltf.scene, 'EarVisor_Pointy');
  assert.ok(body && pointy);

  body.morphTargetInfluences[0] = 1; // ThighButt, full
  body.morphTargetInfluences[2] = 0.5; // Belly, half
  pointy.visible = false; // toggle-off part must not be exported

  const out = await exportSceneToGlb(buildExportClone(gltf.scene));
  assert.ok(out.byteLength > 100);

  const re = await parseGlb(out.slice(0));
  const reBody = findByName(re.scene, 'Body');
  assert.ok(reBody);
  assert.equal(findByName(re.scene, 'EarVisor_Pointy'), null, 'hidden node must be excluded');
  assert.ok(findByName(re.scene, 'EarVisor_Round'), 'visible node must be exported');
  assert.equal((reBody.geometry.morphAttributes.position ?? []).length, 0, 'export must have no morph targets');
  assert.equal(reBody.morphTargetDictionary, undefined);

  // Every vertex must equal base + 1.0*ThighButt + 0.5*Belly — displaced
  // exactly where a morph delta is non-zero, untouched everywhere else.
  const basePos = body.geometry.attributes.position;
  const dThigh = body.geometry.morphAttributes.position[0];
  const dBelly = body.geometry.morphAttributes.position[2];
  const outPos = reBody.geometry.attributes.position;
  assert.equal(outPos.count, basePos.count);
  let displaced = 0;
  let untouched = 0;
  for (let i = 0; i < basePos.count; i++) {
    const dx = dThigh.getX(i) + 0.5 * dBelly.getX(i);
    const dy = dThigh.getY(i) + 0.5 * dBelly.getY(i);
    const dz = dThigh.getZ(i) + 0.5 * dBelly.getZ(i);
    assert.ok(Math.abs(outPos.getX(i) - (basePos.getX(i) + dx)) < 1e-5, `vertex ${i} x mismatch`);
    assert.ok(Math.abs(outPos.getY(i) - (basePos.getY(i) + dy)) < 1e-5, `vertex ${i} y mismatch`);
    assert.ok(Math.abs(outPos.getZ(i) - (basePos.getZ(i) + dz)) < 1e-5, `vertex ${i} z mismatch`);
    const moved =
      Math.abs(outPos.getX(i) - basePos.getX(i)) +
      Math.abs(outPos.getY(i) - basePos.getY(i)) +
      Math.abs(outPos.getZ(i) - basePos.getZ(i));
    const deltaMag = Math.abs(dx) + Math.abs(dy) + Math.abs(dz);
    if (deltaMag > 1e-3) {
      assert.ok(moved > 1e-4, `vertex ${i} should have been displaced`);
      displaced++;
    } else if (deltaMag === 0) {
      // f32(x + 0) === x, so a zero delta must survive the round-trip bit-exact
      assert.equal(moved, 0, `vertex ${i} has no morph delta and must not move`);
      untouched++;
    }
    // in between: float32 rounding zone, no constraint
  }
  assert.ok(displaced > 0, 'expected at least some displaced vertices');
  assert.ok(untouched > 0, 'expected at least some untouched vertices');
});

await test('buildExportClone leaves the source scene untouched', async () => {
  const glb = readFileSync(join(PACK_DIR, 'model.glb'));
  const gltf = await parseGlb(glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength));
  const body = findByName(gltf.scene, 'Body');
  body.morphTargetInfluences[1] = 1; // ThickerBody
  const before = [...body.geometry.attributes.position.array];
  buildExportClone(gltf.scene);
  assert.deepEqual([...body.geometry.attributes.position.array], before); // source not baked
  assert.deepEqual([...body.morphTargetInfluences], [0, 1, 0]); // influences intact
  assert.equal(body.geometry.morphAttributes.position.length, 3); // morphs intact
});

// --- Phase 4: VRChat config -------------------------------------------------------

await test('buildVrcConfig resolves labels, percents and hex colors', () => {
  const p = defaultPreset(manifest);
  p.toggles.earVisorShape = 'pointy';
  p.toggles.antenna = []; // independent group, nothing on
  p.sliders.thighsButt = 0.6;
  p.textureSet = 'set2';
  p.colors.bodyTrim = '#123456';
  const cfg = buildVrcConfig(manifest, p);
  assert.equal(cfg.pack.id, 'placeholder-synth');
  assert.equal(cfg.generator, 'SynthCreator3D');
  const ear = cfg.toggles.find((t) => t.id === 'earVisorShape');
  assert.deepEqual(ear.selected, [{ id: 'pointy', label: 'Pointy' }]);
  const antenna = cfg.toggles.find((t) => t.id === 'antenna');
  assert.deepEqual(antenna.selected, []);
  const hoodie = cfg.toggles.find((t) => t.id === 'hoodieStyle');
  assert.deepEqual(hoodie.selected, [{ id: 'none', label: 'None' }]);
  const thigh = cfg.sliders.find((s) => s.id === 'thighsButt');
  assert.equal(thigh.percent, 60);
  assert.equal(thigh.group, 'Body');
  assert.equal(cfg.textureSet.label, 'Texture Set 2');
  assert.deepEqual(cfg.colors, [
    { id: 'bodyTrim', label: 'Body Trim', material: 'body', color: '#123456' },
  ]);
  assert.equal(cfg.emissive[0].color, '#ff3fa4'); // default preserved
  assert.equal(cfg.emissive[0].intensity, 1);
});

await test('renderVrcConfigMarkdown contains every section', () => {
  const p = defaultPreset(manifest);
  p.toggles.earVisorShape = 'pointy';
  p.sliders.thighsButt = 0.6;
  p.colors.bodyTrim = '#123456';
  const md = renderVrcConfigMarkdown(buildVrcConfig(manifest, p));
  assert.ok(md.includes('# VRChat avatar config — Placeholder Synth'));
  assert.ok(md.includes('- Ear Visor Shape: Pointy'));
  assert.ok(md.includes('- Antenna: Antenna'));
  assert.ok(md.includes('- Body / Thighs + Butt: 60%'));
  assert.ok(md.includes('- Texture Set 1'));
  assert.ok(md.includes('- Body Trim [body]: #123456'));
  assert.ok(md.includes('- Visor Glow [body]: #ff3fa4 (intensity 1)'));
});

// --- pose library ----------------------------------------------------------

function boneChain() {
  const hip = new THREE.Bone(); hip.name = 'Hips';
  const leg = new THREE.Bone(); leg.name = 'Left leg';
  const knee = new THREE.Bone(); knee.name = 'Left knee';
  hip.add(leg); leg.add(knee);
  hip.position.set(0, 1, 0);
  leg.position.set(0.1, -0.4, 0);
  knee.position.set(0, -0.4, 0);
  const root = new THREE.Group();
  root.add(hip);
  root.updateMatrixWorld(true);
  return { root, hip, leg, knee };
}

await test('applyPose rotates a bone in world axes and resetToBindPose restores', () => {
  const { root, hip, leg } = boneChain();
  const bind = captureBindPose(root);
  const before = leg.getWorldQuaternion(new THREE.Quaternion());
  applyPose(root, bind, { id: 'x', label: 'x', instructions: [{ bone: 'Left leg', axis: [1, 0, 0], deg: 90 }] });
  const after = leg.getWorldQuaternion(new THREE.Quaternion());
  assert.ok(Math.abs(before.angleTo(after) - Math.PI / 2) < 1e-4,
    `expected a 90° world rotation, got ${before.angleTo(after)}`);
  resetToBindPose(bind);
  const restored = leg.getWorldQuaternion(new THREE.Quaternion());
  assert.ok(before.angleTo(restored) < 1e-6, 'bind pose not restored');
});

await test('applyPose composes parent-first and applies rootOffset', () => {
  const { root, hip, knee } = boneChain();
  const bind = captureBindPose(root);
  const bindQ = knee.getWorldQuaternion(new THREE.Quaternion());
  applyPose(root, bind, {
    id: 'x', label: 'x',
    rootOffset: { bone: 'Hips', offset: [0, -0.5, 0] },
    instructions: [
      { bone: 'Left leg', axis: [1, 0, 0], deg: 45 },
      { bone: 'Left knee', axis: [1, 0, 0], deg: 45 },
    ],
  });
  assert.ok(Math.abs(hip.position.y - 0.5) < 1e-6, 'rootOffset not applied');
  const kneeWorld = knee.getWorldQuaternion(new THREE.Quaternion());
  assert.ok(Math.abs(bindQ.angleTo(kneeWorld) - Math.PI / 2) < 1e-3,
    `expected composed 90° at knee, got ${bindQ.angleTo(kneeWorld)}`);
});

await test('loadPreset defaults pose to tpose and round-trips it', () => {
  const legacy = JSON.parse(serializePreset(defaultPreset(manifest)));
  delete legacy.pose; // preset saved before poses existed
  const loaded = loadPreset(legacy);
  assert.equal(loaded.pose, 'tpose');
  const withPose = loadPreset({ ...JSON.parse(serializePreset(defaultPreset(manifest))), pose: 'sit' });
  assert.equal(withPose.pose, 'sit');
  assert.ok(poseById('sit'), 'sit pose exists in library');
  assert.throws(() => loadPreset({ ...JSON.parse(serializePreset(defaultPreset(manifest))), pose: 42 }), /"pose" must be a string/);
});

console.log(`\nsmoke: ${passed} tests passed`);