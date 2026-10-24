import { serializeMobileTeachingRobot } from './mobileTeachingKinematics.js';

export function planPolylineInWorker({ robot, geometry, path, lockedJointNames, signal, onProgress }) {
  if (signal?.aborted) return Promise.reject(new DOMException('计算已取消', 'AbortError'));
  robot.updateWorldMatrix(true, true);
  const position = geometry.getAttribute('position');
  const positions = !position.isInterleavedBufferAttribute && position.itemSize === 3
    ? new Float32Array(position.array) : Float32Array.from({ length: position.count * 3 }, (_, index) => position.getComponent(Math.floor(index / 3), index % 3));
  const indices = geometry.getIndex()?.array.slice();
  const snapshot = serializeMobileTeachingRobot(robot, { includeCollision: true, includeCollisionHulls: true });
  const worker = new Worker(new URL('../workers/polylineTeaching.worker.js', import.meta.url), { type: 'module' });
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = (error, value) => {
      if (finished) return; finished = true;
      worker.terminate(); signal?.removeEventListener('abort', cancel);
      if (error) reject(error); else resolve(value);
    };
    const cancel = () => finish(new DOMException('计算已取消', 'AbortError'));
    signal?.addEventListener('abort', cancel, { once: true });
    worker.onerror = (event) => { event.preventDefault(); finish(new Error(event.message || '路径计算进程失败')); };
    worker.onmessageerror = () => finish(new Error('路径计算结果无法读取'));
    worker.onmessage = ({ data }) => {
      if (finished) return;
      if (data.type === 'progress') onProgress?.(data.value);
      else if (data.type === 'complete') finish(null, data.value);
      else if (data.type === 'error') finish(new Error(data.message));
    };
    try { worker.postMessage({ robot: snapshot, parentMatrix: robot.parent.matrixWorld.toArray(), path, lockedJointNames,
      environment: { positions, indices, kind: indices?.length ? 'mesh' : 'points' } }, [positions.buffer, ...(indices ? [indices.buffer] : [])]);
    } catch (error) { finish(error); }
  });
}
