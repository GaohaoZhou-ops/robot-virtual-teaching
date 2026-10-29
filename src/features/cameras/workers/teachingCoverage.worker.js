import { prepareTeachingVisionCoverageFrames } from "../model/visionCoverage.js";
import { measureTeachingCoverage, prepareTeachingCoverageSamples } from "../../teaching/model/teachingCoverageMeasurement.js";

let samples;
let generation = 0;
let preparationError;

self.onmessage = async ({ data }) => {
  const current = ++generation;
  if (data.type === 'initialize') {
    try {
      samples = prepareTeachingCoverageSamples(data.position, data.index);
      preparationError = null;
    } catch (error) {
      samples = null;
      preparationError = error;
    }
    return;
  }
  if (data.type !== 'measure') return;
  try {
    if (preparationError) throw preparationError;
    if (!samples) throw new Error('模型尚未准备好');
    const frames = prepareTeachingVisionCoverageFrames(data.records);
    const result = await measureTeachingCoverage(samples, frames, {
      isCancelled: () => current !== generation,
    });
    if (result && current === generation) {
      self.postMessage({ type: 'complete', requestId: data.requestId, result });
    }
  } catch (error) {
    if (current === generation) {
      self.postMessage({ type: 'error', requestId: data.requestId, message: error.message });
    }
  }
};
