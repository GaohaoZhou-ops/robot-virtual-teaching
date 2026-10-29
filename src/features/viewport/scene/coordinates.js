import * as THREE from 'three';

export const createRosAxisLabel = (text, color, worldHeight) => {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const context = canvas.getContext('2d');
  context.fillStyle = color;
  context.font = '700 36px "SFMono-Regular", Menlo, monospace';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.shadowColor = 'rgba(0, 0, 0, 0.92)';
  context.shadowBlur = 5;
  context.fillText(text, canvas.width / 2, canvas.height / 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    fog: false,
  });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(worldHeight, worldHeight, 1);
  sprite.renderOrder = 20;
  return sprite;
};

export const createRosAxisArrow = (direction, color, length, shaftRadius) => {
  const group = new THREE.Group();
  const shaftLength = length * 0.76;
  const headLength = length - shaftLength;
  const material = new THREE.MeshBasicMaterial({
    color,
    depthTest: false,
    depthWrite: false,
    fog: false,
    toneMapped: false,
  });
  const shaft = new THREE.Mesh(
    new THREE.CylinderGeometry(shaftRadius, shaftRadius, shaftLength, 12),
    material,
  );
  shaft.position.y = shaftLength / 2;
  shaft.renderOrder = 18;

  const head = new THREE.Mesh(
    new THREE.CylinderGeometry(0, shaftRadius * 3.15, headLength, 16),
    material.clone(),
  );
  head.position.y = shaftLength + headLength / 2;
  head.renderOrder = 18;
  group.add(shaft, head);
  group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
  return group;
};

export const createCoordinateOrigin = (axisLength) => {
  const group = new THREE.Group();
  group.userData.baseAxisLength = axisLength;
  const shaftRadius = axisLength * 0.025;
  [
    { name: 'X', direction: new THREE.Vector3(1, 0, 0), color: '#f0443e' },
    { name: 'Y', direction: new THREE.Vector3(0, 1, 0), color: '#38c75a' },
    { name: 'Z', direction: new THREE.Vector3(0, 0, 1), color: '#3c82f6' },
  ].forEach(({ name, direction, color }) => {
    const arrow = createRosAxisArrow(direction, color, axisLength, shaftRadius);
    const label = createRosAxisLabel(name, color, axisLength * 0.16);
    label.position.copy(direction).multiplyScalar(axisLength * 1.09);
    group.add(arrow, label);
  });
  const joint = new THREE.Mesh(
    new THREE.SphereGeometry(shaftRadius * 1.55, 14, 10),
    new THREE.MeshBasicMaterial({ color: 0xe9edf0, depthTest: false, depthWrite: false, fog: false }),
  );
  joint.renderOrder = 19;
  joint.name = 'coordinate-origin-center';
  group.add(joint);
  return group;
};

export const createChassisControlGuide = () => {
  const group = new THREE.Group();
  group.name = 'robot-chassis-keyboard-control-guide';
  group.visible = false;
  const heightMaterials = [];
  [
    { name: 'X', direction: new THREE.Vector3(1, 0, 0), color: '#f36b68' },
    { name: 'Y', direction: new THREE.Vector3(0, 1, 0), color: '#5ee59a' },
    { name: 'Z', direction: new THREE.Vector3(0, 0, 1), color: '#79a8ff' },
  ].forEach(({ name, direction, color }) => {
    const arrow = createRosAxisArrow(direction, color, 1, 0.012);
    const label = createRosAxisLabel(name, color, 0.28);
    label.position.copy(direction).multiplyScalar(1.15);
    group.add(arrow, label);
    if (name === 'Z') {
      arrow.traverse((object) => {
        if (object.material) heightMaterials.push(object.material);
      });
      heightMaterials.push(label.material);
    } else {
      const reverse = createRosAxisArrow(direction.clone().negate(), color, 0.68, 0.009);
      reverse.traverse((object) => {
        if (!object.material) return;
        object.material.transparent = true;
        object.material.opacity = 0.48;
      });
      group.add(reverse);
    }
  });
  const ringMaterial = new THREE.MeshBasicMaterial({
    color: 0xf4c95d,
    transparent: true,
    opacity: 0.82,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.78, 0.009, 8, 72), ringMaterial);
  group.add(ring);
  [-1, 1].forEach((sign) => {
    const head = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.14, 12), ringMaterial);
    head.position.set(0, sign * 0.78, 0);
    head.rotation.z = -Math.PI / 2;
    group.add(head);
  });
  group.traverse((object) => { object.renderOrder = 36; });
  return { group, heightMaterials, heightLocked: null };
};
