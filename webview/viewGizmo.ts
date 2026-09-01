import * as THREE from "three";

export interface GizmoControls {
  target: THREE.Vector3;
  update(): void;
}

/**
 * A Blender/three.js-ViewHelper-style corner orientation gizmo, vendored
 * locally so it can be positioned (top-left), reflect the asset's up-axis, and
 * snap the camera to an axis view on click — without pulling any runtime CDN.
 */
export class ViewGizmo {
  private readonly gizmoScene = new THREE.Scene();
  private readonly gizmoCamera = new THREE.OrthographicCamera(-2, 2, 2, -2, 0, 4);
  private readonly root = new THREE.Object3D();
  private readonly interactive: THREE.Sprite[] = [];
  private readonly raycaster = new THREE.Raycaster();
  private readonly posSprites: Record<string, THREE.Sprite> = {};
  private readonly negSprites: Record<string, THREE.Sprite> = {};
  private readonly frameOffset = new THREE.Quaternion();

  private animating = false;
  private readonly animStartDir = new THREE.Vector3();
  private readonly animEndDir = new THREE.Vector3();
  private animRadius = 0;
  private animT = 0;
  private readonly animDuration = 0.35;

  readonly dim = 112;
  readonly margin = 12;

  constructor(
    private readonly mainCamera: THREE.PerspectiveCamera,
    private readonly controls: GizmoControls,
    private readonly canvas: HTMLCanvasElement
  ) {
    this.gizmoCamera.position.set(0, 0, 2);
    this.build();
    this.gizmoScene.add(this.root);
  }

  /** Orientation that maps the asset frame into the world (up-axis handling). */
  setFrameOffset(q: THREE.Quaternion): void {
    this.frameOffset.copy(q);
  }

  get isAnimating(): boolean {
    return this.animating;
  }

  private build(): void {
    const colors: Record<string, number> = { X: 0xff4466, Y: 0x88ff44, Z: 0x4488ff };
    const dirs: [string, THREE.Vector3][] = [
      ["X", new THREE.Vector3(1, 0, 0)],
      ["Y", new THREE.Vector3(0, 1, 0)],
      ["Z", new THREE.Vector3(0, 0, 1)],
    ];
    for (const [label, dir] of dirs) {
      const color = colors[label];
      const geom = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(),
        dir.clone(),
      ]);
      const line = new THREE.Line(
        geom,
        new THREE.LineBasicMaterial({ color, toneMapped: false })
      );
      this.root.add(line);

      const pos = new THREE.Sprite(this.spriteMat(color, label));
      pos.position.copy(dir);
      pos.scale.setScalar(0.5);
      pos.userData.dir = dir.clone();
      this.root.add(pos);
      this.interactive.push(pos);
      this.posSprites[label] = pos;

      const neg = new THREE.Sprite(this.spriteMat(color, null));
      neg.position.copy(dir.clone().multiplyScalar(-1));
      neg.scale.setScalar(0.36);
      neg.userData.dir = dir.clone().multiplyScalar(-1);
      (neg.material as THREE.SpriteMaterial).opacity = 0.5;
      this.root.add(neg);
      this.interactive.push(neg);
      this.negSprites[label] = neg;
    }
  }

  private spriteMat(color: number, text: string | null): THREE.SpriteMaterial {
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext("2d")!;
    ctx.beginPath();
    ctx.arc(32, 32, 18, 0, 2 * Math.PI);
    ctx.closePath();
    ctx.fillStyle = `#${new THREE.Color(color).getHexString()}`;
    ctx.fill();
    if (text) {
      ctx.font = "bold 34px Arial";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = "#ffffff";
      ctx.fillText(text, 32, 34);
    }
    const tex = new THREE.CanvasTexture(canvas);
    return new THREE.SpriteMaterial({
      map: tex,
      toneMapped: false,
      transparent: true,
      depthTest: false,
    });
  }

  /** Draw the gizmo into a small top-left viewport, oriented like the camera. */
  render(renderer: THREE.WebGLRenderer): void {
    // Show the asset frame as seen by the camera.
    this.root.quaternion.copy(this.mainCamera.quaternion).invert().multiply(this.frameOffset);

    // Fade the axis end pointing away from the viewer. Camera view axis in the
    // asset frame tells which side of each axis faces us.
    const inv = this.frameOffset.clone().invert();
    const point = new THREE.Vector3(0, 0, 1)
      .applyQuaternion(this.mainCamera.quaternion)
      .applyQuaternion(inv);
    const fade = (label: string, coord: number) => {
      const near = coord >= 0;
      (this.posSprites[label].material as THREE.SpriteMaterial).opacity = near ? 1 : 0.5;
      (this.negSprites[label].material as THREE.SpriteMaterial).opacity = near ? 0.5 : 1;
    };
    fade("X", point.x);
    fade("Y", point.y);
    fade("Z", point.z);

    const size = renderer.getSize(new THREE.Vector2());
    const prev = renderer.getViewport(new THREE.Vector4());
    const prevAutoClear = renderer.autoClear;
    // Draw OVER the scene (no color clear) so the gizmo has a transparent
    // background instead of an opaque black box.
    renderer.autoClear = false;
    renderer.clearDepth();
    renderer.setScissorTest(true);
    // WebGL viewport origin is bottom-left, so top-left => y = height - dim.
    const y = size.y - this.dim - this.margin;
    renderer.setViewport(this.margin, y, this.dim, this.dim);
    renderer.setScissor(this.margin, y, this.dim, this.dim);
    renderer.render(this.gizmoScene, this.gizmoCamera);
    renderer.setScissorTest(false);
    renderer.setViewport(prev.x, prev.y, prev.z, prev.w);
    renderer.autoClear = prevAutoClear;
  }

  /** Returns true when the click hit the gizmo (and started a camera snap). */
  handleClick(event: PointerEvent): boolean {
    const rect = this.canvas.getBoundingClientRect();
    const gx = event.clientX - (rect.left + this.margin);
    const gy = event.clientY - (rect.top + this.margin);
    if (gx < 0 || gy < 0 || gx > this.dim || gy > this.dim) {
      return false;
    }
    const mouse = new THREE.Vector2((gx / this.dim) * 2 - 1, -((gy / this.dim) * 2 - 1));
    this.raycaster.setFromCamera(mouse, this.gizmoCamera);
    const hits = this.raycaster.intersectObjects(this.interactive);
    if (hits.length === 0) {
      return false;
    }
    this.startSnap((hits[0].object.userData.dir as THREE.Vector3).clone());
    return true;
  }

  private startSnap(displayDir: THREE.Vector3): void {
    const worldDir = displayDir.clone().applyQuaternion(this.frameOffset).normalize();
    this.animRadius = this.mainCamera.position.distanceTo(this.controls.target);
    this.animStartDir.copy(this.mainCamera.position).sub(this.controls.target).normalize();
    this.animEndDir.copy(worldDir);
    this.animT = 0;
    this.animating = true;
  }

  /** Advance the snap animation; caller invokes every frame. */
  update(delta: number): void {
    if (!this.animating) {
      return;
    }
    this.animT = Math.min(1, this.animT + delta / this.animDuration);
    const q = new THREE.Quaternion().setFromUnitVectors(this.animStartDir, this.animEndDir);
    const partial = new THREE.Quaternion().slerp(q, this.animT);
    const dir = this.animStartDir.clone().applyQuaternion(partial);
    this.mainCamera.position.copy(this.controls.target).add(dir.multiplyScalar(this.animRadius));
    this.controls.update();
    if (this.animT >= 1) {
      this.animating = false;
    }
  }
}
