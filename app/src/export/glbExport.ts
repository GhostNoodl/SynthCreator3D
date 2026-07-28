import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import type { Object3D } from 'three';

/**
 * Promise wrapper around GLTFExporter producing a binary .glb ArrayBuffer.
 *
 * DOM-free enough for Node: with no textures on the materials there is no
 * canvas/Image involvement, and the exporter's FileReader use is covered by a
 * small polyfill (same trick as scripts/make-placeholder-pack.mjs). Texture
 * embedding (CanvasTexture maps) is browser-only and happens upstream in
 * viewer/exportRuntime.ts.
 */
export function exportSceneToGlb(root: Object3D): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    new GLTFExporter().parse(
      root,
      (result) => {
        if (result instanceof ArrayBuffer) resolve(result);
        else reject(new Error('exportSceneToGlb: expected binary (ArrayBuffer) output'));
      },
      (error) => reject(error instanceof Error ? error : new Error(`GLTF export failed: ${String(error)}`)),
      { binary: true },
    );
  });
}
