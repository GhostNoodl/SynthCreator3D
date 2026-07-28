/**
 * Generates public/packs/placeholder/ — a synthetic model pack used until the
 * real pipeline produces one. Run via `npm run gen:placeholder`.
 *
 * The GLB is built with three + GLTFExporter in Node and then parsed back to
 * assert that node names, material names, and morph target names actually made
 * it into the binary. The script exits non-zero if any assertion fails.
 */
import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import pngjsPkg from 'pngjs';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const { PNG } = pngjsPkg;

// GLTFExporter assembles the GLB through FileReader in some three versions;
// provide a minimal polyfill on Node (only the array-buffer path is used here).
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

const PACK_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'packs', 'placeholder');

const MORPH_NAMES = ['ThighButt', 'ThickerBody', 'Belly'];
/** Morph on the Head mesh, driven by a toggle option (exercises morph toggles). */
const HEAD_MORPH_NAMES = ['BigHead'];
const NODE_NAMES = [
  'Body',
  'Head',
  'EarVisor_Round',
  'EarVisor_Pointy',
  'Antenna',
  'Hoodie_Full',
  'Hoodie_Sleeveless',
];
const MATERIAL_NAMES = ['MainBody', 'Clothing'];

// --------------------------------------------------------------------------
// GLB
// --------------------------------------------------------------------------

const clamp01 = (v) => Math.min(1, Math.max(0, v));
/** smoothstep that also works with edge0 > edge1 (falloff direction). */
const smooth = (edge0, edge1, v) => {
  const t = clamp01((v - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
};

function buildBody() {
  const geo = new THREE.SphereGeometry(1, 48, 32);
  geo.scale(0.85, 1.15, 0.7); // capsule-ish torso; +z is the front (faces the default camera)

  const base = geo.attributes.position;
  const thighButt = new Float32Array(base.count * 3);
  const thicker = new Float32Array(base.count * 3);
  const belly = new Float32Array(base.count * 3);

  for (let i = 0; i < base.count; i++) {
    const x = base.getX(i);
    const y = base.getY(i);
    const z = base.getZ(i);

    // ThickerBody: uniform widening.
    thicker[i * 3] = x * 0.18;
    thicker[i * 3 + 2] = z * 0.18;

    // ThighButt: widen the lower body and push the back (-z) out.
    const w = smooth(-0.1, -0.9, y);
    thighButt[i * 3] = x * 0.35 * w;
    thighButt[i * 3 + 2] = (z < 0 ? z * 0.6 : z * 0.1) * w;

    // Belly: rounded front bulge around the midriff.
    const bw = Math.exp(-((y / 0.45) ** 2)) * Math.max(0, z);
    belly[i * 3 + 2] = 0.5 * bw;
  }

  // GLTFExporter takes morph target names from mesh.morphTargetDictionary,
  // which updateMorphTargets() builds from each morph attribute's `.name`.
  const morphs = [thighButt, thicker, belly].map((data, i) => {
    const attr = new THREE.BufferAttribute(data, 3);
    attr.name = MORPH_NAMES[i];
    return attr;
  });
  geo.morphAttributes.position = morphs;
  geo.morphTargetsRelative = true; // GLTF only supports relative morphs

  const mesh = new THREE.Mesh(geo);
  mesh.name = 'Body';
  mesh.position.y = 1.2;
  mesh.updateMorphTargets();
  return mesh;
}

function buildHead(material) {
  const geo = new THREE.SphereGeometry(0.55, 32, 24);

  // BigHead: uniform 25% inflation, driven by the antenna group's "bigHead"
  // toggle option (exercises morph-driving options in this pack).
  const base = geo.attributes.position;
  const bigHead = new Float32Array(base.count * 3);
  for (let i = 0; i < base.count; i++) {
    bigHead[i * 3] = base.getX(i) * 0.25;
    bigHead[i * 3 + 1] = base.getY(i) * 0.25;
    bigHead[i * 3 + 2] = base.getZ(i) * 0.25;
  }
  const attr = new THREE.BufferAttribute(bigHead, 3);
  attr.name = HEAD_MORPH_NAMES[0];
  geo.morphAttributes.position = [attr];
  geo.morphTargetsRelative = true;

  const head = new THREE.Mesh(geo, material);
  head.name = 'Head';
  head.scale.set(1, 1.1, 0.95);
  head.position.y = 2.5;
  head.updateMorphTargets();
  return head;
}

function buildScene() {
  const scene = new THREE.Scene();

  const bodyMat = new THREE.MeshStandardMaterial({
    name: 'MainBody',
    color: 0xffffff, // white so tint regions are visible
    roughness: 0.6,
    metalness: 0.05,
  });
  const clothingMat = new THREE.MeshStandardMaterial({
    name: 'Clothing',
    color: 0xffffff, // albedo comes from texture sets; keep white here too
    roughness: 0.9,
    metalness: 0,
    side: THREE.DoubleSide,
  });

  const body = buildBody();
  body.material = bodyMat;
  scene.add(body);

  scene.add(buildHead(bodyMat));

  const earRound = new THREE.Mesh(new THREE.SphereGeometry(0.28, 24, 16), bodyMat);
  earRound.name = 'EarVisor_Round';
  earRound.scale.set(0.45, 1, 1);
  earRound.position.set(0.58, 2.55, 0);
  scene.add(earRound);

  const earPointy = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.5, 20), bodyMat);
  earPointy.name = 'EarVisor_Pointy';
  earPointy.rotation.z = -Math.PI / 2;
  earPointy.position.set(0.68, 2.55, 0);
  scene.add(earPointy);

  const antenna = new THREE.Group();
  antenna.name = 'Antenna';
  const stalk = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.5, 10), bodyMat);
  stalk.position.y = 0.25;
  const tip = new THREE.Mesh(new THREE.SphereGeometry(0.07, 16, 12), bodyMat);
  tip.position.y = 0.53;
  antenna.add(stalk, tip);
  antenna.position.set(0, 3.05, 0);
  scene.add(antenna);

  const hoodieFull = new THREE.Mesh(new THREE.CylinderGeometry(0.95, 1.15, 1.15, 32, 1, true), clothingMat);
  hoodieFull.name = 'Hoodie_Full';
  hoodieFull.position.y = 1.35;
  scene.add(hoodieFull);

  const hoodieSleeveless = new THREE.Mesh(
    new THREE.CylinderGeometry(0.92, 1.05, 0.7, 32, 1, true),
    clothingMat,
  );
  hoodieSleeveless.name = 'Hoodie_Sleeveless';
  hoodieSleeveless.position.y = 1.55;
  scene.add(hoodieSleeveless);

  return scene;
}

