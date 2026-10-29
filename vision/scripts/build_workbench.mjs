import { build } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyFile } from 'node:fs/promises';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// The native target alone installs this adapter. Desktop/iPad entry points and
// the shared document engine remain byte-for-byte unchanged.
let installed = false, documentPort = false;
await build({ root, configFile: false, publicDir: false, plugins: [{
  name: 'vision-hand-teaching-entry', enforce: 'pre',
  resolveId(source, importer) {
    if (importer === path.join(root, 'src/app/App.jsx') && source.endsWith('/VisionWorkbenchBridge.jsx')) {
      installed = true;
      return path.join(root, 'vision/web/VisionTeachingBridge.jsx');
    }
  },
  transform(code, id) {
    if (id !== path.join(root, 'src/app/App.jsx')) return null;
    // An explicit, guarded port in this target's build avoids re-importing a
    // ZIP (and rebuilding hundreds of MB of robot resources) for every pose.
    // Only the existing document state setters are exposed, never robot I/O.
    const entry = '<VisionWorkbenchBridge ready=';
    if (code.split(entry).length !== 2) this.error('Vision document port moved; update vision/scripts/build_workbench.mjs.');
    documentPort = true;
    return { code: code.replace(entry, `<VisionWorkbenchBridge commitHandTeaching={patch => {
      setTeachingTasks(patch.tasks);
      setRobotJointValues(patch.joints);
      setRobotPose(patch.basePose);
      setActiveTeachingTaskId(patch.taskId);
      setActiveTeachingParkingPointId(patch.parkingId);
    }} ready=`), map: null };
  },
  buildEnd(error) {
    if (!error && (!installed || !documentPort)) this.error('Vision workbench bridge entry moved; update the Vision-only adapter.');
  },
}, react()], build: {
  outDir: path.join(root, 'vision/AtlasVisionTeaching/WebWorkbench'), emptyOutDir: true,
} });
await copyFile(path.join(root, 'maps/xian_map.ply'), path.join(root, 'vision/AtlasVisionTeaching/WebWorkbench/xian_map.ply'));
