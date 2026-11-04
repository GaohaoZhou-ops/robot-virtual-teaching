import { RobotTwinProjectionCoverage } from '../model/robotTwinProjection.js';

let coverage;
self.onmessage = ({ data }) => {
  try {
    if (data.type === 'init') {
      coverage = new RobotTwinProjectionCoverage(data.positions, data.indices); return;
    }
    const result = coverage.sync(data.records);
    self.postMessage({ revision: data.revision, ...result }, [result.mask.buffer]);
  } catch (error) { self.postMessage({ revision: data.revision, error: error.message }); }
};
