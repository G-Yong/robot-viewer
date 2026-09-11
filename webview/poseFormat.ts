/**
 * End-effector pose readout: the numbers the IK panel shows for the TCP, in
 * whichever representation and origin frame the user picked.
 *
 * Deliberately free of the DOM and of the viewer, for the same reason ikSolver is:
 * the rotation conventions are what is easy to get subtly wrong - a transposed
 * index still returns perfectly plausible-looking angles, with nothing in the
 * output to give the mistake away. The only honest way to check them is to run
 * them in node against an independent oracle, which is what tools/ikCheck.ts does:
 * it builds each rotation from the convention's own definition and round-trips it.
 *
 * Conventions
 * -----------
 * Every order here is **intrinsic** (rotations about the moving axes), which
 * composes, in fixed-frame terms, as
 *
 *     R = R_a1(θ1) · R_a2(θ2) · R_a3(θ3)
 *
 * Two families are on offer:
 *   - proper Euler, first and third axis equal: ZYZ, ZXZ
 *   - Tait-Bryan, three distinct axes: XYZ, ZYX
 *
 * RPY is not a rotation of its own: "fixed-axis XYZ" is exactly intrinsic ZYX with
 * (roll, pitch, yaw) = (θ3, θ2, θ1). It keeps its own entry in the panel because
 * that is the name URDF, RViz and every robot datasheet uses for those numbers.
 */
import * as THREE from "three";
import type { IkTarget } from "./ikSolver";

/** How the orientation is presented. */
export type PoseRepresentation = "rpy" | "euler" | "quaternion";

/** Intrinsic axis orders offered for the euler representation. */
export type EulerOrder = "ZYZ" | "ZXZ" | "XYZ" | "ZYX";

export interface PoseDisplayOptions {
  representation: PoseRepresentation;
  /** Only read when `representation` is "euler". */
  eulerOrder: EulerOrder;
}

export interface PoseRow {
  label: string;
  value: string;
}

/** One line of the readout: cells that share a unit. */
export interface PoseGroup {
  /** Shown once at the end of the line; "" for a unitless row. */
  unit: string;
  cells: PoseRow[];
}

export interface PoseReadout {
  /** Name of the frame the numbers are expressed in. */
  origin: string;
  groups: PoseGroup[];
  /** Set when the reading needs a caveat (gimbal lock). */
  note?: string;
}

export interface EulerReading {
  angles: [number, number, number];
  /** True at the degenerate middle angle, where θ3 is pinned to 0. */
  gimbal: boolean;
}

type Triple = [number, number, number];

/**
 * Below this the middle rotation counts as degenerate. Exact gimbal lock lands
 * far under it (cos(π/2) = 6.1e-17), while the atan2 ratios stay usable above it.
 */
const GIMBAL_EPS = 1e-6;

const RAD2DEG = 180 / Math.PI;

// A robot frame is tens to thousands of millimetres, where 0.1 mm is a readable
// resolution; the same for 0.1° of orientation. The quaternion gets more because
// four decimals is roughly where a change stops being visible in the pose.
const POSITION_DECIMALS = 1;
const ANGLE_DECIMALS = 1;
const QUATERNION_DECIMALS = 4;

const degrees = (rad: number): string => (rad * RAD2DEG).toFixed(ANGLE_DECIMALS);

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Whichever of x, y, z is non-zero first; 1 when all of them are. */
function firstNonZeroVectorPart(q: THREE.Quaternion): number {
  for (const c of [q.x, q.y, q.z]) {
    if (c !== 0) {
      return c;
    }
  }
  return 1;
}

/**
 * Unit quaternion with a pinned sign.
 *
 * q and -q are the same rotation but not the same four numbers, so the readout
 * would flip between them as a handle is dragged. At a half turn w is 0 and
 * carries no sign at all, so there the vector part decides. A zero (or NaN-prone)
 * input degrades to the identity rather than printing NaN in the panel.
 */
export function normalizeQuaternion(q: THREE.Quaternion): THREE.Quaternion {
  const out = q.clone();
  const len = out.length();
  if (len < 1e-12) {
    return new THREE.Quaternion();
  }
  out.normalize();
  if (out.w < 0 || (Math.abs(out.w) < 1e-12 && firstNonZeroVectorPart(out) < 0)) {
    out.set(-out.x, -out.y, -out.z, -out.w);
  }
  return out;
}

