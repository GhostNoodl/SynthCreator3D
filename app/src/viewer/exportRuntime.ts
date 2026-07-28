import * as THREE from 'three';
import type { Manifest } from '../manifest/types.ts';
import { materialIdList, maskRefParts } from '../manifest/types.ts';
import type { PresetState } from '../state/presetLogic.ts';
import type { PackRuntime } from './pack.ts';
import { buildExportClone } from '../export/morphBake.ts';
import { exportSceneToGlb } from '../export/glbExport.ts';
import { applyColorRegions, buildEmissiveMap, extractChannel } from '../export/textureBake.ts';
import type { PixelImage } from '../export/textureBake.ts';

/**
 * Browser-only export wiring: canvas pixel plumbing, GLB export with baked
 * textures, and turntable video recording. All pixel math lives in the pure
 * modules under src/export/ (Node-tested); this file only moves data between
 * canvases, fetch, and three.js. Manual-verify territory — not covered by the
 * Node smoke test.
 */

// ---------------------------------------------------------------------------
// canvas <-> PixelImage plumbing
// ---------------------------------------------------------------------------

function drawToPixels(source: CanvasImageSource, width: number, height: number): PixelImage {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2d canvas context unavailable');
  ctx.drawImage(source, 0, 0, width, height);
  const data = ctx.getImageData(0, 0, width, height);
  return { width, height, data: data.data };
}

/** Fetch a pack texture and read its pixels (optionally rescaled to `size`). */
async function fetchPixels(url: string, size?: { width: number; height: number }): Promise<PixelImage> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`texture fetch failed (HTTP ${response.status}): ${url}`);
  const bitmap = await createImageBitmap(await response.blob());
  const width = size?.width ?? bitmap.width;
  const height = size?.height ?? bitmap.height;
  const pixels = drawToPixels(bitmap, width, height);
  bitmap.close();
  return pixels;
}

function canvasFromPixels(pixels: PixelImage): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = pixels.width;
  canvas.height = pixels.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d canvas context unavailable');
  // copy into a fresh ArrayBuffer-backed array to satisfy ImageData's typing
  ctx.putImageData(new ImageData(new Uint8ClampedArray(pixels.data), pixels.width, pixels.height), 0, 0);
  return canvas;
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('canvas.toBlob returned null'))),
      'image/png',
    );
  });
}

// ---------------------------------------------------------------------------
// materials
// ---------------------------------------------------------------------------

/** logical material id -> unique MeshStandardMaterials using its GLB material. */
function collectLogicalMaterials(
  root: THREE.Object3D,
  manifest: Manifest,
): Map<string, THREE.MeshStandardMaterial[]> {
  const glbToLogical = new Map<string, string>();
  for (const [logicalId, def] of Object.entries(manifest.materials)) {
    glbToLogical.set(def.glbMaterial, logicalId);
  }
  const out = new Map<string, THREE.MeshStandardMaterial[]>();
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const mat of mats) {
      const logicalId = glbToLogical.get(mat.name);
      if (!logicalId) continue;
      const std = mat as THREE.MeshStandardMaterial;
      if (!std.isMeshStandardMaterial) continue;
      const list = out.get(logicalId) ?? [];
      if (!list.includes(std)) list.push(std);
      out.set(logicalId, list);
    }
  });
  return out;
}

/**
 * Final albedo pixels for one logical material: the current texture set's map
 * (else the manifest albedo, else the material's live map / solid color as
 * fallback), then each color region mixed in manifest order — same source
 * data and order as pack.ts.
 */
