/**
 * Damped-least-squares IK for urdf-loader robots.
 *
 * The solver reads the robot's current geometry straight out of the three.js
 * scene graph (joint world positions and axes) and writes joint values back
 * through `setJointValue`, so the viewer keeps a single source of truth: the
 * loader's own forward kinematics. Nothing here touches the DOM, which is what
 * lets tools/ikCheck.ts exercise it in plain node.
 *
 * Two rules are copied from hard-won experience with the same algorithm in
 * pinocTest, and both are required for correct results:
 *   - re-normalise revolute angles into (-pi, pi] every iteration, otherwise the
 *     solver happily winds a joint by whole turns (it once returned 754.9 deg for
 *     a 34.9 deg pose);
 *   - clamp to the joint limits every iteration as well, otherwise a solution
 *     that respects the mechanics is reported as "unreachable" while the
 *     unclamped one flails the arm.
 * Note the loader already clamps inside setJointValue, so the solver re-reads the
 * applied values each iteration to keep its own vector - and thus the Jacobian it
 * derives from it - consistent with the pose the loader actually produced.
 */
import * as THREE from "three";
import type { JointValues } from "../src/protocol";

/** End-effector definition: a URDF link plus a tool offset in that link's frame. */
export interface TcpSpec {
  link: string;
  /** Tool offset in metres, expressed in the link's own frame (0,0,0 = link origin). */
  offset: THREE.Vector3;
}

export interface IkTarget {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
}

export interface SolveOptions {
  /** Configuration to start from; defaults to every joint at zero. */
  start?: JointValues;
  maxIters?: number;
  posTol?: number;
  rotTol?: number;
  /** Damping factor: larger is more stable near singularities, slower to converge. */
  damping?: number;
  /** Cap on a single iteration's joint change (rad / m), to keep motion smooth. */
  maxStep?: number;
}

export interface SolveResult {
  q: JointValues;
  posErr: number;
  rotErr: number;
  converged: boolean;
  iters: number;
}

const DEFAULTS = {
  maxIters: 80,
  posTol: 1e-4,
  rotTol: 1e-4,
  damping: 0.02,
  maxStep: 0.2,
};

/** The subset of urdf-loader's joint object this solver relies on. */
type LoaderJoint = THREE.Object3D & {
  urdfName: string;
  jointType: string;
  axis: THREE.Vector3;
  angle: number;
  limit: { lower: number; upper: number };
  ignoreLimits: boolean;
};

// ---------------------------------------------------------------------------
// Small vector helpers
// ---------------------------------------------------------------------------

/**
 * Rotation vector (axis * angle) of a quaternion. Unlike a naive
 * `2 * acos(w) * axis`, this stays well behaved for the tiny rotations the
 * solver deals with, where `acos` loses all its precision.
 */
export function quaternionToRotationVector(q: THREE.Quaternion): THREE.Vector3 {
  const v = new THREE.Vector3(q.x, q.y, q.z);
  const len = v.length();
  if (len < 1e-12) {
    return new THREE.Vector3();
  }
  const angle = 2 * Math.atan2(len, q.w);
  return v.multiplyScalar(angle / len);
}

/** Wrap an angle into (-pi, pi]. */
function wrapToPi(a: number): number {
  const wrapped = ((a + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
  return wrapped === -Math.PI ? Math.PI : wrapped;
}

/** Mirror of urdf-loader's own clamping rule, so the solver cannot disagree with FK. */
function clampRange(joint: LoaderJoint): [number, number] | null {
  if (joint.jointType !== "revolute" && joint.jointType !== "prismatic") {
    return null; // continuous and fixed joints have no range
  }
  if (joint.ignoreLimits || !joint.limit) {
    return null;
  }
  return [joint.limit.lower, joint.limit.upper];
}

/** Solve A x = b for a small symmetric positive-definite A (Cholesky). */
function solveSpd(a: number[][], b: number[]): number[] {
  const n = b.length;
  const l: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));

  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = a[i][j];
      for (let k = 0; k < j; k++) {
        sum -= l[i][k] * l[j][k];
      }
      if (i === j) {
        // A positive diagonal is guaranteed by the damping term; the guard keeps
        // a degenerate Jacobian from producing NaN.
        l[i][j] = Math.sqrt(Math.max(sum, 1e-12));
      } else {
        l[i][j] = sum / l[j][j];
      }
    }
  }

  const y = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    let sum = b[i];
    for (let k = 0; k < i; k++) {
      sum -= l[i][k] * y[k];
    }
    y[i] = sum / l[i][i];
  }

  const x = new Array<number>(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let sum = y[i];
    for (let k = i + 1; k < n; k++) {
      sum -= l[k][i] * x[k];
    }
    x[i] = sum / l[i][i];
  }
  return x;
}

// ---------------------------------------------------------------------------
// Robot inspection
// ---------------------------------------------------------------------------