function exportGlb(scene) {
  const exporter = new GLTFExporter();
  return new Promise((resolve, reject) => {
    exporter.parse(scene, resolve, reject, { binary: true });
  });
}

/** Parse the JSON chunk of a GLB buffer (no deps) and assert pack contents. */
function verifyGlb(buffer) {
  const failures = [];
  const check = (cond, msg) => {
    if (!cond) failures.push(msg);
  };

  check(buffer.readUInt32LE(0) === 0x46546c67, 'bad GLB magic');
  const jsonLength = buffer.readUInt32LE(12);
  check(buffer.readUInt32LE(16) === 0x4e4f534a, 'first GLB chunk is not JSON');
  const gltf = JSON.parse(buffer.subarray(20, 20 + jsonLength).toString('utf8'));

  const nodeNames = new Set((gltf.nodes ?? []).map((n) => n.name));
  for (const name of NODE_NAMES) check(nodeNames.has(name), `missing node "${name}"`);

  const matNames = new Set((gltf.materials ?? []).map((m) => m.name));
  for (const name of MATERIAL_NAMES) check(matNames.has(name), `missing material "${name}"`);

  const checkMorphs = (nodeName, expected) => {
    const node = (gltf.nodes ?? []).find((n) => n.name === nodeName);
    const mesh = node && Number.isInteger(node.mesh) ? gltf.meshes[node.mesh] : null;
    check(mesh != null, `${nodeName} node has no mesh`);
    if (mesh) {
      const targets = mesh.primitives?.[0]?.targets;
      check(Array.isArray(targets) && targets.length === expected.length,
        `${nodeName} primitives[0].targets: expected ${expected.length} morph targets, got ${targets?.length ?? 'none'}`);
      const targetNames = mesh.extras?.targetNames ?? node.extras?.targetNames;
      check(JSON.stringify(targetNames) === JSON.stringify(expected),
        `${nodeName} morph target names: expected ${JSON.stringify(expected)}, got ${JSON.stringify(targetNames)}`);
    }
  };
  checkMorphs('Body', MORPH_NAMES);
  checkMorphs('Head', HEAD_MORPH_NAMES);

  if (failures.length > 0) {
    throw new Error(`GLB verification failed:\n  - ${failures.join('\n  - ')}`);
  }
  console.log(`GLB verified: ${NODE_NAMES.length} nodes, materials [${MATERIAL_NAMES.join(', ')}], morphs [${MORPH_NAMES.join(', ')}] + [${HEAD_MORPH_NAMES.join(', ')}]`);
}

// --------------------------------------------------------------------------
// PNG textures (via pngjs)
// --------------------------------------------------------------------------

function makePng(width, height, fill) {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = fill(x, y);
      const i = (y * width + x) * 4;
      png.data[i] = r;
      png.data[i + 1] = g;
      png.data[i + 2] = b;
      png.data[i + 3] = a;
    }
  }
  return PNG.sync.write(png);
}

const solid = (r, g, b) => () => [r, g, b, 255];

