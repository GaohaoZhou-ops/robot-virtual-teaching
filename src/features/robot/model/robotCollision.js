import * as THREE from 'three';
import { collisionSideForLink, normalizeIgnoredCollisionJoints } from "./robotCollisionSettings.js";
import { isRobotBodyJoint } from "../../../shared/robotics/robotJointLocks.js";
import { applyRobotMaterialOpacity, robotSourceMaterialOpacity } from "./robotDisplay.js";

export const ROBOT_COLLISION_SAFETY_DISTANCE = 0.1;
export const ROBOT_COLLISION_CONTACT_MARGIN = 0.008;
export const ROBOT_COLLISION_CHECK_INTERVAL_MS = 160;

const CHASSIS_LINK_PATTERN = /(?:^base(?:[_-]|$)|(?:^|[_-])(?:chassis|wheel|caster|mecanum)(?:[_-]|$)|(?:mobile|robot)[_-]base)/i;
const BODY_BRANCH_PATTERN = /(?:^|[_-])(?:torso|trunk|body|waist|hip|pelvis|chest|head|neck|ankle|knee|spine)(?:[_-]|$)/i;

const RED_WARNING_COLOR = '#ff4545';
const YELLOW_WARNING_COLOR = '#ffc84a';

export const createRobotCollisionStatus = (overrides = {}) => ({
  enabled: false,
  state: 'disabled',
  backend: 'local',
  requestedBackend: 'local',
  engine: 'Browser spatial worker',
  threshold: ROBOT_COLLISION_SAFETY_DISTANCE,
  minimumDistance: null,
  collisionLinks: [],
  nearLinks: [],
  excludedLinks: [],
  ignoredJointNames: [],
  ignoredLinks: [],
  monitoredLinkCount: 0,
  monitoredProxyCount: 0,
  collisionModelProxyCount: 0,
  visualFallbackProxyCount: 0,
  sourcePointCount: 0,
  indexedPointCount: 0,
  meshSampleCount: 0,
  checkCount: 0,
  message: '碰撞保护未开启',
  detail: '专用空间索引与距离检测尚未占用硬件资源',
  ...overrides,
});

export const isExcludedRobotCollisionLink = (name) => (
  CHASSIS_LINK_PATTERN.test(String(name || '').trim())
);

const collisionJointGroup = (link, robot) => {
  const joint = link?.parent;
  if (['revolute', 'continuous', 'prismatic'].includes(joint?.userData?.jointType)) {
    // Match the editable torso joints in preset creation and joint adjustment.
    if (isRobotBodyJoint(joint.name)) return 'torso';
    if (/(head|neck)/i.test(joint.name)) return 'head';
  }
  // Fixed arm/base attachments retain their mounting group. Torso/head
  // attachments stay configurable separately from those movable joints.
  for (let current = link; current && current !== robot; current = current.parent) {
    if (current.userData?.urdfType === 'link') {
      const side = collisionSideForLink(current.name);
      if (side !== 'body') return side;
      if (BODY_BRANCH_PATTERN.test(current.name)) return 'other';
      if (isExcludedRobotCollisionLink(current.name)) return 'chassis';
    }
    if (current.userData?.urdfType === 'joint' && current.userData.jointType !== 'fixed') return 'other';
  }
  return 'other';
};

const findOwningLink = (object, robot) => {
  let current = object;
  while (current && current !== robot) {
    if (current.userData?.urdfType === 'link') return current;
    current = current.parent;
  }
  return null;
};

const hasUrdfAncestor = (object, robot, type) => {
  let current = object;
  while (current && current !== robot) {
    if (current.userData?.urdfType === type) return true;
    current = current.parent;
  }
  return false;
};

const materialAllowsCollisionOverlay = (mesh) => {
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  return materials.some((material) => (
    material
    && material.visible !== false
    && material.colorWrite !== false
    && Number(robotSourceMaterialOpacity(material)) > 0.01
  ));
};

const createWarningMaterial = (color) => new THREE.MeshBasicMaterial({
  color,
  transparent: false,
  opacity: 1,
  depthTest: true,
  depthWrite: true,
  toneMapped: false,
  fog: false,
});

const warningMaterialForMesh = (mesh, material) => (
  Array.isArray(mesh.material) ? mesh.material.map(() => material) : material
);