async function bakeAlbedoPixels(
  runtime: PackRuntime,
  manifest: Manifest,
  preset: PresetState,
  logicalId: string,
  material: THREE.MeshStandardMaterial,
): Promise<PixelImage> {
  const set = manifest.textureSets.find((s) => s.id === preset.textureSet) ?? manifest.textureSets[0];
  const path = set?.maps[logicalId] ?? manifest.materials[logicalId]?.albedo;
  let base: PixelImage;
  if (path) {
    base = await fetchPixels(runtime.baseUrl + path);
  } else if (material.map?.image) {
    // no texture set or manifest albedo -> whatever map is live on the material
    const image = material.map.image as CanvasImageSource & { width: number; height: number };
    base = drawToPixels(image, image.width, image.height);
  } else {
    base = solidPixels(material.color, 256, 256);
  }
  const regions = manifest.colorRegions.filter((r) => materialIdList(r.material).includes(logicalId));
  if (regions.length === 0) return base;
  const withMasks = await Promise.all(
    regions.map(async (r) => {
      const ref = maskRefParts(r.mask);
      // masks may have a different resolution than the albedo; rescale to match
      const pack = await fetchPixels(runtime.baseUrl + ref.texture, { width: base.width, height: base.height });
      return {
        mask: extractChannel(pack, ref.channel),
        colorHex: preset.colors[r.id] ?? r.defaultColor,
      };
    }),
  );
  return applyColorRegions(base, withMasks);
}

function solidPixels(color: THREE.Color, width: number, height: number): PixelImage {
  const data = new Uint8ClampedArray(width * height * 4);
  const r = Math.round(Math.min(1, Math.max(0, color.r)) * 255);
  const g = Math.round(Math.min(1, Math.max(0, color.g)) * 255);
  const b = Math.round(Math.min(1, Math.max(0, color.b)) * 255);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = 255;
  }
  return { width, height, data };
}

// ---------------------------------------------------------------------------
// Export textures
// ---------------------------------------------------------------------------

export interface BakedTextureFile {
  name: string;
  blob: Blob;
}

/**
 * One albedo PNG per logical material (texture-set map + region tints baked)
 * plus one emissive PNG per emissive region (mask × color).
 */
export async function bakeTexturePngs(
  runtime: PackRuntime,
  manifest: Manifest,
  preset: PresetState,
): Promise<BakedTextureFile[]> {
  const files: BakedTextureFile[] = [];
  const materials = collectLogicalMaterials(runtime.root, manifest);
  for (const [logicalId, mats] of materials) {
    const mat = mats[0];
    if (!mat) continue;
    const albedo = await bakeAlbedoPixels(runtime, manifest, preset, logicalId, mat);
    files.push({ name: `${logicalId}_albedo.png`, blob: await canvasToBlob(canvasFromPixels(albedo)) });
    for (const region of manifest.emissiveRegions.filter((r) => materialIdList(r.material).includes(logicalId))) {
      const ref = maskRefParts(region.mask);
      const pack = await fetchPixels(runtime.baseUrl + ref.texture);
      const emissive = buildEmissiveMap(extractChannel(pack, ref.channel), preset.emissive[region.id] ?? region.defaultColor);
      files.push({
        name: `${logicalId}_${region.id}_emissive.png`,
        blob: await canvasToBlob(canvasFromPixels(emissive)),
      });
    }
  }
  return files;
}

// ---------------------------------------------------------------------------
// Export GLB (visible nodes only, morphs + final albedo baked in)
// ---------------------------------------------------------------------------

