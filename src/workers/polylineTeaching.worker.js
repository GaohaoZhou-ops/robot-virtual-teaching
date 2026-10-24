import { restoreMobileTeachingRobot } from '../lib/mobileTeachingKinematics.js';
import { planPolyline } from '../lib/polylineTeachingSolver.js';

self.onmessage = async ({ data }) => {
  try {
    const plan = await planPolyline({ ...data, robot: restoreMobileTeachingRobot(data.robot),
      onProgress: (value) => self.postMessage({ type: 'progress', value }) });
    self.postMessage({ type: 'complete', value: plan });
  } catch (error) { self.postMessage({ type: 'error', message: error.message || '路径检查失败' }); }
};