const collectRobotCollisionMeshes = (robot, includeChassis = false) => {
  const excludedLinks = new Set();
  const visualMeshes = new Map();
  const collisionMeshes = new Map();
  const jointByLink = new Map();

  robot?.traverse((object) => {
    if (!includeChassis && object.userData?.urdfType === 'link' && isExcludedRobotCollisionLink(object.name)) {
      excludedLinks.add(object.name);
    }
    if (!object.isMesh || !object.geometry?.getAttribute?.('position')) return;

    const link = findOwningLink(object, robot);
    const linkName = link?.name || robot?.name || 'robot';
    if (!includeChassis && isExcludedRobotCollisionLink(linkName)) {
      excludedLinks.add(linkName);
      return;
    }
    // Each joint owns its direct child link, not the entire downstream chain.
    if (link?.parent?.userData?.urdfType === 'joint') {
      jointByLink.set(linkName, { name: link.parent.name, type: link.parent.userData.jointType,
        group: collisionJointGroup(link, robot) });
    }

    const isCollisionGeometry = Boolean(object.userData?.robotCollisionGeometry)
      || hasUrdfAncestor(object, robot, 'collision');
    if (isCollisionGeometry) {
      if (!collisionMeshes.has(linkName)) collisionMeshes.set(linkName, []);
      collisionMeshes.get(linkName).push(object);
      return;
    }
    if (object.userData?.robotChassisDragHandle || !materialAllowsCollisionOverlay(object)) return;
    if (!visualMeshes.has(linkName)) visualMeshes.set(linkName, []);
    visualMeshes.get(linkName).push(object);
  });
  return { excludedLinks, visualMeshes, collisionMeshes, jointByLink };
};

