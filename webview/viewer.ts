import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import URDFLoader from "urdf-loader";
import type { URDFRobot, URDFJoint } from "urdf-loader";
import { loadMesh } from "./meshLoader";
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
  };

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

    this.scene.add(this.robotRoot);

    window.addEventListener("resize", () => this.resize());
    this.resize();
    this.animate();
  }

  private resize(): void {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private animate = (): void => {
    requestAnimationFrame(this.animate);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
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

  private applyUpAxis(): void {
    this.robotRoot.rotation.set(0, 0, 0);
    if (this.upAxis === "+Z") {
      // URDF is Z-up; rotate to the viewer's Y-up world.
      this.robotRoot.rotation.x = -Math.PI / 2;
    }
  }

  private applyMeshSettings(): void {
    if (!this.robot) {
      return;
    }
    this.robot.traverse((child: any) => {
      if (child.isURDFCollider) {
        child.visible = this.settings.showCollision;
      } else if (child.isURDFVisual) {
        child.visible = this.settings.showVisual;
      }
      if (child.isMesh && child.material) {
        const mats = Array.isArray(child.material) ? child.material : [child.material];
        for (const m of mats) {
          if ("wireframe" in m) {
            m.wireframe = this.settings.wireframe;
          }
          if (child.parent && child.parent.isURDFCollider) {
            m.color?.set(0x00e5ff);
            m.transparent = true;
            m.opacity = 0.4;
          }
        }
        child.castShadow = true;
        child.receiveShadow = true;
      }
    });
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

    // Place the grid at the base of the model.
    this.grid.position.y = box.min.y;
    this.directional.shadow.camera.far = maxDim * 20;
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
