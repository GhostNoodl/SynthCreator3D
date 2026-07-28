/**
 * Pose library: named sets of bone rotations applied on top of the bind pose.
 *
 * Rotations are specified in WORLD axes ({bone, axis, deg}) and applied in
 * order (parents before children), which sidesteps Blender's per-bone local
 * axis conventions: an instruction always rotates the bone the way a reader
 * expects in model space (model faces +Z, +Y up, +X model-left).
 *
 * Bone names match the Synth's skeleton; packs sharing the rig share poses.
 * Unknown bones warn once and are skipped.
 */
import * as THREE from 'three';

export interface PoseInstruction {
  bone: string;
  axis: [number, number, number];
  deg: number;
}

export interface PoseDef {
  id: string;
  label: string;
  /** Optional root offset for the named bone (usually Hips), world units. */
  rootOffset?: { bone: string; offset: [number, number, number] };
  instructions: PoseInstruction[];
}

/** Captured bind-pose transforms so any pose can be reset/rebased. */
export interface BindPose {
  entries: Map<THREE.Object3D, { position: THREE.Vector3; quaternion: THREE.Quaternion; scale: THREE.Vector3 }>;
}

export function captureBindPose(root: THREE.Object3D): BindPose {
  const entries = new Map<THREE.Object3D, { position: THREE.Vector3; quaternion: THREE.Quaternion; scale: THREE.Vector3 }>();
  root.traverse((obj) => {
    if ((obj as THREE.Bone).isBone) {
      entries.set(obj, {
        position: obj.position.clone(),
        quaternion: obj.quaternion.clone(),
        scale: obj.scale.clone(),
      });
    }
  });
  return { entries };
}

export function resetToBindPose(bind: BindPose): void {
  for (const [bone, t] of bind.entries) {
    bone.position.copy(t.position);
    bone.quaternion.copy(t.quaternion);
    bone.scale.copy(t.scale);
  }
}

/** Apply a pose on top of the bind pose. World-axis rotations, parents first. */
export function applyPose(root: THREE.Object3D, bind: BindPose, pose: PoseDef): void {
  resetToBindPose(bind);
  const boneByName = new Map<string, THREE.Object3D>();
  root.traverse((obj) => {
    if ((obj as THREE.Bone).isBone && obj.name) {
      // GLTFLoader sanitizes node names ("Left leg" -> "Left_leg"); index by
      // the GLB's original spaced name so instructions can use it.
      const key = obj.name.replace(/_/g, ' ');
      if (!boneByName.has(key)) boneByName.set(key, obj);
    }
  });

  const warned = new Set<string>();
  const parentWorldQ = new THREE.Quaternion();
  const delta = new THREE.Quaternion();
  const axis = new THREE.Vector3();

  if (pose.rootOffset) {
    const bone = boneByName.get(pose.rootOffset.bone);
    if (bone) bone.position.add(new THREE.Vector3(...pose.rootOffset.offset));
  }

  for (const { bone, axis: a, deg } of pose.instructions) {
    const obj = boneByName.get(bone);
    if (!obj) {
      if (!warned.has(bone)) {
        console.warn(`[poses] bone "${bone}" not found`);
        warned.add(bone);
      }
      continue;
    }
    obj.parent!.getWorldQuaternion(parentWorldQ);
    delta.setFromAxisAngle(axis.set(...a).normalize(), (deg * Math.PI) / 180);
    // local = parentWorld⁻¹ * delta * parentWorld * local
    obj.quaternion.copy(
      parentWorldQ.clone().invert().multiply(delta).multiply(parentWorldQ).multiply(obj.quaternion),
    );
    obj.updateMatrixWorld(true);
  }
}

export const POSES: PoseDef[] = [
  { id: 'tpose', label: 'T-Pose (bind)', instructions: [] },
  {
    id: 'relaxed',
    label: 'Relaxed (A-pose)',
    instructions: [
      // arms down toward the body, slight elbow bend
      { bone: 'Right arm', axis: [0, 0, 1], deg: 62 },
      { bone: 'Left arm', axis: [0, 0, -1], deg: 62 },
      { bone: 'Right elbow', axis: [0, 0, 1], deg: 14 },
      { bone: 'Left elbow', axis: [0, 0, -1], deg: 14 },
    ],
  },
  {
    id: 'sit',
    label: 'Kneel',
    rootOffset: { bone: 'Hips', offset: [0, -0.45, 0] },
    instructions: [
      // one knee on the ground, other foot planted in front, upright torso
      { bone: 'Right leg', axis: [1, 0, 0], deg: -12 },
      { bone: 'Right knee', axis: [1, 0, 0], deg: 88 },
      { bone: 'Right ankle', axis: [1, 0, 0], deg: -60 },
      { bone: 'Left leg', axis: [1, 0, 0], deg: 62 },
      { bone: 'Left knee', axis: [1, 0, 0], deg: 70 },
      { bone: 'Left ankle', axis: [1, 0, 0], deg: -15 },
      { bone: 'Right arm', axis: [0, 0, 1], deg: 48 },
      { bone: 'Left arm', axis: [0, 0, -1], deg: 48 },
      { bone: 'Right elbow', axis: [1, 0, 0], deg: -20 },
      { bone: 'Left elbow', axis: [1, 0, 0], deg: -20 },
    ],
  },
];

export const DEFAULT_POSE_ID = 'tpose';

export function poseById(id: string): PoseDef | undefined {
  return POSES.find((p) => p.id === id);
}
