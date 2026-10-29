import { MathUtils, PerspectiveCamera } from 'three';

// Nominal, co-located M70 viewing model from the vendor's 754 × 449 mm
// footprint at 700 mm. This is not per-unit optical calibration. The two
// angular fields are independent of the 1944 × 1200 output raster.
export const ZIVID_M70_PROFILE = Object.freeze({
  model: 'Zivid 2 M70', nativeWidth: 1944, nativeHeight: 1200,
  near: 0.3, focus: 0.7, far: 1.3,
  horizontalFov: 56.6, verticalFov: 35.6,
  focusWidthMm: 754, focusHeightMm: 449,
});

export class ZividM70Camera extends PerspectiveCamera {
  constructor() {
    super(ZIVID_M70_PROFILE.verticalFov, ZIVID_M70_PROFILE.nativeWidth / ZIVID_M70_PROFILE.nativeHeight,
      ZIVID_M70_PROFILE.near, ZIVID_M70_PROFILE.far);
  }

  updateProjectionMatrix() {
    let top = this.near * Math.tan(MathUtils.degToRad(ZIVID_M70_PROFILE.verticalFov / 2)) / this.zoom;
    let height = 2 * top;
    let width = 2 * this.near * Math.tan(MathUtils.degToRad(ZIVID_M70_PROFILE.horizontalFov / 2)) / this.zoom;
    let left = -width / 2;
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
