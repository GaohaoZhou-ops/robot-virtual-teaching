import { serializeMobileTeachingRobot } from './mobileTeachingKinematics.js';

export function solveMobileTeachingInWorker({ robot, task, mapPose, environment, options, lockedJointNames,
  signal, onProgress, onSample, onControl, onStatus }) {
  if (!robot) throw new Error('请先加载机器人模型');
  if (signal?.aborted) return Promise.reject(new DOMException('计算已取消', 'AbortError'));
  const worker = new Worker(new URL('../workers/mobileTeachingSolver.worker.js', import.meta.url), { type: 'module' });
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = (error, value) => {
      if (finished) return;
      finished = true;
      signal?.removeEventListener('abort', cancel);
      worker.terminate();
      if (error) reject(error); else resolve(value);
    };
    const cancel = () => finish(new DOMException('计算已取消', 'AbortError'));
    signal?.addEventListener('abort', cancel, { once: true });
    worker.onerror = (event) => { event.preventDefault(); finish(new Error(event.message || '后台计算进程启动失败')); };
    worker.onmessageerror = () => finish(new Error('后台计算结果无法读取'));
    worker.onmessage = ({ data }) => {
      if (finished) return;
      try {
        if (data.type === 'progress') onProgress?.(data.value);
        else if (data.type === 'sample') onSample?.(data.value);
        else if (data.type === 'status') onStatus?.(data.value);
        else if (data.type === 'complete') finish(null, data.value);
        else if (data.type === 'error') finish(new Error(data.message));
      } catch (error) { finish(error); }
    };
    try {
      onControl?.({
        pause: () => { if (!finished) worker.postMessage({ type: 'pause' }); },
        resume: () => { if (!finished) worker.postMessage({ type: 'resume' }); },
      });
      worker.postMessage({ type: 'solve', request: {
        robot: serializeMobileTeachingRobot(robot, { includeCollision: options?.checkCollisions !== false }), mapPose, environment, options, lockedJointNames,
        task: { id: task.id, coordinateFrame: task.coordinateFrame, mobileTransform: task.mobileTransform,
          mobileCapture: { id: task.mobileCapture.id, samples: task.mobileCapture.samples.map((sample) => ({
            id: sample.id, name: sample.name, kind: sample.kind, capturedAt: sample.capturedAt, cameraPose: sample.cameraPose,
          })) } },
      } }, [environment?.positions?.buffer, environment?.indices?.buffer].filter(Boolean));
    } catch (error) { finish(error); }
  });
}
