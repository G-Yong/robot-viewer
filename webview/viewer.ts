import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import URDFLoader from "urdf-loader";
import type { URDFRobot, URDFJoint } from "urdf-loader";
import { loadMesh } from "./meshLoader";
import { ViewGizmo } from "./viewGizmo";
import type { JointValues, ViewerSettings, SceneConfig } from "../src/protocol";

export interface JointInfo {
  name: string;
  type: string;
  lower: number;
  upper: number;
  value: number;
}

export class Viewer {
  readonly scene = new THREE.Scene();
  private readonly renderer: THREE.WebGLRenderer;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly robotRoot = new THREE.Group();
  private readonly ambient: THREE.AmbientLight;
  private readonly directional: THREE.DirectionalLight;
  private grid: THREE.GridHelper;
  private robot?: URDFRobot;
  private upAxis: "+Z" | "+Y" = "+Z";
  private settings: ViewerSettings = {
    backgroundColor: "#263238",
    showGrid: true,
    upAxis: "+Z",
    ambientIntensity: 0.8,
    directionalIntensity: 1.0,
    showVisual: true,
    showCollision: false,
    wireframe: false,
    colorMode: "original",
    showOriginAxes: true,
    showJointAxes: true,
    showViewGizmo: true,
    axisSize: 0.25,
  };

  // "alternate" mode uses golden-angle hue spacing so that consecutive links
  // (and any two nearby links) get clearly separated colors — a plain rainbow
  // palette makes neighbors too similar.
  private static readonly GOLDEN_ANGLE = 137.508;
  private linkIndex = new Map<string, number>();

  private originAxes?: THREE.Group;
  private jointAxisGroups: THREE.Group[] = [];
  private readonly axesParent = new THREE.Group();

  private gizmo!: ViewGizmo;
  private readonly clock = new THREE.Clock();

  onJointChange?: (values: JointValues) => void;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene.background = new THREE.Color(this.settings.backgroundColor);

    this.camera = new THREE.PerspectiveCamera(50, 1, 0.01, 1000);
    this.camera.position.set(1.2, 1.0, 1.2);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.target.set(0, 0.3, 0);

    this.ambient = new THREE.AmbientLight(0xffffff, this.settings.ambientIntensity);
    this.scene.add(this.ambient);

    this.directional = new THREE.DirectionalLight(
      0xffffff,
      this.settings.directionalIntensity
    );
    this.directional.position.set(3, 5, 2);
    this.directional.castShadow = true;
    this.directional.shadow.mapSize.set(2048, 2048);
    this.directional.shadow.camera.near = 0.1;
    this.directional.shadow.camera.far = 30;
    this.scene.add(this.directional);
    this.scene.add(this.directional.target);

    this.grid = new THREE.GridHelper(10, 20, 0x888888, 0x444444);
    (this.grid.material as THREE.Material).opacity = 0.4;
    (this.grid.material as THREE.Material).transparent = true;
    this.scene.add(this.grid);

    this.scene.add(this.axesParent);
    this.scene.add(this.robotRoot);

    this.gizmo = new ViewGizmo(this.camera, this.controls, this.canvas);
    // Capture phase so a gizmo click pre-empts OrbitControls' orbit start.
    this.canvas.addEventListener(
      "pointerdown",
      (e) => {
        if (this.settings.showViewGizmo && this.gizmo.handleClick(e)) {
          e.stopPropagation();
          e.preventDefault();
        }
      },
      { capture: true }
    );

