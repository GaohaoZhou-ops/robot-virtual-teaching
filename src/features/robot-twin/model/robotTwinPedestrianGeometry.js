import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';

export const ROBOT_PEDESTRIAN_MODEL_URL = new URL('../assets/pedestrian/standing-person.ply', import.meta.url);
let cachedGeometry;

// Keep one CPU-side template; each scene owns and disposes its own GPU geometry.
// Fetch only the bundled asset, on first use. No external model service is needed.
export function loadRobotPedestrianGeometry() {
  cachedGeometry ||= new PLYLoader().loadAsync(ROBOT_PEDESTRIAN_MODEL_URL.href).then((geometry) => {
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return geometry;
  }).catch((error) => { cachedGeometry = null; throw error; });
  return cachedGeometry.then((geometry) => geometry.clone());
}
