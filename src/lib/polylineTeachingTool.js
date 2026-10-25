// Tool-local direction and mounting offsets belong to the authored path.
// Changing arms clears the recorded orientation, but never infers an offset
// from a mounted device or the robot model.
export function polylineWithSide(path, side) {
  return { ...path, side, quaternion: null, toolAxisMode: 'manual' };
}
