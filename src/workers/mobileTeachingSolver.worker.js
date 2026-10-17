import { solveMobileTeaching } from '../lib/mobileTeachingSolver.js';
import { createMobileTeachingPauseGate, restoreMobileTeachingRobot } from '../lib/mobileTeachingKinematics.js';

const gate = createMobileTeachingPauseGate();
let started = false;
self.onmessage = async ({ data }) => {
  if (data.type === 'pause') {
    gate.pause(); self.postMessage({ type: 'status', value: 'paused' }); return;
  }
  if (data.type === 'resume') {
    gate.resume(); self.postMessage({ type: 'status', value: 'running' }); return;
  }
  if (data.type !== 'solve' || started) return;
  started = true;
  try {
    const { robot, ...request } = data.request;
    const report = await solveMobileTeaching({ ...request, robot: restoreMobileTeachingRobot(robot),
      waitIfPaused: gate.waitIfPaused,
      onProgress: (value) => self.postMessage({ type: 'progress', value }),
      onSample: (value) => self.postMessage({ type: 'sample', value }),
    });
    self.postMessage({ type: 'complete', value: report });
  } catch (error) {
    self.postMessage({ type: 'error', message: error.message || '计算失败' });
  }
};
