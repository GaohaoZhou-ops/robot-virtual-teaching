// Link recorded targets to editable robot poses without modifying the capture.
// A task can have several saved computations; prefer the current report's output.
export function mobileRobotPoseLinks(source, tasks) {
  const candidates = tasks.filter((task) => !task.mobileCapture
    && task.mobileSolveSource?.taskId === source.id
    && task.mobileSolveSource.captureId === source.mobileCapture?.id
    && task.coordinateFrame === source.coordinateFrame);
  candidates.sort((a, b) => Number(b.id === source.mobileSolve?.savedTaskId)
    - Number(a.id === source.mobileSolve?.savedTaskId)
    || String(b.createdAt).localeCompare(String(a.createdAt)));
  const links = new Map();
  for (const task of candidates) {
    for (const parkingPoint of task.parkingPoints || []) {
      for (const pose of parkingPoint.poses || []) {
        for (const sampleId of pose.mobileSampleIds || [pose.mobileSampleId]) {
          if (sampleId && !links.has(sampleId)) links.set(sampleId, { task, parkingPoint, pose });
        }
      }
    }
  }
  return links;
}

export function mobileSampleStatus(row, link) {
  if (link) return '已保存 · 可精修';
  if (!row) return '待计算';
  return row.feasible ? '可达 · 待保存' : '未通过';
}
