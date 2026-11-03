import { MathUtils, PerspectiveCamera } from 'three';
import { validCameraIntrinsics } from '../../../shared/robotics/handEyeCalibration.js';

// Nominal, co-located M70 viewing model from the vendor's 754 × 449 mm
// footprint at 700 mm. This is not per-unit optical calibration. The two
// angular fields are independent of the 1944 × 1200 output raster.
export const ZIVID_M70_PROFILE = Object.freeze({
  model: 'Zivid 2 M70', nativeWidth: 1944, nativeHeight: 1200,
  near: 0.3, focus: 0.7, far: 1.3,
  horizontalFov: 56.6, verticalFov: 35.6,
  focusWidthMm: 754, focusHeightMm: 449,
});

export function zividProjection(calibration) {
  const intrinsics = validCameraIntrinsics(calibration?.intrinsics) ? calibration.intrinsics : null;
  const field = (name, fallback) => Number.isFinite(calibration?.[name]) ? calibration[name] : fallback;
  const horizontalFov = MathUtils.clamp(field('horizontalFov', ZIVID_M70_PROFILE.horizontalFov), 1, 175);
  const verticalFov = MathUtils.clamp(field('verticalFov', ZIVID_M70_PROFILE.verticalFov), 1, 175);
  const tx = Math.tan(MathUtils.degToRad(horizontalFov) / 2);
  const ty = Math.tan(MathUtils.degToRad(verticalFov) / 2);
  const width = intrinsics?.width || ZIVID_M70_PROFILE.nativeWidth, height = intrinsics?.height || ZIVID_M70_PROFILE.nativeHeight;
  const scaleX = intrinsics ? 2 * intrinsics.K[0][0] / width : 1 / tx;
  const scaleY = intrinsics ? 2 * intrinsics.K[1][1] / height : 1 / ty;
  const offsetX = intrinsics ? 2 * intrinsics.K[0][2] / width - 1 : 0;
  const offsetY = intrinsics ? 2 * intrinsics.K[1][2] / height - 1 : 0;
  const left = (-1 - offsetX) / scaleX, right = (1 - offsetX) / scaleX;
  const top = (1 + offsetY) / scaleY, bottom = (-1 + offsetY) / scaleY;
  const near = Math.max(.0001, field('workingNear', ZIVID_M70_PROFILE.near));
  return { scaleX, scaleY, offsetX, offsetY, left, right, top, bottom, width, height, near,
    far: Math.max(near + .0001, field('workingFar', ZIVID_M70_PROFILE.far)),
    horizontalFov: intrinsics ? MathUtils.radToDeg(Math.atan(right) - Math.atan(left)) : horizontalFov,
    verticalFov: intrinsics ? MathUtils.radToDeg(Math.atan(top) - Math.atan(bottom)) : verticalFov,
  };
}

// A capture keeps its own optical model so later calibration changes cannot
// move old coverage or reinterpret its image pixels. Virtual images are ideal
// pinhole views; distortion is retained as metadata for real 2D image use.
export function zividCalibrationSnapshot(calibration) {
  const p = zividProjection(calibration);
  const result = { projection: 'perspective', nativeResolution: [p.width, p.height],
    horizontalFov: p.horizontalFov, verticalFov: p.verticalFov, workingNear: p.near, workingFar: p.far };
  if (validCameraIntrinsics(calibration?.intrinsics)) {
    const i = calibration.intrinsics;
    result.intrinsics = { width: i.width, height: i.height, K: i.K.map((row) => [...row]),
      ...(Array.isArray(i.distortion) && i.distortion.length === 5 && i.distortion.every(Number.isFinite)
        ? { distortion: [...i.distortion], distortionModel: 'opencv-brown-conrady' } : {}) };
    result.imageModel = 'undistorted-pinhole';
    for (const key of ['source', 'method', 'generatedAt', 'planRevision']) {
      if (typeof calibration[key] === 'string') result[key] = calibration[key];
    }
  }
  return result;
}

export class ZividM70Camera extends PerspectiveCamera {
  constructor(calibration = null) {
    super(ZIVID_M70_PROFILE.verticalFov, ZIVID_M70_PROFILE.nativeWidth / ZIVID_M70_PROFILE.nativeHeight,
      ZIVID_M70_PROFILE.near, ZIVID_M70_PROFILE.far);
    this.calibration = calibration;
    this.updateProjectionMatrix();
  }

  updateProjectionMatrix() {
    const p = zividProjection(this.calibration);
    let top = this.near * p.top / this.zoom;
    let height = this.near * (p.top - p.bottom) / this.zoom;
    let width = this.near * (p.right - p.left) / this.zoom;
    let left = this.near * p.left / this.zoom;
    const view = this.view;
    if (view?.enabled) {
      left += view.offsetX * width / view.fullWidth;
      top -= view.offsetY * height / view.fullHeight;
      width *= view.width / view.fullWidth;
      height *= view.height / view.fullHeight;
    }
    this.projectionMatrix.makePerspective(left, left + width, top, top - height, this.near, this.far, this.coordinateSystem);
    this.projectionMatrixInverse.copy(this.projectionMatrix).invert();
  }
}