export function getRobotCollisionJointOptions(robot) {
  const { visualMeshes, collisionMeshes, jointByLink } = collectRobotCollisionMeshes(robot);
  const options = new Map();
  new Set([...visualMeshes.keys(), ...collisionMeshes.keys()]).forEach((linkName) => {
    const joint = jointByLink.get(linkName);
    if (!joint?.name) return;
    if (!options.has(joint.name)) options.set(joint.name, { ...joint, links: [] });
    options.get(joint.name).links.push(linkName);
  });
  return [...options.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function collectRobotCollisionProxies(robot, ignoredJointNames = [], { includeChassis = false, highlights = true } = {}) {
  const { excludedLinks, visualMeshes, collisionMeshes, jointByLink } = collectRobotCollisionMeshes(robot, includeChassis);
  const ignoredJoints = new Set(normalizeIgnoredCollisionJoints(ignoredJointNames));
  const ignoredLinks = [];
  const proxies = [];
  const monitoredLinks = new Set();
  const highlightEntries = [];
  const redMaterial = highlights ? createWarningMaterial(RED_WARNING_COLOR) : null;
  const yellowMaterial = highlights ? createWarningMaterial(YELLOW_WARNING_COLOR) : null;
  let proxyIndex = 0;

  const linkNames = new Set([...visualMeshes.keys(), ...collisionMeshes.keys()]);
  linkNames.forEach((linkName) => {
    if (ignoredJoints.has(jointByLink.get(linkName)?.name)) {
      excludedLinks.add(linkName);
      ignoredLinks.push(linkName);
      return;
    }
    const dedicatedCollisionMeshes = collisionMeshes.get(linkName) || [];
    const fallbackVisualMeshes = visualMeshes.get(linkName) || [];
    const detectionMeshes = dedicatedCollisionMeshes.length
      ? dedicatedCollisionMeshes
      : fallbackVisualMeshes;
    const proxySource = dedicatedCollisionMeshes.length ? 'urdf-collision' : 'visual-fallback';

    detectionMeshes.forEach((mesh) => {
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
      const box = mesh.geometry.boundingBox;
      if (!box || box.isEmpty()) return;
      const localCenter = box.getCenter(new THREE.Vector3());
      const localHalfSize = box.getSize(new THREE.Vector3()).multiplyScalar(0.5);
      if (![...localCenter.toArray(), ...localHalfSize.toArray()].every(Number.isFinite)) return;

      monitoredLinks.add(linkName);
      proxies.push({
        id: `proxy-${proxyIndex += 1}`,
        linkName,
        mesh,
        source: proxySource,
        localCenter,
        localHalfSize,
      });
    });

    (highlights ? fallbackVisualMeshes : []).forEach((mesh) => {
      highlightEntries.push({
        linkName,
        mesh,
        originalMaterial: mesh.material,
        warningMaterials: {
          collision: warningMaterialForMesh(mesh, redMaterial),
          near: warningMaterialForMesh(mesh, yellowMaterial),
        },
        warningState: 'safe',
      });
    });
  });

  return {
    robot,
    proxies,
    highlightEntries,
    excludedLinks: [...excludedLinks].sort(),
    ignoredLinks: ignoredLinks.sort(),
    monitoredLinks: [...monitoredLinks].sort(),
    collisionModelProxyCount: proxies.filter(
      (proxy) => proxy.source === 'urdf-collision',
    ).length,
    visualFallbackProxyCount: proxies.filter(
      (proxy) => proxy.source === 'visual-fallback',
    ).length,
    warningMaterials: [redMaterial, yellowMaterial].filter(Boolean),
  };
}

const readWorldAxis = (elements, offset, target) => {
  target.set(elements[offset], elements[offset + 1], elements[offset + 2]);
  const scale = target.length();
  if (scale > 1e-12) target.multiplyScalar(1 / scale);
  else target.set(offset === 0 ? 1 : 0, offset === 4 ? 1 : 0, offset === 8 ? 1 : 0);
  return scale || 1;
};

export function serializeRobotCollisionProxies(collection) {
  const axisX = new THREE.Vector3();
  const axisY = new THREE.Vector3();
  const axisZ = new THREE.Vector3();
  const center = new THREE.Vector3();
  const records = collection?.proxies?.map((proxy) => {
    proxy.mesh.updateWorldMatrix(true, false);
    const elements = proxy.mesh.matrixWorld.elements;
    const scaleX = readWorldAxis(elements, 0, axisX);
    const scaleY = readWorldAxis(elements, 4, axisY);
    const scaleZ = readWorldAxis(elements, 8, axisZ);
    center.copy(proxy.localCenter).applyMatrix4(proxy.mesh.matrixWorld);
    const halfSize = [
      Math.max(0.0005, proxy.localHalfSize.x * scaleX),
      Math.max(0.0005, proxy.localHalfSize.y * scaleY),
      Math.max(0.0005, proxy.localHalfSize.z * scaleZ),
    ];
    const axes = [
      axisX.x, axisX.y, axisX.z,
      axisY.x, axisY.y, axisY.z,
      axisZ.x, axisZ.y, axisZ.z,
    ];
    const extentX = Math.abs(axisX.x) * halfSize[0]
      + Math.abs(axisY.x) * halfSize[1]
      + Math.abs(axisZ.x) * halfSize[2];
    const extentY = Math.abs(axisX.y) * halfSize[0]
      + Math.abs(axisY.y) * halfSize[1]
      + Math.abs(axisZ.y) * halfSize[2];
    const extentZ = Math.abs(axisX.z) * halfSize[0]
      + Math.abs(axisY.z) * halfSize[1]
      + Math.abs(axisZ.z) * halfSize[2];
    return {
      id: proxy.id,
      linkName: proxy.linkName,
      source: proxy.source,
      center: center.toArray(),
      axes,
      halfSize,
      aabbMin: [center.x - extentX, center.y - extentY, center.z - extentZ],
      aabbMax: [center.x + extentX, center.y + extentY, center.z + extentZ],
    };
  }) || [];

  const signature = records.map((record) => (
    `${record.linkName}:` + [...record.center, ...record.axes, ...record.halfSize]
      .map((value) => Number(value).toFixed(4))
      .join(',')
  )).join('|');
  return { records, signature };
}

export function selectRobotCollisionProbe(records) {
  if (!records?.length) return null;
  const candidates = records
    .filter((record) => record.center[2] > 0.25)
    .sort((left, right) => {
      const leftSpan = Math.max(...left.halfSize);
      const rightSpan = Math.max(...right.halfSize);
      return leftSpan - rightSpan;
    });
  const selected = candidates[0] || records[0];
  return {
    linkName: selected.linkName,
    center: [...selected.center],
  };
}

export function applyRobotCollisionHighlights(collection, result = {}) {
  if (!collection?.highlightEntries) return;
  const collisionLinks = new Set(result.collisionLinks || []);
  const nearLinks = new Set(result.nearLinks || []);
  collection.highlightEntries.forEach((entry) => {
    const collision = collisionLinks.has(entry.linkName);
    const near = !collision && nearLinks.has(entry.linkName);
    const nextState = collision ? 'collision' : near ? 'near' : 'safe';
    if (entry.warningState === nextState) return;
    entry.warningState = nextState;
    entry.mesh.material = nextState === 'safe'
      ? entry.originalMaterial
      : entry.warningMaterials[nextState];
    applyRobotMaterialOpacity(entry.mesh.material, collection.robot?.userData.robotDisplayOpacity ?? 1);
  });
}

export function disposeRobotCollisionProxies(collection) {
  collection?.highlightEntries?.forEach((entry) => {
    entry.mesh.material = entry.originalMaterial;
    applyRobotMaterialOpacity(entry.originalMaterial, collection.robot?.userData.robotDisplayOpacity ?? 1);
    entry.warningState = 'safe';
  });
  collection?.warningMaterials?.forEach((material) => material.dispose());
}
