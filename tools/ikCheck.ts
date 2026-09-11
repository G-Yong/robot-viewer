/**
 * Offline check for the interactive-IK solver (webview/ikSolver.ts).
 *
 * Runs in plain node - no browser, no VS Code - by shimming the two DOM pieces
 * urdf-loader needs (DOMParser plus the one querySelector form it uses) with
 * xmldom and stubbing mesh loading. The solver never touches the DOM, so the
 * whole numeric path can be verified without launching the extension:
 *
 *   npm run check:ik
 *
 * Exit code is non-zero when any check fails, so it can gate a build.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as THREE from "three";
import URDFLoader from "urdf-loader";
import { DOMParser } from "@xmldom/xmldom";

import {
  applyJointValues,
  collectChainJoints,
  collectMovableJoints,
  computeJacobian,
  quaternionToRotationVector,
  readJointValues,
  solveIk,
  tcpPose,
  type TcpSpec,
} from "../webview/ikSolver";
import type { JointValues } from "../src/protocol";

// ---------------------------------------------------------------------------
// Environment shims
// ---------------------------------------------------------------------------

/**
 * urdf-loader parses with `new DOMParser()`, branches on `instanceof Document`
 * and `instanceof Element`, spreads/indexes `children` on every node, and detects
 * the root link with `querySelector('child[link="name"]')`. xmldom provides the
 * parser and the two classes (borrowed off a probe document) but neither
 * `children` as an iterable nor `querySelector`, so those are added per node.
 */
function installDomShim(): void {
  const globals = globalThis as unknown as Record<string, unknown>;
  globals.DOMParser = DOMParser;

  const probe = new DOMParser().parseFromString("<r/>", "text/xml");
  globals.Document = (probe as unknown as { constructor: unknown }).constructor;
  globals.Element = Object.getPrototypeOf(probe.documentElement).constructor;
}

/** Give a parsed subtree the DOM surface urdf-loader relies on. */
function patchDom(node: any): void {
  const kids: any[] = [];
  const list = node.childNodes;
  for (let i = 0; i < (list?.length ?? 0); i++) {
    const child = typeof list.item === "function" ? list.item(i) : list[i];
    if (child && child.nodeType === 1) {
      kids.push(child);
    }
  }

  Object.defineProperty(node, "children", {
    value: kids,
    configurable: true,
    enumerable: false,
  });

  if (typeof node.querySelector !== "function") {
    Object.defineProperty(node, "querySelector", {
      value: function (selector: string): unknown {
        const match = /^([\w-]+)\[link="([^"]+)"\]$/.exec(selector.trim());
        if (!match) {
          return null;
        }
        const [, tag, link] = match;
        const all = this.getElementsByTagName(tag);
        for (let i = 0; i < all.length; i++) {
          if (all[i].getAttribute("link") === link) {
            return all[i];
          }
        }
        return null;
      },
      configurable: true,
      writable: true,
      enumerable: false,
    });
  }

  for (const child of kids) {
    patchDom(child);
  }
}

function loadSampleRobot(fileName: string): any {
  const path = join(__dirname, "..", "samples", fileName);
  const loader = new URDFLoader();
  // Primitive geometry only: nothing to load, so an empty group is enough.
  loader.loadMeshCb = (_path, _manager, done) => done(new THREE.Group(), undefined);

  // Hand urdf-loader the <robot> element itself: its Element branch takes the
  // node as-is, whereas the Document branch would need `children` on the
  // document node as well.
  const doc = new DOMParser().parseFromString(readFileSync(path, "utf8"), "text/xml");
  const robotNode = doc.documentElement;
  patchDom(robotNode);
  return loader.parse(robotNode as unknown as Element);
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

let failures = 0;

function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) {
    failures++;
  }
}

