/**
 * Interactive end-effector handle for the viewer.
 *
 * three.js TransformControls does the pointer maths (axis picking, plane
 * projection, snapping); all this class adds is the proxy object the handles
 * move, plus the two conventions the viewer needs:
 *
 *  - the proxy lives in the robot's **base frame** (a child of robotRoot), so the
 *    handle position/quaternion the owner reads is directly a URDF-frame pose -
 *    no Y-up/Z-up conversion anywhere;
 *  - the handle axes follow URDF convention by using TransformControls' `local`
 *    space, which tracks the proxy's own rotation. `world` space would use
 *    three's world axes (Y up here) and read as the wrong frame. The proxy is
 *    therefore kept unrotated in translate mode (arrows along base X/Y/Z) and is
 *    given the TCP orientation in rotate mode (rings about the tool axes).
 *
 * Note for anyone tempted by `dragging-changed`: three 0.160 does not emit it.
 * Drag start/end are the `mouseDown` / `mouseUp` events, and a window-level
 * pointerup/pointercancel listener covers the case where the gesture ends off
 * the canvas - without it a lost pointerup leaves the camera disabled forever.
 */
import * as THREE from "three";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";

export type IkGizmoMode = "translate" | "rotate";

export interface IkGizmoCallbacks {
  onDragStart?: () => void;
  /** The handle moved: `position` / `quaternion` are the desired TCP pose. */
  onDrag?: (position: THREE.Vector3, quaternion: THREE.Quaternion) => void;
  onDragEnd?: () => void;
}

/** Minimal camera-orbit surface this gizmo needs to lock while dragging. */
export interface OrbitLock {
  enabled: boolean;
}

export class IkGizmo {
  /** The object the handles move; also the pose the owner reads. */
  readonly proxy = new THREE.Object3D();

  private readonly controls: TransformControls;
  private mode: IkGizmoMode = "translate";
  private enabled = false;
  private dragging = false;
  /** Last TCP orientation, used to aim the rings when in rotate mode. */
  private readonly orientation = new THREE.Quaternion();

  constructor(
    scene: THREE.Scene,
    robotBase: THREE.Object3D,
    camera: THREE.Camera,
    domElement: HTMLElement,
    private readonly orbit: OrbitLock,
    private readonly cb: IkGizmoCallbacks = {}
  ) {
    this.proxy.name = "ik-tcp-proxy";
    robotBase.add(this.proxy);

    this.controls = new TransformControls(camera, domElement);
    this.controls.setSpace("local");
    this.controls.setMode(this.mode);
    // TransformControls keeps its own on-screen size (its scale is proportional
    // to the camera distance), so setSize() is a dimensionless multiplier.
    this.controls.setSize(1);
    scene.add(this.controls);

    this.controls.addEventListener("mouseDown", () => this.handleDragStart());
    this.controls.addEventListener("objectChange", () => this.handleDragMove());
    this.controls.addEventListener("mouseUp", () => this.handleDragEnd());

    window.addEventListener("pointerup", () => this.handleDragEnd());
    window.addEventListener("pointercancel", () => this.handleDragEnd());

    this.setEnabled(false);
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  isDragging(): boolean {
    return this.dragging;
  }

  setEnabled(on: boolean): void {
    if (this.enabled === on) {
      return;
    }
    // Leaves the drag state (and the camera lock) behind, not half-applied.
    this.handleDragEnd();
    this.enabled = on;
    this.controls.enabled = on;
    this.controls.visible = on;
    if (on) {
      this.controls.attach(this.proxy);
    } else {
      this.controls.detach();
    }
  }

  setMode(mode: IkGizmoMode): void {
    if (this.mode === mode) {
      return;
    }
    this.mode = mode;
    this.controls.setMode(mode);
    // Re-aim the handles for the new mode. Safe here: mode never changes mid-drag
    // (the panel is what changes it, not the pointer).
    this.applyProxyOrientation();
  }

  setSize(factor: number): void {
    this.controls.setSize(factor);
  }

  /**
   * Move the handles to a pose. Ignored while dragging: TransformControls
   * recomputes the proxy from its own drag-start state on every pointer move, and
   * the whole point of the interaction is that the handle follows the mouse even
   * when the robot cannot.
   */
  setTarget(position: THREE.Vector3, quaternion: THREE.Quaternion): void {
    if (this.dragging) {
      return;
    }
    this.orientation.copy(quaternion);
    this.proxy.position.copy(position);
    this.applyProxyOrientation();
    this.proxy.updateMatrixWorld(true);
  }

  private applyProxyOrientation(): void {
    if (this.mode === "rotate") {
      this.proxy.quaternion.copy(this.orientation);
    } else {
      this.proxy.quaternion.identity();
    }
    this.proxy.updateMatrixWorld(true);
  }

  private handleDragStart(): void {
    this.dragging = true;
    this.orbit.enabled = false;
    this.cb.onDragStart?.();
  }

  private handleDragMove(): void {
    if (!this.dragging) {
      return;
    }
    const position = this.proxy.position.clone();
    let quaternion: THREE.Quaternion;
    if (this.mode === "rotate") {
      quaternion = this.proxy.quaternion.clone();
      this.orientation.copy(quaternion);
    } else {
      // The proxy stays unrotated in translate mode, so the orientation has to
      // come from the stored value rather than from the proxy itself.
      quaternion = this.orientation.clone();
    }
    this.cb.onDrag?.(position, quaternion);
  }

  private handleDragEnd(): void {
    if (!this.dragging) {
      return;
    }
    this.dragging = false;
    this.orbit.enabled = true;
    this.cb.onDragEnd?.();
  }
}
