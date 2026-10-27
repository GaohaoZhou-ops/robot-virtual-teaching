export const ROBOT_TWIN_MONITOR_INTERVAL = 1000;
export const ROBOT_TWIN_MONITOR_MAX_AGE = 7000;
export const ROBOT_TWIN_RESULT_LIMIT = 24;

export const TASK_PHASES = {
  idle: '空闲', preparing: '正在核对', ready: '待确认', starting: '正在下发', running: '执行中',
  awaiting_recovery: '失败待处理', recovering: '正在恢复', pausing: '正在暂停', paused: '已暂停',
  stopping: '正在停止', succeeded: '执行完成', succeeded_with_skips: '执行结束（有跳过）',
  failed: '执行失败', canceled: '已停止', expired: '确认已过期', stop_unconfirmed: '停止未确认', interrupted: '已中断',
};
export const FINISHED_TASK_PHASES = new Set(['succeeded', 'succeeded_with_skips', 'failed', 'canceled', 'expired', 'interrupted']);
export const ALGORITHM_PHASES = { processing: '算法执行中', complete: '算法完成', skipped: '未执行算法', failed: '算法异常' };
export const CAMERA_NAMES = { left: '左相机', right: '右相机', 'head-left': '头部左目', 'head-right': '头部右目',
  'chest-color': '胸前彩色', 'chest-depth': '胸前深度', 'wrist-left': '左手腕', 'wrist-right': '右手腕' };

// Only display fields cross into the browser. Storage paths, ownership tokens,
// confirmation receipts and executable task plans never leave the local server.
export function robotTwinTask(run) {
  if (!run || !/^[a-f0-9]{32}$/.test(run.id) || typeof run.phase !== 'string') throw new Error('机器人任务状态格式无效');
  const text = (value) => typeof value === 'string' ? value.slice(0, 2000) : '';
  const count = (value) => Number.isFinite(value) && value >= 0 ? value : 0;
  const tasks = Array.isArray(run.summary?.tasks) ? run.summary.tasks.slice(0, 20).map((task, index) => ({
    name: text(task.name), index: Number.isInteger(task.task_index) ? task.task_index : index,
  })) : [];
  return { id: run.id, phase: text(run.phase), kind: text(run.kind), stage: text(run.stage),
    taskName: text(run.task_name), parkingName: text(run.parking_name), pointName: text(run.point_name),
    message: text(run.message), error: text(run.task_error?.error || run.failure?.error),
    taskIndex: Number.isInteger(run.task_index) ? run.task_index : null, tasks,
    completedPoints: count(run.completed_points), skippedPoints: count(run.skipped_points),
    totalPoints: count(run.summary?.point_count), completedCaptures: count(run.completed_captures),
    elapsedMs: count(run.elapsed_ms), startedAt: count(run.started_ms),
    algorithmMode: text(run.algorithm_mode), algorithmState: text(run.algorithm_state),
    navigationWaiting: run.navigation_waiting === true || Boolean(run.parallel?.actions?.some((item) => item.navigation_waiting === true)),
  };
}