function fmt(v: number): string {
  return v.toExponential(2);
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

/** The analytic Jacobian must match a central-difference one column by column. */
function checkJacobian(robot: any, spec: TcpSpec): void {
  const joints = collectMovableJoints(robot);
  const home = readJointValues(joints);
  const eps = 1e-6;

  applyJointValues(robot, home);
  const analytic = computeJacobian(robot, joints, spec);
  const pose0 = tcpPose(robot, spec);

  let worst = 0;
  for (let i = 0; i < joints.length; i++) {
    const probe = { ...home };
    const up = { ...home };
    const down = { ...home };
    probe[joints[i].name] = home[joints[i].name];
    up[joints[i].name] = home[joints[i].name] + eps;
    down[joints[i].name] = home[joints[i].name] - eps;

    applyJointValues(robot, up);
    const poseUp = tcpPose(robot, spec);
    applyJointValues(robot, down);
    const poseDown = tcpPose(robot, spec);

    const dp = poseUp.position
      .clone()
      .sub(poseDown.position)
      .multiplyScalar(1 / (2 * eps));
    const dq = poseUp.quaternion
      .clone()
      .multiply(poseDown.quaternion.clone().invert());
    const dRot = quaternionToRotationVector(dq).multiplyScalar(1 / (2 * eps));

    for (let row = 0; row < 3; row++) {
      worst = Math.max(worst, Math.abs(analytic[row][i] - dp.getComponent(row)));
      worst = Math.max(worst, Math.abs(analytic[row + 3][i] - dRot.getComponent(row)));
    }
    applyJointValues(robot, probe);
  }

  applyJointValues(robot, home);
  check(
    "jacobian matches finite differences",
    worst < 1e-5,
    `n=${joints.length}, worst |dJ| = ${fmt(worst)}`
  );
}

/** TCP must be the link frame translated by the offset, expressed in that frame. */
function checkTcpOffset(robot: any): void {
  const joints = collectMovableJoints(robot);
  const home = readJointValues(joints);
  applyJointValues(robot, home);

  const link = robot.links["tool"];
  const plain = tcpPose(robot, { link: "tool", offset: new THREE.Vector3() });
  const linkPos = link.getWorldPosition(new THREE.Vector3());
  const linkQuat = link.getWorldQuaternion(new THREE.Quaternion());

  const offset = new THREE.Vector3(0.01, 0.02, 0.3);
  const shifted = tcpPose(robot, { link: "tool", offset });
  const expected = offset.clone().applyQuaternion(linkQuat).add(linkPos);

  const posErr = plain.position.distanceTo(linkPos);
  const shiftedErr = shifted.position.distanceTo(expected);
  const rotErr = plain.quaternion.angleTo(linkQuat);

  check(
    "tcp pose honours the tool offset",
    posErr < 1e-9 && shiftedErr < 1e-9 && rotErr < 1e-9,
    `link=${fmt(posErr)}, offset=${fmt(shiftedErr)}, rot=${fmt(rotErr)}`
  );
}

/** Targets generated by the arm itself must be solved back, from a far start. */
function checkReachableTargets(robot: any, spec: TcpSpec): void {
  const joints = collectMovableJoints(robot);
  const mid = (j: (typeof joints)[number]): number => {
    if (j.jointType === "continuous" || !j.limit) {
      return 0;
    }
    return (j.limit.lower + j.limit.upper) / 2;
  };
  const home: JointValues = {};
  for (const j of joints) {
    home[j.name] = mid(j);
  }

  let worstPos = 0;
  let worstRot = 0;
  let solved = 0;
  const cases = 20;
  for (let c = 0; c < cases; c++) {
    // A target near the mid posture: always reachable, and a fair test of
    // convergence (a target far outside the workspace proves nothing).
    const qRef: JointValues = {};
    for (const j of joints) {
      const jitter = (Math.random() - 0.5) * 0.8;
      let v = mid(j) + jitter;
      if (j.jointType !== "continuous" && j.limit) {
        v = Math.min(j.limit.upper, Math.max(j.limit.lower, v));
      }
      qRef[j.name] = v;
    }
    applyJointValues(robot, qRef);
    const target = tcpPose(robot, spec);

    const res = solveIk(robot, spec, target, { start: home });
    worstPos = Math.max(worstPos, res.posErr);
    worstRot = Math.max(worstRot, res.rotErr);
    if (res.converged) {
      solved++;
    }

    // The solution must obey the joint limits...
    for (const j of joints) {
      const v = res.q[j.name];
      if (j.jointType !== "continuous" && j.limit && j.jointType !== "fixed") {
        if (v < j.limit.lower - 1e-6 || v > j.limit.upper + 1e-6) {
          check(`limits respected (case ${c})`, false, `${j.name} = ${v}`);
          return;
        }
      }
    }
  }

  check(
    "solves reachable targets",
    solved === cases && worstPos < 1e-3 && worstRot < 1e-3,
    `${solved}/${cases}, worst pos = ${fmt(worstPos)} m, worst rot = ${fmt(worstRot)} rad`
  );
}

/** No joint may wind up by whole turns (the 754.9 deg bug). */
function checkNoRunawayWinding(robot: any, spec: TcpSpec): void {
  const joints = collectMovableJoints(robot);
  const start: JointValues = {};
  for (const j of joints) {
    start[j.name] = 0;
  }

  let worst = 0;
  for (let c = 0; c < 10; c++) {
    const qRef: JointValues = {};
    for (const j of joints) {
      const span = j.limit ? j.limit.upper - j.limit.lower : 2 * Math.PI;
      qRef[j.name] = (Math.random() - 0.5) * span * 0.6;
    }
    applyJointValues(robot, qRef);
    const res = solveIk(robot, spec, tcpPose(robot, spec), { start });
    for (const j of joints) {
      worst = Math.max(worst, Math.abs(res.q[j.name]));
    }
  }

  // Wrapped into (-pi, pi], so anything near or above 2*pi means the solver
  // accumulated revolutions instead of re-normalising.
  check(
    "no full-turn winding",
    worst <= Math.PI + 1e-6,
    `max |q| = ${worst.toFixed(4)} rad (limit ${Math.PI.toFixed(4)})`
  );
}

/**
 * A drag the arm cannot meet exactly must still settle on the nearest pose it
 * can hold, within the viewer's acceptance threshold. That is the normal case for
 * an arm with fewer than six joints: translating this 3-DOF arm while keeping the
 * tool orientation gives a 1-D curve of exact solutions, so a sideways nudge has
 * a small but non-zero best-possible residual.
 */
function checkNearestReachable(robot: any, spec: TcpSpec): void {
  const joints = collectMovableJoints(robot);
  const zero: JointValues = {};
  for (const j of joints) {
    zero[j.name] = 0;
  }
  applyJointValues(robot, zero);

  const start = tcpPose(robot, spec);
  const target = {
    position: start.position.clone().add(new THREE.Vector3(0.0406, 0, 0)),
    quaternion: start.quaternion.clone(),
  };
  const res = solveIk(robot, spec, target);

  // 40 mm sideways on a 400 mm-radius arc leaves ~2 mm of irreducible error.
  check(
    "settles on the nearest reachable pose",
    res.posErr < 3e-3,
    `posErr = ${(res.posErr * 1000).toFixed(2)} mm over ${res.iters} iterations`
  );
}

/** A hopeless target must be reported, not "solved" with wild angles. */function checkUnreachableTarget(robot: any, spec: TcpSpec): void {
  const joints = collectMovableJoints(robot);
  const start: JointValues = {};
  for (const j of joints) {
    start[j.name] = 0;
  }

  const far = new THREE.Vector3(10, 10, 10);
  const res = solveIk(robot, spec, { position: far, quaternion: new THREE.Quaternion() }, {
    start,
  });

  let maxAbs = 0;
  for (const j of joints) {
    maxAbs = Math.max(maxAbs, Math.abs(res.q[j.name]));
  }

  check(
    "reports unreachable targets",
    !res.converged && res.posErr > 1 && maxAbs <= Math.PI + 1e-6,
    `converged=${res.converged}, posErr=${res.posErr.toFixed(3)} m, max |q| = ${maxAbs.toFixed(3)}`
  );
}

/**
 * Dragging one end effector must leave every other mechanism in the model alone.
 *
 * A Jacobian column only means anything for a joint that is an ancestor of the
 * TCP; for any other joint the axis-cross-lever formula still returns a
 * plausible-looking vector instead of failing loudly. Handing the whole model to
 * the solver therefore let it "reach" a target by moving both arms at once - the
 * handle being dragged was not the only thing that moved, and the dragged arm did
 * not even converge because the solver was spending the error on joints that move
 * nothing. Scoping the solve to the TCP's own chain is the fix; this keeps it.
 */
function checkIndependentArms(robot: any): void {
  const left: TcpSpec = { link: "tool_L", offset: new THREE.Vector3() };
  const right: TcpSpec = { link: "tool_R", offset: new THREE.Vector3() };

  const chain = collectChainJoints(robot, left.link);
  check(
    "one arm's solve only spans that arm",
    chain.length === 3 && chain.every((j) => j.urdfName.endsWith("_L")),
    chain.map((j) => j.urdfName).join(", ")
  );

  const joints = collectMovableJoints(robot);
  const mid: JointValues = {};
  for (const j of joints) {
    mid[j.urdfName] = (j.limit.lower + j.limit.upper) / 2;
  }

  // A target taken from the left arm's own forward kinematics, so it is
  // reachable by construction whichever fixture is loaded.
  const qRef: JointValues = { ...mid };
  qRef["shoulder_yaw_L"] += 0.3;
  qRef["elbow_pitch_L"] -= 0.4;
  qRef["wrist_pitch_L"] += 0.2;
  applyJointValues(robot, qRef);
  const target = tcpPose(robot, left);

  applyJointValues(robot, mid);
  const rightTcpBefore = tcpPose(robot, right);
  const res = solveIk(robot, left, target, { start: mid });

  check(
    "the dragged arm reaches a target from its own kinematics",
    res.converged,
    `posErr = ${fmt(res.posErr)} m, rotErr = ${fmt(res.rotErr)} rad`
  );
  checkRightArmStill(robot, joints, mid, right, rightTcpBefore, "after a successful drag");

  // A target the arm cannot hold is the other half of the story: refusing it must
  // not spill motion onto the rest of the model either.
  applyJointValues(robot, mid);
  const refused = solveIk(
    robot,
    left,
    { position: new THREE.Vector3(10, 10, 10), quaternion: new THREE.Quaternion() },
    { start: mid }
  );
  check("a hopeless target is still refused", !refused.converged);
  checkRightArmStill(robot, joints, mid, right, rightTcpBefore, "after a refused drag");
}

/** Every joint and the TCP of the non-dragged arm must be bit-for-bit where it was. */
function checkRightArmStill(
  robot: any,
  joints: any[],
  before: JointValues,
  right: TcpSpec,
  rightTcpBefore: { position: THREE.Vector3 },
  when: string
): void {
  const after = readJointValues(joints);
  let drift = 0;
  for (const j of joints) {
    if (j.urdfName.endsWith("_R")) {
      drift = Math.max(drift, Math.abs(after[j.urdfName] - before[j.urdfName]));
    }
  }
  const tcpDrift = tcpPose(robot, right).position.distanceTo(rightTcpBefore.position);

  check(
    `the other arm is left untouched ${when}`,
    drift < 1e-9 && tcpDrift < 1e-9,
    `joint drift = ${fmt(drift)} rad, tcp drift = ${fmt(tcpDrift)} m`
  );
}

// ---------------------------------------------------------------------------

function main(): void {
  installDomShim();
  const robot = loadSampleRobot("simple_arm.urdf");
  const spec: TcpSpec = { link: "tool", offset: new THREE.Vector3() };

  check(
    "sample model exposes its joints",
    collectMovableJoints(robot).length === 3,
    `${collectMovableJoints(robot).length} movable joints`
  );

  checkTcpOffset(robot);
  checkJacobian(robot, spec);
  checkReachableTargets(robot, spec);
  checkNearestReachable(robot, spec);
  checkNoRunawayWinding(robot, spec);
  checkUnreachableTarget(robot, spec);

  checkIndependentArms(loadSampleRobot("dual_arm.urdf"));

  console.log(failures === 0 ? "\nIK CHECK OK" : `\nIK CHECK FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
