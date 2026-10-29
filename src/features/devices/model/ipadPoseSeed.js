import { Matrix4, Quaternion, Vector3 } from 'three';
import { MAX_SAMPLES, validateIPadPoseSeed, ipadPoseArm } from "../../../shared/protocols/ipadProtocol.js";

// The model fingerprint stays geometry-only. Freeze the current workpiece's
// optical poses separately when creating a transfer, in its Z-up model frame.
export function buildIPadPoseSeed(tasks, map, manifest) {
  const samples = [];
  const add = (camera, name, capturedAt, matrix = new Matrix4(), surfacePoint, origin = 'desktop', arm) => {
    if (!camera?.position || !camera.quaternion) return;
    const p = camera.position, q = camera.quaternion;
    if (![p.x, p.y, p.z, q.x, q.y, q.z, q.w, ...matrix.elements].every(Number.isFinite)
      || Math.abs(Math.hypot(q.x, q.y, q.z, q.w) - 1) >= 0.002) {
      throw new Error('Mac Pose 相机参数无效，请检查示教点后重新传输。');
    }
    const position = new Vector3(p.x, p.y, p.z).applyMatrix4(matrix);
    const quaternion = new Quaternion().setFromRotationMatrix(matrix)
      .multiply(new Quaternion(q.x, q.y, q.z, q.w)).normalize();
    const point = surfacePoint && new Vector3(surfacePoint.x, surfacePoint.y, surfacePoint.z).applyMatrix4(matrix);
    const xyz = (v) => ({ x: v.x, y: v.y, z: v.z });
    samples.push({ id: `mac-${samples.length + 1}`, name: Array.from(name || 'Mac Pose').slice(0, 80).join(''),
      origin, ...(arm ? { arm } : {}), segmentId: 'mac-reference', kind: 'keyframe', tracking: 'normal',
      // Older poses may lack a capture time. Keep their snapshot deterministic
      // so reopening/refreshing pairing does not create a new transfer forever.
      capturedAt: Number.isFinite(Date.parse(capturedAt)) ? new Date(capturedAt).toISOString() : '1970-01-01T00:00:00.000Z',
      cameraPose: { frameName: 'ipad_camera_optical_frame', position: xyz(position), quaternion: { ...xyz(quaternion), w: quaternion.w } },
      ...(point ? { surfacePoint: xyz(point) } : {}) });
    if (samples.length > MAX_SAMPLES) throw new Error('Mac Pose 数量超过 iPad 的 50000 个上限。');
  };
  for (const task of tasks || []) {
    if (task.coordinateFrame && task.coordinateFrame !== 'virtual_origin') continue;
    const sameMap = task.map?.sourceHash && map.sourceHash
      ? task.map.sourceHash === map.sourceHash : task.map?.id && task.map.id === map.mapId;
    if (!sameMap && task.mobileCapture?.modelHash !== manifest.modelHash) continue;
    if (task.mobileCapture) {
      const matrix = task.mobileTransform ? new Matrix4().fromArray(task.mobileTransform) : new Matrix4();
      for (const sample of task.mobileCapture.samples || []) {
        if (sample.kind !== 'keyframe' || sample.cameraPose?.frameName !== 'ipad_camera_optical_frame') continue;
        // Transporting an iPad recording through the Mac does not turn it into
        // a robot/Mac teaching pose. Legacy mobile captures were iPad-only.
        add(sample.cameraPose, sample.name, sample.capturedAt, matrix, sample.surfacePoint, sample.origin ?? 'ipad', ipadPoseArm(sample));
      }
    } else {
      for (const parking of task.parkingPoints || []) for (const pose of parking.poses || []) {
        // Robot base poses and joint values alone do not define a camera view.
        for (const [side, label] of [['left', '左相机'], ['right', '右相机']]) {
          const optical = pose.opticalTargets?.[side] || pose.cameraCapture?.frames?.[side]?.opticalPose;
          if (optical) add(optical, `${pose.name || 'Pose'} · ${label}`, pose.capturedAt, undefined, undefined, 'desktop', side);
        }
      }
    }
  }
  if (!samples.length) return undefined;
  return validateIPadPoseSeed({ samples }, manifest);
}
