import { parseRobotTwinPointCloud } from '../lib/robotTwinPointCloud.js';

self.onmessage = ({ data }) => {
  try {
    const result = parseRobotTwinPointCloud(data);
    self.postMessage(result, [result.positions.buffer, result.pixels.buffer, result.colors.buffer]);
  } catch (error) { self.postMessage({ error: error.message }); }
};