/**
 * Extract the intrinsic euler angles of `order` from a quaternion.
 *
 * One atan2 per axis, read off the rotation matrix. atan2 rather than
 * acos/asin-plus-a-quadrant-guess is what keeps this accurate: both arguments it
 * receives scale with the same sine, so the ratio stays well conditioned right up
 * to the degenerate case, which is detected separately rather than solved.
 */
export function quaternionToEuler(q: THREE.Quaternion, order: EulerOrder): EulerReading {
  // THREE stores matrices column-major, so element (row, col) is at col * 4 + row.
  const e = new THREE.Matrix4().makeRotationFromQuaternion(q).elements;
  const m = (row: number, col: number): number => e[col * 4 + row];

  switch (order) {
    case "ZYZ": {
      // Rz(θ1)·Ry(θ2)·Rz(θ3) has
      //   m22 = cos θ2, (m02, m12) = sin θ2 · (cos θ1, sin θ1),
      //   (m20, m21) = sin θ2 · (-cos θ3, sin θ3).
      // θ2 ∈ [0, π] makes sin θ2 ≥ 0, so the two vector rows each give their angle
      // directly - except where sin θ2 vanishes and θ1, θ3 only appear as a sum
      // (θ2 → 0) or a difference (θ2 → π), which is the gimbal-lock case.
      const theta2 = Math.acos(clamp(m(2, 2), -1, 1));
      if (Math.sin(theta2) < GIMBAL_EPS) {
        const theta1 = Math.atan2(m(1, 0), Math.sign(m(2, 2)) * m(0, 0));
        return { angles: [theta1, theta2, 0], gimbal: true };
      }
      return {
        angles: [Math.atan2(m(1, 2), m(0, 2)), theta2, Math.atan2(m(2, 1), -m(2, 0))],
        gimbal: false,
      };
    }

    case "ZXZ": {
      // Rz(θ1)·Rx(θ2)·Rz(θ3): m22 = cos θ2, (m02, m12) = sin θ2 · (sin θ1, -cos θ1),
      // (m20, m21) = sin θ2 · (sin θ3, cos θ3).
      const theta2 = Math.acos(clamp(m(2, 2), -1, 1));
      if (Math.sin(theta2) < GIMBAL_EPS) {
        // θ1 + θ3 (at θ2 → 0) and θ1 - θ3 (at θ2 → π) read the same off this 2x2
        // block, so one expression covers both ends.
        const theta1 = Math.atan2(m(1, 0), m(0, 0));
        return { angles: [theta1, theta2, 0], gimbal: true };
      }
      return {
        angles: [Math.atan2(m(0, 2), -m(1, 2)), theta2, Math.atan2(m(2, 0), m(2, 1))],
        gimbal: false,
      };
    }

    case "XYZ": {
      // Rx(θ1)·Ry(θ2)·Rz(θ3): m02 = sin θ2, (m12, m22) = cos θ2 · (-sin θ1, cos θ1),
      // (m01, m00) = cos θ2 · (-sin θ3, cos θ3).
      const theta2 = Math.asin(clamp(m(0, 2), -1, 1));
      if (Math.abs(Math.cos(theta2)) < GIMBAL_EPS) {
        // θ2 = ±π/2 leaves θ1 and θ3 as a single rotation about X, and the sign of
        // sin θ2 picks which way round: θ1 - θ3 at the top, θ1 + θ3 at the bottom.
        const theta1 =
          m(0, 2) > 0
            ? Math.atan2(m(1, 0), -m(2, 0))
            : Math.atan2(-m(1, 0), m(2, 0));
        return { angles: [theta1, theta2, 0], gimbal: true };
      }
      return {
        angles: [Math.atan2(-m(1, 2), m(2, 2)), theta2, Math.atan2(-m(0, 1), m(0, 0))],
        gimbal: false,
      };
    }

    default: {
      // ZYX: Rz(θ1)·Ry(θ2)·Rx(θ3), i.e. Rz(yaw)·Ry(pitch)·Rx(roll) with the triple
      // reversed - which is why quaternionToRpy() below is this one, re-versed.
      // m20 = -sin θ2, (m10, m00) = cos θ2 · (sin θ1, cos θ1),
      // (m21, m22) = cos θ2 · (sin θ3, cos θ3).
      const theta2 = Math.asin(clamp(-m(2, 0), -1, 1));
      if (Math.abs(Math.cos(theta2)) < GIMBAL_EPS) {
        // At θ2 = ±π/2, θ1 ∓ θ3 is all the matrix still holds.
        const sine2 = -m(2, 0);
        const theta1 = Math.atan2(-m(0, 1), sine2 > 0 ? m(0, 2) : -m(0, 2));
        return { angles: [theta1, theta2, 0], gimbal: true };
      }
      return {
        angles: [Math.atan2(m(1, 0), m(0, 0)), theta2, Math.atan2(m(2, 1), m(2, 2))],
        gimbal: false,
      };
    }
  }
}

