import * as THREE from 'three';

/**
 * Geometry baking for GLB export. Pure three.js — no DOM — so the Node smoke
 * test can bake + export + re-import without a browser.
 *
 * `buildExportClone` produces a throwaway copy of the live scene with the
 * current preset baked in:
 *  - invisible nodes (toggle-off parts) are omitted entirely;
 *  - every mesh's morph influences are folded into its position attribute
 *    (respecting `morphTargetsRelative`) and all morph target data is
 *    stripped, so the export is a static mesh.
 *
 * Materials are shared with the source scene here; texture baking swaps them
 * for clones (see viewer/exportRuntime.ts).
 */

type PositionAttribute = THREE.BufferAttribute | THREE.InterleavedBufferAttribute;

/**
 * Return a geometry for export: if the mesh has morph targets, a clone with
 * the current influences baked into `position` and morph data stripped;
 * otherwise the original geometry is shared unchanged.
 */
function bakeMeshGeometry(mesh: THREE.Mesh): THREE.BufferGeometry {
  const source = mesh.geometry;
  const morphs = source.morphAttributes.position ?? [];
  if (morphs.length === 0) return source;

  const baked = source.clone();
  const pos = baked.attributes.position as PositionAttribute | undefined;
  if (!pos) return baked;
  const influences = mesh.morphTargetInfluences ?? [];
  const relative = source.morphTargetsRelative;

  for (let i = 0; i < morphs.length; i++) {
    const influence = influences[i] ?? 0;
    if (influence === 0) continue;
    const delta = morphs[i];
    for (let v = 0; v < pos.count; v++) {
      if (relative) {
        // GLTF morphs are relative: final = base + influence * delta
        pos.setXYZ(
          v,
          pos.getX(v) + delta.getX(v) * influence,
          pos.getY(v) + delta.getY(v) * influence,
          pos.getZ(v) + delta.getZ(v) * influence,
        );
      } else {
        // absolute morphs: final = mix(base, target, influence)
        pos.setXYZ(
          v,
          pos.getX(v) + (delta.getX(v) - pos.getX(v)) * influence,
          pos.getY(v) + (delta.getY(v) - pos.getY(v)) * influence,
          pos.getZ(v) + (delta.getZ(v) - pos.getZ(v)) * influence,
        );
      }
    }
  }
  pos.needsUpdate = true;
  baked.morphAttributes = {};
  baked.morphTargetsRelative = false;
  return baked;
}

/**
 * Deep-clone `root` for export, skipping invisible subtrees and baking morph
 * influences into cloned geometries. Node names, transforms, hierarchy and
 * materials are preserved. Throws if the root itself is invisible.
 *
 * Limitation: SkinnedMesh rigs are not specially handled (the placeholder
 * pack has none) — a skinned model would need skeleton rebinding here.
 */
export function buildExportClone(root: THREE.Object3D): THREE.Object3D {
  const cloneVisible = (node: THREE.Object3D): THREE.Object3D | null => {
    if (!node.visible) return null;
    const copy = node.clone(false); // shallow: keeps type, name, transform, material
    const mesh = copy as THREE.Mesh;
    if (mesh.isMesh) {
      mesh.geometry = bakeMeshGeometry(node as THREE.Mesh);
      mesh.morphTargetDictionary = undefined;
      mesh.morphTargetInfluences = undefined;
    }
    for (const child of node.children) {
      const clonedChild = cloneVisible(child);
      if (clonedChild) copy.add(clonedChild);
    }
    return copy;
  };
  const result = cloneVisible(root);
  if (!result) throw new Error('buildExportClone: root object is not visible');
  return result;
}
