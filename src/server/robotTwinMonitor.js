import { CAMERA_NAMES, ROBOT_TWIN_MONITOR_INTERVAL, ROBOT_TWIN_RESULT_LIMIT, robotTwinTask } from '../lib/robotTwinMonitor.js';
import { robotDetectionConfidence, robotDetectionThreshold, summarizeRobotDetections } from '../lib/robotTwinInspection.js';

const validId = (value) => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
const text = (value) => typeof value === 'string' ? value.slice(0, 2000) : '';
const count = (value) => Number.isSafeInteger(value) && value >= 0 && value < 100_000_000 ? value : 0;
const bodyCamera = (side) => Object.hasOwn(CAMERA_NAMES, side) && !['left', 'right'].includes(side);
const key = (record) => `${record.id}:${record.side}`;
const jobPath = (record) => `${bodyCamera(record.side) ? '/api/v1/execution/frame-captures/' : '/api/v1/cameras/jobs/'}${record.id}`;
const detection = (box) => ({ label: text(box?.label) || '未标注类型', confidence: robotDetectionConfidence(box),
  confidence_threshold: robotDetectionThreshold(box) });

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
  const detections = boxes.slice(0, 100).map(detection);
  return { key: key(record), captureId: record.id, sequence: count(record.sequence), camera: text(record.side),
    taskName: text(record.task_name), parkingName: text(record.parking_name), pointName: text(record.point_name),
    state: text(inspection?.state), jobState: text(job?.state), demo,
    error: text(inspection?.error || camera?.error || job?.error),
    ...summarizeRobotDetections(boxes), labels: detections.map((item) => item.label), detections,
  };
}

function captureDetails(record, jobs) {
  const entry = jobs.get(jobPath(record)), job = entry?.job;
  return { id: record.id, createdAt: text(job?.created_utc), taskName: text(record.task_name),
    parkingName: text(record.parking_name), pointName: text(record.point_name), error: entry?.error || '',
    sides: Object.fromEntries(['left', 'right'].map((side) => {
      const camera = job?.cameras?.[side], inspection = camera?.inspection, mapping = camera?.pixel_mapping;
      // Only advertise files belonging to this exact capture and side. Never
      // follow a URL supplied by a robot response or borrow an older side.
      const has = (kind) => Array.isArray(camera?.files) && camera.files.some((file) => file?.kind === kind
        && file.url === `/api/v1/cameras/jobs/${record.id}/${side}/${kind}`) || false;
      const width = inspection?.image_width, height = inspection?.image_height;
      const boxes = inspection?.state === 'complete' && Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0
        ? (Array.isArray(inspection.boxes) ? inspection.boxes : []).filter((box) => box && [box.x, box.y, box.width, box.height].every(Number.isFinite)
          && box.x >= 0 && box.y >= 0 && box.width > 0 && box.height > 0 && box.x + box.width <= width && box.y + box.height <= height)
          .slice(0, 100).map((box) => ({ x: box.x, y: box.y, width: box.width, height: box.height, ...detection(box) })) : [];
      return [side, { image: has('png'), cloud: has('xyzbin'), state: text(inspection?.state),
        pixelMapping: { available: mapping?.available === true, kind: text(mapping?.kind), reason: text(mapping?.reason),
          ...Object.fromEntries(['image_width', 'image_height', 'cloud_width', 'cloud_height', 'step_x', 'step_y', 'offset_x', 'offset_y']
            .map((field) => [field, Number.isSafeInteger(mapping?.[field]) ? mapping[field] : null])) },
        pending: !job || !['complete', 'failed', 'cancelled'].includes(job.state),
        imageWidth: width || 0, imageHeight: height || 0, boxes, error: text(camera?.error),
        ...summarizeRobotDetections(Array.isArray(inspection?.boxes) ? inspection.boxes : []),
        abnormal: inspection?.state === 'complete' && Array.isArray(inspection.boxes) && inspection.boxes.length > 0 }];
    })) };
}