/**
 * Every movable joint in the model, in kinematic-tree order (a joint before its
 * own subtree), which is the order a person reads the mechanism in. `robot.joints`
 * is keyed by name and would come back in URDF document order instead.
 *
 * This is the *whole* model, so it is the wrong input for a Jacobian: one URDF may
 * hold several independent mechanisms (two arms side by side, an arm plus a
 * positioner). Use `collectChainJoints` for anything that drives one end effector.
 */
export function collectMovableJoints(robot: THREE.Object3D): LoaderJoint[] {
  const joints: LoaderJoint[] = [];
  robot.traverse((node) => {
    const j = node as LoaderJoint;
    if ((node as unknown as { isURDFJoint?: boolean }).isURDFJoint && j.jointType !== "fixed") {
      joints.push(j);
    }
  });
  return joints;
}

/**
 * The movable joints that can actually move `linkName`: its ancestors, root first.
 *
 * A geometric Jacobian column is only meaningful for a joint that is an ancestor
 * of the TCP. For any other joint the axis-cross-lever formula describes no motion
 * at all, yet it still returns a perfectly healthy-looking vector - there is no
 * zero column to give the mistake away. Handing the whole model to the solver
 * therefore lets it spend the target error on unrelated branches: in a dual-arm
 * URDF, dragging one gripper visibly dragged the other (and the dragged arm did
 * not even converge, because the solver was busy moving joints that do nothing).
 */
export function collectChainJoints(robot: THREE.Object3D, linkName: string): LoaderJoint[] {
  const link = findLink(robot, linkName);
  if (!link) {
    return [];
  }

  const joints: LoaderJoint[] = [];
  // Walk up to the robot root: link -> joint -> link -> ... A joint's parent is
  // always a link, so no movable joint can be stepped over on the way.
  for (let node: THREE.Object3D | null = link; node && node !== robot; node = node.parent) {
    const joint = node as LoaderJoint;
    if (
      (node as unknown as { isURDFJoint?: boolean }).isURDFJoint &&
      joint.jointType !== "fixed"
    ) {
      joints.push(joint);
    }
  }
  return joints.reverse();
}

export function readJointValues(joints: LoaderJoint[]): JointValues {
  const values: JointValues = {};
  for (const j of joints) {
    values[j.urdfName] = Number(j.angle ?? 0);
  }
  return values;
}

/** Apply joint values; the loader clamps, so readJointValues() afterwards is the truth. */
export function applyJointValues(robot: THREE.Object3D, values: JointValues): void {
  const robotWithJoints = robot as unknown as {
    setJointValue?: (name: string, value: number) => void;
  };
  if (typeof robotWithJoints.setJointValue !== "function") {
    return;
  }
  for (const [name, value] of Object.entries(values)) {
    robotWithJoints.setJointValue(name, value);
  }
  robot.updateMatrixWorld(true);
}

/** World pose of the tool centre point (link frame translated by the tool offset). */
export function tcpPose(robot: THREE.Object3D, spec: TcpSpec): IkTarget {
  const link = findLink(robot, spec.link);
  robot.updateMatrixWorld(true);

  const quat = new THREE.Quaternion();
  const pos = new THREE.Vector3();
  if (!link) {
    return { position: pos, quaternion: quat };
  }
  link.getWorldQuaternion(quat);
  link.getWorldPosition(pos);
  pos.add(spec.offset.clone().applyQuaternion(quat));
  return { position: pos, quaternion: quat };
}

function findLink(robot: THREE.Object3D, name: string): THREE.Object3D | undefined {
  const links = (robot as unknown as { links?: Record<string, THREE.Object3D> }).links;
  if (links && links[name]) {
    return links[name];
  }
  let found: THREE.Object3D | undefined;
  robot.traverse((node) => {
    if (!found && (node as unknown as { urdfName?: string }).urdfName === name) {
      found = node;
    }
  });
  return found;
}

// ---------------------------------------------------------------------------
// Jacobian and solve
// ---------------------------------------------------------------------------

/**
 * Geometric Jacobian (6 x N, world frame) of the TCP with respect to the
 * movable joints. Column per joint, in the order the joints are passed in.
 */
export function computeJacobian(
  robot: THREE.Object3D,
  joints: LoaderJoint[],
  spec: TcpSpec,
  tcp?: IkTarget
): number[][] {
  const pose = tcp ?? tcpPose(robot, spec);
  robot.updateMatrixWorld(true);

  const jacobian: number[][] = Array.from({ length: 6 }, () =>
    new Array<number>(joints.length).fill(0)
  );

  const axisWorld = new THREE.Vector3();
  const jointPos = new THREE.Vector3();
  const quat = new THREE.Quaternion();

  joints.forEach((joint, i) => {
    joint.getWorldPosition(jointPos);
    joint.getWorldQuaternion(quat);
    // joint.axis lives in the joint's own frame, so it has to be rotated by the
    // joint's world rotation - not the link's, and not left in place.
    axisWorld.copy(joint.axis).applyQuaternion(quat).normalize();

    if (joint.jointType === "prismatic") {
      for (let r = 0; r < 3; r++) {
        jacobian[r][i] = axisWorld.getComponent(r);
      }
      return;
    }

    // Revolute / continuous: linear part is the axis crossed with the lever arm.
    const lever = pose.position.clone().sub(jointPos);
    const linear = axisWorld.clone().cross(lever);
    for (let r = 0; r < 3; r++) {
      jacobian[r][i] = linear.getComponent(r);
      jacobian[r + 3][i] = axisWorld.getComponent(r);
    }
  });

  return jacobian;
}

