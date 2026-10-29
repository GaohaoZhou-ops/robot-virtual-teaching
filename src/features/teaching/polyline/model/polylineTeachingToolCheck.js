import * as THREE from 'three';
import { createMobileCollisionChecker, MOBILE_ENVIRONMENT_MARGIN } from "../../mobile/model/mobileTeachingCollision.js";
import { polylineStartQuaternion } from "./polylineTeachingOrientation.js";

const moving = (node) => ['revolute', 'continuous', 'prismatic'].includes(node.userData?.jointType);
const rigidRoot = (node) => {
  for (let parent = node; parent; parent = parent.parent) if (moving(parent)) return parent;
  return null;
};

// A rigid tool's world pose at P0 is determined by the TCP, offset and tool
// orientation, independently of elbow/waist/base IK. Inspect only those rigid
// attachments, never an invented whole-body pose. A clear result is NOT IK.
export async function checkPolylineStartTool({ robot, frame, path, environment, preparedEnvironment, checkpoint = async () => {}, certifyTolerance = true }) {
  robot.updateWorldMatrix(true, true);
  const root = rigidRoot(frame), attached = [];
  robot.traverse((node) => {
    if (node.userData.mobileCollision && rigidRoot(node) === root) attached.push(node);
  });
  if (!attached.length) return null;
  const tcpMatrix = frame.matrixWorld.clone().multiply(new THREE.Matrix4().makeTranslation(...path.tcpOffset));
  const current = new THREE.Vector3(), currentQ = new THREE.Quaternion(), scale = new THREE.Vector3();
  tcpMatrix.decompose(current, currentQ, scale);
  // A sheared or degenerate frame needs the normal planner; do not infer a
  // rigid displacement bound from its decomposed quaternion.
  const recomposed = new THREE.Matrix4().compose(current, currentQ, scale);
  if (Math.min(scale.x, scale.y, scale.z) <= 1e-9
    || tcpMatrix.elements.some((value, i) => !Number.isFinite(value) || Math.abs(value - recomposed.elements[i]) > 1e-8)) return null;
  const position = new THREE.Vector3().fromArray(path.points[0].position);
  const reference = path.quaternion ? new THREE.Quaternion().fromArray(path.quaternion).normalize() : currentQ;
  const quaternion = path.settings.perpendicularTool ? polylineStartQuaternion(path, reference) : reference;
  const desired = new THREE.Matrix4().compose(position, quaternion, scale);
  const transform = desired.multiply(tcpMatrix.clone().invert());
  const layer = new THREE.Group(), tool = new THREE.Group();
  // Retain the original support plane while placing detached collision boxes
  // at the required goal pose. Neither the live robot nor its joints move.
  layer.position.z = robot.parent.position.z; layer.add(tool); layer.updateMatrixWorld(true);
  const inverseLayer = layer.matrixWorld.clone().invert();
  const angular = THREE.MathUtils.degToRad(path.settings.rotationTolerance);
  let inspected = 0;
  for (const node of attached) {
    await checkpoint();
    const data = node.userData.mobileCollision;
    const proxyPosition = new THREE.Vector3(), proxyQuaternion = new THREE.Quaternion(), proxyScale = new THREE.Vector3();
    node.matrixWorld.decompose(proxyPosition, proxyQuaternion, proxyScale);
    const proxyMatrix = new THREE.Matrix4().compose(proxyPosition, proxyQuaternion, proxyScale);
    if (node.matrixWorld.elements.some((value, i) => !Number.isFinite(value) || Math.abs(value - proxyMatrix.elements[i]) > 1e-8)) continue;
    const nodeScale = proxyScale.toArray().map(Math.abs);
    if (nodeScale.some(value => !Number.isFinite(value) || value < 1e-9)) continue;
    // Erode by an upper bound on ALL displacement allowed by the configured
    // position/orientation tolerances. An intersection of this common interior
    // persists throughout that tolerance, so a nominal near-contact alone must
    // never suppress an otherwise feasible approach. Use the same 8 mm shell
    // as the collision checker, including it in the angular radius bound.
    let radius = 0;
    for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) {
      const corner = new THREE.Vector3(...[x, y, z].map((sign, i) => data.center[i]
        + sign * (data.halfSize[i] + MOBILE_ENVIRONMENT_MARGIN / nodeScale[i]))).applyMatrix4(node.matrixWorld);
      radius = Math.max(radius, corner.distanceTo(current));
    }
    const displacement = certifyTolerance ? path.settings.tolerance + 2 * radius * Math.sin(angular / 2) + 1e-9 : 0;
    const halfSize = data.halfSize.map((half, i) => half - displacement / nodeScale[i]);
    if (halfSize.some(half => half <= 0)) continue;
    const proxy = new THREE.Object3D();
    proxy.matrixAutoUpdate = false;
    proxy.matrix.copy(inverseLayer).multiply(transform).multiply(node.matrixWorld);
    proxy.userData.mobileCollision = { ...data, halfSize, hull: null };
    tool.add(proxy); inspected += 1;
  }
  if (!inspected) return null;
  layer.updateMatrixWorld(true);
  const checker = await createMobileCollisionChecker(tool, environment, checkpoint, { preparedEnvironment });
  const checked = checker.check({ detailedEnvironment: true });
  // Ground, self collision and the rest of the robot belong to full planning.
  const collision = { ...checked, clear: checked.environmentLinks.length === 0,
    selfPairs: [], groundLinks: [], armBodyClearance: { checked: false, required: 0, clear: true } };
  return { blocked: !collision.clear, collision, rigidLinkCount: inspected, allAttachmentsChecked: inspected === attached.length,
    position: position.toArray(), toolPosition: new THREE.Vector3().fromArray(path.tcpOffset).multiply(scale).negate().applyQuaternion(quaternion).add(position).toArray(),
    positionTolerance: path.settings.tolerance, rotationTolerance: path.settings.rotationTolerance };
}
