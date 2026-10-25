import { serializeMobileTeachingRobot } from './mobileTeachingKinematics.js';
import { readPolylineTcp } from './polylineTeaching.js';
import { polylineApproachGuides } from './polylineTeachingGuides.js';
import { createPolylineSuccessMemory, polylineMemoryContext } from './polylineTeachingMemory.js';

const successfulPlans = new WeakMap();

export function planPolylineInWorker({ robot, geometry, path, savedPaths = [], lockedJointNames, signal, onProgress }) {
  if (signal?.aborted) return Promise.reject(new DOMException('计算已取消', 'AbortError'));
  robot.updateWorldMatrix(true, true);
  const position = geometry.getAttribute('position');
  const positions = !position.isInterleavedBufferAttribute && position.itemSize === 3
    ? new Float32Array(position.array) : Float32Array.from({ length: position.count * 3 }, (_, index) => position.getComponent(Math.floor(index / 3), index % 3));
  const indices = geometry.getIndex()?.array.slice();
  const snapshot = serializeMobileTeachingRobot(robot, { includeCollision: true, includeCollisionHulls: true });
  const start = readPolylineTcp(robot, path), context = polylineMemoryContext(robot, geometry, snapshot, lockedJointNames);
  if (!successfulPlans.has(robot)) successfulPlans.set(robot, createPolylineSuccessMemory());
  const memory = successfulPlans.get(robot), successfulGuides = memory.guides(context, path, start);
  const approachGuides = polylineApproachGuides(path, savedPaths, start);
  const worker = new Worker(new URL('../workers/polylineTeaching.worker.js', import.meta.url), { type: 'module' });
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = (error, value) => {
      if (finished) return; finished = true;
      worker.terminate(); signal?.removeEventListener('abort', cancel);
      if (error) reject(error);
      else {
        // Optional hints must never prevent delivery of a checked plan.
        try { memory.remember(context, path, value); }
        catch (error) { console.warn('未能更新折线规划参考缓存', error); }
        resolve(value);
      }
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
    try { worker.postMessage({ robot: snapshot, parentMatrix: robot.parent.matrixWorld.toArray(), path, lockedJointNames, approachGuides, successfulGuides,
      environment: { positions, indices, kind: indices?.length ? 'mesh' : 'points' } }, [positions.buffer, ...(indices ? [indices.buffer] : [])]);
    } catch (error) { finish(error); }
  });
}
