// Only the native Vision Pro shell installs this bridge. Ordinary browsers and
// the iPhone/iPad teaching apps keep their existing behavior.
export const isVisionWorkbench = () => Boolean(globalThis.window?.AtlasVision?.native);
export const visionMessage = (type, payload = {}) => {
  const handler = globalThis.window?.webkit?.messageHandlers?.atlasWorkbench;
  if (!handler) return Promise.reject(new Error('空间工作台连接不可用'));
  return handler.postMessage({ type, ...payload });
};
export async function visionRequest(path, options = {}) {
  const response = await fetch(`/__atlas/vision-native/${path}`, { ...options,
    headers: { ...options.headers, Authorization: `Bearer ${window.AtlasVision.token}` } });
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || '本机工程操作失败');
  return response;
}

export async function openVisionWorkspaceScene(options, progress, { signal, generation = 0, revision = '' } = {}) {
  const { buildVisionScenePackage } = await import("./visionScenePackage.js");
  const { loadRobotModel, applyRobotJointValues, configureRobotArmSoftLimits, disposeRobotModel } = await import("../../robot/model/robotLoader.js");
  const { configureRobotJointCoupling } = await import("../../robot/model/robotJointCoupling.js");
  const { robot, softLimitRatio, softLimitOverrides, jointCoupling, ...scene } = options;
  const snapshot = structuredClone({ robotPose: scene.robotPose, robotJointValues: scene.robotJointValues,
    tasks: scene.tasks, waypoints: scene.waypoints, edges: scene.edges, pointColorMode: scene.pointColorMode,
    placedObjectColorMode: scene.placedObjectColorMode, workspaceTransfer: scene.workspaceTransfer });
  let model;
  try {
    if (robot) {
      progress('正在装配机器人…'); model = await loadRobotModel(robot, { signal });
      configureRobotJointCoupling(model, jointCoupling);
      configureRobotArmSoftLimits(model, softLimitRatio, softLimitOverrides);
      applyRobotJointValues(model, snapshot.robotJointValues);
    }
    const manifest = await buildVisionScenePackage({ ...scene, ...snapshot, robotDescriptor: robot, robotModel: model,
      signal, onProgress: progress,
      onAsset: (asset, buffer) => visionRequest(`assets/${asset.id}`, { method: 'PUT', body: buffer, signal }) });
    signal?.throwIfAborted();
    manifest.id = crypto.randomUUID();
    await visionMessage('openScene', { manifest, generation, revision });
  } finally { if (model) disposeRobotModel(model); }
}