/**
 * Solve for joint values that put the TCP at `target`.
 *
 * Only the joints on the TCP's own chain take part (see `collectChainJoints`);
 * every other joint in the model is left untouched, so a second arm in the same
 * URDF stays exactly where it is.
 *
 * The robot is left at the returned configuration. On failure the returned
 * configuration is still the best attempt (and always inside the joint limits),
 * with `converged: false` and the residuals reported, so the caller decides
 * whether to keep it.
 */
export function solveIk(
  robot: THREE.Object3D,
  spec: TcpSpec,
  target: IkTarget,
  options: SolveOptions = {}
): SolveResult {
  const maxIters = options.maxIters ?? DEFAULTS.maxIters;
  const posTol = options.posTol ?? DEFAULTS.posTol;
  const rotTol = options.rotTol ?? DEFAULTS.rotTol;
  const damping = options.damping ?? DEFAULTS.damping;
  const maxStep = options.maxStep ?? DEFAULTS.maxStep;

  const joints = collectChainJoints(robot, spec.link);
  if (joints.length === 0) {
    return { q: {}, posErr: Infinity, rotErr: Infinity, converged: false, iters: 0 };
  }

  const start: JointValues = {};
  for (const joint of joints) {
    start[joint.urdfName] = options.start?.[joint.urdfName] ?? 0;
  }

  let q = sanitize(joints, start);
  applyJointValues(robot, q);
  q = readJointValues(joints);

  let posErr = Infinity;
  let rotErr = Infinity;
  let iters = 0;

  for (; iters < maxIters; iters++) {
    const pose = tcpPose(robot, spec);

    const dPos = target.position.clone().sub(pose.position);
    const dQuat = target.quaternion.clone().multiply(pose.quaternion.clone().invert());
    const dRot = quaternionToRotationVector(dQuat);

    posErr = dPos.length();
    rotErr = dRot.length();
    if (posErr < posTol && rotErr < rotTol) {
      break;
    }

    const err = [
      dPos.x,
      dPos.y,
      dPos.z,
      dRot.x,
      dRot.y,
      dRot.z,
    ];

    const jacobian = computeJacobian(robot, joints, spec, pose);

    // (J Jt + lambda^2 I) y = e   ->   dq = Jt y, the damped least-squares step.
    const a: number[][] = Array.from({ length: 6 }, () => new Array<number>(6).fill(0));
    for (let r = 0; r < 6; r++) {
      for (let c = 0; c < 6; c++) {
        let sum = 0;
        for (let i = 0; i < joints.length; i++) {
          sum += jacobian[r][i] * jacobian[c][i];
        }
        a[r][c] = sum;
      }
      a[r][r] += damping * damping;
    }

    const y = solveSpd(a, err);

    const dq = new Array<number>(joints.length).fill(0);
    let biggest = 0;
    for (let i = 0; i < joints.length; i++) {
      let sum = 0;
      for (let r = 0; r < 6; r++) {
        sum += jacobian[r][i] * y[r];
      }
      dq[i] = sum;
      biggest = Math.max(biggest, Math.abs(sum));
    }

    // One iteration may not jump further than maxStep, which keeps a far target
    // from snapping the arm across the workspace in a single frame.
    const scale = biggest > maxStep ? maxStep / biggest : 1;
    const next = { ...q };
    for (let i = 0; i < joints.length; i++) {
      next[joints[i].urdfName] = (q[joints[i].urdfName] ?? 0) + dq[i] * scale;
    }

    q = sanitize(joints, next);
    applyJointValues(robot, q);
    // The loader clamps whatever it was given; adopting its values keeps the next
    // Jacobian consistent with the pose it produced.
    q = readJointValues(joints);
  }

  return {
    q,
    posErr,
    rotErr,
    converged: posErr < posTol && rotErr < rotTol,
    iters,
  };
}

/**
 * Normalise a candidate configuration: wrap revolute angles, then clamp to the
 * limits (in that order - clamping first would be undone by the wrap).
 */
function sanitize(joints: LoaderJoint[], values: JointValues): JointValues {
  const out: JointValues = {};
  for (const joint of joints) {
    let v = values[joint.urdfName] ?? 0;
    if (!Number.isFinite(v)) {
      v = 0;
    }
    if (joint.jointType === "revolute" || joint.jointType === "continuous") {
      v = wrapToPi(v);
    }

    const range = clampRange(joint);
    if (range) {
      v = Math.min(range[1], Math.max(range[0], v));
    }
    out[joint.urdfName] = v;
  }
  return out;
}
