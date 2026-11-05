import * as THREE from 'three';
import { RobotTwinPedestriansLayer } from '../src/features/robot-twin/model/robotTwinPedestriansLayer.js';

// Run in Vite/Chromium so the real asset, instancing, depth and blending are
// exercised together. A faded person must equal one blend of its opaque image.
export async function checkPedestrianFade() {
  const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
  renderer.setSize(420, 630);
  const scene = new THREE.Scene(); scene.background = new THREE.Color('#11212c');
  const key = new THREE.DirectionalLight('#ffffff', 2.65); key.position.set(4, -6, 9);
  scene.add(new THREE.HemisphereLight(0xd8f4f3, 0x172229, 2.15), key);
  const layer = new RobotTwinPedestriansLayer(scene);
  const camera = new THREE.OrthographicCamera(-.7, .7, 1.05, -1.05, .1, 30);
  camera.up.set(0, 0, 1);
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(4, 4),
    new THREE.MeshBasicMaterial({ color: '#496780', transparent: true, opacity: .75 }));
  plane.rotation.y = Math.PI / 2; plane.position.x = -1; plane.renderOrder = 2;
  const obstacle = new THREE.Mesh(new THREE.BoxGeometry(.12, .15, 1.4),
    new THREE.MeshBasicMaterial({ color: '#9f7147' }));
  obstacle.position.set(.4, .06, .7);
  const boxes = [{ center: [0, 0, .9], size: [.5, .6, 1.8], yaw: 0, score: .9 }];
  const robot = { id: 'fade', localizationFresh: true,
    motionSample: { time: 0, sourceTime: 0, id: 1 },
    pose: { position: { x: 0, y: 0, z: 0 }, rpy: { yaw: 0 } },
    pedestrians: { enabled: true, phase: 'live', generation: 1,
      frame: { id: 'fade', receivedAt: 0, sourceTime: 0, boxes } } };
  const offsets = new Map(), gl = renderer.getContext();
  const render = () => {
    renderer.render(scene, camera);
    const pixels = new Uint8Array(420 * 630 * 4);
    gl.readPixels(0, 0, 420, 630, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    return pixels;
  };
  const difference = (background, opaque, faded, opacityAtPixel = () => layer.positions[0].opacity) => {
    let wrongPixels = 0, personPixels = 0, maxError = 0;
    for (let i = 0; i < faded.length; i += 4) {
      let error = 0, contrast = 0;
      const opacity = opacityAtPixel(i / 4 % 420);
      for (let channel = 0; channel < 3; channel++) {
        const b = background[i + channel], solid = opaque[i + channel];
        const expected = solid * opacity + b * (1 - opacity);
        error = Math.max(error, Math.abs(faded[i + channel] - expected));
        contrast = Math.max(contrast, Math.abs(solid - b));
      }
      if (contrast > 5) personPixels++;
      if (error > 2) wrongPixels++;
      maxError = Math.max(maxError, error);
    }
    return { wrongPixels, personPixels, maxError };
  };
  const results = [], images = [];
  try {
    for (const [name, position] of [
      ['front', [5, 0, .9]], ['oblique', [4, -6, 1.7]],
      ['rear', [-5, 0, .9]], ['side', [0, 5, .9]], ['occlusion', [5, 0, .9]],
    ]) {
      layer.clear();
      if (name === 'occlusion') {
        scene.add(plane, obstacle);
        boxes.push({ ...boxes[0], center: [-.4, .18, .85], size: [.5, .6, 1.7] });
      }
      camera.position.fromArray(position); camera.lookAt(0, 0, .9);
      const background = render();
      layer.update([robot], true, offsets, 0); await layer.loading;
      layer.update([robot], true, offsets, 0);
      const opaque = render(), solidImage = renderer.domElement.toDataURL();
      layer.update([robot], true, offsets, 1700);
      const faded = render(), fadedImage = renderer.domElement.toDataURL();
      const actual = difference(background, opaque, faded);
      if (actual.personPixels < 5000 || actual.wrongPixels) {
        throw new Error(`${name}: whole-person fade failed: ${JSON.stringify(actual)}`);
      }
      // Demonstrate that this fixture catches the original internal-surface bleed.
      layer.heldDepthMesh.visible = false;
      const naive = difference(background, opaque, render());
      if (naive.wrongPixels < 100) throw new Error(`${name}: fixture does not expose internal surfaces`);
      results.push({ name, ...actual, originalWrongPixels: naive.wrongPixels });
      images.push({ name, solid: solidImage, faded: fadedImage });
      layer.clear();
      const cleared = render();
      if (cleared.some((value, i) => value !== background[i])) {
        throw new Error(`${name}: removed people still occlude the scene`);
      }
    }
    // Two instances can be at different points in their fade. One material's
    // opacity must not make the other person brighten or disappear with it.
    scene.remove(plane, obstacle); layer.clear();
    camera.position.set(5, 0, .9); camera.lookAt(0, 0, .9);
    boxes.splice(0, boxes.length,
      { ...boxes[0], center: [0, -.36, .9] }, { ...boxes[0], center: [0, .36, .9] });
    const background = render();
    layer.update([robot], true, offsets, 0);
    const second = { ...robot, motionSample: { time: 500, sourceTime: 500, id: 2 },
      pedestrians: { ...robot.pedestrians, frame: { id: 'second', receivedAt: 500, sourceTime: 500, boxes: [boxes[1]] } } };
    layer.update([second], true, offsets, 500);
    const opaque = render(), solidImage = renderer.domElement.toDataURL();
    layer.update([second], true, offsets, 1900);
    const faded = render(), fadedImage = renderer.domElement.toDataURL();
    const left = layer.positions.find((person) => person.y < 0), right = layer.positions.find((person) => person.y > 0);
    if (!(left.opacity < .3 && right.opacity > .8 && right.opacity < 1)) throw new Error('Independent fade fixture is not active');
    const independent = difference(background, opaque, faded, (x) => x < 210 ? left.opacity : right.opacity);
    if (independent.wrongPixels) throw new Error(`Independent fades: ${JSON.stringify(independent)}`);
    results.push({ name: 'independent', ...independent, opacities: [left.opacity, right.opacity] });
    images.push({ name: 'independent', solid: solidImage, faded: fadedImage });
    return { results, images };
  } finally {
    layer.dispose();
    for (const mesh of [plane, obstacle]) { mesh.geometry.dispose(); mesh.material.dispose(); }
    renderer.dispose(); renderer.forceContextLoss();
  }
}