function writeTextures() {
  const files = {
    // Set 1: plain albedos (near-white body so tints read well).
    'textures/set1/body_albedo.png': makePng(256, 256, solid(205, 205, 210)),
    'textures/set1/clothing_albedo.png': makePng(256, 256, solid(150, 155, 170)),
    // Set 2: simple woven pattern on the body, warmer clothing tone.
    'textures/set2/body_albedo.png': makePng(256, 256, (x, y) => {
      const line = (x + y) % 32 < 4 || (x - y + 256) % 32 < 4;
      const v = line ? 165 : 215;
      return [v, v, v + 5, 255];
    }),
    'textures/set2/clothing_albedo.png': makePng(256, 256, (x, y) => {
      const checker = (Math.floor(x / 32) + Math.floor(y / 32)) % 2 === 0;
      return checker ? [170, 140, 120, 255] : [140, 115, 100, 255];
    }),
    // Masks (white = affected). Grayscale, used as data.
    'textures/masks/body_trim.png': makePng(256, 256, (_x, y) => {
      const band = y >= 104 && y <= 140; // horizontal stripe
      const v = band ? 255 : 0;
      return [v, v, v, 255];
    }),
    'textures/masks/visor_glow.png': makePng(256, 256, (x, y) => {
      const d = Math.hypot(x - 128, y - 100);
      const v = d < 42 ? 255 : 0; // round glow spot
      return [v, v, v, 255];
    }),
  };
  for (const [rel, buf] of Object.entries(files)) {
    const p = join(PACK_DIR, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, buf);
  }
  console.log(`textures written: ${Object.keys(files).length} PNGs`);
}

// --------------------------------------------------------------------------
// manifest.json (v1, see docs/manifest-schema.md) — exercises every feature
// --------------------------------------------------------------------------

const MANIFEST = {
  schemaVersion: 1,
  id: 'placeholder-synth',
  name: 'Placeholder Synth',
  model: 'model.glb',
  materials: {
    body: { glbMaterial: 'MainBody' },
    clothing: { glbMaterial: 'Clothing' },
  },
  toggleGroups: [
    {
      id: 'earVisorShape',
      label: 'Ear Visor Shape',
      mode: 'exclusive',
      options: [
        { id: 'round', label: 'Round', nodes: ['EarVisor_Round'], default: true },
        { id: 'pointy', label: 'Pointy', nodes: ['EarVisor_Pointy'] },
        { id: 'none', label: 'None', nodes: [] },
      ],
    },
    {
      id: 'antenna',
      label: 'Antenna',
      mode: 'independent',
      options: [
        { id: 'antenna', label: 'Antenna', nodes: ['Antenna'], default: true },
        // morph-driving option: checked inflates the head, unchecked deflates it
        { id: 'bigHead', label: 'Big Head', morphs: { BigHead: 1 }, morphsOff: { BigHead: 0 } },
      ],
    },
    {
      id: 'hoodieStyle',
      label: 'Hoodie Style',
      mode: 'exclusive',
      options: [
        { id: 'full', label: 'Full', nodes: ['Hoodie_Full'] },
        { id: 'sleeveless', label: 'Sleeveless', nodes: ['Hoodie_Sleeveless'] },
        { id: 'none', label: 'None', nodes: [], default: true },
      ],
    },
  ],
  sliders: [
    {
      id: 'thighsButt',
      label: 'Thighs + Butt',
      group: 'Body',
      morphs: ['ThighButt'],
      min: 0,
      max: 1,
      default: 0,
      conflicts: ['bellyStandard'],
    },
    {
      id: 'thickerBody',
      label: 'Thicker Body',
      group: 'Body',
      morphs: ['ThickerBody'],
      min: 0,
      max: 1,
      default: 0,
    },
    {
      id: 'bellyStandard',
      label: 'Belly',
      group: 'Body',
      morphs: ['Belly'],
      min: 0,
      max: 1,
      default: 0,
      conflicts: ['thighsButt'],
    },
  ],
  textureSets: [
    {
      id: 'set1',
      label: 'Texture Set 1',
      maps: {
        body: 'textures/set1/body_albedo.png',
        clothing: 'textures/set1/clothing_albedo.png',
      },
    },
    {
      id: 'set2',
      label: 'Texture Set 2',
      maps: {
        body: 'textures/set2/body_albedo.png',
        clothing: 'textures/set2/clothing_albedo.png',
      },
    },
  ],
  colorRegions: [
    {
      id: 'bodyTrim',
      label: 'Body Trim',
      material: 'body',
      mask: 'textures/masks/body_trim.png',
      defaultColor: '#37c8ff',
    },
  ],
  emissiveRegions: [
    {
      id: 'visorGlow',
      label: 'Visor Glow',
      material: 'body',
      mask: 'textures/masks/visor_glow.png',
      defaultColor: '#ff3fa4',
      intensity: 1.0,
    },
  ],
};

// --------------------------------------------------------------------------

async function main() {
  mkdirSync(PACK_DIR, { recursive: true });

  const glb = await exportGlb(buildScene());
  const glbPath = join(PACK_DIR, 'model.glb');
  writeFileSync(glbPath, Buffer.from(glb));
  verifyGlb(readFileSync(glbPath)); // verify what actually landed on disk

  writeTextures();
  writeFileSync(join(PACK_DIR, 'manifest.json'), JSON.stringify(MANIFEST, null, 2) + '\n');
  console.log(`placeholder pack written to ${PACK_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
