import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import type { Manifest } from '../manifest/types.ts';
import { materialIdList, maskRefParts } from '../manifest/types.ts';
import type { MaskChannel } from '../manifest/types.ts';
import type { PresetState } from '../state/presetLogic.ts';
import { toggleMorphValues } from '../state/presetLogic.ts';
import type { BindPose } from './poses.ts';
import { applyPose, captureBindPose, poseById, DEFAULT_POSE_ID } from './poses.ts';

interface MorphMesh {
  dictionary: Record<string, number>;
  influences: number[];
}

interface ColorBinding {
  regionId: string;
  defaultColor: string;
  color: { value: THREE.Color };
  /** Mask texture path (an RGBA pack — several regions share one texture). */
  texture: string;
  channel: MaskChannel;
}

interface EmissiveBinding {
  regionId: string;
  defaultColor: string;
  texture: string;
  channel: MaskChannel;
  material: THREE.MeshStandardMaterial;
}

/**
 * A loaded model pack: the GLB scene graph plus everything needed to apply
 * manifest-driven preset state to it (toggles, morphs, texture sets, tints,
 * emissive). Missing nodes/morphs/materials warn once and are otherwise
 * ignored, per the schema conventions. `manifest`/`baseUrl` are public so the
 * export layer (viewer/exportRuntime.ts) can fetch the same pack textures.
 */
export class PackRuntime {
  readonly root: THREE.Object3D;
  readonly manifest: Manifest;
  /** Pack base URL (trailing slash) that manifest texture paths resolve against. */
  readonly baseUrl: string;

  private readonly textureLoader = new THREE.TextureLoader();
  private readonly textureCache = new Map<string, THREE.Texture>();
  private readonly nodeIndex = new Map<string, THREE.Object3D>();
  private readonly materials = new Map<string, THREE.MeshStandardMaterial[]>();
  private readonly originalMaps = new Map<THREE.MeshStandardMaterial, THREE.Texture | null>();
  private readonly morphMeshes: MorphMesh[] = [];
  private readonly colorBindings = new Map<THREE.MeshStandardMaterial, ColorBinding[]>();
  private readonly emissiveBindings: EmissiveBinding[] = [];
  private readonly warned = new Set<string>();
  private readonly bindPose: BindPose;
  private activePoseId = DEFAULT_POSE_ID;
  /** FBX packs sample textures with the FBX UV convention (V flipped vs glTF). */
  private readonly flipTexturesY: boolean;

  constructor(root: THREE.Object3D, manifest: Manifest, baseUrl: string, options?: { flipTexturesY?: boolean }) {
    this.root = root;
    this.manifest = manifest;
    this.baseUrl = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
    this.flipTexturesY = options?.flipTexturesY === true;

    this.indexNodes();
    this.indexMaterials();
    this.indexMorphMeshes();
    this.disableSkinnedFrustumCulling();
    this.applyManifestAlbedos();
    this.checkManifestReferences();
    this.setupRegions();
    this.bindPose = captureBindPose(root);
  }

  /** Apply a library pose on top of the bind pose (unknown ids fall back to bind). */
  setPose(poseId: string): void {
    const pose = poseById(poseId) ?? poseById(DEFAULT_POSE_ID)!;
    this.activePoseId = pose.id;
    applyPose(this.root, this.bindPose, pose);
  }

