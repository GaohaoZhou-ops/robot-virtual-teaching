import { writeFile } from 'node:fs/promises';
import { buildProjectArchive } from "../src/features/workspace/model/projectArchive.js";
import { visionSceneFixture } from './vision_scene_fixture.mjs';
import { pathToFileURL } from 'node:url';

export async function workbenchFixture() {
  const { mapData, robotPose, robotJointValues, tasks } = visionSceneFixture();
  const geometry = mapData.geometry; geometry.computeBoundingBox(); geometry.computeBoundingSphere();
  const id = 'workbench/robot.urdf';
  const urdf = `<robot name="工作台验证机械臂">
    <link name="base"><visual><origin xyz="0 0 0.15"/><geometry><box size="0.65 0.5 0.3"/></geometry><material name="white"><color rgba="0.8 0.9 0.9 1"/></material></visual></link>
    <link name="lift"><visual><origin xyz="0 0 0.2"/><geometry><box size="0.15 0.15 0.4"/></geometry></visual></link>
    <joint name="lift" type="prismatic"><parent link="base"/><child link="lift"/><origin xyz="0 0 0.3"/><axis xyz="0 0 1"/><limit lower="0" upper="0.5" effort="100" velocity="1"/></joint>
    <link name="arm"><visual><origin xyz="0 0 0.35"/><geometry><box size="0.18 0.18 0.7"/></geometry><material name="yellow"><color rgba="0.9 0.6 0.1 1"/></material></visual></link>
    <joint name="shoulder" type="revolute"><parent link="lift"/><child link="arm"/><origin xyz="0 0 0.4"/><axis xyz="0 1 0"/><limit lower="-2" upper="2" effort="100" velocity="1"/></joint>
    <link name="forearm"><visual><origin xyz="0 0 0.3"/><geometry><box size="0.14 0.14 0.6"/></geometry></visual></link>
    <joint name="elbow" type="continuous"><parent link="arm"/><child link="forearm"/><origin xyz="0 0 0.7"/><axis xyz="0 1 0"/></joint>
  </robot>`;
  const robot = { id, relativePath: id, name: '工作台验证机械臂', fileName: 'robot.urdf', format: 'urdf', packageName: 'workbench', packagePath: 'workbench', origin: robotPose, joints: robotJointValues };
  const payload = { schemaVersion: '1.3', map: { fileName: '完整工作台演练.ply', format: 'ply', byteLength: 4096,
    pointCount: geometry.attributes.position.count, faceCount: geometry.index.count / 3, bounds: geometry.boundingBox, sourceHash: 'workbench-fixture', sourceHashKind: 'file' },
    workspace: { teachingSpaceMode: 'map' }, projection: { minHeight: 0, maxHeight: 2 }, robot,
    virtualTeaching: { tasks: tasks.filter(t => t.id === 'motion').map(t => ({ ...t, robot: { ...robot } })), jointPoses: [] },
    waypoints: [], paths: [] };
  const rgb = geometry.attributes.color.array;
  const mapResource = { geometryCacheVersion: 1, name: payload.map.fileName, ...payload.map,
    positionBuffer: geometry.attributes.position.array.buffer,
    colorBuffer: Uint8Array.from(rgb, x => Math.round(x * 255)).buffer, indexBuffer: geometry.index.array.buffer,
    indexComponentType: 'uint16', sphere: geometry.boundingSphere };
  const robotPackage = { schemaVersion: 1, packageName: 'workbench', packagePath: 'workbench', relativePath: id, format: 'urdf',
    files: [{ path: id, mimeType: 'application/xml', bytes: new TextEncoder().encode(urdf).buffer }] };
  return buildProjectArchive(payload, { mapResource, existingRobotPackage: robotPackage });
}
if (import.meta.url === pathToFileURL(process.argv[1]).href && process.argv[2]) {
  const archive = await workbenchFixture(); await writeFile(process.argv[2], archive.bytes);
}
