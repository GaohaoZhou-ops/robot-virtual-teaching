import assert from 'node:assert/strict';
import { buildTeachingDataExport, TEACHING_DATA_FORMAT } from '../src/lib/teachingData.js';
import { normalizeProject } from '../src/lib/io.js';
import { readProjectFile } from '../src/lib/projectArchive.js';
import { teachingTransferFixture } from './teaching_transfer_helpers.mjs';

for (const mode of ['map', 'independent']) {
  const fixture = teachingTransferFixture(mode);
  const project = fixture.config.config.project;
  const before = structuredClone(project);
  const result = buildTeachingDataExport(project);
  assert.deepEqual(project, before, 'export must not change the live project');
  assert.equal(result.format, TEACHING_DATA_FORMAT);
  assert.equal(result.version, 1);
  assert.equal(result.source.teachingSpaceMode, mode);
  assert.equal(result.coordinateSystem.frameId, mode === 'map' ? 'map' : 'virtual_origin');
  assert.equal(result.coordinateSystem.angleUnit, 'degree');
  assert.equal(result.coordinateSystem.distanceUnit, 'meter');
  assert.equal(result.source.map.sourceHash, fixture.map.sourceHash);
  assert.equal(result.tasks[0].id, `${mode}-task`);
  assert.equal(result.tasks[0].parkingPoints[1].id, `${mode}-outside`);
  assert.equal(result.tasks[0].parkingPoints[1].sequence, 2);
  const point = result.tasks[0].parkingPoints[0].poses[0];
  const original = project.virtualTeaching.tasks[0].parkingPoints[0].poses[0];
  assert.deepEqual(point.mapPose, original.mapPose);
  assert.deepEqual(point.fullBodyJoints.values, { shoulder: 12, lift: 0.4 });
  assert.deepEqual(point.opticalTargets, original.opticalTargets);
  assert.deepEqual(result.robot.mapPose.position, project.robot.origin.position);
  assert.deepEqual(result.robot.fullBodyJoints.values, project.robot.joints);
  assert.deepEqual(result.jointPoses[0].joints.values, project.virtualTeaching.jointPoses[0].joints.values);
  assert.deepEqual(result.navigation.paths[0].limits, project.paths[0].limits);
  const waypointIds = new Set(result.navigation.waypoints.map((waypoint) => waypoint.id));
  assert.ok(result.navigation.paths.every((path) => waypointIds.has(path.from) && waypointIds.has(path.to)));
  assert.deepEqual(result.statistics, {
    taskCount: 1, parkingPointCount: 2, poseCount: 2, devicePoseCount: 0,
    jointPoseCount: 1, waypointCount: 3, pathCount: 2,
  });
  const serialized = JSON.stringify(result);
  for (const excluded of ['cameraCapture', 'positionBuffer', 'positionData', 'colorData', 'dataUrl',
    'replanningHistory', 'mergeHistory', 'workspace', 'view2d', 'view3d', 'portableRobotPackage']) {
    assert.ok(!serialized.includes(`"${excluded}"`), `${excluded} must not enter the exchange file`);
  }
  // Changing the size of the media has no effect on the lightweight payload.
  const largeProject = structuredClone(project);
  const largePoint = largeProject.virtualTeaching.tasks[0].parkingPoints[0].poses[0];
  largePoint.cameraCapture.frames.left.rgb.dataUrl += 'A'.repeat(2_000_000);
  largePoint.cameraCapture.frames.left.pointCloud.positionData = 'B'.repeat(2_000_000);
  assert.equal(JSON.stringify(buildTeachingDataExport(largeProject)), serialized);

  const fallback = structuredClone(project);
  delete fallback.virtualTeaching.tasks[0].parkingPoints[0].poses[0].opticalTargets;
  assert.deepEqual(buildTeachingDataExport(fallback).tasks[0].parkingPoints[0].poses[0].opticalTargets.left,
    original.cameraCapture.frames.left.opticalPose, 'retain optical targets without their camera media');
  const radians = structuredClone(project);
  radians.virtualTeaching.tasks[0].parkingPoints[0].poses[0].fullBodyJoints = {
    angularUnit: 'radian', linearUnit: 'meter', values: { shoulder: Math.PI / 2, lift: 0.4 },
  };
  assert.equal(buildTeachingDataExport(radians).tasks[0].parkingPoints[0].poses[0].fullBodyJoints.angularUnit, 'radian');
  assert.equal(buildTeachingDataExport(radians).tasks[0].parkingPoints[0].poses[0].fullBodyJoints.values.shoulder, Math.PI / 2);
  result.tasks[0].parkingPoints[0].mapPose.position.x = 999;
  assert.deepEqual(project, before, 'exchange data must not alias live pose objects');

  await assert.rejects(readProjectFile(new File([serialized], 'teaching.json')), /轻量示教数据/);
  assert.throws(() => normalizeProject(JSON.parse(serialized)), /轻量示教数据/);
  assert.equal((await readProjectFile(new File([JSON.stringify(project)], 'legacy.json'))).source, 'json');
}

for (const platform of ['iPadOS', 'visionOS']) {
  const project = teachingTransferFixture('independent').config.config.project;
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const task = project.virtualTeaching.tasks[0];
  task.mobileCapture = {
    protocol: 'atlas-ipad-teaching/1', id: 'result', sessionId: 'session', modelHash: 'a'.repeat(64),
    coordinateFrame: 'virtual_origin', createdAt: '2026-10-17T00:00:00Z', completedAt: '2026-10-17T00:01:00Z',
    device: { model: platform, lidar: platform === 'iPadOS', platform, poseSource: 'deviceAnchor' },
    calibrations: [{ id: 'segment', capturedAt: '2026-10-17T00:00:00Z', worldFromModel: identity }],
    samples: [{ id: 'sample', name: 'Pose 001', segmentId: 'segment', kind: 'keyframe', tracking: 'normal',
      capturedAt: '2026-10-17T00:00:30Z', cameraPose: { frameName: platform === 'visionOS' ? 'visionpro_head_optical_frame' : 'ipad_camera_optical_frame',
        position: { x: 1, y: 2, z: 3 }, quaternion: { x: 0, y: 0, z: 0, w: 1 } },
      previewCameraTransform: identity, thumbnail: 'data:image/png;base64,unneeded' }],
  };
  task.mobileTransform = [...identity];
  task.mobileTransform[12] = 3;
  task.mobileSolve = { rows: [{ largeDebugPayload: 'must-not-export' }] };
  const result = buildTeachingDataExport(project);
  assert.equal(result.statistics.devicePoseCount, 1);
  assert.deepEqual(result.tasks[0].mobileCapture.samples[0].cameraPose, task.mobileCapture.samples[0].cameraPose);
  assert.deepEqual(result.tasks[0].mobileCapture.calibrations, task.mobileCapture.calibrations);
  assert.deepEqual(result.tasks[0].mobileTransform, task.mobileTransform);
  for (const excluded of ['mobileSolve', 'previewCameraTransform', 'thumbnail', 'must-not-export']) {
    assert.ok(!JSON.stringify(result).includes(excluded));
  }
}

const empty = buildTeachingDataExport({});
assert.equal(empty.robot, null);
assert.deepEqual(empty.tasks, []);
assert.throws(() => buildTeachingDataExport(null), /没有可导出/);
console.log('map_and_independent_lightweight_exports=ok');
console.log('robot_navigation_units_and_identity=ok');
console.log('media_exclusion_and_snapshot_isolation=ok');
console.log('ipad_and_vision_pose_exports=ok');
console.log('project_loader_rejects_teaching_data=ok');
