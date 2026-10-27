import { CAMERA_NAMES, ROBOT_TWIN_MONITOR_INTERVAL, ROBOT_TWIN_RESULT_LIMIT, robotTwinTask } from '../lib/robotTwinMonitor.js';

const validId = (value) => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
const text = (value) => typeof value === 'string' ? value.slice(0, 2000) : '';
const count = (value) => Number.isSafeInteger(value) && value >= 0 && value < 100_000_000 ? value : 0;
const bodyCamera = (side) => Object.hasOwn(CAMERA_NAMES, side) && !['left', 'right'].includes(side);
const key = (record) => `${record.id}:${record.side}`;
const jobPath = (record) => `${bodyCamera(record.side) ? '/api/v1/execution/frame-captures/' : '/api/v1/cameras/jobs/'}${record.id}`;

// These GET patterns describe existing status/result reads, not arbitrary
// execution or camera URLs. Query values are built here from validated IDs.
export function isRobotMonitorRead(path) {
  return ['/api/v1/execution/activity', '/api/v1/execution'].includes(path)
    || /^\/api\/v1\/execution\/(captures|demo-images)\?run_id=[a-f0-9]{32}&offset=[0-9]{1,8}$/.test(path)
    || /^\/api\/v1\/(cameras\/jobs|execution\/frame-captures)\/[a-f0-9]{32}$/.test(path);
}

function result(record, job, { demo, algorithmState, skipped }) {
  const camera = job?.cameras?.[record.side];
  const inspection = skipped ? { state: 'skipped' } : demo ? {
    state: algorithmState || 'processing', image_width: record.width, image_height: record.height, boxes: record.boxes || [],
  } : camera?.inspection;
  const boxes = Array.isArray(inspection?.boxes) ? inspection.boxes : [];
  const raw = inspection ? JSON.stringify(inspection, null, 2) : '';
  return { key: key(record), sequence: count(record.sequence), camera: text(record.side),
    taskName: text(record.task_name), parkingName: text(record.parking_name), pointName: text(record.point_name),
    state: text(inspection?.state), jobState: text(job?.state), demo,
    error: text(inspection?.error || camera?.error || job?.error),
    detectionCount: boxes.length, labels: boxes.slice(0, 100).map((box) => text(box?.label) || '未标注类型'),
    output: raw.slice(0, 32768), outputTruncated: raw.length > 32768,
  };
}

export function createRobotTaskMonitor(read) {
  let pending, cached, runId, jobs = new Map(), total = 0;
  async function sample() {
    const activity = await read('/api/v1/execution/activity');
    if (activity?.ok !== true || typeof activity.task_phase !== 'string') throw new Error('机器人作业状态格式无效');
    // Idle observation does not start the ABX execution worker or access storage.
    const execution = activity.task_phase === 'idle' ? { ok: true, run: null } : await read('/api/v1/execution');
    if (execution?.ok !== true || !Object.hasOwn(execution, 'run')) throw new Error('机器人任务状态格式无效');
    const task = execution.run ? robotTwinTask(execution.run) : null;
    const taskSampledAt = Date.now();
    if (runId !== task?.id) { runId = task?.id; jobs = new Map(); total = 0; cached = null; }
    const base = { task, navigationPhase: text(activity.navigation_phase), taskSampledAt,
      results: [], resultTotal: 0, resultLimit: ROBOT_TWIN_RESULT_LIMIT, resultsError: '', resultsFresh: true };
    if (!task || task.kind === 'base-navigation') return base;
    const demo = task.algorithmMode === 'demo', skipped = task.algorithmMode === 'skip';
    const hint = count(demo ? execution.run.demo_image_count : execution.run.completed_captures);
    const pageSize = demo ? 8 : ROBOT_TWIN_RESULT_LIMIT;
    base.resultLimit = pageSize;
    const offset = Math.max(0, Math.max(hint, total) - pageSize);
    try {
      const page = await read(`/api/v1/execution/${demo ? 'demo-images' : 'captures'}?run_id=${task.id}&offset=${offset}`);
      const records = demo ? page?.images : page?.captures;
      if (page?.ok !== true || !Array.isArray(records) || (!demo && page.run_id !== task.id)
        || !Number.isSafeInteger(page.total) || page.total < 0
        || !records.every((item) => validId(item.id) && Object.hasOwn(CAMERA_NAMES, item.side))) throw new Error('机器人算法结果索引格式无效');
      total = count(page.total);
      const selected = records.slice(-ROBOT_TWIN_RESULT_LIMIT).reverse();
      const wanted = new Set(selected.map(jobPath));
      for (const path of jobs.keys()) if (!wanted.has(path)) jobs.delete(path);
      if (!demo && !skipped) {
        // Read at most two jobs per cycle; reuse paired-camera jobs and finished
        // results. Rotate pending jobs so a slow algorithm cannot starve others.
        const due = [...wanted].filter((path) => !jobs.get(path)?.done)
          .sort((a, b) => (jobs.get(a)?.checkedAt || 0) - (jobs.get(b)?.checkedAt || 0)).slice(0, 2);
        await Promise.all(due.map(async (path) => {
          const previous = jobs.get(path);
          try {
            const payload = await read(path);
            const job = payload?.job;
            if (!job || typeof job.state !== 'string' || !job.cameras || typeof job.cameras !== 'object') throw new Error('机器人采集结果格式无效');
            const sides = selected.filter((item) => jobPath(item) === path).map((item) => item.side);
            const done = ['complete', 'failed', 'cancelled'].includes(job.state)
              && sides.every((side) => job.cameras[side]?.inspection?.state !== 'processing');
            jobs.set(path, { job, done, checkedAt: Date.now(), error: '' });
          } catch (error) {
            jobs.set(path, { ...previous, done: false, checkedAt: Date.now(), error: error.message });
          }
        }));
      }
      const results = selected.map((record) => {
        const entry = jobs.get(jobPath(record));
        return { ...result(record, entry?.job, { demo, skipped, algorithmState: page.algorithm_state || task.algorithmState }),
          readError: entry?.error || '', received: demo || skipped || Boolean(entry?.job) };
      });
      return { ...base, results, resultTotal: total, resultsFresh: results.every((item) => !item.readError) };
    } catch (error) {
      // A failed results read must not erase a valid task status or label old
      // results as current. A new run has already discarded the old run's cache.
      return { ...base, results: cached?.results || [], resultTotal: total,
        resultsFresh: false, resultsError: error.message };
    }
  }
  return async () => {
    if (pending) return pending;
    if (cached && Date.now() - cached.sampledAt < ROBOT_TWIN_MONITOR_INTERVAL) return cached;
    pending = sample().then((value) => { cached = { ...value, sampledAt: Date.now() }; return cached; });
    try { return await pending; } finally { pending = null; }
  };
}
