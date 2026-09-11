/**
 * Interactive end-effector handle for the viewer.
 *
 * three.js TransformControls does the pointer maths (axis picking, plane
 * projection, snapping); all this class adds is the proxy object the handles
 * move, plus the two conventions the viewer needs:
 *
 *  - the proxy lives in the robot's **base frame** (a child of robotRoot), so the
 *    handle position the owner reads is directly a URDF-frame position - no
 *    Y-up/Z-up conversion anywhere. It is kept **unrotated**: `local` space on an
 *    unrotated object *is* the base frame, which is what makes the arrows point
 *    along base X/Y/Z and the rings turn about those same axes. (`world` space
 *    would use three's world axes - Y up here - and read as the wrong frame.)
 *  - moves and turns are on screen **at the same time**. One TransformControls
 *    cannot do that, its `mode` picks a single handle set, so there are two. They
 *    do not fight over the pointer: `pointerHover()` raycasts only its own picker
 *    geometries, and `pointerDown()` only starts a drag when that raycast hit
 *    something - so grabbing an arrow never arms the rings, and vice versa.
 *
 * The TCP orientation is remembered rather than applied to the proxy (which has to
 * stay unrotated). A move keeps that orientation; a turn rotates about a base axis
 * on top of the orientation the drag started from.
 *
 * Note for anyone tempted by `dragging-changed`: three 0.160 does not emit it.
 * Drag start/end are the `mouseDown` / `mouseUp` events, and a window-level
 * pointerup/pointercancel listener covers the case where the gesture ends off
 * the canvas - without it a lost pointerup leaves the camera disabled forever.
 */
import * as THREE from "three";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";

/** Which handle sets are on screen. */
export type IkHandles = "both" | "translate" | "rotate";

type HandleKind = "translate" | "rotate";

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

/**
 * `pointerHover` is part of the runtime API (TransformControls.js) but missing from
 * @types/three, and asking it to re-decide the hit at pointerdown is the point of
 * `pickHandle` below. Reach it through this narrow shape rather than casting a
 * control to `any`. Returns whether the pointer landed on that control's own
 * handles.
 */
function probeHover(
  control: TransformControls,
  pointer: { x: number; y: number; button: number }
): boolean {
  (control as unknown as { pointerHover(p: typeof pointer): void }).pointerHover(pointer);
  return control.axis !== null;
}

export class IkGizmo {
  /** The object the handles move; also the position the owner reads. */
  readonly proxy = new THREE.Object3D();

  private readonly move: TransformControls;
  private readonly turn: TransformControls;
  private handles: IkHandles = "both";
  private enabled = false;
  private dragging = false;
  /** Which of the two handles the drag in progress belongs to. */
  private active: HandleKind | null = null;
  /** TCP orientation the handles are aiming at, in the base frame. */
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

    this.move = this.createControls(scene, "translate", camera, domElement);
    this.turn = this.createControls(scene, "rotate", camera, domElement);

    // Both sets cover the same pixels in places (the rings cross the arrows near
    // their tips), so this has to run before either instance sees the event: see
    // pickHandle.
    domElement.addEventListener("pointerdown", (e) => this.pickHandle(e, domElement), { capture: true });

    const endGesture = (): void => {
      this.handleDragEnd();
      // Unconditional: a press that never turned into a drag still has to hand the
      // other handle set its enabled flag back.
      this.applyHandles();
    };
    window.addEventListener("pointerup", endGesture);
    window.addEventListener("pointercancel", endGesture);

    this.setEnabled(false);
  }

  /**
   * Decide which handle set the pointer is after, before either TransformControls
   * instance sees the event.
   *
   * Each instance decides on its own whether it was hit, so where the two overlap
   * they would both start a drag and fight over the same proxy - and whichever
   * listener ran last would be the one the drag was attributed to. Arrows win the
   * contested pixels here: a ring is a big target with plenty of uncontested screen
   * area left, an arrow tip is not, so this order keeps both reachable. The capture
   * phase is the only point early enough to stand the loser down.
   */
  private pickHandle(event: PointerEvent, domElement: HTMLElement): void {
    if (!this.enabled || event.button !== 0 || !this.move.enabled || !this.turn.enabled) {
      return;
    }
    const rect = domElement.getBoundingClientRect();
    const pointer = {
      x: ((event.clientX - rect.left) / rect.width) * 2 - 1,
      y: -((event.clientY - rect.top) / rect.height) * 2 + 1,
      button: event.button,
    };

    if (probeHover(this.move, pointer)) {
      this.turn.enabled = false;
    } else if (probeHover(this.turn, pointer)) {
      this.move.enabled = false;
    }
  }

  private createControls(
    scene: THREE.Scene,
    kind: HandleKind,
    camera: THREE.Camera,
    domElement: HTMLElement
  ): TransformControls {
    const controls = new TransformControls(camera, domElement);
    controls.setSpace("local");
    controls.setMode(kind);
    // TransformControls keeps its own on-screen size (its scale is proportional
    // to the camera distance), so setSize() is a dimensionless multiplier.
    controls.setSize(1);
    scene.add(controls);

    // Both instances listen to the same canvas; only the one whose own geometry
    // was hit ever reaches these (see the class comment).
    controls.addEventListener("mouseDown", () => this.handleDragStart(kind));
    controls.addEventListener("objectChange", () => this.handleDragMove());
    controls.addEventListener("mouseUp", () => this.handleDragEnd());

    return controls;
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
    this.applyHandles();
  }

  getHandles(): IkHandles {
    return this.handles;
  }

  /** Show everything, or filter down to just the arrows or just the rings. */
  setHandles(handles: IkHandles): void {
    if (this.handles === handles) {
      return;
    }
    this.handles = handles;
    this.applyHandles();
  }

  setSize(factor: number): void {
    this.move.setSize(factor);
    this.turn.setSize(factor);
  }

  private applyHandles(): void {
    this.applyOne(this.move, this.enabled && this.handles !== "rotate");
    this.applyOne(this.turn, this.enabled && this.handles !== "translate");
  }

  private applyOne(controls: TransformControls, on: boolean): void {
    controls.enabled = on;
    controls.visible = on;
    if (on) {
      controls.attach(this.proxy);
    } else {
      controls.detach();
    }
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
    // Remembered, not applied: the proxy has to stay unrotated for `local` space
    // to keep reading as the base frame.
    this.orientation.copy(quaternion);
    this.proxy.position.copy(position);
    this.proxy.quaternion.identity();
    this.proxy.updateMatrixWorld(true);
  }

  private handleDragStart(kind: HandleKind): void {
    this.dragging = true;
    this.active = kind;
    this.orbit.enabled = false;
    this.cb.onDragStart?.();
  }

  private handleDragMove(): void {
    if (!this.dragging || !this.active) {
      return;
    }
    // A turn composes as a pre-multiply: the proxy carries the rotation since its
    // own drag start (it was unrotated then) and the axis is a base axis, so the
    // result is (turn) applied to the orientation the drag started from. A move
    // leaves that orientation alone, which is why the proxy cannot supply it.
    const quaternion =
      this.active === "rotate"
        ? this.proxy.quaternion.clone().multiply(this.orientation)
        : this.orientation.clone();
    this.cb.onDrag?.(this.proxy.position.clone(), quaternion);
  }

  private handleDragEnd(): void {
    if (!this.dragging) {
      return;
    }
    this.dragging = false;
    this.active = null;
    this.orbit.enabled = true;
    this.cb.onDragEnd?.();
  }
}