  // --------------------------------------------------------------------- setup

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    console.warn(`[pack] ${message}`);
  }

  private indexNodes(): void {
    this.root.traverse((obj) => {
      if (obj.name && !this.nodeIndex.has(obj.name)) this.nodeIndex.set(obj.name, obj);
    });
  }

  private indexMaterials(): void {
    // logical id -> GLB material name
    const wanted = new Map<string, string>();
    for (const [logicalId, def] of Object.entries(this.manifest.materials)) {
      wanted.set(def.glbMaterial, logicalId);
    }
    this.root.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const mat of mats) {
        const logicalId = wanted.get(mat.name);
        if (!logicalId) continue;
        const std = mat as THREE.MeshStandardMaterial;
        if (!std.isMeshStandardMaterial) continue;
        const list = this.materials.get(logicalId) ?? [];
        if (!list.includes(std)) list.push(std);
        this.materials.set(logicalId, list);
        if (!this.originalMaps.has(std)) this.originalMaps.set(std, std.map);
      }
    });
    for (const [logicalId, def] of Object.entries(this.manifest.materials)) {
      if (!this.materials.has(logicalId)) {
        this.warnOnce(
          `mat:${logicalId}`,
          `logical material "${logicalId}" (GLB material "${def.glbMaterial}") not found in model`,
        );
      }
    }
  }

  private indexMorphMeshes(): void {
    this.root.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.isMesh && mesh.morphTargetDictionary && mesh.morphTargetInfluences) {
        this.morphMeshes.push({
          dictionary: mesh.morphTargetDictionary,
          influences: mesh.morphTargetInfluences,
        });
      }
    });
  }

  /**
   * Morph targets displace skinned vertices well beyond the bind-pose
   * bounding volumes three.js culls against — without this, body parts
   * vanish at some camera angles when morphs are active.
   */
  private disableSkinnedFrustumCulling(): void {
    this.root.traverse((obj) => {
      if ((obj as THREE.SkinnedMesh).isSkinnedMesh) obj.frustumCulled = false;
    });
  }

  /**
   * materials[].albedo: the pack's base color maps, assigned at load. A
   * texture set's maps override these per material while a set is active
   * (see applyTextureSet); with no texture sets this is the final map.
   */
  private applyManifestAlbedos(): void {
    for (const [logicalId, def] of Object.entries(this.manifest.materials)) {
      if (!def.albedo) continue;
      const texture = this.getAlbedoTexture(def.albedo);
      for (const mat of this.materials.get(logicalId) ?? []) {
        if (mat.map !== texture) {
          mat.map = texture;
          mat.needsUpdate = true; // toggles the USE_MAP define
        }
      }
    }
  }

  /** The map a material shows when no texture set covers it: manifest albedo, else the GLB original. */
  private defaultMapFor(logicalId: string, mat: THREE.MeshStandardMaterial): THREE.Texture | null {
    const albedo = this.manifest.materials[logicalId]?.albedo;
    if (albedo) return this.getAlbedoTexture(albedo);
    return this.originalMaps.get(mat) ?? null;
  }

  private checkManifestReferences(): void {
    for (const group of this.manifest.toggleGroups) {
      for (const option of group.options) {
        for (const nodeName of option.nodes ?? []) {
          if (!this.nodeIndex.has(nodeName)) {
            this.warnOnce(`node:${nodeName}`, `toggle node "${nodeName}" not found in model`);
          }
        }
        for (const morph of Object.keys(option.morphs ?? {})) {
          if (!this.morphMeshes.some((m) => morph in m.dictionary)) {
            this.warnOnce(`morph:${morph}`, `morph target "${morph}" not found on any mesh`);
          }
        }
        for (const morph of Object.keys(option.morphsOff ?? {})) {
          if (!this.morphMeshes.some((m) => morph in m.dictionary)) {
            this.warnOnce(`morph:${morph}`, `morph target "${morph}" not found on any mesh`);
          }
        }
      }
    }
    for (const slider of this.manifest.sliders) {
      for (const morph of slider.morphs) {
        if (!this.morphMeshes.some((m) => morph in m.dictionary)) {
          this.warnOnce(`morph:${morph}`, `morph target "${morph}" not found on any mesh`);
        }
      }
    }
  }

  /**
   * Color and emissive regions are composed into the material shader with a
   * single onBeforeCompile per material:
   *
   * - After map sampling, each color region mixes diffuseColor toward
   *   diffuseColor * regionColor by its mask channel. Chaining the mixes
   *   means several regions share one material, and tinting rides on top of
   *   whatever albedo map is current.
   * - The emissive region (LIMIT: one per material — extras warn and skip)
   *   multiplies totalEmissiveRadiance by its mask channel; the color stays
   *   the built-in `emissive` uniform so live updates need no recompile.
   *
   * Masks are RGBA packs: four regions share one texture/sampler via
   * channels. This is not optional — WebGL guarantees only 16 fragment
   * texture units (MAX_TEXTURE_IMAGE_UNITS) and one sampler per region
   * exceeds that on the real model (15+ regions), killing the program on
   * actual GPUs (SwiftShader silently tolerates it, so test on hardware).
   */
  private setupRegions(): void {
    for (const [logicalId, mats] of this.materials) {
      const colorRegions = this.manifest.colorRegions.filter((r) =>
        materialIdList(r.material).includes(logicalId),
      );
      const emissiveRegions = this.manifest.emissiveRegions.filter((r) =>
        materialIdList(r.material).includes(logicalId),
      );
      for (const extra of emissiveRegions.slice(1)) {
        this.warnOnce(
          `emissive:${extra.id}:${logicalId}`,
          `emissive region "${extra.id}" skipped for material "${logicalId}": it already has one (one emissive region per material is supported)`,
        );
      }
      const emissiveRegion = emissiveRegions[0];
      if (colorRegions.length === 0 && !emissiveRegion) continue;

      const colorBindings: ColorBinding[] = colorRegions.map((r) => {
        const { texture, channel } = maskRefParts(r.mask);
        return {
          regionId: r.id,
          defaultColor: r.defaultColor,
          color: { value: new THREE.Color(r.defaultColor) },
          texture,
          channel,
        };
      });
      const emissiveMask = emissiveRegion ? maskRefParts(emissiveRegion.mask) : undefined;

      for (const mat of mats) {
        this.colorBindings.set(mat, colorBindings);
        if (emissiveRegion && emissiveMask) {
          mat.emissive = new THREE.Color(emissiveRegion.defaultColor);
          mat.emissiveIntensity = emissiveRegion.intensity;
          this.emissiveBindings.push({
            regionId: emissiveRegion.id,
            defaultColor: emissiveRegion.defaultColor,
            texture: emissiveMask.texture,
            channel: emissiveMask.channel,
            material: mat,
          });
        }
        this.injectRegionShader(mat, colorBindings, emissiveMask);
      }
    }
  }

  /** Wire one material's shader for the given color bindings (+ optional emissive mask). */
  private injectRegionShader(
    mat: THREE.MeshStandardMaterial,
    bindings: ColorBinding[],
    emissiveMask?: { texture: string; channel: MaskChannel },
  ): void {
    // One sampler uniform per unique mask texture, shared by every region
    // packed into it.
    const textureUniforms = new Map<string, string>();
    const uniformFor = (path: string): string => {
      let name = textureUniforms.get(path);
      if (!name) {
        name = `uMaskPack${textureUniforms.size}`;
        textureUniforms.set(path, name);
      }
      return name;
    };
    for (const b of bindings) uniformFor(b.texture);
    if (emissiveMask) uniformFor(emissiveMask.texture);

    mat.onBeforeCompile = (shader) => {
      for (const b of bindings) shader.uniforms[`uColor_${b.regionId}`] = b.color;
      for (const [path, name] of textureUniforms) {
        shader.uniforms[name] = { value: this.getMaskTexture(path) };
      }
      shader.vertexShader =
        'varying vec2 vRegionUv;\n' +
        shader.vertexShader.replace(
          '#include <uv_vertex>',
          '#include <uv_vertex>\n\tvRegionUv = uv;',
        );
      const declarations = [
        ...[...textureUniforms.values()].map((n) => `uniform sampler2D ${n};`),
        ...bindings.map((b) => `uniform vec3 uColor_${b.regionId};`),
      ].join('\n');
      const mixes = bindings
        .map(
          (b) =>
            `\t\tdiffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * uColor_${b.regionId}, texture2D(${uniformFor(b.texture)}, vRegionUv).${b.channel});`,
        )
        .join('\n');
      shader.fragmentShader =
        `varying vec2 vRegionUv;\n${declarations}\n` +
        shader.fragmentShader.replace(
          '#include <map_fragment>',
          `#include <map_fragment>\n${mixes}`,
        );
      if (emissiveMask) {
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <emissivemap_fragment>',
          `#include <emissivemap_fragment>\n\ttotalEmissiveRadiance *= texture2D(${uniformFor(emissiveMask.texture)}, vRegionUv).${emissiveMask.channel};`,
        );
      }
    };
    // The injected GLSL depends on which regions/masks target this material,
    // so the program cache key must reflect that (onBeforeCompile.toString()
    // is identical for every material otherwise).
    mat.customProgramCacheKey = () =>
      `regions:${bindings.map((b) => b.regionId).join(',')}|em:${emissiveMask ? 1 : 0}|${[...textureUniforms.keys()].join(',')}`;
    mat.needsUpdate = true;
  }

  // ------------------------------------------------------------------ textures

  private getAlbedoTexture(path: string): THREE.Texture {
    const key = `albedo:${path}`;
    let tex = this.textureCache.get(key);
    if (!tex) {
      tex = this.textureLoader.load(this.baseUrl + path);
      tex.flipY = this.flipTexturesY; // glTF UVs are V-flipped vs FBX UVs
      tex.colorSpace = THREE.SRGBColorSpace; // albedo is color data
      this.textureCache.set(key, tex);
    }
    return tex;
  }

  private getMaskTexture(path: string): THREE.Texture {
    const key = `mask:${path}`;
    let tex = this.textureCache.get(key);
    if (!tex) {
      tex = this.textureLoader.load(this.baseUrl + path);
      tex.flipY = this.flipTexturesY; // must match the model's UV convention
      // masks are data, not color -> keep the default (linear) color space
      this.textureCache.set(key, tex);
    }
    return tex;
  }

  // -------------------------------------------------------------------- apply

  /** Apply the full preset. Safe to call on every state change. */
  apply(preset: PresetState): void {
    if (preset.pose !== this.activePoseId) this.setPose(preset.pose);
    this.applyToggles(preset);
    this.applySliders(preset);
    this.applyTextureSet(preset.textureSet);
    this.applyColors(preset);
    this.applyEmissive(preset);
  }

  private applyToggles(preset: PresetState): void {
    for (const group of this.manifest.toggleGroups) {
      const selection = preset.toggles[group.id];
      const activeIds = new Set(
        group.mode === 'exclusive'
          ? typeof selection === 'string' ? [selection] : []
          : Array.isArray(selection) ? selection : [],
      );
      // A node may be listed by several options (e.g. the Hoodie mesh appears
      // in Full/Sleeveless/Crop Top) — it is visible iff ANY option listing
      // it is active, not merely the last one processed.
      const nodeVisible = new Map<string, boolean>();
      for (const option of group.options) {
        for (const nodeName of option.nodes ?? []) {
          if (activeIds.has(option.id)) nodeVisible.set(nodeName, true);
          else if (!nodeVisible.has(nodeName)) nodeVisible.set(nodeName, false);
        }
      }
      for (const [nodeName, visible] of nodeVisible) {
        const obj = this.nodeIndex.get(nodeName);
        if (obj) obj.visible = visible; // missing nodes already warned
      }
    }
    // Morph-driving options: pure semantics live in presetLogic.toggleMorphValues;
    // here we just push the flattened values onto every mesh that has the morph.
    const morphValues = toggleMorphValues(this.manifest.toggleGroups, preset.toggles);
    for (const mesh of this.morphMeshes) {
      for (const [morph, value] of Object.entries(morphValues)) {
        const index = mesh.dictionary[morph];
        if (index !== undefined) mesh.influences[index] = value;
      }
    }
  }

  private applySliders(preset: PresetState): void {
    for (const slider of this.manifest.sliders) {
      const value = preset.sliders[slider.id];
      if (value === undefined) continue;
      for (const mesh of this.morphMeshes) {
        for (const morph of slider.morphs) {
          const index = mesh.dictionary[morph];
          if (index !== undefined) mesh.influences[index] = value;
        }
      }
    }
  }

  private applyTextureSet(setId: string): void {
    let set = this.manifest.textureSets.find((s) => s.id === setId);
    if (!set) {
      set = this.manifest.textureSets[0];
      if (!set) return;
      this.warnOnce(`texset:${setId}`, `unknown texture set "${setId}" — falling back to "${set.id}"`);
    }
    for (const [logicalId, mats] of this.materials) {
      const path = set.maps[logicalId];
      for (const mat of mats) {
        // a set may omit a material -> fall back to the manifest albedo (or the GLB's original map)
        const next = path ? this.getAlbedoTexture(path) : this.defaultMapFor(logicalId, mat);
        if (mat.map !== next) {
          mat.map = next;
          mat.needsUpdate = true; // toggles the USE_MAP define
        }
      }
    }
  }

  private applyColors(preset: PresetState): void {
    for (const bindings of this.colorBindings.values()) {
      for (const b of bindings) {
        b.color.value.set(preset.colors[b.regionId] ?? b.defaultColor);
      }
    }
  }

  private applyEmissive(preset: PresetState): void {
    for (const b of this.emissiveBindings) {
      b.material.emissive.set(preset.emissive[b.regionId] ?? b.defaultColor);
    }
  }

  dispose(): void {
    for (const tex of this.textureCache.values()) tex.dispose();
    this.textureCache.clear();
  }
}