/**
 * Roll, pitch, yaw in the URDF / RViz sense: rotations about the fixed X, Y and Z
 * axes, applied in that order.
 */
export function quaternionToRpy(q: THREE.Quaternion): Triple {
  const { angles } = quaternionToEuler(q, "ZYX");
  return [angles[2], angles[1], angles[0]];
}

/**
 * Re-express a world-frame pose in `frame` (null means the world frame itself, so
 * the pose is returned untouched). Reads the frame's own world matrix, so any node
 * in the scene graph works as an origin - not just the robot base.
 */
export function poseInFrame(tcp: IkTarget, frame: THREE.Object3D | null): IkTarget {
  if (!frame) {
    return { position: tcp.position.clone(), quaternion: tcp.quaternion.clone() };
  }
  frame.updateMatrixWorld(true);
  const inverse = frame.getWorldQuaternion(new THREE.Quaternion()).invert();
  return {
    position: frame.worldToLocal(tcp.position.clone()),
    quaternion: inverse.multiply(tcp.quaternion.clone()),
  };
}

/**
 * Everything the panel renders for one pose: a group per unit - position in mm,
 * then the orientation in the chosen representation - plus a note when the
 * reading needs a caveat.
 */
export function buildReadout(
  pose: IkTarget,
  origin: string,
  opts: PoseDisplayOptions
): PoseReadout {
  const position: PoseGroup = {
    unit: "mm",
    cells: [
      { label: "X", value: (pose.position.x * 1000).toFixed(POSITION_DECIMALS) },
      { label: "Y", value: (pose.position.y * 1000).toFixed(POSITION_DECIMALS) },
      { label: "Z", value: (pose.position.z * 1000).toFixed(POSITION_DECIMALS) },
    ],
  };

  let orientation: PoseGroup;
  let note: string | undefined;

  if (opts.representation === "quaternion") {
    const n = normalizeQuaternion(pose.quaternion);
    orientation = {
      unit: "",
      cells: (["x", "y", "z", "w"] as const).map((label) => ({
        label,
        value: n[label].toFixed(QUATERNION_DECIMALS),
      })),
    };
  } else if (opts.representation === "rpy") {
    const [roll, pitch, yaw] = quaternionToRpy(pose.quaternion);
    orientation = {
      unit: "°",
      cells: [
        { label: "R", value: degrees(roll) },
        { label: "P", value: degrees(pitch) },
        { label: "Y", value: degrees(yaw) },
      ],
    };
  } else {
    const reading = quaternionToEuler(pose.quaternion, opts.eulerOrder);
    const [a, b, c] = opts.eulerOrder.split("");
    orientation = {
      unit: "°",
      // Primes mark the moving axes. Without them "Z Y Z" and "Z Y′ Z″" would look
      // like the same row, and the reason two conventions disagree about the same
      // pose is exactly which axis moved.
      cells: [
        { label: a, value: degrees(reading.angles[0]) },
        { label: `${b}′`, value: degrees(reading.angles[1]) },
        { label: `${c}″`, value: degrees(reading.angles[2]) },
      ],
    };
    if (reading.gimbal) {
      // Named with the middle angle that caused it: at the home pose this fires for
      // ZYZ and ZXZ (θ2 = 0 is degenerate for them), which looks alarming until the
      // note says why - only the sum of the other two angles is determined there.
      note = `gimbal lock at θ2 = ${degrees(reading.angles[1])}° — the third angle is pinned to 0°`;
    }
  }

  return { origin, groups: [position, orientation], note };
}
