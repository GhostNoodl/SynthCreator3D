/**
 * Cross-checks the REAL pack (public/packs/zairiza-synth-sfw) against its GLB
 * and files on disk — the correctness gate for the manifest-driven features:
 *
 *   - every toggle option `nodes` entry exists as a GLB node name
 *   - every morph named by sliders / toggle option morphs / morphsOff exists
 *     in some mesh's extras.targetNames
 *   - every materials[].glbMaterial exists as a GLB material name
 *   - every texture/mask path referenced by the manifest exists on disk
 *
 * The GLB is parsed by reading its binary JSON chunk directly (no deps), the
 * same technique as make-placeholder-pack.mjs's verifyGlb. Exits non-zero and
 * prints every mismatch loudly on failure.
 *
 * Run via `npm run smoke` (after the placeholder tests) or directly:
 *   node scripts/check-real-manifest.mjs
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packId = process.argv[2] ?? 'zairiza-synth-sfw';
const PACK_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'packs', packId);

const failures = [];
const check = (cond, msg) => {
  if (!cond) failures.push(msg);
};

// ---------------------------------------------------------------------------
// manifest + GLB JSON chunk
// ---------------------------------------------------------------------------

const manifest = JSON.parse(readFileSync(join(PACK_DIR, 'manifest.json'), 'utf8'));

const glb = readFileSync(join(PACK_DIR, manifest.model ?? 'model.glb'));
check(glb.readUInt32LE(0) === 0x46546c67, 'bad GLB magic');
const jsonLength = glb.readUInt32LE(12);
check(glb.readUInt32LE(16) === 0x4e4f534a, 'first GLB chunk is not JSON');
const gltf = JSON.parse(glb.subarray(20, 20 + jsonLength).toString('utf8'));

const nodeNames = new Set((gltf.nodes ?? []).map((n) => n.name).filter(Boolean));
const materialNames = new Set((gltf.materials ?? []).map((m) => m.name).filter(Boolean));
const targetNames = new Set();
for (const mesh of gltf.meshes ?? []) {
  for (const name of mesh.extras?.targetNames ?? []) targetNames.add(name);
}
for (const node of gltf.nodes ?? []) {
  for (const name of node.extras?.targetNames ?? []) targetNames.add(name);
}

// ---------------------------------------------------------------------------
// 1. toggle option nodes exist as GLB node names
// ---------------------------------------------------------------------------

let nodeRefs = 0;
for (const group of manifest.toggleGroups ?? []) {
  for (const option of group.options ?? []) {
    for (const node of option.nodes ?? []) {
      nodeRefs++;
      check(nodeNames.has(node), `node missing in GLB: "${node}" (toggle ${group.id}/${option.id})`);
    }
  }
}

// ---------------------------------------------------------------------------
// 2. morphs named by sliders / toggle options exist as morph targets
// ---------------------------------------------------------------------------

const morphRefs = []; // [where, name]
for (const slider of manifest.sliders ?? []) {
  for (const morph of slider.morphs ?? []) morphRefs.push([`slider "${slider.id}"`, morph]);
}
for (const group of manifest.toggleGroups ?? []) {
  for (const option of group.options ?? []) {
    for (const morph of Object.keys(option.morphs ?? {})) {
      morphRefs.push([`toggle ${group.id}/${option.id} morphs`, morph]);
    }
    for (const morph of Object.keys(option.morphsOff ?? {})) {
      morphRefs.push([`toggle ${group.id}/${option.id} morphsOff`, morph]);
    }
  }
}
const referencedMorphs = new Set();
for (const [where, morph] of morphRefs) {
  referencedMorphs.add(morph);
  check(targetNames.has(morph), `morph target missing in GLB: "${morph}" (${where})`);
}

// ---------------------------------------------------------------------------
// 3. logical materials exist as GLB material names
// ---------------------------------------------------------------------------

for (const [logicalId, def] of Object.entries(manifest.materials ?? {})) {
  check(
    materialNames.has(def.glbMaterial),
    `GLB material missing: "${def.glbMaterial}" (logical material "${logicalId}")`,
  );
}

// ---------------------------------------------------------------------------
// 4. every texture/mask path exists on disk
// ---------------------------------------------------------------------------

const fileRefs = []; // [where, path]
for (const [logicalId, def] of Object.entries(manifest.materials ?? {})) {
  if (def.albedo) fileRefs.push([`material "${logicalId}" albedo`, def.albedo]);
}
for (const set of manifest.textureSets ?? []) {
  for (const [logicalId, path] of Object.entries(set.maps ?? {})) {
    fileRefs.push([`textureSet "${set.id}" maps.${logicalId}`, path]);
  }
}
for (const r of [...(manifest.colorRegions ?? []), ...(manifest.emissiveRegions ?? [])]) {
  // mask: grayscale path string, or {texture, channel} into an RGBA pack
  fileRefs.push([`region "${r.id}" mask`, typeof r.mask === 'string' ? r.mask : r.mask?.texture]);
}
for (const [where, path] of fileRefs) {
  check(existsSync(join(PACK_DIR, path)), `file missing on disk: ${path} (${where})`);
}

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

// Informational: morphs the GLB has but the manifest never drives (artist
// label separators like ":: VISEMES ::", visemes, etc.) — must stay at 0.
const unreferenced = [...targetNames].filter((name) => !referencedMorphs.has(name));

if (failures.length > 0) {
  console.error(`\ncheck-real-manifest FAILED with ${failures.length} mismatch(es):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

console.log(
  `check-real-manifest OK: ${nodeRefs} node refs, ${referencedMorphs.size} morph refs, ` +
    `${Object.keys(manifest.materials ?? {}).length} materials, ${fileRefs.length} texture paths — all resolve`,
);
console.log(
  `  (GLB: ${nodeNames.size} nodes, ${targetNames.size} morph targets, ${materialNames.size} materials; ` +
    `${unreferenced.length} morphs unreferenced by the manifest, left at 0 — e.g. ${unreferenced.slice(0, 3).join(', ')})`,
);
