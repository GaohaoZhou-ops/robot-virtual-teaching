export const createIdleTeachingPlayback = () => ({
  status: 'idle',
  taskId: '',
  taskName: '',
  phase: '',
  segmentIndex: 0,
  segmentCount: 0,
  parkingPointName: '',
  poseName: '',
  poseOrdinal: 0,
  poseCount: 0,
  reachedPoseIds: [],
  reachedPoseCount: 0,
  elapsedDurationMs: 0,
  totalDurationMs: 0,
  overallProgress: 0,
  segmentProgress: 0,
  speed: 1,
  cycle: 0,
  followRobot: false,
});

export const teachingPlaybackStateFromRuntime = (runtime, status = runtime?.status || 'idle') => {
  const segment = runtime?.plan?.segments?.[runtime.segmentIndex] || null;
  if (!runtime || !segment) return createIdleTeachingPlayback();
  const reachedPoseIds = runtime.reachedPoseIds instanceof Set
    ? [...runtime.reachedPoseIds]
    : [];
  const segmentProgress = segment.durationMs > 0
    ? Math.max(0, Math.min(1, runtime.segmentElapsedMs / segment.durationMs))
    : 1;
  const elapsedDurationMs = Math.min(
    runtime.plan.totalDurationMs,
    segment.startOffsetMs + runtime.segmentElapsedMs,
  );
  return {
    status,
    taskId: runtime.plan.taskId,
    taskName: runtime.plan.taskName,
    phase: segment.phase,
    segmentIndex: runtime.segmentIndex,
    segmentCount: runtime.plan.segments.length,
    parkingPointId: segment.target?.parkingPointId || '',
    parkingPointName: segment.target?.parkingPointName || '',
    poseId: segment.target?.poseId || '',
    poseName: segment.target?.poseName || '',
    poseOrdinal: segment.target?.poseOrdinal || 0,
    poseCount: runtime.plan.poseCount,
    reachedPoseIds,
    reachedPoseCount: reachedPoseIds.length,
    elapsedDurationMs,
    totalDurationMs: runtime.plan.totalDurationMs,
    overallProgress: runtime.plan.totalDurationMs > 0
      ? elapsedDurationMs / runtime.plan.totalDurationMs
      : 1,
    segmentProgress,
    speed: runtime.speed,
    cycle: runtime.cycle,
    followRobot: Boolean(runtime.followRobot),
  };
};

export const markTeachingPlaybackPoseReached = (runtime, segment) => {
  const poseId = segment?.phase === 'hold' ? segment.target?.poseId : '';
  if (!poseId || !(runtime?.reachedPoseIds instanceof Set)) return false;
  const previousSize = runtime.reachedPoseIds.size;
  runtime.reachedPoseIds.add(poseId);
  return runtime.reachedPoseIds.size !== previousSize;
};
