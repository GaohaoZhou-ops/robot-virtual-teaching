import { abxTeachingFixture } from './abx_teaching_helpers.mjs';

export const standardPng = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR4AWP8ICfyX8roEgMAEHkDQSFzOJsAAAAASUVORK5CYII=';

export function abxTeachingStandardsFixture(count = 3) {
  const fixture = abxTeachingFixture();
  const packed = new Uint8Array(count * 6), view = new DataView(packed.buffer);
  for (let i = 0; i < count * 3; i += 1) view.setUint16(i * 2, [0, 1000, 65535][i % 3], true);
  let encoded = '';
  for (const byte of packed) encoded += String.fromCharCode(byte);
  const frame = { capturedAt: fixture.stamp,
    opticalPose: { frameName: 'zivid_left_optical_frame', position: { x: 123, y: 456, z: 789 }, quaternion: { x: 0, y: 0, z: 0, w: 1 } },
    rgb: { encoding: 'data-url', mimeType: 'image/png', width: 2, height: 1, dataUrl: `data:image/png;base64,${standardPng}` },
    pointCloud: { pointCount: count, positionEncoding: 'uint16-le/base64', positionComponents: ['x', 'y', 'z'],
      convention: 'x-right/y-down/z-forward', positionOffset: [-0.2, 0.1, 0.6], positionScale: [0, 0.00001, 0.00001],
      positionData: btoa(encoded) } };
  const parking = fixture.payload.virtualTeaching.tasks[0].parkingPoints.find((p) => p.id === 'parking-a');
  parking.poses.find((pose) => pose.id === 'a1').cameraCapture = { status: 'complete', capturedAt: fixture.stamp,
    frames: { left: structuredClone(frame), right: structuredClone(frame) } };
  parking.poses.find((pose) => pose.id === 'a2').cameraCapture = { status: 'complete', capturedAt: fixture.stamp,
    frames: { left: { ...structuredClone(frame), pointCloud: { ...frame.pointCloud, pointCount: 0, positionData: '' } } } };
  return { ...fixture, frame };
}
