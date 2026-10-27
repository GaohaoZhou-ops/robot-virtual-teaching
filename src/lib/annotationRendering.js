import * as THREE from 'three';

export function setAnnotationDepth(group, onTop) {
  group.traverse((object) => {
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      if (!material || material.colorWrite === false) continue;
      // Draw after the map's transparent points, without letting annotations
      // write depth over the robot, other labels or manipulation handles.
      material.transparent = true;
      material.depthTest = !onTop;
      material.depthWrite = false;
    }
    if (object.material && !object.renderOrder) object.renderOrder = 8;
  });
}

// Use the existing DOM label's typography and colors, but let the GPU clip
// individual pixels against both model surfaces and point-cloud depth.
export function createDepthLabel(element, pose, { offset, above }) {
  const style = getComputedStyle(element);
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  const font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  const border = parseFloat(style.borderTopWidth) || 0;
  context.font = font;
  // A restored workspace can start with the 3D pane collapsed.
  const width = element.offsetWidth || Math.ceil(context.measureText(element.textContent).width
    + parseFloat(style.paddingLeft) + parseFloat(style.paddingRight) + border * 2);
  const height = element.offsetHeight || Math.ceil(parseFloat(style.lineHeight)
    + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) + border * 2);
  canvas.width = Math.ceil(width * pixelRatio);
  canvas.height = Math.ceil(height * pixelRatio);
  context.scale(canvas.width / width, canvas.height / height);
  context.beginPath();
  context.roundRect(border / 2, border / 2, width - border, height - border,
    parseFloat(style.borderTopLeftRadius) || 0);
  context.fillStyle = style.backgroundColor;
  context.fill();
  if (border) {
    context.lineWidth = border;
    context.strokeStyle = style.borderTopColor;
    context.stroke();
  }
  context.font = font;
  context.fillStyle = style.color;
  context.textBaseline = 'middle';
  context.fillText(element.textContent, border + parseFloat(style.paddingLeft), height / 2);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: texture, depthTest: true, depthWrite: false, toneMapped: false, fog: false,
  }));
  sprite.name = `annotation-label:${element.textContent}`;
  sprite.center.set(0.5, above ? 0 : 1);
  sprite.renderOrder = 11;
  sprite.frustumCulled = false;
  sprite.userData = { anchor: new THREE.Vector3(pose.x, pose.y, pose.z), width, height, offset };
  // Labels, like the HTML overlay, must never intercept scene picking.
  sprite.raycast = () => {};
  return sprite;
}

const cameraPosition = new THREE.Vector3();
const projected = new THREE.Vector3();
const cameraUp = new THREE.Vector3();

export function updateDepthLabels(group, camera, viewportHeight) {
  if (!group) return;
  const focalPixels = Math.max(viewportHeight, 1) / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
  cameraUp.setFromMatrixColumn(camera.matrixWorld, 1);
  for (const sprite of group.children) {
    const { anchor, width, height, offset } = sprite.userData;
    cameraPosition.copy(anchor).applyMatrix4(camera.matrixWorldInverse);
    projected.copy(anchor).project(camera);
    sprite.visible = cameraPosition.z < 0 && Math.abs(projected.x) <= 1
      && Math.abs(projected.y) <= 1 && Math.abs(projected.z) <= 1;
    if (!sprite.visible) continue;
    const metersPerPixel = -cameraPosition.z / (camera.zoom * focalPixels);
    sprite.position.copy(anchor).addScaledVector(cameraUp, offset * metersPerPixel);
    sprite.scale.set(width * metersPerPixel, height * metersPerPixel, 1);
  }
}

export function disposeDepthLabels(group) {
  group.removeFromParent();
  for (const sprite of group.children) {
    sprite.material.map.dispose();
    sprite.material.dispose();
  }
  // Sprite geometry is shared by Three.js; only our textures/materials are owned.
  group.clear();
}