export function createRobotTaskMonitor(read) {
  let pending, cached, runId, jobs = new Map(), total = 0, lastCapture = null;
  async function sample() {
    const activity = await read('/api/v1/execution/activity');
    if (activity?.ok !== true || typeof activity.task_phase !== 'string') throw new Error('机器人作业状态格式无效');
    // Idle observation does not start the ABX execution worker or access storage.
    const execution = activity.task_phase === 'idle' ? { ok: true, run: null } : await read('/api/v1/execution');
    if (execution?.ok !== true || !Object.hasOwn(execution, 'run')) throw new Error('机器人任务状态格式无效');
    const task = execution.run ? robotTwinTask(execution.run) : null;
    const taskSampledAt = Date.now();
    if (runId !== task?.id) { if (task) lastCapture = null; runId = task?.id; jobs = new Map(); total = 0; cached = null; }
    const base = { task, navigationPhase: text(activity.navigation_phase), taskSampledAt,
      results: [], captures: [], resultTotal: 0, resultLimit: ROBOT_TWIN_RESULT_LIMIT, resultsError: '', resultsFresh: true, latestCapture: lastCapture };
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
      if (!demo) {
        // Read at most two jobs per cycle; reuse paired-camera jobs and finished
        // results. Rotate pending jobs so a slow algorithm cannot starve others.
        const latestZivid = selected.find((item) => ['left', 'right'].includes(item.side));
        const due = [...wanted].filter((path) => !jobs.get(path)?.done)
          .sort((a, b) => Number(b === (latestZivid && jobPath(latestZivid))) - Number(a === (latestZivid && jobPath(latestZivid)))
            || (jobs.get(a)?.checkedAt || 0) - (jobs.get(b)?.checkedAt || 0)).slice(0, 2);
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
            if (error.code === 'ROBOT_AUTH_FAILED') throw error;
            jobs.set(path, { ...previous, done: false, checkedAt: Date.now(), error: error.message });
          }
        }));
      }
      const results = selected.map((record) => {
        const entry = jobs.get(jobPath(record));
        return { ...result(record, entry?.job, { demo, skipped, algorithmState: page.algorithm_state || task.algorithmState }),
          readError: entry?.error || '', received: demo || skipped || Boolean(entry?.job) };
      });
      const captureIds = new Set();
      const captures = demo ? [] : selected.filter((record) => {
        if (!['left', 'right'].includes(record.side) || captureIds.has(record.id)) return false;
        captureIds.add(record.id); return true;
      }).map((record) => ({ ...captureDetails(record, jobs), runId: task.id }));
      if (!demo) lastCapture = captures[0] || lastCapture;
      return { ...base, results, captures, resultTotal: total, resultsFresh: results.every((item) => !item.readError), latestCapture: lastCapture };
    } catch (error) {
      if (error.code === 'ROBOT_AUTH_FAILED') throw error;
      // A failed results read must not erase a valid task status or label old
      // results as current. A new run has already discarded the old run's cache.
      return { ...base, results: cached?.results || [], captures: cached?.captures || [], resultTotal: total, latestCapture: cached?.latestCapture || null,
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

// The connection's background photo cache pages through the complete index.
// Keep ordinary task polling small; this endpoint fetches metadata only.
export function createRobotCaptureHistory(read) {
  let currentRun, jobs = new Map();
  return async (runId, offset, signal) => {
    signal?.throwIfAborted();
    if (currentRun !== runId) { currentRun = runId; jobs = new Map(); }
    const cache = jobs;
    const page = await read(`/api/v1/execution/captures?run_id=${runId}&offset=${offset}`, signal);
    if (page?.ok !== true || page.run_id !== runId || !Array.isArray(page.captures)
      || !Number.isSafeInteger(page.total) || page.total < offset || page.total >= 100_000_000
      || page.next_offset !== offset + page.captures.length || page.next_offset > page.total
      || (offset < page.total && page.captures.length === 0)
      || !page.captures.every((item) => validId(item?.id) && Object.hasOwn(CAMERA_NAMES, item.side))) {
      throw new Error('机器人算法结果索引格式无效');
    }
    // Offset is an index into camera-side records, including body cameras. A
    // small batch bounds metadata work even when the native index is large.
    const records = page.captures.slice(0, 8);
    const zivid = records.filter((item) => ['left', 'right'].includes(item.side));
    const due = [...new Set(zivid.map(jobPath))].filter((path) => !cache.get(path)?.done);
    for (let start = 0; start < due.length; start += 2) {
      signal?.throwIfAborted();
      await Promise.all(due.slice(start, start + 2).map(async (path) => {
        try {
          const payload = await read(path, signal), job = payload?.job;
          if (!job || typeof job.state !== 'string' || !job.cameras || typeof job.cameras !== 'object') throw new Error('机器人采集结果格式无效');
          const done = ['complete', 'failed', 'cancelled'].includes(job.state)
            && ['left', 'right'].every((side) => job.cameras[side]?.inspection?.state !== 'processing');
          cache.set(path, { job, done, error: '' });
        } catch (error) {
          signal?.throwIfAborted();
          if (error.code === 'ROBOT_AUTH_FAILED') throw error;
          cache.set(path, { ...cache.get(path), done: false, error: error.message });
        }
      }));
    }
    signal?.throwIfAborted();
    const results = zivid.map((record) => {
      const entry = cache.get(jobPath(record));
      return { ...result(record, entry?.job, { demo: false }), readError: entry?.error || '', received: Boolean(entry?.job) };
    });
    const unique = [...new Map(zivid.map((record) => [record.id, record])).values()];
    return { runId, nextOffset: offset + records.length, total: page.total, results,
      captures: unique.map((record) => ({ ...captureDetails(record, cache), runId })),
      pending: zivid.some((record) => !cache.get(jobPath(record))?.done),
      error: results.find((item) => item.readError)?.readError || '' };
  };
}