    window.addEventListener("resize", () => this.resize());
    // The webview panel can resize without a window 'resize' event.
    new ResizeObserver(() => this.resize()).observe(document.body);
    this.resize();
    this.animate();
  }

  private resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    // updateStyle=false: CSS keeps the canvas at 100% while the draw buffer
    // matches the window, so the view fills the page and never overflows.
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private animate = (): void => {
    requestAnimationFrame(this.animate);
    const delta = this.clock.getDelta();
    this.gizmo.update(delta);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    if (this.settings.showViewGizmo) {
      this.gizmo.render(this.renderer);
    }
  };

  loadModel(urdfContent: string): JointInfo[] {
    if (this.robot) {
      this.robotRoot.remove(this.robot);
      disposeObject(this.robot);
      this.robot = undefined;
    }

    const manager = new THREE.LoadingManager();
    const loader = new URDFLoader(manager);
    loader.parseCollision = true;
    // Preserve the original package:// URL so the extension host performs all
    // path resolution (settings + model-directory fallbacks).
    loader.packages = (pkg: string) => `package://${pkg}`;
    loader.workingPath = "";
    loader.loadMeshCb = (path, mgr, onComplete) => {
      loadMesh(path, mgr, (obj, err) => onComplete(obj, err));
    };

    const robot = loader.parse(urdfContent);
    this.robot = robot;
    this.robotRoot.add(robot);
    this.applyUpAxis();
    this.buildAxes();

    manager.onLoad = () => {
      this.applyMeshSettings();
      this.fitCamera();
    };
    // Colliders start hidden unless requested.
    this.applyMeshSettings();

    // Fit once immediately (links exist even before meshes finish loading).
    setTimeout(() => this.fitCamera(), 50);

    return this.getJoints();
  }

  /** Create world-origin and per-joint axes sized to the model. */
  private buildAxes(size?: number): void {
    // Remove any previously built frames (and their labels).
    for (const child of [...this.axesParent.children]) {
      this.axesParent.remove(child);
      disposeObject(child);
    }
    this.disposeJointAxes();

    if (!this.robot) {
      return;
    }
    const s = size ?? this.axisLength();

    // Origin frame, presented in the asset's coordinate frame (rotates with
    // the model) so it reads as X/Y/Z in the model's up-axis.
    this.originAxes = this.buildAxisFrame(s, { labels: true });
    this.axesParent.add(this.originAxes);
    this.axesParent.rotation.x = this.upAxis === "+Z" ? -Math.PI / 2 : 0;

    // One frame per movable joint.
    for (const name of Object.keys(this.robot.joints ?? {})) {
      const joint = (this.robot.joints as any)[name];
      if (!joint || joint.jointType === "fixed") {
        continue;
      }
      const axes = this.buildAxisFrame(s * 0.6, { labels: false });
      joint.add(axes);
      this.jointAxisGroups.push(axes);
    }
    this.applyAxisVisibility();
  }

  /** A colored line frame (X=red, Y=green, Z=blue) with optional labels. */
  private buildAxisFrame(size: number, opts: { labels: boolean }): THREE.Group {
    const group = new THREE.Group();
    const axes: [THREE.Vector3, number, string][] = [
      [new THREE.Vector3(1, 0, 0), 0xff4466, "X"],
      [new THREE.Vector3(0, 1, 0), 0x88ff44, "Y"],
      [new THREE.Vector3(0, 0, 1), 0x4488ff, "Z"],
    ];
    for (const [dir, color, label] of axes) {
      const geom = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0, 0),
        dir.clone().multiplyScalar(size),
      ]);
      const mat = new THREE.LineBasicMaterial({
        color,
        // Lines drawn last so they read on top of the geometry.
        depthTest: !opts.labels,
      });
      const line = new THREE.Line(geom, mat);
      line.renderOrder = 999;
      group.add(line);
      if (opts.labels) {
        // Label size is proportional to the axis length so it never dwarfs it.
        const sprite = this.makeLabelSprite(label, color, size * 0.32);
        sprite.position.copy(dir.clone().multiplyScalar(size * 1.12));
        group.add(sprite);
      }
    }
    return group;
  }

  private makeLabelSprite(text: string, color: number, scale: number): THREE.Sprite {
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext("2d")!;
    ctx.font = "bold 44px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = `#${new THREE.Color(color).getHexString()}`;
    ctx.fillText(text, 32, 32);
    const tex = new THREE.CanvasTexture(canvas);
    const mat = new THREE.SpriteMaterial({
      map: tex,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.setScalar(scale);
    return sprite;
  }

  private disposeJointAxes(): void {
    for (const g of this.jointAxisGroups) {
      g.parent?.remove(g);
      disposeObject(g);
    }
    this.jointAxisGroups = [];
  }

  /** Axes length derived from the model bounding box. */
  private axisLength(): number {
    const box = new THREE.Box3().setFromObject(this.robotRoot);
    if (box.isEmpty()) {
      return 1;
    }
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    return maxDim * this.settings.axisSize;
  }

  private applyAxisVisibility(): void {
    if (this.originAxes) {
      this.originAxes.visible = this.settings.showOriginAxes;
    }
    for (const axes of this.jointAxisGroups) {
      axes.visible = this.settings.showJointAxes;
    }
  }

  private applyUpAxis(): void {
    this.robotRoot.rotation.set(0, 0, 0);
    if (this.upAxis === "+Z") {
      // URDF is Z-up; rotate to the viewer's Y-up world.
      this.robotRoot.rotation.x = -Math.PI / 2;
    }
    // Keep the origin frame + corner gizmo in the asset's coordinate frame.
    this.axesParent.rotation.x = this.upAxis === "+Z" ? -Math.PI / 2 : 0;
    this.gizmo?.setFrameOffset(this.axesParent.quaternion);
  }

  private applyMeshSettings(): void {
    if (!this.robot) {
      return;
    }
    // Build a stable per-link index used to pick the alternate palette color.
    const links = this.robot.links ?? {};
    this.linkIndex.clear();
    Object.keys(links).forEach((name, i) => this.linkIndex.set(name, i));

    this.robot.traverse((child: any) => {
      if (child.isURDFCollider) {
        child.visible = this.settings.showCollision;
      } else if (child.isURDFVisual) {
        child.visible = this.settings.showVisual;
      }
      if (child.isMesh && child.material) {
        this.applyMeshMaterial(child);
        child.castShadow = true;
        child.receiveShadow = true;
      }
    });
  }

  /** Assign/restore a visual mesh's material depending on colorMode. */
  private applyMeshMaterial(mesh: any): void {
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const altColor = this.paletteColorFor(mesh);

    // Snapshot the original color/opacity once so "original" mode can restore
    // them even after we mutated the material in place (materials can be shared).
    if (!mesh.userData.__origColorState) {
      mesh.userData.__origColorState = mats.map(
        (m: any) =>
          m && typeof m.color?.clone === "function"
            ? { color: m.color.clone(), opacity: m.opacity, transparent: m.transparent }
            : null
      );
    }
    const origState = mesh.userData.__origColorState as {
      color: THREE.Color;
      opacity: number;
      transparent: boolean;
    }[];

    mats.forEach((m: any, i: number) => {
      if (!m || typeof m.color?.set !== "function") {
        return; // e.g. a plain material without a color channel
      }

      if (this.settings.colorMode === "alternate" && altColor) {
        m.color.copy(altColor);
        if (m.transparent) {
          m.opacity = 1;
          m.transparent = false;
        }
      } else {
        const orig = origState[i];
        if (orig) {
          m.color.copy(orig.color);
          m.opacity = orig.opacity;
          m.transparent = orig.transparent;
        }
      }

      if ("wireframe" in m) {
        m.wireframe = this.settings.wireframe;
      }
      if (mesh.parent && mesh.parent.isURDFCollider) {
        m.color.set(0x00e5ff);
        m.transparent = true;
        m.opacity = 0.4;
      }
    });
  }

  /** Color for the link that owns this mesh, or undefined. Golden-angle hue
   *  spacing keeps neighboring links well-separated. */
  private paletteColorFor(mesh: any): THREE.Color | undefined {
    let node: any = mesh;
    while (node) {
      if (node.isURDFLink && node.urdfName) {
        const idx = this.linkIndex.get(node.urdfName) ?? 0;
        // Rotate hue by the golden angle per link for maximum separation, and
        // vary lightness slightly to further distinguish close hues.
        const hue = (idx * Viewer.GOLDEN_ANGLE) % 360;
        const lightness = 0.5 + (idx % 2) * 0.1;
        return new THREE.Color().setHSL(hue / 360, 0.85, lightness);
      }
      node = node.parent;
    }
    return undefined;
  }

  private fitCamera(): void {
    if (!this.robot) {
      return;
    }
    const box = new THREE.Box3().setFromObject(this.robotRoot);
    if (box.isEmpty()) {
      return;
    }
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    const dist = maxDim * 2.2;

    this.controls.target.copy(center);
    this.camera.position.set(center.x + dist, center.y + dist * 0.7, center.z + dist);
    this.camera.near = maxDim / 100;
    this.camera.far = maxDim * 100;
    this.camera.updateProjectionMatrix();
    this.controls.update();

    // Keep the grid at the world origin so the model's real height above the
    // ground plane (e.g. a base mounted 1 m up) is shown faithfully.
    this.grid.position.y = 0;
    this.directional.shadow.camera.far = maxDim * 20;

    // Re-size the axes after the model's true bounds are known.
    this.buildAxes();
  }

  getJoints(): JointInfo[] {
    if (!this.robot) {
      return [];
    }
    const out: JointInfo[] = [];
    for (const name of Object.keys(this.robot.joints)) {
      const j = this.robot.joints[name] as URDFJoint;
      if (j.jointType === "fixed") {
        continue;
      }
      out.push({
        name,
        type: j.jointType,
        lower: numberOr(j.limit?.lower, -Math.PI),
        upper: numberOr(j.limit?.upper, Math.PI),
        value: Number(j.angle ?? 0),
      });
    }
    return out;
  }

  setJoint(name: string, value: number): void {
    this.robot?.setJointValue(name, value);
  }

  setJoints(values: JointValues): void {
    if (!this.robot) {
      return;
    }
    for (const [name, value] of Object.entries(values)) {
      this.robot.setJointValue(name, value);
    }
  }

  getJointValues(): JointValues {
    const out: JointValues = {};
    if (!this.robot) {
      return out;
    }
    for (const name of Object.keys(this.robot.joints)) {
      const j = this.robot.joints[name] as URDFJoint;
      if (j.jointType !== "fixed") {
        out[name] = Number(j.angle ?? 0);
      }
    }
    return out;
  }

  applySettings(s: ViewerSettings): void {
    this.settings = { ...this.settings, ...s };
    this.scene.background = new THREE.Color(this.settings.backgroundColor);
    this.ambient.intensity = this.settings.ambientIntensity;
    this.directional.intensity = this.settings.directionalIntensity;
    this.grid.visible = this.settings.showGrid;
    if (this.upAxis !== this.settings.upAxis) {
      this.upAxis = this.settings.upAxis;
      this.applyUpAxis();
      this.fitCamera();
    }
    this.applyMeshSettings();
    this.applyAxisVisibility();
  }

  getSettings(): ViewerSettings {
    return { ...this.settings };
  }

  resetCamera(): void {
    this.fitCamera();
  }

  getCameraState(): { position: [number, number, number]; target: [number, number, number] } {
    return {
      position: [this.camera.position.x, this.camera.position.y, this.camera.position.z],
      target: [this.controls.target.x, this.controls.target.y, this.controls.target.z],
    };
  }

  setCameraState(state: {
    position: [number, number, number];
    target: [number, number, number];
  }): void {
    this.camera.position.set(...state.position);
    this.controls.target.set(...state.target);
    this.controls.update();
  }

  applyScene(scene: SceneConfig): void {
    if (scene.settings) {
      this.applySettings({ ...this.settings, ...scene.settings });
    }
    if (scene.joints) {
      this.setJoints(scene.joints);
    }
    if (scene.camera) {
      this.setCameraState(scene.camera);
    }
  }
}

function numberOr(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function disposeObject(obj: THREE.Object3D): void {
  obj.traverse((child: any) => {
    if (child.geometry) {
      child.geometry.dispose();
    }
    if (child.material) {
      const mats = Array.isArray(child.material) ? child.material : [child.material];
      mats.forEach((m: THREE.Material) => m.dispose());
    }
  });
}
