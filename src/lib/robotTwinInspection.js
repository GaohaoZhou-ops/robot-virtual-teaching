// Match ABX's persisted per-box threshold. Legacy/manual detections without a
// normalized confidence remain confirmed; an absent/invalid threshold is 70%.
export const robotDetectionConfidence = (box) => Number.isFinite(box?.confidence)
  && box.confidence >= 0 && box.confidence <= 1 ? box.confidence : null;
export const robotDetectionThreshold = (box) => Number.isFinite(box?.confidence_threshold)
  && box.confidence_threshold > 0 && box.confidence_threshold <= 1 ? box.confidence_threshold : 0.70;
export const isSuspectedRobotDetection = (box) => robotDetectionConfidence(box) !== null
  && robotDetectionConfidence(box) < robotDetectionThreshold(box);

export function summarizeRobotDetections(boxes) {
  const detectionCount = boxes.length, suspectedCount = boxes.filter(isSuspectedRobotDetection).length;
  const confirmedCount = detectionCount - suspectedCount;
  return { detectionCount, suspectedCount, confirmedCount,
    severity: !detectionCount ? 'clear' : confirmedCount ? 'defect' : 'suspected' };
}

export function formatRobotDetectionConfidence(box) {
  const score = robotDetectionConfidence(box);
  if (score === null) return '';
  const percentage = Math.floor(score * 1000 + 1e-9) / 10;
  // Never round a suspected score up to the threshold shown to the user.
  return `${isSuspectedRobotDetection(box)
    ? Math.min((Math.ceil(robotDetectionThreshold(box) * 1000) - 1) / 10, percentage) : percentage}%`;
}