/**
 * Load the pack's model (as named by the manifest) and build a runtime.
 * .glb/.gltf loads via GLTFLoader; .fbx (user-imported packs) via FBXLoader.
 */
export async function loadPack(baseUrl: string, manifest: Manifest): Promise<PackRuntime> {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const url = base + manifest.model;
  if (/\.fbx$/i.test(manifest.model)) {
    const scene = await new FBXLoader().loadAsync(url);
    convertPhongMaterials(scene);
    return new PackRuntime(scene, manifest, base, { flipTexturesY: true });
  }
  const gltf = await new GLTFLoader().loadAsync(url);
  return new PackRuntime(gltf.scene, manifest, base);
}

/**
 * FBXLoader produces MeshPhongMaterial; the runtime's tint system and
 * manifest material mapping expect MeshStandardMaterial. Swap per material,
 * preserving name (the manifest's glbMaterial key) and basic factors.
 */
function convertPhongMaterials(root: THREE.Object3D): void {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh && !(mesh as THREE.SkinnedMesh).isSkinnedMesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const converted = mats.map((mat) => {
      if ((mat as THREE.MeshStandardMaterial).isMeshStandardMaterial) return mat;
      const std = new THREE.MeshStandardMaterial({ name: mat.name });
      const color = (mat as Partial<THREE.MeshPhongMaterial>).color;
      if (color) std.color.copy(color);
      return std;
    });
    mesh.material = Array.isArray(mesh.material) ? converted : converted[0];
  });
}