export async function exportBakedGlb(
  runtime: PackRuntime,
  manifest: Manifest,
  preset: PresetState,
): Promise<Blob> {
  const clone = buildExportClone(runtime.root);

  // Bake the final albedo per GLB material name (canvas textures embed fine
  // in the browser; the Node smoke test exercises the geometry-only path).
  const bakedByGlbName = new Map<string, THREE.Texture>();
  const emissiveByGlbName = new Map<string, THREE.Texture>();
  const materials = collectLogicalMaterials(runtime.root, manifest);
  for (const [logicalId, mats] of materials) {
    const mat = mats[0];
    if (!mat) continue;
    const pixels = await bakeAlbedoPixels(runtime, manifest, preset, logicalId, mat);
    const texture = new THREE.CanvasTexture(canvasFromPixels(pixels));
    texture.flipY = false; // GLTF UV convention, same as pack.ts
    texture.colorSpace = THREE.SRGBColorSpace;
    const glbName = manifest.materials[logicalId]?.glbMaterial;
    if (glbName) bakedByGlbName.set(glbName, texture);

    // Emissive: the live material's glow comes from an injected shader
    // multiply (packed mask channel × `emissive` uniform), so there is no
    // emissiveMap to carry over — bake the grayscale mask channel as one.
    // glTF emissive = emissiveFactor × emissiveTexture, matching the shader.
    const emissiveRegion = manifest.emissiveRegions.find((r) =>
      materialIdList(r.material).includes(logicalId),
    );
    if (emissiveRegion && glbName) {
      const ref = maskRefParts(emissiveRegion.mask);
      const pack = await fetchPixels(runtime.baseUrl + ref.texture);
      const maskTex = new THREE.CanvasTexture(canvasFromPixels(extractChannel(pack, ref.channel)));
      maskTex.flipY = false; // GLTF UV convention; data texture, linear space
      emissiveByGlbName.set(glbName, maskTex);
    }
  }

  // Swap materials on the clone (never mutate the live scene's materials).
  const swapped = new Map<THREE.Material, THREE.Material>();
  clone.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const next = mats.map((mat) => {
      let replacement = swapped.get(mat);
      if (!replacement) {
        replacement = mat.clone();
        if (replacement instanceof THREE.MeshStandardMaterial) {
          const baked = bakedByGlbName.get(mat.name);
          if (baked) replacement.map = baked;
          const emissiveMask = emissiveByGlbName.get(mat.name);
          if (emissiveMask) replacement.emissiveMap = emissiveMask;
        }
        swapped.set(mat, replacement);
      }
      return replacement;
    });
    mesh.material = Array.isArray(mesh.material) ? next : next[0];
  });

  const buffer = await exportSceneToGlb(clone);
  return new Blob([buffer], { type: 'model/gltf-binary' });
}

// ---------------------------------------------------------------------------
// Turntable video
// ---------------------------------------------------------------------------

/**
 * Record `durationMs` of the model making one full 360° turn to a WebM blob.
 * The MODEL rotates (not the camera), so OrbitControls/damping never fights
 * the animation; the original rotation is restored when finished. Requires
 * canvas.captureStream + MediaRecorder — manual-verify only.
 */
export function recordTurntable(
  canvas: HTMLCanvasElement,
  modelRoot: THREE.Object3D,
  durationMs = 4000,
): Promise<Blob> {
  if (typeof canvas.captureStream !== 'function') {
    throw new Error('canvas.captureStream() is not supported in this browser');
  }
  if (typeof MediaRecorder === 'undefined') {
    throw new Error('MediaRecorder is not supported in this browser');
  }
  const mimeType =
    ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((t) =>
      MediaRecorder.isTypeSupported(t),
    ) ?? '';
  const stream = canvas.captureStream(60);
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  const chunks: Blob[] = [];
  recorder.ondataavailable = (event: BlobEvent) => {
    if (event.data.size > 0) chunks.push(event.data);
  };

  const originalY = modelRoot.rotation.y;
  return new Promise<Blob>((resolve, reject) => {
    let raf = 0;
    const restore = () => {
      modelRoot.rotation.y = originalY;
    };
    recorder.onerror = () => {
      cancelAnimationFrame(raf);
      restore();
      reject(new Error('MediaRecorder failed during turntable recording'));
    };
    recorder.onstop = () => {
      restore();
      resolve(new Blob(chunks, { type: mimeType || 'video/webm' }));
    };
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      modelRoot.rotation.y = originalY + t * Math.PI * 2;
      if (t < 1) raf = requestAnimationFrame(tick);
      else recorder.stop();
    };
    recorder.start();
    raf = requestAnimationFrame(tick);
  });
}
