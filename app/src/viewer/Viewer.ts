import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

/**
 * Three.js viewport: renderer, camera, orbit controls, environment lighting,
 * ground grid, resize handling. Owns the animation loop. Also owns viewport
 * capture (screenshot/thumbnail) used by the export toolbar.
 */
export class Viewer {
  readonly scene: THREE.Scene;
  /** The canvas being rendered to (screenshots, captureStream for video). */
  readonly canvas: HTMLCanvasElement;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly controls: OrbitControls;
  private readonly resizeObserver: ResizeObserver;
  private model: THREE.Object3D | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x15171c);

    // Image-based lighting from a synthetic room, plus a key light for shape.
    // Kept deliberately soft/flat: the model's textures carry baked shading,
    // and a hard key light double-shades protruding shapes (dick underside,
    // belly) into an ugly two-tone look the toon-shaded original doesn't have.
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 1.1;
    pmrem.dispose();
    const key = new THREE.DirectionalLight(0xffffff, 0.6);
    key.position.set(2.5, 4, 3);
    this.scene.add(key);
    // bright ground bounce so protruding undersides don't crush to black
    this.scene.add(new THREE.HemisphereLight(0xdfe9ff, 0x6a6258, 1.0));

    this.camera = new THREE.PerspectiveCamera(40, 1, 0.05, 100);
    this.camera.position.set(0, 1.6, 4.4);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.target.set(0, 1.1, 0);
    this.controls.enableDamping = true;
    this.controls.maxDistance = 12;
    this.controls.minDistance = 0.5;

    const grid = new THREE.GridHelper(10, 20, 0x3a4150, 0x232833);
    this.scene.add(grid);

    const container = canvas.parentElement ?? canvas;
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();

    this.renderer.setAnimationLoop(() => {
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    });
  }

  setModel(model: THREE.Object3D | null): void {
    if (this.model) this.scene.remove(this.model);
    this.model = model;
    if (model) this.scene.add(model);
  }

  /**
   * Render one frame synchronously. Reading pixels in the same JS task right
   * after this call is always safe — no preserveDrawingBuffer needed.
   */
  renderNow(): void {
    this.renderer.render(this.scene, this.camera);
  }

  /**
   * Full-resolution PNG of the current viewport. The drawing buffer already
   * includes the devicePixelRatio scaling set on the renderer, so the PNG is
   * high-DPI without any extra work.
   */
  capturePngBlob(): Promise<Blob> {
    this.renderNow();
    return new Promise((resolve, reject) => {
      this.canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('canvas.toBlob returned null'))),
        'image/png',
      );
    });
  }

  /** Small JPEG dataURL (long edge ~`maxSize` px) for embedding in preset files. */
  captureThumbnailDataUrl(maxSize = 256): string {
    this.renderNow();
    const scale = Math.min(1, maxSize / Math.max(this.canvas.width, this.canvas.height));
    const width = Math.max(1, Math.round(this.canvas.width * scale));
    const height = Math.max(1, Math.round(this.canvas.height * scale));
    const offscreen = document.createElement('canvas');
    offscreen.width = width;
    offscreen.height = height;
    const ctx = offscreen.getContext('2d');
    if (!ctx) throw new Error('2d canvas context unavailable');
    ctx.drawImage(this.canvas, 0, 0, width, height);
    return offscreen.toDataURL('image/jpeg', 0.85);
  }

  private resize(): void {
    const canvas = this.renderer.domElement;
    const container = canvas.parentElement ?? canvas;
    const width = Math.max(1, container.clientWidth);
    const height = Math.max(1, container.clientHeight);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  dispose(): void {
    this.renderer.setAnimationLoop(null);
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this.renderer.dispose();
  }
}
